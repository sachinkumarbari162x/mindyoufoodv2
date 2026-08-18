/* ============================================================
   UNITS — the test, because a conversion table nobody checked
   is a conversion table that is wrong somewhere
   ------------------------------------------------------------
   Needs go-data running on :5504 — the tables under test are the
   ones actually being served, not a copy pasted into a fixture.
   A fixture would pass for ever while the database drifted.

     node public/assets/js/shared/units.test.js

   EVERY EXPECTED VALUE HERE COMES FROM SOMEWHERE ELSE. The molar
   conversions are the textbook ones, the BMI bands are the
   published cut-offs. A test whose expectations were read off the
   thing it is testing proves only that the code has not changed.
   ============================================================ */
/* The conversion table is only worth having if it is right.
   Every expected value below is from an independent source, not
   from the table being tested. */
const units = require("./units.js");

let pass = 0;
let fail = 0;

function near(name, got, want, tolerance) {
  const t = tolerance == null ? 0.01 : tolerance;
  const ok = got != null && Math.abs(got - want) <= t;
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name.padEnd(46)} ${got == null ? "null" : Number(got).toFixed(3)} (want ${want})`
  );
}

function is(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(46)} ${JSON.stringify(got)}`);
}

async function main() {
  const tables = await (await fetch("http://127.0.0.1:5504/crm/units")).json();
  const settingsRes = await (await fetch("http://127.0.0.1:5504/crm/settings")).json();
  const settings = {};
  settingsRes.settings.forEach((s) => (settings[s.key] = s.value));

  units.load(tables, settings);
  console.log(`loaded ${tables.units.length} units, standard = ${units.standard}\n`);

  // ---- mass ----------------------------------------------------
  near("70 kg -> lb", units.convert(70, "kg", "lb"), 154.324);
  near("154.324 lb -> kg", units.convert(154.324, "lb", "kg"), 70);
  near("70 kg -> stones", units.convert(70, "kg", "st"), 11.023);

  // ---- length --------------------------------------------------
  near("170 cm -> inches", units.convert(170, "cm", "in"), 66.929);
  near("5 ft -> cm", units.convert(5, "ft", "cm"), 152.4);

  // ---- energy --------------------------------------------------
  near("2000 kcal -> kJ", units.convert(2000, "kcal", "kj"), 8368);

  /* ---- the molar ones, which are the whole reason this table
     exists. Each expected value is the textbook conversion. */
  near("100 mg/dL glucose -> mmol/L", units.convert(100, "mg_dl_glucose", "mmol_l_glucose"), 5.551, 0.005);
  near("5.6 mmol/L glucose -> mg/dL", units.convert(5.6, "mmol_l_glucose", "mg_dl_glucose"), 100.9, 0.2);
  near("200 mg/dL cholesterol -> mmol/L", units.convert(200, "mg_dl_chol", "mmol_l_chol"), 5.172, 0.005);
  near("150 mg/dL trigs -> mmol/L", units.convert(150, "mg_dl_tg", "mmol_l_tg"), 1.694, 0.005);
  near("1.0 mg/dL creatinine -> umol/L", units.convert(1.0, "mg_dl_creat", "umol_l_creat"), 88.4, 0.2);
  near("12 g/dL haemoglobin -> g/L", units.convert(12, "g_dl", "g_l"), 120);

  // ---- temperature, the one with an offset ---------------------
  near("37 C -> F", units.convert(37, "c", "f"), 98.6, 0.05);
  near("98.6 F -> C", units.convert(98.6, "f", "c"), 37, 0.05);

  // ---- a mismatch must throw, not approximate ------------------
  let threw = false;
  try {
    units.convert(100, "mg_dl_glucose", "mg_dl_chol");
  } catch {
    threw = true;
  }
  is("glucose -> cholesterol is refused", threw, true);

  // ---- display follows the standard ----------------------------
  units.use("india_clinical");
  is("india: 70 kg shows as", units.format(70, "mass"), "70.0 kg");
  is("india: 100 glucose shows as", units.format(100, "glucose"), "100 mg/dL");

  units.use("us_customary");
  is("us: 70 kg shows as", units.format(70, "mass"), "154.3 lb");
  is("us: 170 cm shows as", units.format(170, "length"), "66.9 in");

  units.use("metric");
  is("metric: 100 glucose shows as", units.format(100, "glucose"), "5.6 mmol/L");
  is("metric: 2000 kcal shows as", units.format(2000, "energy"), "8,368 kJ");

  // An override beats the standard.
  units.use("metric", { mass: "lb" });
  is("override: 70 kg shows as", units.format(70, "mass"), "154.3 lb");
  is("override leaves glucose alone", units.format(100, "glucose"), "5.6 mmol/L");
  units.use("india_clinical", {});

  // ---- bands ---------------------------------------------------
  const metrics = (await (await fetch("http://127.0.0.1:5504/crm/metrics")).json()).metrics;
  const by = {};
  metrics.forEach((m) => (by[m.key] = m));

  /* THE POINT OF HAVING TWO BAND SETS. A BMI of 24 is healthy on
     the international cut-offs and overweight on the Asian ones,
     and for this practice the second is the clinically correct
     reading. */
  is("BMI 24, asia_pacific", units.band(24, by.bmi, "asia_pacific").label, "Overweight");
  is("BMI 24, who", units.band(24, by.bmi, "who").label, "Healthy");
  is("BMI 17, asia_pacific", units.band(17, by.bmi, "asia_pacific").label, "Underweight");
  is("BMI 31, asia_pacific", units.band(31, by.bmi, "asia_pacific").label, "Obese II");

  is("HbA1c 5.4", units.band(5.4, by.hba1c, "who").label, "Normal");
  is("HbA1c 6.1", units.band(6.1, by.hba1c, "who").label, "Prediabetes");
  is("HbA1c 8.2", units.band(8.2, by.hba1c, "who").label, "Diabetes, above target");

  is("fasting glucose 132", units.band(132, by.fasting_glucose, "who").label, "Diabetes range");
  is("ferritin 11", units.band(11, by.ferritin, "who").label, "Depleted");
  is("vitamin D 18", units.band(18, by.vitamin_d, "who").label, "Deficient");
  is("systolic 148", units.band(148, by.systolic, "who").label, "Stage 2");
  is("eGFR 52", units.band(52, by.egfr, "who").label, "Stage 3a");

  // Sex-specific bands pick the right row.
  is("haemoglobin 9.8, female", units.band(9.8, by.haemoglobin, "who", "female").label, "Moderate anaemia");

  // A metric with no band list still answers from ref_low/high.
  is("uric acid 7.2 (no bands)", units.band(7.2, by.uric_acid, "who").label, "Above range");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FAILED", e.message);
  process.exit(1);
});
