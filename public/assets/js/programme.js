/* ============================================================
   THE PROGRAMME
   ------------------------------------------------------------
   Opened three times a day, on a phone, in a kitchen, often on
   bad signal. Everything below follows from that.

   THE TOKEN IS KEPT, NOT CARRIED. This page is installed to a home
   screen, and an installed app that launches at /me/ with no token
   would be an app that never works twice. So the token is read
   from the address once and stored, and the address is then
   cleaned — a screenshot of somebody's diet programme should not
   contain the key to it.

   TICKS ARE QUEUED, NOT SENT. A kitchen is where signal dies. A
   tap writes to the queue and paints immediately; the queue drains
   when the network allows. Nothing is ever lost because a wall was
   in the way, and nothing waits on a spinner.

   NOTHING IS DELETED. A correction is a new check-in and the
   latest one for a day wins — the server has no update path at
   all. Tapping a different answer is therefore always safe.
   ============================================================ */

import * as photos from "/assets/js/photos.js";

const KEY_TOKEN = "myf-programme-token";
const KEY_QUEUE = "myf-programme-queue";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---- the ground the glass refracts ------------------------------
   Straight out of liquid-os-ui.html — a linear ground with radial
   blobs composited in `lighter` — with ONE change, and it is
   deliberate.

   THE REFERENCE ANIMATES THIS ON requestAnimationFrame. Six radial
   gradients repainted sixty times a second is fine for a demo page
   somebody looks at for a minute. This app is opened three times a
   day, on whatever phone the client owns, usually on battery, and a
   continuous canvas underneath a backdrop-filter is the most
   expensive thing a web page can do to one.

   And it buys nothing here. The depth comes from the displacement
   filter and the specular edge, not from motion — a still frame
   under liquid glass is indistinguishable from a moving one unless
   you sit and watch it. So it paints once, and again only if the
   window changes size.

   The positions are fixed rather than random, so the wallpaper a
   client sees on Tuesday is the one they saw on Monday. A
   background that is different every launch feels unreliable in a
   way nobody can quite name. */
function paintOne(c) {
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;

  /* Measured, not assumed. There are two of these and they are
     different sizes: the room fills the viewport, the phone's screen
     fills a 390-wide frame in the middle of it. Sizing both from
     innerWidth would stretch the second one. */
  const box = c.getBoundingClientRect();
  const d = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(Math.round(box.width), 1);
  const h = Math.max(Math.round(box.height), 1);

  c.width = w * d;
  c.height = h * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);

  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#080c26");
  g.addColorStop(1, "#101940");
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  /* MUCH QUIETER THAN THE REFERENCE, and the reason is what sits on
     top. The demo's wallpaper is the subject — five saturated blobs
     at 40% are the thing you are looking at. Here it is a GROUND for
     glass to bend, under white body text that has to stay readable
     on every part of it. Turned up, it became a colour field with a
     diet plan lost somewhere in it.

     Four blobs, not six, at roughly half the alpha, and the two
     brightest kept away from the top where the text is densest. */
  const blobs = [
    [0.14, 0.06, 0.52, "#4d7cff", "3a"],
    [0.90, 0.26, 0.44, "#7a5cff", "34"],
    [0.20, 0.72, 0.50, "#1f9fd0", "30"],
    [0.86, 0.92, 0.46, "#3affd0", "22"],
  ];

  ctx.globalCompositeOperation = "lighter";
  for (const [bx, by, br, col, alpha] of blobs) {
    const px = bx * w;
    const py = by * h;
    const rad = br * Math.max(w, h);
    const rg = ctx.createRadialGradient(px, py, 0, px, py, rad);
    rg.addColorStop(0, col + alpha);
    rg.addColorStop(1, col + "00");
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, 6.2832);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Both of them: the room behind the device, and the device's own
    screen. On a phone the second is the only one anybody sees. */
function paintWall() {
  paintOne(document.getElementById("wall"));
  paintOne(document.getElementById("screenWall"));
}

/* Debounced: rotating a phone fires resize repeatedly, and each
   paint is four radial gradients across the whole surface. */
let wallTimer = null;
addEventListener("resize", () => {
  clearTimeout(wallTimer);
  wallTimer = setTimeout(paintWall, 150);
});

/* ---- the token --------------------------------------------------- */

function token() {
  const fromUrl = location.pathname.replace(/^\/me\/?/, "").replace(/\/+$/, "");
  if (fromUrl.length >= 16) {
    try { localStorage.setItem(KEY_TOKEN, fromUrl); } catch { /* private mode */ }
    /* Out of the address bar, out of a screenshot, and out of any
       Referer that leaves this page. replaceState leaves no history
       entry, so Back does not walk into it again. */
    history.replaceState(null, "", "/me/");
    return fromUrl;
  }
  try { return localStorage.getItem(KEY_TOKEN) || ""; } catch { return ""; }
}

const TOKEN = token();
const api = (path) => `/api/programme${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(TOKEN)}`;

/* ---- the outbox --------------------------------------------------
   Every write goes in here first. It survives a reload, a crash and
   a phone going flat, which a request in flight does not. */

const readQueue = () => {
  try { return JSON.parse(localStorage.getItem(KEY_QUEUE) || "[]"); } catch { return []; }
};
const writeQueue = (q) => {
  try { localStorage.setItem(KEY_QUEUE, JSON.stringify(q.slice(-200))); } catch { /* full */ }
};

function enqueue(entry) {
  const q = readQueue();
  q.push({ ...entry, at: Date.now() });
  writeQueue(q);
  paintSync();
  drain();
}

/* itemId|date -> the check-in row it produced. Filled as the queue
   drains, so a photograph can be attached to the tick that was made
   a moment before it. */
const checkinIds = new Map();

let draining = false;

async function drain() {
  if (draining || !navigator.onLine) return;
  draining = true;
  try {
    let q = readQueue();
    while (q.length) {
      const entry = q[0];
      let res;
      try {
        res = await fetch(api(entry.path), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry.body),
        });
      } catch {
        break; // still offline; keep everything and try later
      }
      /* A refusal is not a retry. A 400 means the server will never
         accept this row — a date out of range, a row that is not
         theirs — and leaving it at the head of the queue would block
         every tick behind it forever. */
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        /* The check-in's own id, kept so a photograph taken straight
           after a tap knows what to attach itself to. */
        if (res.ok && entry.path === "/checkin") {
          const made = await res.json().catch(() => ({}));
          if (made.checkinId) {
            checkinIds.set(`${entry.body.itemId}|${entry.body.onDate}`, made.checkinId);
          }
        }
        /* A note stops saying "sending" once it has actually gone.
           Matched on the text because that is what the queue carries
           — and two identical notes on one day are indistinguishable
           anyway, which is the correct outcome: both arrived. */
        if (entry.path === "/note") {
          const mine = notesSent.find(
            (n) => n.pending && n.date === entry.body.onDate && n.body === entry.body.body
          );
          if (mine) delete mine.pending;
          paintNotes();
        }
        q.shift();
        writeQueue(q);
        q = readQueue();
        continue;
      }
      break; // 5xx — the server is unwell, try again later
    }
  } finally {
    draining = false;
    paintSync();
  }
}

