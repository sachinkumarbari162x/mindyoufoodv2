/* ============================================================
   RENDER — turning a booking into an email, safely
   ------------------------------------------------------------
   Two things live here: escaping, and the shell every template
   is poured into.

   ESCAPING IS NOT OPTIONAL AND NOT REMEMBERED. `h` escapes by
   default and there is no way to interpolate raw text into an
   email body from a template file. A visitor types their own
   name into the booking form; that name goes into an email that
   is then read in Gmail, which renders HTML. Forgetting one
   `esc()` in one template is a stored injection that we would
   post ourselves, to somebody else's inbox.

   THE LAYOUT IS PLAIN ON PURPOSE. No images, no web fonts, no
   tracking pixel, no external stylesheet. Partly because a
   dietitian's confirmation should read like a note from a person
   rather than a marketing send — and partly because remote
   images and trackers are exactly what spam filters weigh
   against you. Inline styles only: Gmail strips <style> blocks.
   ============================================================ */
"use strict";

/** Every value that reaches an HTML body goes through this. */
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/** Tagged template that escapes every interpolation.
 *
 *  html`<p>${name}</p>` is safe. There is deliberately no escape
 *  hatch: a template that needs raw markup should be composing
 *  smaller html`` fragments, which arrive here already escaped and
 *  are passed through by the marker below. */
const RAW = Symbol("raw");

function html(strings, ...values) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      out += v && v[RAW] ? v.value : esc(v);
    }
  });
  return { [RAW]: true, value: out, toString: () => out };
}

/** A pre-escaped fragment, for composing templates out of pieces. */
const raw = (value) => ({ [RAW]: true, value, toString: () => value });

/* ---- the shell -------------------------------------------------
   One column, a readable measure, system fonts. The signature is
   part of the shell rather than each template so her name and the
   practice cannot drift apart between two emails. */
function shell({ body, practice, from }) {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;background:#fbfaf8;">
  <div style="max-width:34rem;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1b1610;">
    ${String(body)}
    <p style="margin:28px 0 0;padding-top:16px;border-top:1px solid #e3e0d9;font-size:13px;color:#7a6c58;">
      ${esc(practice.dietitian)} · ${esc(practice.name)}<br />
      <a href="mailto:${esc(from)}" style="color:#9a6712;">${esc(from)}</a>
    </p>
  </div>
</body>
</html>`;
}

/* ---- dates -----------------------------------------------------
   Written in HER practice timezone with the zone named, because an
   appointment time with no zone is the single most expensive
   ambiguity this system can put in front of somebody. A visitor in
   London reading "11:00" about an Indian practice will get it
   wrong, and will get it wrong silently. */
function when(iso, timezone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  const date = d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: timezone,
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
  /* THE ABBREVIATION PEOPLE ACTUALLY WRITE.
     en-GB renders Asia/Kolkata as "GMT+5:30", which is correct and
     is not what anybody in India has ever called it. en-IN gives
     "IST". The fallback matters though: en-IN would render a US zone
     as "GMT-4", so anything still shaped like an offset falls back to
     the full name — "Eastern Daylight Time" beats "GMT-4" for
     somebody deciding when to answer their phone. */
  const abbr = (locale, style) =>
    new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: style })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value || "";

  const short = abbr("en-IN", "short");
  const zone = (!short || /^GMT/.test(short) ? abbr("en-GB", "long") : short) || timezone;

  return { date, time, zone, full: `${date} at ${time} ${zone}` };
}

module.exports = { esc, html, raw, shell, when };
