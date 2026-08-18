/* ============================================================
   ROWS — one renderer per kind of thing
   ------------------------------------------------------------
   Kept as separate functions rather than one clever generic
   renderer. These four look alike today and will not in a
   month: a request grows a reason for declining, a session
   grows a note, a message grows a retry count. Merging them now
   buys nothing and costs the ability to change one of them.

   Every row carries its own actions. Nothing here opens a
   detail page — that is the point of the layout.
   ============================================================ */

import { esc, MODE, fmtDay, fmtTime, hhmm, plural } from "./format.js";
import { contactLinks } from "./contact-links.js";

/** A slot somebody is holding, waiting on her.

    TWO KINDS ARRIVE HERE AND THEY ARE NOT THE SAME JOB.

    A stranger booked an hour through the front desk: there is a
    time, it is being held, and the question is yes or no.

    A client already on a programme asked to be seen again from
    their app: there is NO time, nothing is being held, and the
    question is when. She has met them, their plan is a tab away,
    and "Accept" would be accepting nothing.

    Rendering both the same way put `new Date(null)` through the
    formatter and printed "Thu, 1 Jan · 05:30 — held until Thu, 1
    Jan" on a request that had no time at all. */
export const request = (b) =>
  b.startAt ? bookedRequest(b) : reviewRequest(b);

const bookedRequest = (b) => `
  <div class="row is-waiting">
    <div class="row-main">
      <div class="row-top">
        <span class="who">${esc(b.name)}</span>
        <span class="tag ${esc(b.mode)}">${esc(MODE[b.mode] || b.mode)}</span>
        <span class="when">${fmtDay(b.startAt)} · ${fmtTime(b.startAt)}</span>
      </div>
      <p class="row-sub">
        ${esc(b.focusArea)}${
          b.holdExpiresAt
            ? ` — held until ${fmtDay(b.holdExpiresAt)} ${fmtTime(b.holdExpiresAt)}`
            : ""
        }
      </p>
    </div>
    <div class="row-acts">
      <button class="btn go" data-accept="${esc(b.id)}">Accept</button>
      <button class="btn warn" data-decline="${esc(b.id)}">Decline</button>
    </div>
  </div>`;

/** Somebody already on a plan, asking to be seen again. */
const reviewRequest = (b) => `
  <div class="row is-waiting is-review" data-review="${esc(b.id)}">
    <div class="row-main">
      <div class="row-top">
        <span class="who">${esc(b.name)}</span>
        <span class="tag review">Review</span>
        <span class="when">asked ${b.createdAt ? fmtDay(b.createdAt) : ""}</span>
      </div>
      <p class="row-sub">
        ${esc(b.focusArea)}${
          /* WHAT THEY WANT TO GO OVER, IN THEIR WORDS. Optional, and
             the reason she can answer this without opening anything
             else — which is the whole point of a row. */
          b.notes ? ` — “${esc(b.notes)}”` : " — no time yet"
        }
      </p>
      <div class="row-slots" data-slots hidden></div>
    </div>
    <div class="row-acts">
      <button class="btn go" data-offer="${esc(b.id)}">Offer a time</button>
      <button class="btn warn" data-decline="${esc(b.id)}">Decline</button>
    </div>
  </div>`;

/** A confirmed session, today or ahead. */
export const session = (b) => `
  <div class="row">
    <div class="row-main">
      <div class="row-top">
        <span class="who">${esc(b.name)}</span>
        <span class="tag ${esc(b.mode)}">${esc(MODE[b.mode] || b.mode)}</span>
        <span class="when">${fmtDay(b.startAt)} · ${fmtTime(b.startAt)}</span>
      </div>
      <p class="row-sub">${esc(b.focusArea)}${b.country ? " · " + esc(b.country) : ""}</p>
    </div>
    <div class="row-acts">${contactLinks(b)}</div>
  </div>`;

/* ---- what happened, in her words -------------------------------
   The database stores `no_show`. She reads "Didn't come". Nothing on
   a screen she uses every day should make her translate, and a label
   that matches a column name is a label written for the developer.

   ORDER IS DELIBERATE: the likeliest answer sits leftmost, under the
   thumb, because on most days most sessions simply happened. */
const ENDINGS = [
  { value: "done", label: "Done" },
  { value: "no_show", label: "Didn’t come" },
  { value: "cancelled", label: "Cancelled" },
  { value: "rescheduled", label: "Rescheduled" },
];

/** How it reads back once she has said so. */
export const ENDING_SAID = {
  done: "Done",
  no_show: "Didn’t come",
  cancelled: "Cancelled",
  rescheduled: "Rescheduled",
};

/** Today's session — the only row she has to DO something with.
 *
 *  THE CONTROLS CHANGE WITH THE CLOCK. Before the hour arrives the
 *  only true things are that it might be cancelled or moved; a
 *  session cannot be a no-show at ten in the morning. Offering all
 *  four all day would mean offering two answers that are not yet
 *  possible, and every wrong answer on offer is one that can be
 *  tapped by mistake. */