async function paintSync() {
  const el = $("[data-sync]");
  const n = readQueue().length + (await photos.pending());
  el.hidden = n === 0;
  el.textContent = navigator.onLine ? `saving ${n}…` : `${n} waiting for signal`;
  el.dataset.state = navigator.onLine ? "sending" : "offline";
}

addEventListener("online", () => { paintSync(); drain(); photos.drain(api).then(paintSync); });
addEventListener("offline", paintSync);

/* ---- days --------------------------------------------------------
   THIRTY, newest first, so the whole programme is on one strip and
   nothing is behind a date picker.

   BUT ONLY TODAY CAN BE ANSWERED. A check-in is a record of what
   somebody did today; let them fill in last Tuesday and it stops
   being a record and becomes a memory test. A day that was missed
   stays missed — and stays READABLE, which is why every past day
   is still reachable in the calendar and simply cannot be typed
   into.

   The rule itself lives in Go. This only greys the right dates; a
   modified page still cannot get a yesterday past the server. */

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let chosen = iso(new Date());
let items = [];
let marks = new Map();   // `${itemId}|${date}` -> state
let notesSent = [];      // { date, body, pending? } — newest first

/* ============================================================
   THE CALENDAR
   ------------------------------------------------------------
   A month grid, in two stages, following Apple's own date picker:
   COMPACT is a field showing the chosen date; tapping it reveals
   the INLINE month. Collapsed by default, because nine opens in
   ten are "tick today" and a calendar sitting above the rows
   pushes the actual work below the fold.

   WHY IT REPLACED THE STRIP. Thirty chips was a number, not a
   design: four fit on a phone, and reaching the 3rd meant dragging
   past twenty-six days nobody wanted. A month answers "what was
   the 3rd like" in one look. It also stops being wrong the day a
   programme runs longer than thirty days.

   THE GRID IS ALWAYS SIX ROWS. A calendar that is five rows in
   February and six in March jumps the page under the thumb every
   time somebody pages through it, and the empty row costs nothing.
   ============================================================ */

let calMonth = null;      // first of the month on screen
let calOpen = false;

/* THE PLAN'S OWN WINDOW, and the calendar shows exactly this.

   It used to draw the last thirty days, which is a different thing:
   it drifts forward daily, it never ends, and it cannot answer "how
   far through am I" — the question somebody on a ninety-day
   programme asks every week. A programme is a course of treatment
   with a beginning and an end, so the calendar has both. */
let startedOn = null;
let endsOn = null;
let lengthDays = 0;

const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

/** Is this day part of the plan at all? */
const inPlan = (day) =>
  (!startedOn || day >= startedOn) && (!endsOn || day <= endsOn);

/** Can it be opened? Inside the plan, and not in the future.

    A day later in the programme is drawn and is not tappable — it
    is part of the plan, it just has not happened. That is the whole
    reason the end date is on screen: seeing the 14th of September
    sitting there is what makes ninety days feel finite. */
function inRange(day) {
  if (day > iso(new Date())) return false;
  return inPlan(day);
}

/** Only today can be answered. Compared as a date string rather than
    by subtracting timestamps, so a daylight-saving hour cannot make
    "today" arithmetic come out at 0.96 of a day. */
const isOpen = (day) => day === iso(new Date());

/** The weekday header, in the reader's own week order.

    Built from a real week rather than a hard-coded list: a Sunday
    start is an American convention, and this app is used in India
    and the UK. Intl gives the locale's first day, and the letters
    come out of the locale's own calendar. */
function paintDow() {
  const host = $("[data-cal-dow]");
  if (!host || host.childElementCount) return;

  const first = weekStart();
  for (let i = 0; i < 7; i++) {
    const d = new Date(2024, 0, 7 + first + i);   // 7 Jan 2024 was a Sunday
    const s = document.createElement("span");
    s.textContent = d.toLocaleDateString(undefined, { weekday: "narrow" });
    host.append(s);
  }
}

/** Which weekday the locale's week starts on, as 0=Sunday. */
function weekStart() {
  try {
    const loc = new Intl.Locale(navigator.language);
    // Chrome and Safari disagree about where this lives; both or neither.
    const info = loc.getWeekInfo?.() || loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;   // Intl is 1=Mon…7=Sun
  } catch { /* fall through */ }
  return 1;   // Monday, which is right for both places this is used
}

function paintCal() {
  const grid = $("[data-cal-grid]");
  const label = $("[data-cal-month]");
  if (!grid || !calMonth) return;

  paintDow();

  label.textContent = calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const today = iso(new Date());
  const first = weekStart();

  /* Back up to the start of the week the 1st falls in, so the month
     lands under the right weekday columns. */
  const lead = (calMonth.getDay() - first + 7) % 7;
  const from = new Date(calMonth);
  from.setDate(1 - lead);

  grid.replaceChildren();

  for (let i = 0; i < 42; i++) {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    const day = iso(d);

    const b = document.createElement("button");
    b.type = "button";
    b.className = "cal-day";
    b.dataset.day = day;
    b.setAttribute("role", "gridcell");

    /* Days spilling in from either side are shown, not blanked: a
       grid with holes in it reads as broken, and seeing that the
       1st is a Thursday is half of why a calendar is a calendar. */
    b.dataset.out = String(!sameMonth(d, calMonth));

    /* Inside the plan but not yet reached. Drawn differently from a
       day outside it altogether: one is "not yet", the other is
       "not part of this", and they are not the same fact. */
    b.dataset.ahead = String(sameMonth(d, calMonth) && inPlan(day) && day > iso(new Date()));

    const usable = inRange(day) && sameMonth(d, calMonth);
    b.disabled = !usable;
    b.dataset.today = String(day === today);
    b.setAttribute("aria-selected", String(day === chosen));
    if (day === chosen) b.dataset.on = "true";

    const n = document.createElement("span");
    n.className = "cal-n";
    n.textContent = d.getDate();
    b.append(n);

    /* A dot under a day something was reported on. This is what
       turns a date picker into a picture of the month — and it is
       the one thing the old strip did that had to survive. */
    if (usable && [...marks.keys()].some((k) => k.endsWith("|" + day))) {
      const dot = document.createElement("i");
      dot.className = "cal-dot";
      b.append(dot);
    }

    b.setAttribute("aria-label", d.toLocaleDateString(undefined, {
      weekday: "long", day: "numeric", month: "long",
    }));

    grid.append(b);
  }

  /* Nothing before the programme, nothing after today. A chevron
     that pages into an empty month is a control that lies about
     there being something there. */
  const back = $('[data-cal-step="-1"]');
  const fwd = $('[data-cal-step="1"]');
  if (back) {
    back.disabled = !!startedOn &&
      calMonth <= monthStart(new Date(startedOn + "T12:00:00"));
  }
  /* Forward to the end of the PLAN, not to today. A ninety-day
     programme should let them look at the month it finishes in. */
  if (fwd) {
    fwd.disabled = !!endsOn &&
      calMonth >= monthStart(new Date(endsOn + "T12:00:00"));
  }
}

