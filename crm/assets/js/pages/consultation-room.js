/* ============================================================
   CONSULTING ROOM — her side, inside the CRM
   ------------------------------------------------------------
   The trial's room, now behind her session.

   WHAT IS DIFFERENT FROM THE CLIENT'S PAGE is not styling and
   not a hidden class: it is that Start and End exist in this
   document and not in theirs, and that the server checks the
   side before it moves the state machine. A modified page can
   ask; it cannot start a consultation.

   WHO IS IN IT COMES FROM TODAY'S SESSIONS AND NOWHERE ELSE.
   One request, at boot, and every detail on the page is drawn
   from it — who is coming, what about, when, how to reach them.
   The record is the one other thing this page opens, and it is
   written straight into the panel rather than loaded as a second
   page inside a frame. See assets/js/nsf-panel.js.

   IT IS SIZED TO THE VIEWPORT, not to its contents. A
   consultation is one screen: the stage fills the height it has,
   the record scrolls inside its panel, and the page itself never
   scrolls. Anything that pushes a control off the bottom of the
   screen mid-call is a bug, so the height is measured from where
   the grid actually sits rather than guessed in a stylesheet.
   ============================================================ */

import * as api from "../api.js";
import * as nsfPanel from "../nsf-panel.js";
import { start, $, $$ } from "../page.js";
import { esc, fmtDay, fmtTime, MODE } from "../format.js";
import { joinRoom } from "../room-client.js";

const params = new URLSearchParams(location.search);
let signal = null;
let peer = null;
let stream = null;
let here = [];

/* ---- picking somebody ----------------------------------------- */

function renderPick(rows) {
  const host = $("[data-pick]");
  if (!rows.length) {
    host.innerHTML =
      `<p class="empty">Nothing booked today. Open a session from ` +
      `<a href="./today.html">Today</a> when there is one.</p>`;
    return;
  }
  host.innerHTML = rows.map((b) => `
    <div class="row">
      <div class="row-main">
        <div class="row-top">
          <span class="who">${esc(b.name)}</span>
          <span class="when">${fmtTime(b.startAt)}</span>
        </div>
        <p class="row-sub">${esc(b.focusArea || "")}</p>
      </div>
      <div class="row-acts">
        <button class="btn go" type="button" data-open="${esc(b.id)}">Open the room</button>
      </div>
    </div>`).join("");
}

/* ---- the room -------------------------------------------------- */

function setState(state, text) {
  const chip = $("[data-state-chip]");
  chip.dataset.state = state;
  $("[data-state-text]").textContent = text;
}

function paintControls(state) {
  const live = state === "live";
  const ended = state === "ended";
  $("[data-start]").disabled = live || ended;
  $("[data-end]").disabled = !live;
  $("[data-start]").textContent = live ? "In progress" : "Start consultation";

  /* The same sentence in both places. The chip is up in the bar and
     the card is in the middle of the stage she is actually looking
     at, and they must never disagree about whether somebody is here. */
  const say = (state, text) => {
    setState(state, text);
    const note = $("[data-await-note]");
    if (note) note.textContent = text;
  };

  if (ended) return say("ended", "Ended — your notes are still open");
  if (live) return say("live", "Consultation in progress");
  say("waiting", here.includes("client")
    ? "They're waiting — start when you're ready"
    : "Nobody here yet");
}

/* ---- one screen, and it fits ------------------------------------
   The grid is given the height that is actually left below it,
   measured from where it sits rather than assumed from a stack of
   rems that is wrong the moment the masthead wraps or the browser
   font changes. innerHeight rather than 100vh so a phone's
   collapsing address bar is accounted for.

   Everything inside then works in that budget: the stage takes what
   it is given, the record scrolls within the panel, and the page
   itself has nothing to scroll. */
function fitToViewport() {
  /* The sub-nav's real height, published for the stylesheet, and
     BEFORE the guard below: on a narrow screen the stage is pinned
     beneath that bar whether or not the grid is on screen yet, and
     the offset has to be measured — a number written into the CSS is
     wrong the moment the bar wraps onto two lines, which is exactly
     what it does on a phone. */
  const bar = document.querySelector(".work-bar");
  if (bar) {
    document.documentElement.style.setProperty("--work-bar-h", `${bar.offsetHeight}px`);
  }

  const grid = $("[data-grid]");
  if (!grid || grid.offsetParent === null) return;

  /* Document-relative, so a page that has been scrolled does not
     measure its own scroll position into the answer. */
  const top = grid.getBoundingClientRect().top + window.scrollY;

  /* AND WHAT COMES AFTER IT. The footer is small, but leaving it out
     of the budget leaves the page one line taller than the window —
     and the sub-nav is sticky, so the moment the page can scroll at
     all it lifts off and covers the top of the panel. */
  const foot = document.querySelector(".work .foot");
  const tail = foot ? Math.ceil(foot.getBoundingClientRect().height) : 0;

  const room = Math.max(360, Math.round(window.innerHeight - top - tail - 14));
  document.documentElement.style.setProperty("--room-h", `${room}px`);

  /* AND THEN CHECK. The arithmetic above accounts for what is above
     the grid and what is below it; it cannot account for a margin
     that collapses differently once the grid has a height, or a
     footer that rewraps. So measure what actually happened and take
     the difference off — once, not in a loop, because on a viewport
     genuinely too short to hold the room no height would ever
     satisfy it and the short-viewport rules take over anyway. */
  const over = document.documentElement.scrollHeight - window.innerHeight;
  if (over > 0 && room - over >= 360) {
    document.documentElement.style.setProperty("--room-h", `${room - over}px`);
  }
}

