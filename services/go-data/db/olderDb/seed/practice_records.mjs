/* ============================================================
   PRACTICE RECORDS — plans, rows, programmes, and a month of use
   ------------------------------------------------------------
   Runs after practice_reset.sql and practice_diary.sql.

   THROUGH THE API, NOT AS SQL, and that is the point of it being
   a script rather than a third .sql file. Plan references, the
   amendment chain, the partial unique indexes and the CHECK that
   refuses a confirmed row with nobody attached are all Go's — a
   seed that hand-forges those writes rows the application itself
   would have refused, and then everything downstream is being
   tested against data that could not really exist.

   Two things it still does in SQL, because the API is right to
   refuse them: check-ins for days in the past, and her replies
   dated to when she actually wrote them. A client may only fill
   in today; that rule is the feature, not an obstacle.

   node services/go-data/db/seed/practice_records.mjs
   ============================================================ */

const DATA = "http://127.0.0.1:5504";
const BY = "khadija@mindyourfood.co.in";

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(DATA + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 160)}`);
  return json;
}

const P = (n) => `a1000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const C = (n) => `c1000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

/* ---- the plans she actually writes ---------------------------
   One per condition, in her own register: plain, specific, and
   without a number where she would not have given one. */
const PLANS = [
  {
    person: 1, consult: 1, issue: "PCOS",
    targets: { energy_kcal: 1600, protein_g: 75, weight_kg: 78 },
    note: "Insulin resistance is the lever here. Recheck HbA1c and a fasting insulin at twelve weeks. Mother has T2DM.",
    rows: [
      ["meal", "Two eggs and a slice of wholemeal toast", 2, "eggs", "breakfast, before 9am"],
      ["meal", "A handful of almonds", 15, "almonds", "mid-morning"],
      ["meal", "One cup rice with dal and a vegetable", 1, "cup", "lunch"],
      ["habit", "Half the plate should be the vegetable", null, "", "lunch"],
      ["meal", "Green tea and two dates if you want something sweet", 2, "dates", "evening"],
      ["meal", "Two rotis with sabzi", 2, "rotis", "dinner, by 8pm"],
      ["activity", "Walk", 30, "minutes", "after dinner, daily"],
      ["sleep", "Bed by 11pm", 7, "hours", "nightly"],
    ],
    programme: 90,
  },
  {
    person: 2, consult: 2, issue: "weight",
    targets: { energy_kcal: 1500, protein_g: 80, weight_kg: 84 },
    note: "Skips breakfast then grazes from four o'clock. The fix is the morning, not the evening.",
    rows: [
      ["meal", "Poha or upma with a boiled egg", 1, "bowl", "breakfast, within an hour of waking"],
      ["meal", "Curd with fruit", 1, "cup", "mid-morning"],
      ["meal", "Two rotis, dal and salad", 2, "rotis", "lunch"],
      ["meal", "Roasted chana", 30, "g", "5pm"],
      ["meal", "Grilled paneer or fish with vegetables", null, "", "dinner, by 8:30pm"],
      ["activity", "Brisk walk", 45, "minutes", "5 days a week"],
      ["habit", "Weigh yourself", null, "", "once a week, same morning"],
    ],
    programme: 60,
  },
  {
    person: 3, consult: 3, issue: "T2DM",
    targets: { energy_kcal: 1550, protein_g: 85, weight_kg: 81, hba1c: 7.4 },
    note: "On metformin 500 twice daily. Any reduction is her GP's call, not mine — I have written that into the plan.",
    rows: [
      ["meal", "Vegetable omelette, two eggs", 2, "eggs", "breakfast"],
      ["meal", "Barley or millet roti instead of wheat", 2, "rotis", "lunch"],
      ["meal", "A cup of dal", 1, "cup", "lunch"],
      ["meal", "Cucumber and carrot before the meal", null, "", "lunch and dinner"],
      ["meal", "Grilled fish or chicken with two vegetables", null, "", "dinner, by 8pm"],
      ["activity", "Walk after every meal", 10, "minutes", "three times a day"],
      ["supplement", "Vitamin D 60,000 IU", 60000, "IU", "weekly, Sunday"],
      ["habit", "Check your sugars before breakfast", null, "", "three mornings a week"],
    ],
    programme: 90,
  },
  {
    person: 4, consult: 4, issue: "sports",
    targets: { energy_kcal: 2600, protein_g: 120, weight_kg: 68 },
    note: "Half marathon in twelve weeks. Fuelling, not restricting.",
    rows: [
      ["meal", "Oats with milk, banana and peanut butter", 60, "g", "breakfast"],
      ["meal", "Rice, dal, chicken and salad", 2, "cups", "lunch"],
      ["meal", "Banana and a glass of milk", 1, "banana", "before the run"],
      ["meal", "Curd rice or khichdi within an hour of finishing", null, "", "after the run"],
      ["meal", "Eggs or paneer with rotis", 3, "eggs", "dinner"],
      ["habit", "Water", 3, "l", "daily, more on run days"],
      ["sleep", "Eight hours on training nights", 8, "hours", "nightly"],
    ],
    programme: 90,
  },
  {
    person: 5, consult: 5, issue: "IBS",
    targets: { energy_kcal: 1700, protein_g: 70 },
    note: "Low FODMAP for six weeks then reintroduce one group a week. She travels for work — the plan has to survive a hotel.",
    rows: [
      ["meal", "Rice flakes with lactose-free milk", 1, "bowl", "breakfast"],
      ["meal", "Rice, moong dal and a cooked vegetable", 1, "cup", "lunch"],
      ["meal", "No onion or garlic for six weeks", null, "", "every meal"],
      ["meal", "Grilled chicken or tofu with rice", null, "", "dinner"],
      ["habit", "Chew slowly and stop at eighty per cent", null, "", "every meal"],
      ["habit", "Write down anything that upsets you", null, "", "daily"],
    ],
    programme: 60,
  },
  {
    person: 6, consult: 6, issue: "thyroid",
    targets: { energy_kcal: 1500, protein_g: 70, weight_kg: 72 },
    note: "TSH 6.2, on 50mcg thyroxine. Selenium and iodine adequate from diet — no supplement needed.",
    rows: [
      ["supplement", "Take your thyroxine on an empty stomach", null, "", "on waking, one hour before food"],
      ["meal", "Eggs and a fruit", 2, "eggs", "breakfast, after the hour"],
      ["meal", "Rotis, dal and a green vegetable", 2, "rotis", "lunch"],
      ["meal", "Brazil nuts", 2, "pieces", "mid-afternoon"],
      ["meal", "Soup and grilled paneer", null, "", "dinner"],
      ["activity", "Yoga or a walk", 30, "minutes", "5 days a week"],
    ],
    programme: 60,
  },
  {
    person: 8, consult: 8, issue: "muscle",
    targets: { energy_kcal: 2800, protein_g: 130, weight_kg: 62 },
    note: "Student budget. Eggs, milk, dal and chana do this cheaper than any powder — said so plainly.",
    rows: [
      ["meal", "Four eggs and two slices of toast", 4, "eggs", "breakfast"],
      ["meal", "Milk", 500, "ml", "mid-morning"],
      ["meal", "Rice, rajma and curd", 2, "cups", "lunch"],
      ["meal", "Roasted chana and a banana", 50, "g", "before the gym"],
      ["meal", "Paneer or chicken with rotis", 150, "g", "dinner"],
      ["activity", "Weights", 4, "days", "a week"],
      ["sleep", "Eight hours", 8, "hours", "nightly"],
    ],
    programme: 90,
  },
  {
    person: 9, consult: 9, issue: "cholesterol",
    targets: { energy_kcal: 1600, protein_g: 70, weight_kg: 79 },
    note: "LDL 4.1, GP wants six months of diet before considering a statin.",
    rows: [
      ["meal", "Oats with walnuts", 50, "g", "breakfast"],
      ["meal", "Two rotis, dal and a vegetable", 2, "rotis", "lunch"],
      ["meal", "Oily fish twice a week", 2, "portions", "a week"],
      ["meal", "Cook in mustard or rice bran oil", null, "", "every meal"],
      ["habit", "No fried snacks on weekdays", null, "", "Monday to Friday"],
      ["activity", "Walk", 40, "minutes", "daily"],
    ],
    programme: null,
  },
  {
    person: 11, consult: 11, issue: "T2DM",
    targets: { energy_kcal: 1700, protein_g: 90, weight_kg: 92, hba1c: 8.1 },
    note: "Works nights. The plan is built round his shift, not round breakfast.",
    rows: [
      ["meal", "Eggs and salad when you wake", 3, "eggs", "on waking"],
      ["meal", "Rice with dal and vegetables", 1, "cup", "main meal"],
      ["meal", "Nuts and curd at work", 30, "g", "during the shift"],
      ["meal", "Nothing fried after midnight", null, "", "night shift"],
      ["activity", "Walk before your shift", 30, "minutes", "5 days a week"],
      ["supplement", "Vitamin D 60,000 IU", 60000, "IU", "weekly"],
    ],
    programme: 30,
  },
  {
    person: 12, consult: 12, issue: "bone",
    targets: { energy_kcal: 1400, protein_g: 65, weight_kg: 61 },
    note: "DEXA T-score -2.1. Calcium from food where possible; she does not like tablets.",
    rows: [
      ["meal", "Ragi porridge with milk", 1, "bowl", "breakfast"],
      ["meal", "Curd or paneer", 200, "g", "daily"],
      ["meal", "Sesame seeds on the sabzi", 1, "tbsp", "lunch and dinner"],
      ["meal", "Two rotis and a green vegetable", 2, "rotis", "dinner"],
      ["supplement", "Vitamin D 60,000 IU", 60000, "IU", "weekly, Sunday"],
      ["activity", "Weight-bearing walk", 30, "minutes", "daily"],
    ],
    programme: 30,
  },
];

/* ---- go ------------------------------------------------------ */

const made = [];

for (const spec of PLANS) {
  const opened = await call("/crm/plans", {
    method: "POST",
    body: { personId: P(spec.person), consultationId: C(spec.consult), targets: spec.targets, by: BY },
  });
  const plan = opened.plan;

  /* The body, written in the house shape — which is what Generate
     would have produced and what Build reads back. Seeding prose
     would leave every plan one press away from looking right. */
  const body = spec.rows
    .map(([, label, qty, unit, when]) => {
      let l = `- ${label}`;
      const amount = [qty ?? "", unit].filter((x) => x !== "" && x !== null).join(" ").trim();
      if (amount && !new RegExp(`\\b${amount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(l)) {
        l += ` (${amount})`;
      }
      if (when && !l.toLowerCase().includes(when.toLowerCase())) l += `, ${when}`;
      return l;
    })
    .join("\n");

  await call(`/crm/plans/${plan.id}`, {
    method: "PATCH",
    body: { body, privateNote: spec.note, targets: spec.targets },
  });

  /* The rows, as Build would write them — model "syntax", because
     that is what produced them and the accuracy panel must not
     credit a language model for a seed. */
  const items = await call("/crm/plan-items", {
    method: "POST",
    body: {
      planId: plan.id,
      model: "syntax",
      items: spec.rows.map(([kind, label, quantity, unit, schedule], i) => ({
        line: i, kind, label, quantity, unit, schedule,
      })),
    },
  });

  /* She has read and confirmed every one. A seeded plan with
     unchecked rows would look like work she abandoned. */
  for (const it of items.items) {
    await call(`/crm/plan-items/${it.id}`, {
      method: "PATCH", body: { status: "confirmed", by: BY },
    });
  }

  await call(`/crm/plans/${plan.id}/issue`, { method: "POST" });
  await call(`/crm/plans/${plan.id}/link`, { method: "POST" });

  let programme = null;
  if (spec.programme) {
    const started = await call(`/crm/plans/${plan.id}/programme`, {
      method: "POST", body: { days: spec.programme },
    });
    programme = started.programme.id;
  }

  made.push({ person: spec.person, plan: plan.id, ref: plan.ref, programme, days: spec.programme });
  console.log(
    `  ${plan.ref.padEnd(18)} ${String(spec.rows.length).padStart(2)} rows` +
    (programme ? `  ${spec.programme}-day programme` : "  no programme")
  );
}

console.log(`\n${made.length} plans issued, ${made.filter((m) => m.programme).length} programmes running`);
console.log(JSON.stringify(made.filter((m) => m.programme), null, 0));