/** How far through the programme they are, in plain words.

    Under the calendar rather than in it, because it is a fact about
    the whole plan and not about the month on screen. */
function paintSpan() {
  const el = $("[data-span]");
  if (!el) return;
  if (!startedOn || !endsOn || !lengthDays) { el.textContent = ""; return; }

  const day = (a, b) =>
    Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);

  const today = iso(new Date());
  const done = Math.min(lengthDays, Math.max(0, day(startedOn, today) + 1));
  const end = new Date(endsOn + "T12:00:00")
    .toLocaleDateString(undefined, { day: "numeric", month: "long" });

  el.textContent = today > endsOn
    ? `${lengthDays}-day plan, finished ${end}`
    : `Day ${done} of ${lengthDays} · ends ${end}`;
}

/** The compact field: what it says when the calendar is shut. */
function paintCalField() {
  const label = $("[data-cal-label]");
  if (!label) return;
  const d = new Date(chosen + "T12:00:00");
  label.textContent = isOpen(chosen)
    ? "Today"
    : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function paintDays() {
  calMonth = calMonth || monthStart(new Date(chosen + "T12:00:00"));
  paintCal();
  paintCalField();
  paintSpan();
  paintHero();
}

/** The date, the big numeral, and whose day it is. Follows the
    chosen day rather than the clock — picking Friday should move the
    hero to Friday, or the two disagree on one screen. */
function paintHero() {
  const d = new Date(chosen + "T12:00:00");
  /* Built rather than formatted. Asking toLocaleDateString for a
     weekday and a month without a day gives "August Saturday" in
     en-US — the parts in the locale's order for a date that has no
     number in it, which is not a sentence anybody writes. The
     number is the hero underneath, so the line above it is two
     words and they go in this order. */
  $("[data-today]").textContent =
    d.toLocaleDateString(undefined, { weekday: "long" }) +
    ", " +
    d.toLocaleDateString(undefined, { month: "long" });

  const n = $("[data-hero-n]");
  if (n) n.textContent = d.getDate();

  paintProgress();

  /* The way back. Hidden on today, because a control that does
     nothing on the screen you are usually looking at is a control
     you stop seeing. */
  const back = $("[data-back-today]");
  if (back) back.hidden = isOpen(chosen);
}

/** How far through the day they are.

    A count and a bar, saying the same thing twice on purpose: the
    number is what they read, the bar is what they see without
    reading. It answers the one question a daily app has to answer at
    a glance — am I finished — which otherwise costs them a scan of
    seven rows.

    NO CELEBRATION AT SEVEN OF SEVEN. This is a clinical record, and
    a day somebody honestly marked four out of seven is worth exactly
    as much to her as a full one. An app that cheers for green ticks
    teaches people to tick green. */
function paintProgress() {
  const line = $("[data-done]");
  const wrap = $("[data-bar-wrap]");
  const bar = $("[data-bar]");
  if (!line || !wrap || !bar) return;

  const answered = items.filter((it) => marks.has(`${it.id}|${chosen}`)).length;
  const total = items.length;

  if (!total) { line.textContent = ""; wrap.hidden = true; return; }

  wrap.hidden = false;
  bar.style.width = `${Math.round((answered / total) * 100)}%`;
  bar.dataset.full = String(answered === total);

  line.textContent = answered === total
    ? `All ${total} answered`
    : `${answered} of ${total} answered`;
}

/* ---- the list ---------------------------------------------------- */

const STATE_LABEL = { done: "Done", part: "Some", skip: "No" };

/* Which rows get a camera. Food, and nothing else.
   `meal` is the only kind in crm.plan_items that is food today —
   see migration 0022 for the full set. If macros become their own
   kind of row rather than something read off the meal, this is one
   of three places that has to learn the word: the CHECK constraint,
   the assistant's prompt, and here. */
const PHOTO_KINDS = new Set(["meal"]);

function paintList() {
  const host = $("[data-list]");
  host.replaceChildren();

  const shut = $("[data-shut]");
  if (shut) shut.hidden = isOpen(chosen);

  if (!items.length) {
    const p = document.createElement("p");
    p.className = "quiet";
    p.textContent = "There is nothing on your plan yet.";
    host.append(p);
    return;
  }

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.item = it.id;

    const main = document.createElement("div");
    main.className = "row-main";

    const label = document.createElement("p");
    label.className = "row-label";
    label.textContent = it.label;

    const sub = document.createElement("p");
    sub.className = "row-sub";
    const bits = [];
    if (it.quantity !== null && it.quantity !== undefined) {
      bits.push(`${it.quantity}${it.unit ? " " + it.unit : ""}`);
    } else if (it.unit) bits.push(it.unit);
    if (it.schedule) bits.push(it.schedule);
    sub.textContent = bits.join(" · ");
    if (!bits.length) sub.hidden = true;

    main.append(label, sub);

    const acts = document.createElement("div");
    acts.className = "row-acts";
    const now = marks.get(`${it.id}|${chosen}`) || "";

    const open = isOpen(chosen);
    for (const state of ["done", "part", "skip"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tick";
      b.dataset.state = state;
      b.dataset.on = String(now === state);
      b.setAttribute("aria-pressed", String(now === state));
      /* Disabled rather than hidden: what they answered three weeks
         ago is worth seeing, it is only no longer worth changing. */
      b.disabled = !open;
      b.textContent = STATE_LABEL[state];
      acts.append(b);
    }

    /* A CAMERA ONLY WHERE A PHOTOGRAPH IS EVIDENCE — which is food.
       A picture of a walk, of eight hours' sleep or of a tablet in a
       palm tells her nothing she cannot read off the tick, and three
       useless buttons a day is how a feature gets ignored.

       One set, in one place: adding a kind later is this line. */
    if (PHOTO_KINDS.has(it.kind)) {
      const shot = document.createElement("label");
      shot.className = "shot";
      shot.hidden = !open;

      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      /* Opens the camera directly on a phone rather than the photo
         library. They are standing in front of the food. */
      input.capture = "environment";
      input.dataset.shotFor = it.id;

      const face = document.createElement("span");
      face.className = "shot-face";
      face.textContent = "Photo";

      shot.append(input, face);
      acts.append(shot);
    }

    row.append(main, acts);
    row.dataset.state = now;

    const said = document.createElement("p");
    said.className = "shot-said";
    said.dataset.shotSaid = it.id;
    said.hidden = true;
    row.append(said);

    host.append(row);
  }
}

/** A tap. Painted immediately, queued for the network — the whole
    reason this feels usable on bad signal. */
function tick(itemId, state) {
  /* Belt and braces. The buttons are disabled on a closed day, but a
     disabled button is a browser's promise and this writes into a
     clinical record — so the check is made again on the way out. The
     server refuses it a third time. */
  if (!isOpen(chosen)) return;

  const key = `${itemId}|${chosen}`;
  /* Tapping the same answer again clears it. There is no undo to
     find because the answer itself is the undo. */
  if (marks.get(key) === state) marks.delete(key);
  else marks.set(key, state);

  paintList();
  paintProgress();
  enqueue({
    path: "/checkin",
    body: { itemId, onDate: chosen, state: marks.get(key) || state },
  });
}

/* ---- anything else ------------------------------------------------
   The note goes through the same outbox as a tick, so a thought typed
   in a basement is not lost — which matters more here than for a
   tick, because a tick can be re-tapped from memory and a sentence
   cannot be retyped from one. */

/** THE WHOLE CONVERSATION, ON ITS OWN SCREEN.

    This used to be the day's conversation, drawn inside the note box
    and filtered to whichever date was selected. That was the single
    worst thing about the old layout: her reply to a message sent on
    the 3rd could only be found by navigating back to the 3rd, so
    unless the client happened to return to exactly the right day they
    never learned she had answered. A reply you have to hunt for is a
    reply nobody reads.

    Oldest first, because it is a conversation and one read bottom-up
    is a puzzle. Grouped under the day it belongs to, so a note about
    Tuesday still reads as being about Tuesday now that they are all
    on one page.

    Drawn with textContent throughout: every line here was typed by a
    person, and it is going onto a screen.

    Her replies are marked by who wrote them rather than by which side
    of the screen they sit on. Chat bubbles would make this look like
    a messaging app, which would promise a speed of answer nobody has
    agreed to — the line at the top of the page says she reads these
    between sessions, and the layout has to say the same. */
function paintNotes() {
  const host = $("[data-thread]");
  if (!host) return;

  const all = notesSent
    .slice()
    .sort((a, b) =>
      String(a.date || "").localeCompare(String(b.date || "")) ||
      String(a.at || "").localeCompare(String(b.at || ""))
    );

  host.replaceChildren();
  const none = $("[data-thread-none]");
  if (none) none.hidden = all.length > 0;

  let lastDay = null;
  for (const n of all) {
    if (n.date !== lastDay) {
      lastDay = n.date;
      const h = document.createElement("p");
      h.className = "thread-day";
      const d = new Date(n.date + "T12:00:00");
      h.textContent = isOpen(n.date)
        ? "Today"
        : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
      host.append(h);
    }

    const p = document.createElement("p");
    p.className = "note-one";
    p.dataset.from = n.author === "practitioner" ? "her" : "them";
    if (n.pending) p.dataset.pending = "true";

    if (n.author === "practitioner") {
      const who = document.createElement("span");
      who.className = "note-who";
      who.textContent = "Khadija";
      p.append(who);
    }

    p.append(document.createTextNode(n.body));
    host.append(p);
  }

  paintJump();
  paintUnread();
}

/* ---- what Today says about the thread ------------------------------
   Today's note box no longer shows what was said — that is a whole
   screen now. What it owes the client is the knowledge that the
   screen is worth opening, which is one line and a way through. */
function paintJump() {
  const btn = $("[data-note-jump]");
  const label = $("[data-note-jump-l]");
  if (!btn || !label) return;

  const n = notesSent.length;
  if (!n) { btn.hidden = true; return; }

  const hers = notesSent.filter((x) => x.author === "practitioner").length;
  btn.hidden = false;
  label.textContent = hers
    ? `Khadija has written back${hers > 1 ? ` (${hers})` : ""}`
    : `${n === 1 ? "1 message" : `${n} messages`} sent`;
}

/* ---- the dot on the Messages tab -----------------------------------
   HER REPLY IS THE ONLY THING THAT ARRIVES ON ITS OWN. Everything
   else on this screen got there because the client put it there, so
   this is the only thing that can be news — and the only thing worth
   a dot.

   "Read" is remembered on the phone, not on the server: marking it
   read is not a clinical fact, it costs a round trip, and getting it
   wrong in either direction is harmless. The high-water mark is the
   timestamp of the newest reply seen on the Messages tab. */
const KEY_SEEN = "myf-programme-seen";

const lastHers = () =>
  notesSent
    .filter((n) => n.author === "practitioner")
    .map((n) => String(n.at || n.date || ""))
    .sort()
    .pop() || "";

function paintUnread() {
  const dot = $("[data-unread]");
  if (!dot) return;
  let seen = "";
  try { seen = localStorage.getItem(KEY_SEEN) || ""; } catch { /* private mode */ }
  const newest = lastHers();
  dot.hidden = !newest || newest <= seen;
}

function markRead() {
  const newest = lastHers();
  if (!newest) return;
  try { localStorage.setItem(KEY_SEEN, newest); } catch { /* private mode */ }
  paintUnread();
}

function sendNote() {
  const box = $("[data-note]");
  const said = $("[data-note-said]");
  const body = (box?.value || "").trim();
  if (!body) return;

  /* Painted as sent before the network is asked, like a tick. The
     entry carries `pending` so the list can show it as on its way
     rather than pretending it has arrived. */
  notesSent.push({
    date: chosen, body, author: "client", at: new Date().toISOString(), pending: true,
  });
  box.value = "";
  $("[data-note-send]").disabled = true;
  paintNotes();

  said.hidden = false;
  said.textContent = navigator.onLine
    ? "Sent. She will see it before your next session."
    : "Saved. It will go when you have signal.";

  enqueue({ path: "/note", body: { onDate: chosen, body } });
  paintSync();
}

/* Sizes change and canvases do not reflow — a rotated phone leaves a
   chart drawn for the old width stretched across the new one. Only
   the visible page is repainted, because the hidden ones have no
   width to measure and will be painted when they are opened. */
addEventListener("resize", () => {
  if (page === "progress") paintProgressTab();
});

/* ---- wiring ------------------------------------------------------ */

/** Open or close the month. Kept in one function so the button's
    aria-expanded and the panel's hidden can never disagree — which
    is the usual way a disclosure ends up lying to a screen reader. */
function setCal(open) {
  calOpen = open;
  const sheet = $("[data-cal-sheet]");
  const btn = $("[data-cal-toggle]");
  if (!sheet || !btn) return;
  sheet.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  if (open) paintCal();
}

/** Move to a day, and put it where they can see it.

    The strip is thirty chips wide and only four fit on a phone, so a
    day changed by any route other than tapping it — "back to today",
    the app opening — has to be scrolled to, or the selection is
    somewhere off the left edge and the screen looks unchanged.

    `smooth`, and `block: "nearest"` so it never drags the page
    vertically to bring a horizontal strip into view. */
function pick(day, { shut = true } = {}) {
  chosen = day;

  /* The month follows the choice. Picking a day is also how the
     calendar is told which month it is looking at — otherwise
     "back to today" from March leaves the grid on March with
     nothing selected in it. */
  calMonth = monthStart(new Date(chosen + "T12:00:00"));
  paintCal();
  paintCalField();

  /* CHOOSING CLOSES IT. The calendar was opened to answer one
     question; leaving it up afterwards means the rows she came for
     are still below the fold. Apple's own picker does the same. */
  if (shut) setCal(false);

  /* The box follows the day. Text typed about today must not be sent
     as a note about last Thursday because they tapped a chip while
     thinking about it. */
  const box = $("[data-note]");
  if (box) box.value = "";
  $("[data-note-send]").disabled = true;
  $("[data-note-said]").hidden = true;

  /* Only today can be written about — the same rule as a tick, and
     the box goes away rather than being refused after typing. */
  const noteBox = $("[data-note-box]");
  if (noteBox) noteBox.dataset.shut = String(!isOpen(chosen));

  paintHero();
  paintList();
  /* The grid highlights whichever day Today is showing, so switching
     tabs never loses your place. Cheap, and only if that page has
     been built. */
  if ($("[data-grid-days]")?.childElementCount) paintGrid();
}

/* Send is dead until there is something to send: a button that can be
   pressed to no effect teaches people the app is unreliable. */
document.addEventListener("input", (e) => {
  if (!e.target.matches("[data-note]")) return;
  $("[data-note-send]").disabled = !e.target.value.trim();
  $("[data-note-said]").hidden = true;
});

/* Ctrl/Cmd+Enter sends, for the people who expect it to. Enter alone
   makes a new line, because this is a paragraph and not a chat. */
document.addEventListener("keydown", (e) => {
  if (e.target.matches("[data-note]") && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendNote();
  }
});

document.addEventListener("click", (e) => {
  /* FIRST, because everything else on the page is inside a tab and a
     tab button must never be mistaken for one of them. */
  const nav = e.target.closest("[data-goto]");
  if (nav) return go(nav.dataset.goto);

  /* A square on Progress opens that day on Today — the two screens
     are the same record from two distances, and tapping the 3rd
     should take you to the 3rd rather than telling you to go and
     find it. */
  const square = e.target.closest(".grid-day");
  if (square) {
    pick(square.dataset.day);
    return go("today");
  }

  if (e.target.closest("[data-cal-toggle]")) return setCal(!calOpen);

  const step = e.target.closest("[data-cal-step]");
  if (step) {
    calMonth = new Date(
      calMonth.getFullYear(), calMonth.getMonth() + Number(step.dataset.calStep), 1
    );
    return paintCal();
  }

  const day = e.target.closest("[data-day]");
  if (day) return pick(day.dataset.day);

  const back = e.target.closest("[data-back-today]");
  if (back) return pick(iso(new Date()));

  if (e.target.closest("[data-note-send]")) return sendNote();
  if (e.target.closest("[data-ask-send]")) return askForReview();

  const t = e.target.closest(".tick");
  if (t) {
    const row = t.closest("[data-item]");
    if (row) tick(row.dataset.item, t.dataset.state);
    return;
  }

  if (e.target.closest("[data-weigh-save]")) {
    const box = $("[data-kg]");
    const kg = Number(box.value);
    const said = $("[data-weigh-said]");
    if (!Number.isFinite(kg) || kg < 20 || kg > 400) {
      said.hidden = false;
      said.textContent = "That does not look like a weight.";
      said.dataset.tone = "bad";
      return;
    }
    enqueue({ path: "/weight", body: { kg } });
    box.value = "";
    said.hidden = false;
    said.dataset.tone = "good";
    said.textContent = `${kg} kg saved.`;

    /* THE LINE MOVES NOW, not on the next launch. Held locally the
       same way a tick is: the queue will get it to the server, and
       making somebody reload to see the number they just typed is
       exactly what made this box feel like a hole.

       Today's reading replaces today's reading rather than stacking,
       so correcting a typo does not put two dots on one day. */
    const day = iso(new Date());
    weights = weights.filter((x) => x.date !== day).concat([{ date: day, kg }]);
    paintWeights();
  }
});

/* A photograph. Needs a check-in to hang off, so if the row has not
   been answered yet this answers it first — somebody who has just
   photographed their breakfast has plainly eaten it, and making them
   press Done as well would be asking them to say the same thing
   twice. */
document.addEventListener("change", async (e) => {
  const input = e.target.closest("[data-shot-for]");
  if (!input || !input.files || !input.files[0]) return;

  const itemId = input.dataset.shotFor;
  const said = document.querySelector(`[data-shot-said="${CSS.escape(itemId)}"]`);
  const file = input.files[0];
  input.value = "";

  const show = (text, tone) => {
    if (!said) return;
    said.hidden = false;
    said.textContent = text;
    said.dataset.tone = tone;
  };

  show("Sending…", "");

  if (!marks.get(`${itemId}|${chosen}`)) tick(itemId, "done");

  /* The tick has to have reached the server before a photograph can
     be attached to it, so the queue is drained and then asked for the
     id it produced. */
  await drain();
  const checkinId = checkinIds.get(`${itemId}|${chosen}`);
  if (!checkinId) {
    show("Saved. The photo will follow when there is signal.", "");
    return;
  }

  const out = await photos.send(api, file, checkinId);
  if (!out.ok) return show(out.why || "That photo did not send.", "bad");
  show(out.sent ? `Photo sent (${Math.round(out.bytes / 1024)} KB).` : "Photo waiting for signal.", "good");
  paintSync();
});

/* ============================================================
   ASKING TO BE SEEN AGAIN
   ------------------------------------------------------------
   The only thing this app does that lands on HER page rather
   than in the client's own record, and it is written to be
   honest about that: it asks, it does not book. She confirms
   every session herself, and a button promising otherwise would
   be promising a diary the client cannot see.

   NOT QUEUED LIKE A TICK. The outbox exists so a tap in a
   basement is not lost, and that is right for a check-in — the
   client knows what they did and the record catches up. A
   request is different: "she has it" is the whole content of
   the message, and saying that while it sits unsent on a phone
   would be the one lie this app tells. So it needs the network,
   and says so plainly when there is none.
   ============================================================ */

let review = null;

function paintAsk() {
  const box = $("[data-ask]");
  if (!box) return;

  const form = $("[data-ask-form]");
  const said = $("[data-ask-said]");

  if (!review) {
    form.hidden = false;
    said.hidden = true;
    return;
  }

  /* ASKED, OR BOOKED. Two different sentences, because they are
     two different states and "we have your request" after she has
     given you a Thursday is a screen that has stopped paying
     attention. */
  form.hidden = true;
  said.hidden = false;
  said.replaceChildren();

  const line = document.createElement("p");
  line.className = "ask-state";

  if (review.scheduled && review.startAt) {
    const d = new Date(review.startAt);
    line.dataset.state = "booked";
    line.textContent =
      "Your next session is " +
      d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) +
      " at " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) +
      ".";
  } else {
    const asked = review.askedAt ? new Date(review.askedAt) : null;
    line.dataset.state = "asked";
    line.textContent = asked
      ? `You asked for a review on ${asked.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}. She will come back to you with a time.`
      : "You have asked for a review. She will come back to you with a time.";
  }

  said.append(line);
}