/** Who is in the room, beside the call.
 *
 *  IT HAS ALREADY ARRIVED. Every line here comes off the same
 *  today-session row that put the person on this page — no second
 *  lookup, because a second request is a second thing that can be
 *  slow while somebody is already waiting on the other end.
 *
 *  The phone is a link and never a field. It is what she falls back
 *  to when the connection goes, and it is not hers to edit here. */
function paintBrief(b) {
  const set = (sel, text) => { $(sel).textContent = text || "—"; };

  set("[data-brief-name]", b.name);
  set("[data-brief-focus]", b.focusArea);
  set("[data-brief-when]", b.startAt ? `${fmtDay(b.startAt)} · ${fmtTime(b.startAt)}` : "");
  set("[data-brief-mode]", MODE[b.mode] || b.mode);
  set("[data-brief-email]", b.email);

  const phone = $("[data-brief-phone]");
  phone.textContent = b.phone || "not on file";
  if (b.phone) phone.href = `tel:${b.phone}`;
  else phone.removeAttribute("href");
}

/** Their way in, shown so she can hand it over — and so the room can
 *  be tested at all: without it there was no way to reach the same
 *  room as the client from this side.
 *
 *  ITS FAILURE IS NOT THE CALL'S FAILURE. If minting is refused the
 *  row simply says so and everything else in the room carries on.
 *  She still has their number. */
async function paintLink(b) {
  const row = $("[data-link-row]");
  const out = $("[data-link-url]");

  // A phone or in-person consultation has no room to link to.
  if (b.mode !== "video") { row.hidden = true; return; }

  row.hidden = false;
  out.textContent = "making it…";
  out.removeAttribute("href");

  try {
    const { url } = await api.consultationLink(b.id);
    out.textContent = url;
    out.href = url;
  } catch (err) {
    out.textContent = err.message || "could not make a link";
  }
}

/** The black tile, before there is anything to show on it.
 *
 *  An initial and a name, so a room that has been sitting open for
 *  ten minutes still answers "who am I waiting for" without her
 *  looking away from the stage. It is under the video, not instead
 *  of it: the moment their track lands the picture covers it. */
function paintStage(b) {
  const initial = (b.name || "").trim().charAt(0).toUpperCase() || "·";
  $("[data-avatar]").textContent = initial;
  $("[data-await-who]").textContent = b.name || "—";
  $("[data-tile-name]").textContent = b.name || "—";
}

/* ---- media and signalling -------------------------------------- */

async function openMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    try {
      // Audio alone is a consultation. No camera is not.
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return null;
    }
  }
}

/* WIRED ONCE, PAINTED MANY TIMES.
 *
 *  These two were bound inside wireToggles, which runs on every
 *  enter() — so opening a second session without reloading added a
 *  second click listener to each button. Both fired, the track was
 *  toggled twice, and the control did nothing at all. "Not working
 *  properly" in the most literal way: it worked, exactly twice. */
let togglesWired = false;

const audioTrack = () => stream?.getAudioTracks()[0] || null;
const videoTrack = () => stream?.getVideoTracks()[0] || null;

/** One control's appearance, from the track behind it.
 *
 *  data-off drives BOTH the colour and the slash across the icon, so
 *  the state survives a colourblind eye and a bad screen — a control
 *  whose only difference is dark-grey versus dark-red is a control
 *  she cannot read at a glance in a room with a window in it.
 *
 *  A button with no track says so rather than doing nothing. Two
 *  windows on one machine compete for the same microphone, and a
 *  silent no-op looks exactly like a bug. */
function paintToggle(btn, track, onLabel, offLabel) {
  if (!track) {
    btn.disabled = true;
    btn.dataset.off = "true";
    btn.setAttribute("aria-pressed", "true");
    btn.title = "No device — another window may be using it";
    return;
  }
  btn.disabled = false;
  btn.dataset.off = String(!track.enabled);
  btn.setAttribute("aria-pressed", String(!track.enabled));
  btn.title = track.enabled ? onLabel : offLabel;
}

function paintToggles() {
  paintToggle($("[data-mic]"), audioTrack(), "Mute microphone", "Unmute microphone");
  paintToggle($("[data-cam]"), videoTrack(), "Turn camera off", "Turn camera on");
  const v = videoTrack();
  $("[data-near]").dataset.off = String(!!v && !v.enabled);
}

