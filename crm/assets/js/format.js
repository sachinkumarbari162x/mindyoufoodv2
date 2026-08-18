/* ============================================================
   FORMAT — text that reaches the page
   ------------------------------------------------------------
   Everything a person typed passes through `esc` before it goes
   anywhere near innerHTML. A visitor's name is untrusted input
   and it is rendered on this page dozens of times.
   ============================================================ */

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/** How the session happens, in her words rather than the column's. */
export const MODE = {
  video: "Video",
  audio: "Phone",
  in_person: "In person",
  undecided: "Undecided",
};

export const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export const fmtDay = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** Minutes from midnight → "11:00". The form availability is stored in. */
export const hhmm = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