async function askForReview() {
  const btn = $("[data-ask-send]");
  const note = $("[data-ask-note]");
  if (!btn) return;

  if (!navigator.onLine) {
    btn.textContent = "No signal — try again in a moment";
    setTimeout(() => { btn.textContent = "Ask for a review"; }, 3000);
    return;
  }

  btn.disabled = true;
  btn.textContent = "Sending…";

  try {
    const res = await fetch(api("/review"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: (note?.value || "").trim() }),
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.message || "that did not send");

    review = out.request;
    if (note) note.value = "";
    paintAsk();
  } catch {
    btn.disabled = false;
    btn.textContent = "That did not send — try again";
    setTimeout(() => { btn.textContent = "Ask for a review"; }, 3000);
  }
}

/* ============================================================
   THE TABS
   ------------------------------------------------------------
   Four destinations replacing one very long scroll.

   NOTHING IS UNMOUNTED. Switching hides a page and shows
   another; the canvas keeps its bitmap, the note box keeps its
   draft, and each page keeps its own scroll position because
   each page has its own scroller. That is most of the reason
   this feels like an app rather than a document.

   THE CANVASES ARE DRAWN ON ARRIVAL, not on boot. A canvas
   sized while its page is hidden has a client width of zero,
   which paints a 1px-wide chart that stays that way. Painting
   when the page becomes visible is the only reliable moment.
   ============================================================ */

