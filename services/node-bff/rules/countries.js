/* ============================================================
   COUNTRIES — one list, and it lives in the database
   ------------------------------------------------------------
   The desk used to accept any text as a country and title-case
   it. Go then tried to match it against crm.countries and, on no
   match, stored NULL. So "Indea" was accepted, silently discarded,
   and the consultation saved with no country at all — no error, no
   warning, nothing in the record to say a country had ever been
   offered.

   The fix is not to reject the WRITE. By the time a booking is
   being written, refusing it over a spelling loses the booking,
   which is worse than losing the field. The fix is to check while
   the desk is still TALKING to them, when asking again costs
   nothing.

   So: this module resolves what they typed against the real 74
   rows, and the desk asks again when it cannot. Nothing reaches
   the database that the database will not recognise.

       ONE LIST. It is `crm.countries`, and there is no second
       copy of it up here to drift out of date.

   The fallback below is not a second copy — it is a floor for the
   minutes before go-data has answered, and it accepts rather than
   rejects, because a cold cache must never turn into a visitor
   being told their country does not exist.
   ============================================================ */
"use strict";

const data = require("../data-client");

const TTL_MS = 10 * 60 * 1000; // the list changes when a migration runs

let rows = [];
let byKey = new Map();
let fetchedAt = 0;
let loading = null;

/** Every spelling we will answer to, mapped to the row. */
function index(list) {
  const m = new Map();
  const put = (k, row) => {
    const key = String(k || "").trim().toLowerCase();
    if (key && !m.has(key)) m.set(key, row);
  };

  for (const row of list) {
    put(row.iso2, row);
    put(row.name, row);
    // "the United Kingdom", "the UAE" — how people actually write it.
    put(`the ${row.name}`, row);
  }

  for (const [alias, iso] of Object.entries(ALIASES)) {
    const row = list.find((r) => r.iso2 === iso);
    if (row) m.set(alias, row);
  }

  return m;
}

/* The handful people type instead of the official name. Module scope
   because the picker in the browser needs exactly these too — it is
   served with the list rather than copied into the client, so "uk"
   cannot mean United Kingdom at the desk and Ukraine in the dropdown.
   That was a real bug for the ten minutes this lived in one place.

   Deliberately short: this is for what visitors type, not a synonym
   dictionary. */
const ALIASES = {
    uk: "GB", "u.k.": "GB", britain: "GB", "great britain": "GB", england: "GB",
    scotland: "GB", wales: "GB", "northern ireland": "GB",
    usa: "US", "u.s.": "US", "u.s.a.": "US", america: "US", "the states": "US",
    uae: "AE", emirates: "AE", dubai: "AE", "abu dhabi": "AE",
    ksa: "SA", "saudi": "SA",
  bharat: "IN", hindustan: "IN",
};

async function refresh() {
  const out = await data.crm.countries();
  const list = out?.countries || [];
  if (!list.length) return false;
  rows = list;
  byKey = index(list);
  fetchedAt = Date.now();
  return true;
}

function maybeRefresh() {
  if (loading) return;
  if (Date.now() - fetchedAt < TTL_MS) return;
  loading = refresh()
    .catch(() => false)
    .finally(() => {
      loading = null;
    });
}

/** Called once at boot, with the same backoff as the knowledge base
    and for the same reason: all four services start together and
    go-data runs its migrations before it answers anything. */
async function prime(attempt = 1) {
  const ok = await refresh().catch(() => false);
  if (ok) return true;

  if (attempt < 8) {
    const wait = 2 ** (attempt - 1) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return prime(attempt + 1);
  }
  console.warn("[bff] country list unavailable after 8 attempts — accepting any country");
  return false;
}

/** True once the real list is in hand. Callers use this to decide
    whether they are entitled to reject anything. */
const ready = () => rows.length > 0;

/**
 * Resolve free text to a country.
 * @returns {{iso2: string, name: string} | null} null = not a country we know
 */
function resolve(raw) {
  maybeRefresh();
  const key = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[.]$/, "");
  if (!key) return null;
  const hit = byKey.get(key);
  return hit ? { iso2: hit.iso2, name: hit.name } : null;
}

/** The list for a picker: hers first, then everyone else by name. */
function list() {
  maybeRefresh();
  return rows.map((r) => ({
    iso2: r.iso2,
    name: r.name,
    dialCode: r.dialCode,
    pinned: !!r.pinned,
    // Sent, not duplicated. The picker matches on these so the two
    // halves cannot disagree about what "uk" means.
    aliases: Object.entries(ALIASES)
      .filter(([, iso]) => iso === r.iso2)
      .map(([alias]) => alias),
  }));
}

/** A few names to show in the "did you mean" when nothing matched.
    Hers first, because that is where most visitors are. */
function examples(n = 4) {
  return rows
    .filter((r) => r.pinned)
    .slice(0, n)
    .map((r) => r.name);
}

module.exports = { prime, ready, resolve, list, examples };
