/* ============================================================
   THE CONSULTING ROOM — the server's half
   ------------------------------------------------------------
   Server-sent events downward, POST upward. Six small messages
   let two browsers find each other, and then the server is done:
   the video goes peer to peer and never touches this process.

   TWO THINGS LIVE IN DIFFERENT PLACES, on purpose.

     The SOCKETS are in memory here, because an open HTTP
     response is not a row and cannot be.

     The FACTS — who joined, who started it, when it ended, how
     the media travelled — go to crm.room_sessions and
     crm.room_participants, so they survive a restart and can be
     counted afterwards.

   THE STATE MACHINE IS THE SERVER'S. `start` and `end` are
   refused for anybody who is not the host, and the host is
   established by the session cookie rather than by a field in
   the request body. A modified page can ask.
   ============================================================ */
"use strict";

const data = require("../data-client");

const rooms = new Map(); // room -> { state, startedAt, peers: Map<side, res> }

function room(id) {
  if (!rooms.has(id)) rooms.set(id, { state: "waiting", startedAt: null, peers: new Map() });
  return rooms.get(id);
}

/** Bookkeeping that must never fail a consultation. */
function remember(fn, payload) {
  return data.crm[fn](payload).catch((err) => {
    console.warn(`[room] ${fn} not recorded: ${err.message}`);
    return null;
  });
}

function fanout(id, event, payload, except) {
  const r = rooms.get(id);
  if (!r) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [side, res] of r.peers) {
    if (side === except) continue;
    try { res.write(line); } catch { r.peers.delete(side); }
  }
}

/**
 * Hold a stream open for one side of one room.
 *
 * @param {"host"|"client"} side  established by the caller from a
 *        session or a token — never taken from the query string.
 */
function stream(req, res, id, side, meta = {}) {
  const r = room(id);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    // Stops a proxy sitting on a 40-byte handshake waiting for company.
    "X-Accel-Buffering": "no",
  });
  res.write(": open\n\n");

  /* ONE SCREEN AT A TIME. A link open in two places is two of the
     same person in the room — two cameras, two microphones, and a
     negotiation between three parties designed for two.

     Newest wins rather than refusing the second: a crashed browser
     or a slept phone leaves a connection the server still believes
     in, and strict refusal would lock the real client out of their
     own appointment with no way back. The evicted screen is told
     before it is closed. */
  const already = r.peers.get(side);
  if (already && already !== res) {
    try {
      already.write(`event: evicted\ndata: ${JSON.stringify({ side })}\n\n`);
      already.end();
    } catch { /* already gone — same outcome */ }
    r.peers.delete(side);
  }

  r.peers.set(side, res);
  remember("roomJoin", {
    room: id,
    side,
    consultationId: meta.consultationId || null,
    userAgent: meta.userAgent || "",
    ipHash: meta.ipHash || "",
    source: "system",
  });

  // Whoever arrived needs the state as it is, not as it will be.
  res.write(`event: state\ndata: ${JSON.stringify({ state: r.state, startedAt: r.startedAt })}\n\n`);
  fanout(id, "peer", { side, present: [...r.peers.keys()] });

  // Proxies and phone radios drop an idle connection long before a
  // consultation is over.
  const beat = setInterval(() => {
    try { res.write(": beat\n\n"); } catch { /* closed */ }
  }, 25_000);

  req.on("close", () => {
    clearInterval(beat);
    // Only if this is still the live one — an evicted connection
    // closing must not delete the screen that replaced it.
    if (r.peers.get(side) !== res) return;
    r.peers.delete(side);
    fanout(id, "peer", { side, left: true, present: [...r.peers.keys()] });
    remember("roomLeave", { room: id, side, connection: "" });
  });
}

/**
 * Everything sent upward.
 *
 * @param {"host"|"client"} side  again, established by the caller.
 */
function post(id, side, body) {
  const r = room(id);
  const kind = String(body?.kind || "");

  if (kind === "start" || kind === "end") {
    /* THE RULE, ENFORCED. Not "the client's page has no button" —
       the client's request is refused. */
    if (side !== "host") return { ok: false, error: "only the practitioner may do that" };

    r.state = kind === "start" ? "live" : "ended";
    if (kind === "start" && !r.startedAt) r.startedAt = new Date().toISOString();

    fanout(id, "state", { state: r.state, startedAt: r.startedAt });
    remember("roomState", { room: id, state: r.state, by: body.by || "host" });

    /* Ending closes the client's room and their token with it. Her
       own notes are untouched — the ten minutes after a consultation
       are when half of them get written. */
    return { ok: true, state: r.state };
  }

  /* How the media travelled, reported by the browser once the
     connection settles. Only it can see whether the chosen candidate
     pair was relayed, and that count is what sizes TURN. */
  if (kind === "connection") {
    remember("roomLeave", { room: id, side, connection: String(body.connection || "") });
    return { ok: true };
  }

  if (["offer", "answer", "candidate"].includes(kind)) {
    fanout(id, kind, { ...body, side }, side);
    return { ok: true };
  }

  return { ok: false, error: "unknown kind" };
}

module.exports = { stream, post };