const PAGES = ["today", "progress", "messages", "plan"];
let page = "today";

function go(name) {
  const i = PAGES.indexOf(name);
  if (i < 0) return;
  page = name;

  document.documentElement.style.setProperty("--tab-i", String(i));

  for (const el of $$("[data-page]")) el.hidden = el.dataset.page !== name;

  for (const b of $$(".tab")) {
    const on = b.dataset.goto === name;
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }

  /* Now that it has a width. */
  if (name === "progress") requestAnimationFrame(paintProgressTab);

  /* Arriving IS reading. There is no separate "mark as read", because
     an app that makes you dismiss a badge has invented a chore. */
  if (name === "messages") markRead();
}

/* ============================================================
   PROGRESS
   ------------------------------------------------------------
   Three measured things: how much of the plan has been
   answered, the weights they entered, and the course as a
   shape. Nothing here is scored, graded or ranked — none of
   that exists in the database, and a number nobody computed is
   one that cannot be trusted the one time it matters.
   ============================================================ */

let weights = [];   // { date, kg }, oldest first

const dayCount = (a, b) =>
  Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);

/** Every date in the plan, start to end, as YYYY-MM-DD. */
function planDays() {
  if (!startedOn || !endsOn) return [];
  const out = [];
  const n = dayCount(startedOn, endsOn);
  for (let i = 0; i <= n && i < 400; i++) {
    const d = new Date(startedOn + "T12:00:00");
    d.setDate(d.getDate() + i);
    out.push(iso(d));
  }
  return out;
}