function wireToggles() {
  paintToggles();
  if (togglesWired) return;
  togglesWired = true;

  $("[data-mic]").addEventListener("click", () => {
    const t = audioTrack(); if (!t) return;
    t.enabled = !t.enabled;
    paintToggles();
  });

  $("[data-cam]").addEventListener("click", () => {
    const t = videoTrack(); if (!t) return;
    t.enabled = !t.enabled;
    paintToggles();
  });
}

async function enter(booking) {
  /* Kept where the retry in the record panel can find it. Reopening
     the form must not need the click that opened the room. */
  window.__roomBooking = booking;

  $("[data-pick]").hidden = true;
  $("[data-room]").hidden = false;
  fitToViewport();

  // The bar carries who and when.
  $("[data-room-when]").textContent =
    `${booking.name} · ${fmtDay(booking.startAt)} · ${fmtTime(booking.startAt)}`;

  const phone = $("[data-phone]");
  if (booking.phone) {
    phone.href = `tel:${booking.phone}`;
    phone.textContent = booking.phone;
  }

  paintBrief(booking);
  paintStage(booking);
  paintLink(booking);

  /* The record opens alongside the call, not before it. Awaiting it
     here would put a network request between her clicking into the
     room and her camera coming on. */
  nsfPanel.mount($("[data-record]"), booking);

  stream = await openMedia();
  if (stream) {
    $("[data-near]").srcObject = stream;
  } else {
    setState("ended", "No camera or microphone");
    $("[data-fallback]").hidden = false;
  }
  wireToggles();

  ({ signal, peer } = await joinRoom({
    room: booking.id,
    side: "host",
    stream,
    onState: (p) => paintControls(p.state),
    onPeers: (p) => { here = p.present || []; if (!$("[data-start]").disabled) paintControls("waiting"); },
    onTrack: (remote) => {
      $("[data-far]").srcObject = remote;
      /* Their picture takes the tile. The waiting card underneath is
         hidden by this attribute rather than removed, so a connection
         that drops brings it straight back. */
      $("[data-stage]").dataset.remote = "true";
      $("[data-fallback]").hidden = true;
    },
    onConnection: (state) => {
      if (state === "connected") setState("live", "Connected");
      if (state === "failed") { setState("ended", "Connection lost"); $("[data-fallback]").hidden = false; }
    },
  }));

  paintControls("waiting");
}

/* ---- the scratch pad ------------------------------------------- */
function wirePad(key) {
  const pad = $("[data-pad]");
  const said = $("[data-pad-saved]");
  const storeKey = "myf-room-pad-" + key;
  pad.value = localStorage.getItem(storeKey) || "";

  let timer = null;
  pad.addEventListener("input", () => {
    said.textContent = " · saving";
    clearTimeout(timer);
    timer = setTimeout(() => {
      localStorage.setItem(storeKey, pad.value);
      said.textContent = " · saved";
    }, 300);
  });
}

/* ---- wiring ----------------------------------------------------- */

document.addEventListener("click", (e) => {
  /* Scoped to the picker on purpose. The record's collapsible
     sections also carry data-open — as a boolean, not an id — and a
     bare [data-open] here would match one of them the moment she
     opened section three. */
  const open = e.target.closest("[data-pick] [data-open]");
  if (open) {
    const b = (window.__today || []).find((x) => x.id === open.dataset.open);
    if (b) { wirePad(b.id); enter(b); }
    return;
  }

  if (e.target.closest("[data-start]")) return signal?.send("start");
  if (e.target.closest("[data-end]")) return signal?.send("end");

  const copy = e.target.closest("[data-link-copy]");
  if (copy) {
    const url = $("[data-link-url]").textContent.trim();
    if (!url.startsWith("http")) return;
    /* The button says what happened, in place. A toast would be a
       second thing on the screen during a call for a two-second
       message. */
    navigator.clipboard.writeText(url).then(
      () => { copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1800); },
      () => { copy.textContent = "Select it"; setTimeout(() => (copy.textContent = "Copy"), 1800); }
    );
    return;
  }

  const fold = e.target.closest("[data-fold]");
  if (fold) {
    const folded = $("[data-grid]").classList.toggle("folded");
    fold.textContent = folded ? "Notes" : "Hide";
  }
});

/* ---- boot ------------------------------------------------------- */
start("consultation-room", api.today, (data) => {
  const rows = data.today || [];
  window.__today = rows;
  renderPick(rows);

  /* Re-measured whenever anything above the grid changes height —
     the masthead wraps on a narrow window, and a height worked out
     once at load would then be wrong for the rest of the call. */
  addEventListener("resize", fitToViewport);
  const mast = document.querySelector("[data-masthead]");
  if (mast && "ResizeObserver" in window) new ResizeObserver(fitToViewport).observe(mast);
  fitToViewport();

  // Straight in, when Today sent us here for somebody specific.
  const want = params.get("booking");
  const found = rows.find((b) => b.id === want);
  if (found) { wirePad(found.id); enter(found); }
});