export const sessionToday = (b) => {
  const begun = b.startAt && new Date(b.startAt).getTime() <= Date.now();
  const offer = begun
    ? ENDINGS
    : ENDINGS.filter((e) => e.value === "cancelled" || e.value === "rescheduled");

  /* The same row is used for sessions left over from earlier days,
     where the hour on its own would be a lie by omission — "11:00"
     reads as this morning. The day appears only when it is not
     today, so the common case stays as short as it can be. */
  const isToday =
    b.startAt && new Date(b.startAt).toDateString() === new Date().toDateString();
  const when = isToday ? fmtTime(b.startAt) : `${fmtDay(b.startAt)} · ${fmtTime(b.startAt)}`;

  return `
  <div class="row" data-session="${esc(b.id)}">
    <div class="row-main">
      <div class="row-top">
        <span class="who">${esc(b.name)}</span>
        <span class="tag ${esc(b.mode)}">${esc(MODE[b.mode] || b.mode)}</span>
        <span class="when">${when}</span>
      </div>
      <p class="row-sub">${esc(b.focusArea)}${b.country ? " · " + esc(b.country) : ""}</p>
    </div>
    <div class="row-acts">
      <!-- Straight into the room for THIS booking. She should not
           have to pick the person she is already looking at. -->
      <a class="btn go" href="./consultation-room.html?booking=${esc(b.id)}">Room</a>
      ${contactLinks(b)}
    </div>

    <div class="row-end">
      <span class="end-ask">${begun ? "How did it go?" : "If plans change"}</span>
      ${offer
        .map(
          (e) =>
            `<button class="btn end" type="button" data-outcome="${e.value}">${e.label}</button>`
        )
        .join("")}
    </div>
  </div>`;
};

/** A session already answered for — one line of History.
 *
 *  READS AS A SENTENCE ABOUT THE PERSON, not a database row. The
 *  business question is never "what is in the outcomes table"; it is
 *  "did this appointment happen, and if not, what happened instead" —
 *  so the hour it was booked for leads, and what became of it follows.
 *
 *  A reschedule names both ends. "Rescheduled" on its own is the least
 *  useful thing this page could say: the whole point of recording it was that the
 *  session went somewhere. */
export const outcomeRow = (o) => `
  <div class="row is-past">
    <div class="row-main">
      <div class="row-top">
        <span class="who">${esc(o.name)}</span>
        <span class="tag ${esc(o.mode)}">${esc(MODE[o.mode] || o.mode)}</span>
        <span class="ending is-${esc(o.outcome)}">${esc(ENDING_SAID[o.outcome] || o.outcome)}</span>
      </div>
      <p class="row-sub">
        ${o.wasScheduledAt ? `${fmtDay(o.wasScheduledAt)} · ${fmtTime(o.wasScheduledAt)}` : "no time set"}
        ${o.movedTo ? ` → ${fmtDay(o.movedTo)} · ${fmtTime(o.movedTo)}` : ""}
        ${o.issue ? ` · ${esc(o.issue)}` : ""}
      </p>
      ${o.note ? `<p class="row-note">${esc(o.note)}</p>` : ""}
    </div>
    <div class="row-acts">
      <span class="row-stamp">${fmtDay(o.recordedAt)} ${fmtTime(o.recordedAt)}</span>
    </div>
  </div>`;

/** One person, however many times they have booked. */
export const person = (p) => `
  <div class="row">
    <div class="row-main">
      <div class="row-top">
        <span class="who">${esc(p.name)}</span>
        <span class="when">${plural(p.sessions, "session")}</span>
      </div>
      <p class="row-sub">
        ${esc(p.email)}${p.lastSeenAt ? " · last seen " + fmtDay(p.lastSeenAt) : ""}
      </p>
    </div>
    <div class="row-acts">${contactLinks(p)}</div>
  </div>`;

/** Something the system sent, and whether it got there. */
export const message = (m) => `
  <div class="row ${m.status === "failed" ? "is-failed" : ""}">
    <div class="row-main">
      <div class="row-top">
        <span class="who">${esc(m.kind)}</span>
        <span class="tag ${esc(m.status)}">${esc(m.status)}</span>
        <span class="when">${fmtDay(m.at)} · ${fmtTime(m.at)}</span>
      </div>
      <p class="row-sub">
        to ${esc(m.recipient)} · ${esc(m.templateId)} v${esc(m.templateVersion)}
      </p>
    </div>
    <div class="row-acts">
      ${m.status === "failed" ? `<button class="btn warn" data-retry="${esc(m.id)}">Send again</button>` : ""}
    </div>
  </div>`;

/** A day that does not follow the weekly pattern. */
export const exception = (e) => `
  <div class="row">
    <div class="row-main">
      <div class="row-top">
        <span class="who">${fmtDay(e.onDate)}</span>
        <span class="tag ${e.kind === "closed" ? "in_person" : "audio"}">${esc(e.kind)}</span>
        ${e.startsMin != null ? `<span class="when">${hhmm(e.startsMin)}–${hhmm(e.endsMin)}</span>` : ""}
      </div>
      <p class="row-sub">${esc(e.reason || "No reason given")}</p>
    </div>
    <div class="row-acts">
      <button class="btn quiet" data-drop-exception="${esc(e.id)}">Remove</button>
    </div>
  </div>`;