/** How many of a day's rows were answered. */
const answeredOn = (day) => items.filter((it) => marks.has(`${it.id}|${day}`)).length;

function paintProgressTab() {
  paintRing();
  paintWeights();
  paintGrid();
}

/* ---- the ring ------------------------------------------------------
   ANSWERED, NOT ACHIEVED. A day honestly marked No is a day she can
   act on, and it fills this ring exactly as much as a Done. An app
   that only rewards green teaches people to tick green, and then the
   record it produces is worthless to the one person reading it. The
   label says "answered" for that reason and must keep saying it. */
function paintRing() {
  const cv = $("[data-ring]");
  const num = $("[data-ring-n]");
  const why = $("[data-ring-why]");
  if (!cv || !num) return;

  const today = iso(new Date());
  const days = planDays().filter((d) => d <= today);
  const slots = days.length * items.length;
  const filled = days.reduce((n, d) => n + answeredOn(d), 0);
  const frac = slots ? filled / slots : 0;

  num.textContent = slots ? `${Math.round(frac * 100)}%` : "—";

  if (why) {
    why.textContent = !slots
      ? "Your first day has not started yet."
      : `${filled} of ${slots} things answered across ${days.length === 1 ? "1 day" : `${days.length} days`} so far.`;
  }

  drawRing(cv, frac);
}

function fit(cv) {
  const w = cv.clientWidth || cv.width;
  const h = cv.clientHeight || cv.height;
  if (!w || !h) return null;
  const d = Math.min(devicePixelRatio || 1, 2);
  cv.width = Math.round(w * d);
  cv.height = Math.round(h * d);
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawRing(cv, frac) {
  const got = fit(cv);
  if (!got) return;
  const { ctx, w, h } = got;

  const lw = 12;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - lw / 2 - 2;

  ctx.lineWidth = lw;
  ctx.lineCap = "round";

  ctx.strokeStyle = "rgba(255,255,255,.1)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  if (frac <= 0.001) return;

  /* One hue, light to bright along its own length. A second colour
     would read as a second series, and there is only one thing being
     measured here. */
  const start = -Math.PI / 2;
  const end = start + Math.PI * 2 * Math.min(frac, 1);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "rgba(143,224,166,.55)");
  g.addColorStop(1, "#8fe0a6");
  ctx.strokeStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end);
  ctx.stroke();
}

/* ---- the weight line -----------------------------------------------
   Their own handwriting, read back. The box used to write into a
   place that never showed anything, which is most of why it felt like
   it went nowhere. */
