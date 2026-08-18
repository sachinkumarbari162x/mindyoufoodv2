/* ============================================================
   UNITS — the only place a number changes shape
   ------------------------------------------------------------
   Shared by the CRM and by the client's panel, deliberately.
   Two copies of a conversion table is two answers to "what does
   she weigh", and the day they disagree nobody will know which
   screen to believe.

   THE CONTRACT, IN ONE LINE: everything is STORED canonical and
   CONVERTED on the way to a screen. crm.measurements holds
   kilograms, centimetres, kcal and mg/dL, always, whatever the
   practice has chosen to look at. That is what makes "show me
   pounds" a setting rather than a migration, and it is what
   makes switching back afterwards safe.

   A CONVERSION ACROSS DIMENSIONS IS REFUSED, NOT APPROXIMATED.
   mg/dL to mmol/L is not one conversion — glucose divides by
   18.016, cholesterol by 38.67, triglycerides by 88.57, because
   the factor is the molar mass of the thing being measured. A
   single "concentration" dimension would happily convert a
   cholesterol with a glucose factor and hand back a number that
   looks entirely plausible and is wrong by a factor of two. So
   each analyte is its own dimension and a mismatch throws.

   Load the tables once from GET /crm/units, then call convert()
   and format() as often as you like — neither touches the
   network.
   ============================================================ */
