/* ============================================================
   THE CLIENT'S SIDE OF THE CONSULTING ROOM
   ------------------------------------------------------------
   Opened from the link in a WhatsApp message or an email. Waits
   until she starts, then joins.

   WHAT IS NOT IN THIS FILE is the point of it. There is no start
   and no end — not hidden, not disabled: absent. A modified copy
   of this page has nothing to un-hide, and the server refuses
   those two messages from this side anyway.

   THE TOKEN IS THE ONLY KEY, and it never becomes anything else.
   It is read from the address, sent with each request, and
   stripped from the address bar once used — this is a link
   people open on a phone and then hand the phone to somebody.
   ============================================================ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* /c/<token> — a path, not a query string. It is what a dynamic URL
   button appends to, and query strings are what proxies and access
   logs record most eagerly. */
const TOKEN = location.pathname.replace(/^\/c\//, "").replace(/\/+$/, "");

let pc = null;
let stream = null;
let signal = null;

/* ---- views ----------------------------------------------------- */
function show(name) {
  for (const el of $$("[data-view]")) el.hidden = el.dataset.view !== name;
}

function setState(state, text) {
  $("[data-state-chip]").dataset.state = state;
  $("[data-state-text]").textContent = text;
}

/** The appointment, in THEIR timezone.
 *
 *  The opposite of the confirmation email, on purpose. The email is
 *  written once and read anywhere, so it names the practice's zone.
 *  This page is being read right now on a device that knows where it
 *  is — so it can say the time the way their own phone will, which
 *  is the version they will set an alarm by. */
function readable(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    weekday: "long", day: "numeric", month: "long",
    hour: "2-digit", minute: "2-digit",
  });
}

/* ---- media ------------------------------------------------------ */
async function openMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    try {
      // A consultation survives without a camera. It does not survive
      // nobody knowing why the picture is missing.
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return null;
    }
  }
}

function wireToggles() {
  const mic = $("[data-mic]");
  const cam = $("[data-cam]");
  const near = $("[data-near]");

  /* A control with no device behind it says so rather than doing
     nothing — a silent no-op is indistinguishable from a bug, and
     "my mute button is broken" is a call she does not need. */
  const paint = (btn, track, on, off) => {
    if (!track) {
      btn.disabled = true;
      btn.dataset.off = "true";
      btn.title = "No device available";
      return;
    }
    btn.disabled = false;
    btn.dataset.off = String(!track.enabled);
    btn.title = track.enabled ? on : off;
    btn.setAttribute("aria-label", track.enabled ? on : off);
  };

  const audio = () => stream?.getAudioTracks()[0] || null;
  const video = () => stream?.getVideoTracks()[0] || null;

  mic.addEventListener("click", () => {
    const t = audio(); if (!t) return;
    t.enabled = !t.enabled;
    paint(mic, t, "Mute microphone", "Unmute microphone");
  });

  cam.addEventListener("click", () => {
    const t = video(); if (!t) return;
    t.enabled = !t.enabled;
    paint(cam, t, "Turn camera off", "Turn camera on");
    near.dataset.off = String(!t.enabled);
  });

  paint(mic, audio(), "Mute microphone", "Unmute microphone");
  paint(cam, video(), "Turn camera off", "Turn camera on");
}

/* ---- signalling and the peer ------------------------------------ */
const ICE = [{ urls: "stun:stun.l.google.com:19302" }];