function paintWeights() {
  const now = $("[data-weight-now]");
  const kgEl = $("[data-weight-kg]");
  const when = $("[data-weight-when]");
  const move = $("[data-weight-move]");
  const wrap = $("[data-chart-wrap]");
  const none = $("[data-weight-none]");
  const alt = $("[data-chart-alt]");

  if (none) none.hidden = weights.length > 0;
  if (now) now.hidden = weights.length === 0;
  /* One point is a reading, not a line. Drawing an axis through a
     single dot invites somebody to read a trend that does not exist
     yet. */
  if (wrap) wrap.hidden = weights.length < 2;
  if (move) move.hidden = weights.length < 2;

  if (!weights.length) {
    if (alt) alt.textContent = "";
    return;
  }

  const last = weights[weights.length - 1];

  if (kgEl) {
    kgEl.replaceChildren();
    kgEl.append(document.createTextNode(last.kg.toFixed(1)));
    const u = document.createElement("small");
    u.textContent = " kg";
    kgEl.append(u);
  }

  if (when) {
    const d = new Date(last.date + "T12:00:00");
    when.textContent = isOpen(last.date)
      ? "today"
      : d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
  }

  if (move && weights.length > 1) {
    const d = last.kg - weights[0].kg;
    /* Rounded before it is compared to zero, so a 40-gram drift does
       not get announced as a direction. */
    const shown = Math.round(d * 10) / 10;
    move.dataset.dir = shown < 0 ? "down" : shown > 0 ? "up" : "flat";
    move.textContent = shown === 0
      ? "no change"
      : `${shown > 0 ? "+" : "−"}${Math.abs(shown).toFixed(1)} kg`;
  }

  if (alt) {
    alt.textContent = weights.length < 2
      ? ""
      : `Weight from ${weights[0].kg.toFixed(1)} kg to ${last.kg.toFixed(1)} kg over ${weights.length} readings.`;
  }

  if (weights.length >= 2) drawChart($("[data-chart]"), weights);
}

function drawChart(cv, data) {
  if (!cv) return;
  const got = fit(cv);
  if (!got) return;
  const { ctx, w, h } = got;

  const padX = 8;
  const padT = 12;
  const padB = 10;

  const vals = data.map((d) => d.kg);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  /* A flat run would divide by zero and a nearly-flat one would be
     drawn as a mountain range. A minimum span of 2 kg keeps the
     amplitude honest: half a kilo across six weeks should LOOK like
     half a kilo. */
  const span = Math.max(hi - lo, 2);
  const mid = (hi + lo) / 2;
  lo = mid - span / 2;
  hi = mid + span / 2;

  const x = (i) => padX + (w - 2 * padX) * (data.length === 1 ? 0.5 : i / (data.length - 1));
  const y = (v) => padT + (h - padT - padB) * (1 - (v - lo) / (hi - lo));
  const pts = data.map((d, i) => [x(i), y(d.kg)]);

  /* A smooth path, and it is only smoothing between real points —
     no value is invented between two weigh-ins. */
  const path = (close) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const mx = (x0 + x1) / 2;
      ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
    }
    if (close) {
      ctx.lineTo(pts[pts.length - 1][0], h);
      ctx.lineTo(pts[0][0], h);
      ctx.closePath();
    }
  };

  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, "rgba(143,224,166,.26)");
  fill.addColorStop(1, "rgba(143,224,166,0)");
  path(true);
  ctx.fillStyle = fill;
  ctx.fill();

  path(false);
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#8fe0a6";
  ctx.stroke();

  /* The latest reading, emphasised. It is the one point on this chart
     anybody is looking for. */
  const [lx, ly] = pts[pts.length - 1];
  ctx.fillStyle = "#080c26";
  ctx.beginPath();
  ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#8fe0a6";
  ctx.stroke();
}

/* ---- the course as a shape -----------------------------------------
   One square per day. "Have I been keeping this up" is answered by
   the pattern long before any number is read. */
function paintGrid() {
  const host = $("[data-grid-days]");
  const tag = $("[data-span-tag]");
  if (!host) return;

  const today = iso(new Date());
  const days = planDays();

  if (tag) {
    const done = Math.min(lengthDays, Math.max(0, dayCount(startedOn, today) + 1));
    tag.textContent = startedOn && lengthDays
      ? (today > endsOn ? `${lengthDays} days, finished` : `day ${done} of ${lengthDays}`)
      : "";
  }

  host.replaceChildren();

  for (const day of days) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "grid-day";
    b.dataset.day = day;

    const ahead = day > today;
    b.dataset.ahead = String(ahead);
    b.disabled = ahead;
    b.dataset.today = String(day === today);
    if (day === chosen) b.dataset.on = "true";

    const n = items.length ? answeredOn(day) / items.length : 0;
    b.dataset.fill = String(ahead ? 0 : n === 0 ? 0 : Math.min(3, Math.ceil(n * 3)));

    const d = new Date(day + "T12:00:00");
    const said = d.toLocaleDateString(undefined, { day: "numeric", month: "long" });
    b.setAttribute("aria-label", ahead
      ? `${said}, not yet`
      : `${said}, ${answeredOn(day)} of ${items.length} answered`);

    host.append(b);
  }
}

/* ============================================================
   PLAN
   ------------------------------------------------------------
   What she prescribed, read-only, grouped by kind. A different
   question from "what did I do today" — and having the two on
   one page was most of what made the old scroll confusing.
   ============================================================ */

/* Her words for the database's words. `kind` is a CHECK constraint
   in migration 0022; nobody should ever read one of those off a
   screen. Anything unrecognised keeps its own name rather than being
   dropped — a row missing from the plan is worse than an odd
   heading. */
const KIND_SAID = {
  meal: "Meals",
  supplement: "Supplements",
  activity: "Movement",
  habit: "Habits",
  sleep: "Sleep",
  macro: "Macros",
};

const KIND_ORDER = ["meal", "macro", "supplement", "habit", "activity", "sleep"];

function paintPlanTab() {
  const host = $("[data-plan-groups]");
  const why = $("[data-plan-why]");
  if (!host) return;

  if (why) {
    why.textContent = startedOn && endsOn && lengthDays
      ? `${lengthDays} days, from ${new Date(startedOn + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long" })} to ${new Date(endsOn + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long" })}.`
      : "";
  }

  host.replaceChildren();

  if (!items.length) {
    const p = document.createElement("p");
    p.className = "quiet";
    p.textContent = "There is nothing on your plan yet.";
    host.append(p);
    return;
  }

  const seen = [...new Set(items.map((it) => it.kind))];
  const order = [
    ...KIND_ORDER.filter((k) => seen.includes(k)),
    ...seen.filter((k) => !KIND_ORDER.includes(k)),
  ];

  for (const kind of order) {
    const mine = items.filter((it) => it.kind === kind);
    if (!mine.length) continue;

    const h = document.createElement("p");
    h.className = "group-h";
    h.textContent = KIND_SAID[kind] || kind;

    const card = document.createElement("div");
    card.className = "card glass";

    for (const it of mine) {
      const row = document.createElement("div");
      row.className = "plan-row";

      const label = document.createElement("p");
      label.className = "row-label";
      label.textContent = it.label;

      const sub = document.createElement("p");
      sub.className = "row-sub";
      const bits = [];
      if (it.quantity !== null && it.quantity !== undefined) {
        bits.push(`${it.quantity}${it.unit ? " " + it.unit : ""}`);
      } else if (it.unit) bits.push(it.unit);
      if (it.schedule) bits.push(it.schedule);
      sub.textContent = bits.join(" · ");
      if (!bits.length) sub.hidden = true;

      row.append(label, sub);
      card.append(row);
    }

    const group = document.createElement("div");
    group.append(h, card);
    host.append(group);
  }
}