(function (global) {
  "use strict";

  /* The tables, as served. Empty until load() has been called,
     and every function below says what it does in that state
     rather than throwing at a call site that cannot fix it. */
  let UNITS = new Map(); // code -> unit
  let BY_DIMENSION = new Map(); // dimension -> [unit]
  let CANONICAL = new Map(); // dimension -> code
  let STANDARDS = new Map(); // code -> {units: {dimension: code}}

  let standard = "india_clinical";
  let overrides = {};
  let ready = false;

  /** Take the tables from GET /crm/units and the two settings. */
  function load({ units, standards }, settings) {
    UNITS = new Map();
    BY_DIMENSION = new Map();
    CANONICAL = new Map();
    STANDARDS = new Map();

    (units || []).forEach((u) => {
      UNITS.set(u.code, u);
      if (!BY_DIMENSION.has(u.dimension)) BY_DIMENSION.set(u.dimension, []);
      BY_DIMENSION.get(u.dimension).push(u);
      if (u.canonical) CANONICAL.set(u.dimension, u.code);
    });

    (standards || []).forEach((s) => STANDARDS.set(s.code, s));

    if (settings) {
      if (settings["units.standard"]) standard = settings["units.standard"];
      if (settings["units.overrides"]) overrides = settings["units.overrides"] || {};
    }
    ready = true;
    return module_;
  }

  /** Change the standard without reloading the tables. */
  function use(code, extraOverrides) {
    if (code) standard = code;
    if (extraOverrides) overrides = extraOverrides;
    return module_;
  }

  /* WHICH UNIT A DIMENSION IS SHOWN IN, in order of precedence:
     an explicit override for that dimension, then whatever the
     current standard names, then the canonical unit. The last
     one is why a standard only has to list its DIFFERENCES — a
     dimension nobody has an opinion about shows as stored. */
  function unitFor(dimension) {
    if (!dimension) return null;
    const chosen =
      overrides[dimension] ||
      (STANDARDS.get(standard) && STANDARDS.get(standard).units[dimension]) ||
      CANONICAL.get(dimension);
    return chosen ? UNITS.get(chosen) || null : null;
  }

  /** Every unit available for a dimension — for a picker. */
  function optionsFor(dimension) {
    return (BY_DIMENSION.get(dimension) || []).slice();
  }

  /* ---- the arithmetic ------------------------------------------
     value_in_canonical = value * factor + offset, and back the
     other way. Both directions in one function so the pair can
     never drift out of agreement with each other. */

  function toCanonical(value, unitCode) {
    const u = UNITS.get(unitCode);
    if (!u || value == null || !Number.isFinite(Number(value))) return null;
    return Number(value) * Number(u.factor) + Number(u.offset);
  }

  function fromCanonical(value, unitCode) {
    const u = UNITS.get(unitCode);
    if (!u || value == null || !Number.isFinite(Number(value))) return null;
    return (Number(value) - Number(u.offset)) / Number(u.factor);
  }

  /**
   * A stored (canonical) value, in whatever unit is currently in
   * force for its dimension.
   *
   * @returns {{value:number, unit:object}|null}
   */
  function display(canonicalValue, dimension) {
    const u = unitFor(dimension);
    if (!u) return null;
    const value = fromCanonical(canonicalValue, u.code);
    return value == null ? null : { value, unit: u };
  }

  /**
   * Between any two units of the SAME dimension. Throws across
   * dimensions rather than returning something wrong — see the
   * header: a silently mis-converted lab value is the failure
   * this whole module exists to prevent.
   */
  function convert(value, fromCode, toCode) {
    const a = UNITS.get(fromCode);
    const b = UNITS.get(toCode);
    if (!a || !b) throw new Error(`units: unknown unit ${!a ? fromCode : toCode}`);
    if (a.dimension !== b.dimension) {
      throw new Error(
        `units: cannot convert ${fromCode} (${a.dimension}) to ${toCode} (${b.dimension})`
      );
    }
    return fromCanonical(toCanonical(value, fromCode), toCode);
  }

  /* ---- how it reads --------------------------------------------- */

  /* Decimals come from the unit rather than from the metric,
     because they are a property of the unit: 70.5 kg is sensible
     and 155.43 lb is not, and the same stored weight is both. */
  function round(value, unit, decimalsOverride) {
    const dp = decimalsOverride == null ? (unit ? unit.decimals : 1) : decimalsOverride;
    const factor = Math.pow(10, dp);
    return Math.round(Number(value) * factor) / factor;
  }

  /**
   * A stored value as a string somebody can read.
   *
   * @param {number} canonicalValue
   * @param {string} dimension
   * @param {object} [opts]  {decimals, symbol=true, locale}
   */
  function format(canonicalValue, dimension, opts) {
    const o = opts || {};
    const shown = display(canonicalValue, dimension);
    if (!shown) {
      // No dimension, or no table loaded: the number itself is
      // still better than nothing, and better than "undefined".
      return canonicalValue == null ? "" : String(canonicalValue);
    }

    const dp = o.decimals == null ? shown.unit.decimals : o.decimals;
    const n = round(shown.value, shown.unit, dp);

    const text = new Intl.NumberFormat(o.locale || "en-IN", {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    }).format(n);

    if (o.symbol === false || !shown.unit.symbol) return text;
    /* No space before a degree or a per-cent sign; a space before
       everything else. Typographic, and it is the difference
       between a screen that looks made and one that looks
       generated. */
    const tight = /^[°%]/.test(shown.unit.symbol);
    return tight ? `${text}${shown.unit.symbol}` : `${text} ${shown.unit.symbol}`;
  }

  /* ---- reference bands -------------------------------------------
     A band list is [{to, label, tone}, …] with the last one
     open-ended. Compared in CANONICAL units, always — the bands
     in the registry are stored canonical, so a client looking at
     pounds still gets the same verdict as one looking at
     kilograms. Converting the value first and then comparing
     against canonical cut-offs is the bug this comment exists to
     prevent. */

  function band(canonicalValue, metric, bandsStandard, sex) {
    if (!metric || canonicalValue == null) return null;
    const all = metric.bands || {};
    const list = all[bandsStandard || "who"] || all.who || all.asia_pacific;
    if (!Array.isArray(list) || !list.length) return simpleBand(canonicalValue, metric);

    const applies = list.filter((b) => !b.sex || !sex || b.sex === sex);
    for (const b of applies) {
      if (b.to == null || Number(canonicalValue) < Number(b.to)) return b;
    }
    return applies[applies.length - 1] || null;
  }

  /* When a metric has no band list, ref_low and ref_high still
     answer the only question most screens ask. */
  function simpleBand(canonicalValue, metric) {
    const v = Number(canonicalValue);
    const low = metric.refLow;
    const high = metric.refHigh;
    if (low == null && high == null) return null;
    if (low != null && v < low) return { label: "Below range", tone: "warn" };
    if (high != null && v > high) return { label: "Above range", tone: "warn" };
    return { label: "Within range", tone: "good" };
  }

  const module_ = {
    load,
    use,
    get ready() {
      return ready;
    },
    get standard() {
      return standard;
    },
    unitFor,
    optionsFor,
    toCanonical,
    fromCanonical,
    convert,
    display,
    format,
    band,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = module_;
  else global.units = module_;
})(typeof window !== "undefined" ? window : globalThis);