function connect() {
  const qs = new URLSearchParams({ t: TOKEN });
  const src = new EventSource(`/api/room?${qs}`);

  const send = async (kind, extra) => {
    try {
      await fetch(`/api/room?${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ...extra }),
      });
    } catch { /* the media does not need the server once it is up */ }
  };

  pc = new RTCPeerConnection({ iceServers: ICE });
  let making = false;
  let ignoring = false;

  pc.addEventListener("track", (e) => {
    $("[data-far]").srcObject = e.streams[0];
    $("[data-fallback]").hidden = true;
  });

  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate) send("candidate", { candidate: e.candidate });
  });

  pc.addEventListener("connectionstatechange", async () => {
    if (pc.connectionState === "connected") {
      setState("live", "Connected");
      send("connection", { connection: await howItTravelled(pc) });
    }
    if (pc.connectionState === "failed") {
      setState("ended", "Could not connect");
      $("[data-fallback]").hidden = false;
      send("connection", { connection: "failed" });
    }
  });

  pc.addEventListener("negotiationneeded", async () => {
    try {
      making = true;
      await pc.setLocalDescription();
      send("offer", { sdp: pc.localDescription });
    } catch { /* the other side will offer */ } finally { making = false; }
  });

  /* POLITE. Two sides offering at the same instant deadlock, so one
     must back down — and it is this one, because whoever decides
     when the session begins should not be the side yielding. */
  async function take(kind, msg) {
    try {
      if (kind === "offer" || kind === "answer") {
        const description = msg.sdp;
        const collision = description.type === "offer" &&
          (making || pc.signalingState !== "stable");
        ignoring = false;
        if (collision) await pc.setLocalDescription({ type: "rollback" }).catch(() => {});
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          send("answer", { sdp: pc.localDescription });
        }
      } else if (kind === "candidate") {
        try { await pc.addIceCandidate(msg.candidate); }
        catch (err) { if (!ignoring) throw err; }
      }
    } catch (err) {
      console.warn("[room]", kind, err.message);
    }
  }

  for (const kind of ["state", "offer", "answer", "candidate", "evicted"]) {
    src.addEventListener(kind, (e) => {
      let payload = {};
      try { payload = JSON.parse(e.data); } catch { /* keep going */ }

      if (kind === "state") return onState(payload.state);
      if (kind === "evicted") {
        try { pc.close(); } catch { /* gone */ }
        src.close();
        return show("elsewhere");
      }
      return take(kind, payload);
    });
  }

  src.addEventListener("error", () => setState("waiting", "Reconnecting…"));

  if (stream) for (const t of stream.getTracks()) pc.addTrack(t, stream);
  return { send, close: () => src.close() };
}

async function howItTravelled(peer) {
  try {
    const stats = await peer.getStats();
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
      ? "relayed" : "direct";
  } catch {
    return "";
  }
}

/* ---- what the room is doing ------------------------------------- */
function onState(state) {
  if (state === "waiting") {
    $("[data-waiting]").hidden = false;
    setState("waiting", "Waiting for Khadija");
    return show("room");
  }

  if (state === "live") {
    /* The waiting screen covered the video rather than replacing it,
       so their camera has been running and permitted since they
       arrived. Nobody should be granting permissions while somebody
       waits for them to appear. */
    $("[data-waiting]").hidden = true;
    setState("live", "Consultation in progress");
    return show("room");
  }

  if (state === "ended") {
    setState("ended", "Ended");
    try { pc?.close(); } catch { /* gone */ }
    for (const t of stream?.getTracks() || []) t.stop();
    signal?.close();
    return show("ended");
  }
}

/* ---- how it went ------------------------------------------------- */
let stars = 0;

$("[data-rate]").addEventListener("click", async (e) => {
  const star = e.target.closest("[data-star]");
  if (star) {
    stars = Number(star.dataset.star);
    for (const b of $$("[data-star]")) b.dataset.lit = String(Number(b.dataset.star) <= stars);
    return;
  }

  if (e.target.closest("[data-skip]")) return done("Thanks all the same.");

  if (e.target.closest("[data-send]")) {
    const comment = $("[data-comment]").value.trim();
    if (!stars && !comment) return done("Thanks all the same.");
    try {
      await fetch(`/api/room/rating?t=${encodeURIComponent(TOKEN)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stars, comment }),
      });
    } catch { /* said thank you either way — see below */ }
    /* Thanked whether or not it saved. Somebody who has just given
       an opinion should not be shown a network error about it; she
       loses one rating, they lose nothing. */
    done("Thank you — that's been passed on.");
  }
});

function done(message) {
  $("[data-rate]").hidden = true;
  const thanks = $("[data-thanks]");
  thanks.textContent = message;
  thanks.hidden = false;
}

/* ---- boot -------------------------------------------------------- */
(async function open() {
  if (!TOKEN || TOKEN.length < 16) return show("gone");

  let link;
  try {
    const res = await fetch(`/api/link?t=${encodeURIComponent(TOKEN)}`, {
      headers: { Accept: "application/json" },
    });
    link = res.ok ? await res.json() : null;
  } catch {
    link = null;
  }

  if (!link?.ok) return show("gone");

  /* Their own name, first — see the comment in consultation.html.
     textContent, because a name is somebody's text and this page
     renders it before asking for a camera. */
  const whose = $("[data-whose]");
  if (whose) {
    whose.textContent = link.firstName ? `${link.firstName}'s consultation` : "";
    whose.hidden = !link.firstName;
  }

  const when = link.startAt ? readable(link.startAt) : null;
  $("[data-when]").textContent = when ? `Booked for ${when}` : "";

  /* THE ROOM IS SHOWN BEFORE THE CAMERA IS ASKED FOR.
     getUserMedia has a third outcome besides granted and refused: it
     can simply never settle. A permission prompt nobody answers — the
     client looked away, the tab is in the background, a managed
     browser is deciding — leaves that promise pending for as long as
     the page is open. Awaiting it first meant they sat on a blank
     "One moment…" card with nothing to read and nothing to press,
     while she waited on the other side of a room they never reached.

     So the room appears first and says what it is doing. Granted,
     refused and never-answered now all look like a client in the
     room; only the picture differs. */
  $("[data-mic]").disabled = true;
  $("[data-cam]").disabled = true;
  show("room");
  setState("waiting", "Getting your camera…");

  /* Still awaited before connecting: the tracks have to exist before
     the peer connection is built, or nothing is offered to send. A
     stalled prompt therefore still stalls the CALL — it cannot not —
     but it no longer stalls the page, and what she is waiting on is
     now written on the client's screen where they can act on it. */
  stream = await openMedia();
  const ready = $("[data-ready]");
  if (stream) {
    $("[data-near]").srcObject = stream;
    ready.textContent = "Your camera and microphone are set up — there's nothing else to do.";
  } else {
    /* Said here rather than only in the corner notice, because this
       overlay is the whole screen while they wait and it is the only
       thing they are reading. A consultation survives without a
       camera; it does not survive nobody knowing why. */
    ready.textContent =
      "No camera or microphone — she can still hear you if your microphone comes back, " +
      "and she has your number either way.";
    $("[data-fallback]").hidden = false;
  }
  wireToggles();

  signal = connect();
  setState("waiting", "Waiting for Khadija");

  /* Used, so it goes. replaceState leaves no history entry, so Back
     does not walk into the tokenised URL again. */
  history.replaceState(null, "", "/c/");
})();