/* ---- a newer version of the app ------------------------------------ */

let reloadOffered = false;

/** Is it safe to reload right now?

    Three things say no, and each is somebody losing work: a
    half-written note, a queue that has not gone, and a photo still
    waiting for signal. The queue survives a reload in localStorage;
    a note in the box does not, because it is not a record until
    Send. */
function safeToReload() {
  if (($("[data-note]")?.value || "").trim()) return false;
  const tag = document.activeElement?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return false;
  try {
    if (JSON.parse(localStorage.getItem(KEY_QUEUE) || "[]").length) return false;
  } catch { /* an unreadable queue is not a reason to stay put */ }
  return true;
}

function offerReload() {
  if (reloadOffered) return;
  reloadOffered = true;

  if (safeToReload()) { location.reload(); return; }

  /* Nothing to dismiss, nothing blocking. It sits with the sync
     pill, which is already where "the app is doing something"
     lives — one place to look rather than two. */
  const el = $("[data-sync]");
  if (!el) return;
  el.hidden = false;
  el.dataset.state = "update";
  el.textContent = "New version — tap to load";
  el.onclick = () => location.reload();
}

/* ---- boot -------------------------------------------------------- */

function show(name) {
  for (const el of $$("[data-view]")) el.hidden = el.dataset.view !== name;
}

(async function open() {
  paintWall();
  if (!TOKEN || TOKEN.length < 16) return show("gone");

  let prog;
  try {
    const res = await fetch(api(""), { headers: { Accept: "application/json" } });
    prog = res.ok ? await res.json() : null;
  } catch {
    prog = null;
  }

  /* OFFLINE IS NOT GONE. If the network is down but this phone has
     opened the programme before, show what it had — an app that says
     "this link doesn't work" because a lift has no signal is an app
     that gets deleted. */
  if (!prog?.ok) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem("myf-programme-cache") || "null"); } catch { /* none */ }
    if (!cached) return show("gone");
    prog = cached;
  } else {
    try { localStorage.setItem("myf-programme-cache", JSON.stringify(prog)); } catch { /* full */ }
  }

  items = prog.items || [];

  /* WHOSE APP THIS IS. First line, before anything else is drawn:
     the link arrived in a message with no account behind it, so
     "is this mine" is the first question it has to answer.
     textContent, because a name is somebody's text. */
  $("[data-whose]").textContent = prog.firstName
    ? `${prog.firstName}'s programme`
    : "Your programme";
  $("[data-ref]").textContent = prog.ref || "";
  /* The window the calendar draws. Nothing before it started and
     nothing after it ends — a plan is a course of treatment, not a
     rolling month. */
  startedOn = prog.startedOn || null;
  endsOn = prog.endsOn || null;
  lengthDays = prog.lengthDays || 0;

  try {
    const res = await fetch(api("/days"), { headers: { Accept: "application/json" } });
    if (res.ok) {
      const { checkins } = await res.json();
      for (const c of checkins || []) marks.set(`${c.itemId}|${c.date}`, c.state);
    }
  } catch { /* the ticks they made on this phone are still queued */ }

  /* What they have already said. Failure is silent and the box still
     works — not being able to show old notes is no reason to stop
     somebody writing a new one. */
  try {
    const res = await fetch(api("/notes"), { headers: { Accept: "application/json" } });
    if (res.ok) notesSent = (await res.json()).notes || [];
  } catch { /* the box is what matters, not the history */ }

  /* WHETHER THEY HAVE ALREADY ASKED TO BE SEEN.
     Without this the button came back on every reload, so somebody
     who asked on Tuesday was invited to ask again on Wednesday.
     Go refuses to make a second request either way — but a screen
     that offers a button which quietly does nothing is worse than
     one that never offered it, because they will press it.

     Silent on failure: no answer means the form stays, and asking
     twice costs them nothing that Go does not already catch. */
  try {
    const res = await fetch(api("/review"), { headers: { Accept: "application/json" } });
    if (res.ok) review = (await res.json()).request || null;
  } catch { /* the form stays, which is the safe way to be wrong */ }

  /* THEIR OWN WEIGHTS, for the line on Progress. Read after the
     notes because it is the least urgent thing on the page: nobody
     opens this app in a kitchen to look at a chart. Silent on
     failure — the box still saves, and the card says there is
     nothing yet, which is indistinguishable from the truth on a
     first launch. */
  try {
    const res = await fetch(api("/weights"), { headers: { Accept: "application/json" } });
    if (res.ok) weights = (await res.json()).weights || [];
  } catch { /* the box works; the line can wait for signal */ }

  paintAsk();
  paintDays();
  paintPlanTab();
  /* Through `pick` rather than by painting directly, so everything
     that follows the chosen day — the hero, the rows, the grid —
     is drawn from one place. */
  pick(chosen);
  /* The thread and its two derived bits: the line on Today's note box
     and the dot on the Messages tab. Not day-filtered any more, so it
     is painted once here rather than on every pick. */
  paintNotes();
  paintSync();
  show("programme");

  /* THE TAB BAR STARTS ON TODAY, always. There is no "last screen you
     were on": the app is opened to tick today, three times a day, and
     resuming on Progress because that is where they last looked would
     be wrong nine times out of ten.

     After `show`, so the pages have a width when Progress is asked to
     paint its canvases. */
  go("today");
  drain();
  photos.drain(api).then(paintSync);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/programme-sw.js").catch(() => { /* fine without */ });

    /* ============================================================
       A NEW VERSION LANDED
       ------------------------------------------------------------
       The worker revalidates the shell on every request and says
       so when a file actually changed. Without this the new code
       would sit in the cache until the next cold start, which is
       how "it keeps showing the old design" happens even after the
       caching itself is fixed.

       IT DOES NOT RELOAD UNDER HER HANDS. A reload mid-sentence
       loses the sentence, and this app's one text box is the place
       somebody types something that mattered enough to write down.
       So: reload only when nothing is in flight and nothing is
       half-typed. Otherwise a quiet line she can tap when she is
       ready — the same grey as everything else, because a new
       stylesheet is not an emergency.
       ============================================================ */
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type !== "sw:updated") return;
      offerReload();
    });
  }
})();
