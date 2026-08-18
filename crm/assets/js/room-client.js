/* ============================================================
   ROOM CLIENT — signalling and one peer connection
   ------------------------------------------------------------
   The browser half of the consulting room. Two jobs, kept apart
   from the page so the page reads as "what she can do" rather
   than as WebRTC.

   THE MEDIA NEVER TOUCHES THE SERVER. It carries about six small
   messages so the two sides can find each other, and then the
   picture and the sound go directly between the two browsers.
   That is the reason this is cheap to run and the reason a
   consultation cannot leak through a server that never sees it.
   ============================================================ */

/* Google's public STUN — free, stateless, and it only ever answers
   "here is how the internet sees you". TURN, which does carry media
   and does cost bandwidth, is added here when it exists. */
const ICE = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * @param {object} o
 * @param {string} o.room     the consultation this is about
 * @param {"host"|"client"} o.side
 * @param {MediaStream|null} o.stream
 */
export async function joinRoom(o) {
  const qs = new URLSearchParams({ room: o.room });
  const src = new EventSource(`/api/crm/room?${qs}`);

  const signal = {
    async send(kind, extra) {
      try {
        await fetch(`/api/crm/room?${qs}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, ...extra }),
        });
      } catch {
        o.onConnection?.("failed");
      }
    },
    close: () => src.close(),
  };

  const pc = new RTCPeerConnection({ iceServers: ICE });
  let making = false;
  let ignoring = false;

  pc.addEventListener("track", (e) => o.onTrack?.(e.streams[0]));
  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate) signal.send("candidate", { candidate: e.candidate });
  });

  pc.addEventListener("connectionstatechange", async () => {
    o.onConnection?.(pc.connectionState);
    if (pc.connectionState === "connected") {
      signal.send("connection", { connection: await howItTravelled(pc) });
    } else if (pc.connectionState === "failed") {
      signal.send("connection", { connection: "failed" });
    }
  });

  /* Renegotiation, which happens whenever a track is added — turning
     a camera on mid-call, for instance. Handled rather than assumed
     to be a single handshake at the start. */
  pc.addEventListener("negotiationneeded", async () => {
    try {
      making = true;
      await pc.setLocalDescription();
      signal.send("offer", { sdp: pc.localDescription });
    } catch (err) {
      console.warn("[room] could not offer:", err.message);
    } finally {
      making = false;
    }
  });

  /* POLITE AND IMPOLITE. Two sides offering at the same instant
     deadlock, so one must yield. The client yields; she does not —
     whoever decides when the session begins should not be the side
     backing down. */
  const polite = o.side === "client";

  async function take(kind, msg) {
    try {
      if (kind === "offer" || kind === "answer") {
        const description = msg.sdp;
        const collision = description.type === "offer" && (making || pc.signalingState !== "stable");
        ignoring = !polite && collision;
        if (ignoring) return;

        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          signal.send("answer", { sdp: pc.localDescription });
        }
      } else if (kind === "candidate") {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (err) {
          // A candidate for an offer we discarded. Expected.
          if (!ignoring) throw err;
        }
      }
    } catch (err) {
      console.warn("[room]", kind, "failed:", err.message);
    }
  }

  for (const kind of ["state", "peer", "offer", "answer", "candidate", "evicted"]) {
    src.addEventListener(kind, (e) => {
      let payload = {};
      try { payload = JSON.parse(e.data); } catch { /* keep going */ }

      if (kind === "state") return o.onState?.(payload);
      if (kind === "peer") return o.onPeers?.(payload);
      if (kind === "evicted") {
        try { pc.close(); } catch { /* gone */ }
        src.close();
        return o.onEvicted?.();
      }
      return take(kind, payload);
    });
  }

  // Publishing our own tracks is what triggers the negotiation.
  if (o.stream) for (const t of o.stream.getTracks()) pc.addTrack(t, o.stream);

  return { signal, peer: pc };
}

/** Direct, or relayed? A candidate of type "relay" on either end
    means TURN carried the media — the only case that costs
    anything, and the only one worth counting. */
async function howItTravelled(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => {
      if (r.type === "candidate-pair" && (r.selected || r.state === "succeeded")) {
        if (!pair || r.selected || (r.bytesReceived || 0) > (pair.bytesReceived || 0)) pair = r;
      }
    });
    if (!pair) return "direct";
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return local?.candidateType === "relay" || remote?.candidateType === "relay"
      ? "relayed"
      : "direct";
  } catch {
    // Not knowing is not the same as having failed.
    return "";
  }
}
