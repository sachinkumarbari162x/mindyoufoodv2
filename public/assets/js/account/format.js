/* ============================================================
   ACCOUNT · FORMAT
   ------------------------------------------------------------
   Turning what the database holds into what a person reads, and
   the one place in this panel that builds a string of HTML.

   `esc` IS NOT OPTIONAL. Every value on these screens was typed
   by somebody — a plan she wrote, a document the client named, a
   note from a consultation — and all of it is rendered through
   innerHTML because the alternative is four hundred lines of
   createElement. So everything that came from the server goes
   through esc() on the way in, without exception. A document
   called `<img onerror=…>.pdf` is a file somebody can upload
   today; it must render as that filename and nothing else.
   ============================================================ */
(function () {
  "use strict";

  /* Text into markup. The five characters that can end an
     attribute or open a tag — quotes included, because half of
     these values land inside attributes. */
  function esc(value) {
    return String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (ch) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
    );
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const FULL = ["January", "February", "March", "April", "May", "June", "July",
                "August", "September", "October", "November", "December"];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const parse = (iso) => (iso ? new Date(iso) : null);

  /** "18 August" — a date in a sentence. */
  function day(iso) {
    const d = parse(iso);
    if (!d || isNaN(d)) return "";
    return `${d.getDate()} ${FULL[d.getMonth()]}`;
  }

  /** "Tuesday, 18 August" — a date as a heading. */
  function longDay(iso) {
    const d = parse(iso);
    if (!d || isNaN(d)) return "";
    return `${DAYS[d.getDay()]}, ${d.getDate()} ${FULL[d.getMonth()]}`;
  }

  /** "18 Aug 2026" — a date in a table. */
  function shortDate(iso) {
    const d = parse(iso);
    if (!d || isNaN(d)) return "";
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  /** "2:00 PM". Lower-case am/pm is harder to read at 13px. */
  function time(iso) {
    const d = parse(iso);
    if (!d || isNaN(d)) return "";
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const suffix = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m} ${suffix}`;
  }

  /** {m:"Aug", d:"21"} for the date badge on a session. */
  function badge(iso) {
    const d = parse(iso);
    if (!d || isNaN(d)) return { m: "", d: "" };
    return { m: MONTHS[d.getMonth()], d: String(d.getDate()).padStart(2, "0") };
  }

  /* Money comes over as minor units and a currency, and is
     printed with the symbol its currency actually uses. Dividing
     by 100 in a template is how a receipt ends up saying 5000
     rupees for a five thousand rupee consultation. */
  function money(minor, currency) {
    const amount = (Number(minor) || 0) / 100;
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: currency || "INR",
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      return `${currency || ""} ${amount.toFixed(0)}`.trim();
    }
  }

  /** 245760 → "240 KB". What a person recognises off a file. */
  function bytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${Math.round(b / 1024)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  }

  /** 7.53 → "7h 32m". Sleep is never read as a decimal. */
  function hours(value) {
    const v = Number(value) || 0;
    const h = Math.floor(v);
    const m = Math.round((v - h) * 60);
    // "0h 27m below your target" is not a sentence anybody writes.
    if (!h) return `${m}m`;
    return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
  }

  /* A quantity and its unit, as she wrote them. "2 no" is how the
     database says two of something and is not how anybody says
     it, so that unit disappears and the number carries the line. */
  function amount(quantity, unit) {
    if (quantity == null) return "";
    const n = Number(quantity);
    const q = Number.isInteger(n) ? String(n) : String(n).replace(/\.0+$/, "");
    if (!unit || unit === "no") {
      // "1 Multivitamin" is not how anybody says it. Two of a thing
      // is worth stating; one of it is just the thing.
      return n === 1 ? "" : q;
    }
    return `${q} ${unit}`;
  }

  /* The same duration, marked up so the units sit small and grey
     beside the digits. Returns markup, so its caller must not
     escape it — which is why it is named apart from hours(). */
  function hoursMarkup(value) {
    const v = Number(value) || 0;
    const h = Math.floor(v);
    const m = Math.round((v - h) * 60);
    const unit = (u) => `<span class="u">${u}</span>`;
    return m ? `${h}${unit("h")} ${String(m).padStart(2, "0")}${unit("m")}` : `${h}${unit("h")}`;
  }

  /* Her prose to markup. Blank lines are paragraphs and a line
     starting "- " is a bullet — the two things she actually types.
     Anything else is a paragraph, because a plan is prose and a
     markdown parser is a dependency and a new class of bug. */
  function prose(text) {
    const blocks = String(text || "").split(/\n\s*\n/);
    return blocks
      .map((block) => {
        const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
        if (!lines.length) return "";
        if (lines.every((l) => l.startsWith("- "))) {
          const items = lines.map((l) => `<li>${esc(l.slice(2))}</li>`).join("");
          return `<ul>${items}</ul>`;
        }
        return `<p>${esc(lines.join(" "))}</p>`;
      })
      .join("");
  }

  /** "SB" for the avatar. Two letters, or one if that is all there is. */
  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /* Sentence case for a lab metric: `fasting_glucose` is a column
     name and nobody should be shown a column name. */
  const METRIC_NAMES = {
    hba1c: "HbA1c",
    fasting_glucose: "Fasting glucose",
    haemoglobin: "Haemoglobin",
    ferritin: "Ferritin",
    sodium: "Sodium",
    creatinine: "Creatinine",
    systolic: "Blood pressure (systolic)",
    weight: "Weight",
  };

  /* A metric is called what the report calls it. Title-casing the
     column name gives "Hba1c", which is not a thing, and a client
     comparing this screen against a printed lab report should see
     the same word on both. Anything not on the list falls back to
     sentence case rather than to nothing. */
  function metricName(metric) {
    const key = String(metric || "").toLowerCase();
    if (METRIC_NAMES[key]) return METRIC_NAMES[key];
    const words = key.replace(/_/g, " ").trim();
    return words ? words[0].toUpperCase() + words.slice(1) : "";
  }

  /** "23:00" → "11:00 PM". Her plan is written in 24-hour time;
      nobody in India reads a bedtime that way. */
  function clock(hhmm) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
    if (!match) return String(hhmm || "");
    let h = Number(match[1]);
    const suffix = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${match[2]} ${suffix}`;
  }

  const BANDS = {
    below: "Below range",
    above: "Above range",
    within: "Within range",
    unknown: "",
  };

  window.accountFormat = {
    esc, day, longDay, shortDate, time, badge, money, bytes, hours, hoursMarkup,
    amount, prose, initials, metricName, clock,
    band: (b) => BANDS[b] || "",
    SHORT_DAYS,
  };
})();
