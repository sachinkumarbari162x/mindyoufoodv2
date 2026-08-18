/* ============================================================
   ACCOUNT · VIEWS
   ------------------------------------------------------------
   One function per screen. Each takes the payload and fills its
   slots; none of them fetches anything, and none of them knows
   about any other screen.

   THE PANEL DRAWS WHAT IS THERE. Every screen has a real empty
   state, because these three clients have genuinely different
   plans — one has no upcoming session, one has no training, one
   has two meals that exist only on the days she runs. A screen
   that assumes four meals is a screen that is wrong about two
   clients out of three.
   ============================================================ */
(function () {
  "use strict";

  const F = window.accountFormat;
  const esc = F.esc;

  const CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" aria-hidden="true"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHEV =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHEV_SM =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const FILE_IC =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h8l4 4v14H7z"/><path d="M14 3v5h5"/></svg>';
  const DL_IC =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>';

  const slot = (name) => document.querySelector(`[data-slot="${name}"]`);
  const slots = (name) => document.querySelectorAll(`[data-slot="${name}"]`);

  function fill(name, html) {
    slots(name).forEach((el) => {
      el.innerHTML = html;
    });
  }

  function emptyCard(title, body) {
    return `<div class="card"><div class="empty" style="padding:56px 20px">
      <h2>${esc(title)}</h2><p>${esc(body)}</p></div></div>`;
  }

  /* ---- reading the plan --------------------------------------
     Items arrive as one flat, ordered list. Which screen a line
     belongs on is its `kind`; which card it sits in is
     detail.meal. Both come from her, and neither is guessed. */

  const byKind = (items, ...kinds) =>
    (items || []).filter((i) => kinds.includes(i.kind));

  /* Meals and the supplements she attached to them, grouped into
     the cards the client sees. Ordering is by the time she wrote,
     NOT by the clock: Rajat's day starts at 19:30 and ends at
     05:00, and sorting his plan by time of day would put his last
     meal first and call it breakfast. Sequence is her intent. */
  const TODAY = F.SHORT_DAYS[new Date().getDay()];

  function mealCards(items) {
    const cards = new Map();
    (items || []).forEach((item) => {
      if (item.kind !== "meal" && item.kind !== "supplement") return;
      const key = item.detail && item.detail.meal != null ? String(item.detail.meal) : "loose";
      if (!cards.has(key)) {
        /* Her schedule reads "Meal 2 · 12:30 PM" — the half after
           the dot is the time. When she wrote something else
           entirely ("Before the run"), the whole string IS the
           time, and the old split left that card with a blank
           heading and a stray "· 105 kcal". */
        const schedule = item.schedule || "";
        const when = schedule.includes("·")
          ? schedule.split("·").slice(1).join("·").trim()
          : schedule.trim();

        cards.set(key, {
          key,
          name: key === "loose" ? "Through the day" : `Meal ${key}`,
          when,
          items: [],
          kcal: 0,
          days: (item.detail && item.detail.days) || null,
        });
      }
      const card = cards.get(key);
      card.items.push(item);
      if (item.detail && item.detail.kcal) card.kcal += Number(item.detail.kcal) || 0;
    });

    /* A LINE THAT ONLY EXISTS ON SOME DAYS DOES NOT EXIST TODAY.
       Aisha's pre-run banana is on the plan for Tuesday, Thursday
       and Sunday. On a Wednesday it must not be counted as a meal
       she missed — so the card is marked, greyed, and left out of
       the day's totals rather than removed, because knowing it is
       there tomorrow is the useful part. */
    return [...cards.values()].map((card) => ({
      ...card,
      today: !card.days || card.days.includes(TODAY),
    }));
  }

  /** One tickable line. `data-item` is the plan-item id — the only
      identifier the markup ever carries, and it is useless without
      the cookie: the server checks it is on this client's own
      current plan before writing anything. */
  function itemRow(item, ticked, right, hideAmount) {
    const d = item.detail || {};
    let label = hideAmount ? "" : F.amount(item.quantity, item.unit);

    /* NEVER SAY THE DOSE TWICE. She writes "Vitamin D 2000 IU" as
       the label AND 2000 IU as the quantity, because the CRM needs
       both — one is what she calls it, the other is what the system
       counts. Printing both gives "2000 IU Vitamin D 2000 IU". If
       the amount is already in her wording, hers wins. */
    const flat = (s) => String(s).toLowerCase().replace(/\s+/g, "");
    if (label && flat(item.label).includes(flat(label))) label = "";

    /* TWO MEASUREMENTS, AND THE KITCHEN ONE LEADS.
       "150 g of rice" is a number nobody has at eight in the
       morning; "one katori" is. So the household measure is what
       the eye lands on and the clinical amount sits behind it in
       grey — present, because it is what she prescribed and what a
       review is measured against, and second, because it is not
       what gets somebody through breakfast. */
    const household = d.household ? String(d.household) : "";
    const lead = household && !flat(item.label).includes(flat(household)) ? household : "";

    let text;
    if (lead) {
      text = `<b>${esc(lead)}</b> ${esc(item.label)}`;
      if (label) text += ` <small>· ${esc(label)}</small>`;
    } else if (label) {
      text = `<b>${esc(label)}</b> ${esc(item.label)}`;
    } else {
      text = esc(item.label);
    }

    /* HOW IT IS TAKEN, on its own line. Not a tooltip and not a
       "·" appended to the label: "keep two hours from tea or milk"
       is the instruction that decides whether the iron works at
       all, and it does not belong in a footnote. */
    const how = d.how || d.note || "";

    return `<li class="item${ticked ? " checked" : ""}" data-item="${esc(item.id)}">
      <span class="box">${CHECK}</span>
      <span class="label">${text}${
        how ? `<span class="how">${esc(how)}</span>` : ""
      }</span>
      ${right ? `<span class="reps">${esc(right)}</span>` : ""}
    </li>`;
  }

  /* When a supplement is taken, said the way she would say it. The
     enum is a database value and no client should ever be shown
     one. */
  const TIMING_WORDS = {
    empty_stomach: "On an empty stomach",
    before_meal: "Before the meal",
    with_meal: "With the meal",
    after_meal: "After the meal",
    bedtime: "At bedtime",
  };

  /** "2 hours" / "30 minutes" — for the gap between supplements. */
  function gapWords(minutes) {
    const m = Number(minutes) || 0;
    if (!m) return "";
    if (m < 60) return `${m} minutes`;
    const h = m / 60;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} ${h === 1 ? "hour" : "hours"}`;
  }

  /* ---- SUMMARY ------------------------------------------------ */

  function summary(state) {
    const now = new Date();
    const hour = now.getHours();
    const partOfDay = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

    fill("today-date", esc(F.longDay(now.toISOString())));
    fill("greeting", `${esc(partOfDay)}, ${esc(state.person.firstName || "there")}.`);

    const meals = mealCards(state.items).filter((c) => c.today);
    const tickable = meals.reduce((all, c) => all.concat(c.items), []);
    const ticked = tickable.filter((i) => state.today[i.id]).length;
    const left = tickable.length - ticked;

    /* The sentence is about today and nothing else. No streaks, no
       score: this is a health record, and a client who missed
       yesterday does not need it on the first line this morning. */
    let standing;
    if (!tickable.length) {
      standing = "Your plan is with Khadija at the moment. Everything else here is ready.";
    } else if (left === 0) {
      standing = "Everything on today's plan is ticked off. Nothing left to do.";
    } else {
      standing = `${left} ${left === 1 ? "thing" : "things"} left on today's plan.`;
    }
    fill("standing", esc(standing));

    /* Three figures, and every one of them is something she or
       the client actually recorded. There is no step count and no
       heart rate here, because nothing in this system measures
       either — inventing them would be the panel lying at a
       glance. */
    const lastSleep = (state.sleep || [])[state.sleep.length - 1];
    const prog = state.programme;
    const stats = [
      {
        k: "Today",
        n: `${ticked}<span class="u">of ${tickable.length}</span>`,
        s: tickable.length ? "meals and supplements ticked" : "nothing on the plan yet",
      },
      {
        k: "Last night",
        n: lastSleep ? F.hoursMarkup(lastSleep.value) : "—",
        s: lastSleep ? `you recorded this on ${esc(F.day(lastSleep.on))}` : "nothing recorded yet",
      },
      {
        k: "Programme",
        n: prog ? `${prog.daysLeft}<span class="u">days</span>` : "—",
        s: prog
          ? prog.expired
            ? "your plan has finished — ask her about the next one"
            : `left of ${prog.lengthDays}`
          : "no programme running",
      },
    ];
    fill(
      "today-stats",
      stats
        .map(
          (m) =>
            `<div class="metric"><div class="k">${esc(m.k)}</div>
             <div class="n">${m.n}</div><div class="s">${m.s}</div></div>`
        )
        .join("")
    );

    const pct = tickable.length ? Math.round((ticked / tickable.length) * 100) : 0;
    slots("day-bar").forEach((el) => (el.style.width = `${pct}%`));

    /* What to do next, as three things to press. The next session
       is here because it is the question a client opens this page
       to answer more often than any other. */
    const next = (state.upcoming || [])[0];
    const supplements = byKind(state.items, "supplement");
    const focus = [
      {
        route: "diet",
        icon: '<path d="M7 3v7a3 3 0 006 0V3M10 3v18"/>',
        title: "Diet",
        sub: meals.length
          ? `${meals.filter((c) => c.items.every((i) => state.today[i.id])).length} of ${meals.length} meals complete`
          : "nothing on the plan yet",
      },
      supplements.length && {
        route: "supplements",
        icon: '<rect x="3" y="9" width="12" height="6.5" rx="3.25" transform="rotate(-42 9 12.2)"/><path d="M9.5 8.2l4 4"/>',
        title: "Supplements",
        sub: `${supplements.filter((i) => state.today[i.id]).length} of ${supplements.length} taken`,
      },
      {
        route: "sessions",
        icon: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17M8 3v3M16 3v3"/>',
        title: "Next session",
        sub: next
          ? `${F.day(next.startsAt)} · ${F.time(next.startsAt)}`
          : "nothing booked — you can ask for one",
      },
    ].filter(Boolean);

    /* RECORDING A WEIGHT, on the screen they land on.

       It is a weekly ritual done first thing, so it belongs where
       the eye already is rather than three taps into an Account
       screen. The last one is shown beside the box so the number
       being typed has something to be a change FROM — a weight
       with no previous is a number, not a measurement. */
    const weights = state.weight || [];
    const last = weights[weights.length - 1];
    fill(
      "weigh-in",
      `<div class="weigh">
        <label for="weigh-kg">
          <b>Today's weight</b>
          <span>${
            last
              ? `Last: ${esc(String(last.value))} kg on ${esc(F.day(last.on))}`
              : "Nothing recorded yet"
          }</span>
        </label>
        <div class="weigh-row">
          <input id="weigh-kg" type="number" inputmode="decimal" step="0.1"
                 min="20" max="400" placeholder="${last ? esc(String(last.value)) : "0.0"}">
          <span class="weigh-unit">kg</span>
          <button class="btn" data-action="save-weight">Record</button>
        </div>
        <p class="weigh-said" data-slot="weigh-said" hidden></p>
      </div>`
    );

    fill(
      "focus",
      focus
        .map(
          (f) => `<button class="focus-row" data-route="${esc(f.route)}">
        <span class="fl">
          <span class="fic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${f.icon}</svg></span>
          <span><b>${esc(f.title)}</b><small>${esc(f.sub)}</small></span>
        </span>
        <span class="chev">${CHEV}</span>
      </button>`
        )
        .join("")
    );
  }

  /* ---- PLAN --------------------------------------------------- */

  function plan(state) {
    if (!state.plan) {
      fill("plan-lede", "");
      fill(
        "plan-sections",
        emptyCard(
          "Your plan is being written",
          "Khadija issues it after your consultation. It will be here as soon as it is ready."
        )
      );
      return;
    }

    fill(
      "plan-lede",
      esc(
        `Written for you after your consultation${
          state.plan.issuedAt ? ` on ${F.day(state.plan.issuedAt)}` : ""
        }. She keeps it current after every review.`
      )
    );

    const sections = state.plan.sections || [];
    if (!sections.length) {
      fill("plan-sections", emptyCard("Nothing written yet", "Her notes for this plan are still to come."));
      return;
    }

    /* NUMBERED, BECAUSE A PLAN IS READ IN ORDER. She writes it as
       a sequence — what we are doing, then how the day is shaped,
       then the detail — and the numerals say so. The first opens
       on arrival; the rest are one tap. */
    fill(
      "plan-sections",
      sections
        .map(
          (sec, i) => `<div class="acc${i === 0 ? " open" : ""}">
        <button class="acc-head" aria-expanded="${i === 0}">
          <span class="idx">${String(i + 1).padStart(2, "0")}</span>
          ${esc(sec.title || "Your plan")}
          <span class="chev">${CHEV_SM}</span>
        </button>
        <div class="acc-body"><div class="acc-inner">${F.prose(sec.body)}</div></div>
      </div>`
        )
        .join("")
    );
  }

  /* ---- DIET ---------------------------------------------------- */

  function diet(state) {
    fill("diet-date", esc(F.longDay(new Date().toISOString())));

    const cards = mealCards(state.items);
    const grid = slot("meal-grid");

    if (!cards.length) {
      slot("diet-ring").style.strokeDashoffset = 157;
      fill("meals-done", "No meals yet");
      fill("kcal-count", "Your plan will appear here once Khadija issues it.");
      grid.innerHTML = emptyCard(
        "No meals on your plan yet",
        "As soon as your plan is issued, every meal appears here to tick off."
      );
      return;
    }

    const todays = cards.filter((c) => c.today);
    const done = todays.filter((c) => c.items.every((i) => state.today[i.id])).length;
    const kcalDone = todays
      .filter((c) => c.items.every((i) => state.today[i.id]))
      .reduce((sum, c) => sum + c.kcal, 0);
    const kcalAll = todays.reduce((sum, c) => sum + c.kcal, 0);

    fill("meals-done", `${done}<span> of ${todays.length} meals</span>`);
    fill(
      "kcal-count",
      kcalAll
        ? `${kcalDone.toLocaleString("en-IN")} / ${kcalAll.toLocaleString("en-IN")} kcal`
        : "Tick each line as you eat it"
    );
    slot("diet-ring").style.strokeDashoffset =
      157 * (1 - (todays.length ? done / todays.length : 0));

    grid.innerHTML = cards
      .map((card) => {
        const allDone = card.items.every((i) => state.today[i.id]);
        const rows = card.items
          .map((i) => itemRow(i, !!state.today[i.id], i.kind === "supplement" ? "Supplement" : ""))
          .join("");

        // Only the parts that exist, joined — so a card with no
        // time on it does not open with a stray separator.
        const sub = [card.when, card.kcal ? `${card.kcal} kcal` : ""]
          .filter(Boolean)
          .join(" · ");

        /* A meal that only exists on some days says which. */
        const onlyOn = card.days
          ? `<div class="sub">Only on ${esc(card.days.join(", "))}</div>`
          : "";

        const state_ = !card.today ? "Not today" : allDone ? "Eaten" : "Pending";

        return `<div class="card"${card.today ? "" : ' style="opacity:.6"'}>
        <div class="c-head">
          <div>
            <h3>${esc(card.name)}</h3>
            ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
            ${onlyOn}
          </div>
          <span class="pill${allDone && card.today ? " on" : ""}">${esc(state_)}</span>
        </div>
        <ul class="items" style="margin-top:6px">${rows}</ul>
      </div>`;
      })
      .join("");

    /* ---- and what to eat between them ---------------------------
       A plan with four meals and nothing in between is a plan that
       breaks at four o'clock. These sit under the meals, on the
       same screen, because that is where the question comes up:
       somebody reads the gap between two meals and needs the
       answer to be the next thing on the page — not a tab away.

       NOT TICKABLE, and that is the point. A filler is conditional:
       ticking it would put it in the day's count and then a client
       who was not hungry has "missed" something. Nothing here
       carries data-item, so the click handler passes it by. */
    const fillers = byKind(state.items, "filler");
    const after = slot("filler-list");

    /* ANYTHING THEY WANT TO SAY, at the foot of the day.

       No row on the plan has a box for "ate out, had two chapatis
       instead" — and that sentence is worth more at a review than
       any tick on the screen above it. It is the richest thing a
       client writes and the least prompted for, so it is prompted
       for here. */
    const noteCard =
      '<div class="acc-sec">Anything to tell Khadija?</div>' +
      `<div class="card">
        <textarea class="note" data-slot="day-note" rows="2"
          placeholder="Ate out, had two chapatis instead. Or: the 4 PM meal is not working on a shift day."></textarea>
        <button class="btn" data-action="save-note" style="margin-top:12px">Send it to her</button>
        <p class="weigh-said" data-slot="note-said" hidden></p>
      </div>`;

    after.innerHTML =
      '<div class="acc-sec">If you are hungry between meals</div>' +
      `<div class="card">
        <ul class="items">${fillers
          .map((f) => {
            const d = f.detail || {};
            const amount = F.amount(f.quantity, f.unit);
            const lead = d.household || amount;
            const trail = d.household && amount ? ` <small>· ${esc(amount)}</small>` : "";
            return `<li class="item filler">
              <span class="dotmark"></span>
              <span class="label">${
                lead ? `<b>${esc(lead)}</b> ${esc(f.label)}` : esc(f.label)
              }${trail}${d.how ? `<span class="how">${esc(d.how)}</span>` : ""}</span>
            </li>`;
          })
          .join("")}</ul>
        <p class="fine-print" style="margin-top:14px">
          Any of these, when you need one. They are part of the plan, not a slip —
          and they do not need ticking off.
        </p>
      </div>` +
      noteCard;
  }

  /* ---- CALENDAR --------------------------------------------------
     The programme month by month, one mark per day.

     WHAT A DAY'S MARK MEANS, precisely: how many lines of the
     plan were ticked that day, against how many lines the plan
     has. It is a proportion of the CURRENT plan, and that is a
     real approximation — if she rewrote the plan in week three,
     week two's days are being measured against a list that has
     since changed. The alternative is storing the plan's shape
     for every day of every programme, which is a lot of rows to
     make a square slightly bluer. The screen says "of your plan"
     rather than claiming a percentage, and the client can open
     any day to see what actually happened.

     THIS IS NOT A SCORE. There is no streak, no total and no
     league table, because the person reading it lives with a
     chronic condition and a number to keep up is the thing that
     makes people stop opening an app. It is a record they can
     look at, and take to her. */

  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
                       "August", "September", "October", "November", "December"];

  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  function calendar(state) {
    const prog = state.programme;
    const holder = slot("calendar");

    if (!prog) {
      fill("cal-eyebrow", "");
      fill("cal-lede", "");
      holder.innerHTML = emptyCard(
        "No programme running",
        "Your calendar fills in day by day once a programme starts."
      );
      return;
    }

    /* How many lines there are to tick on a day. Meals and
       supplements only — movement is on its own screen and a walk
       skipped is not a meal missed. */
    const tickable = mealCards(state.items).reduce((n, c) => n + c.items.length, 0);

    const done = new Map();
    (state.days || []).forEach((d) => done.set(d.on, d));

    fill("cal-eyebrow", esc(`${F.day(prog.startedOn)} — ${F.day(prog.endsOn)}`));
    fill(
      "cal-lede",
      esc(
        "Every day of your programme. The fuller a square, the more of that day's plan you ticked off — " +
          "it is a record to look at with Khadija, not a score to keep up."
      )
    );

    const start = new Date(prog.startedOn + "T00:00:00");
    const end = new Date(prog.endsOn + "T00:00:00");
    const today = iso(new Date());

    /* One card per calendar month the programme touches, so a
       ninety-day programme is three months rather than one strip
       of ninety squares nobody can find a date in. */
    const months = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
      months.push(new Date(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }

    const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    holder.innerHTML =
      '<div class="cal-months">' +
      months
        .map((month) => {
          const year = month.getFullYear();
          const m = month.getMonth();
          const first = new Date(year, m, 1);
          const daysInMonth = new Date(year, m + 1, 0).getDate();

          // Weeks start on Monday: Sunday is the end of an Indian
          // week, not the start of one.
          const lead = (first.getDay() + 6) % 7;

          const cells = [];
          for (let i = 0; i < lead; i++) cells.push('<div></div>');

          let monthTicks = 0;
          let monthDays = 0;

          for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(year, m, d);
            const key = iso(date);
            const inside = date >= start && date <= end;
            const record = done.get(key);

            /* A PART COUNTS FOR HALF, NOT FOR NOTHING. Aisha had
               days where she recorded every line as `part` — ate
               some of it — and the square came out the same blank
               grey as a day she never opened the app. Reading
               "I did most of this" back as "you did nothing" is
               the one thing a record like this must not do. */
            let step = 0;
            if (inside && record && tickable) {
              const credit = record.done + record.part * 0.5;
              const share = credit / tickable;
              step = share >= 0.85 ? 3 : share >= 0.5 ? 2 : share > 0 ? 1 : 0;
              monthTicks += credit;
              monthDays += 1;
            }

            const ahead = inside && key > today;

            const classes = [
              "cal-day",
              !inside ? "out" : ahead ? "ahead" : `d${step}`,
              key === today ? "now" : "",
            ]
              .filter(Boolean)
              .join(" ");

            const title = !inside
              ? `${F.day(key)} — outside your programme`
              : ahead
              ? `${F.day(key)} — still to come`
              : record
              ? `${F.day(key)} — ${record.done} of ${tickable} ticked${
                  record.part ? `, ${record.part} part-done` : ""
                }${record.skip ? `, ${record.skip} skipped` : ""}`
              : `${F.day(key)} — nothing recorded`;

            cells.push(
              `<div class="${classes}" title="${esc(title)}">${d}<span class="dot"></span></div>`
            );
          }

          const average =
            monthDays && tickable ? Math.round((monthTicks / (monthDays * tickable)) * 100) : 0;

          return `<div class="cal">
        <div class="cal-head">
          <h3>${esc(MONTH_NAMES[m])} ${year}</h3>
          <span class="sub">${
            monthDays
              ? esc(`${monthDays} ${monthDays === 1 ? "day" : "days"} recorded · ${average}% of the plan`)
              : "nothing recorded yet"
          }</span>
        </div>
        <div class="cal-grid">
          ${dow.map((d) => `<div class="cal-dow">${d[0]}</div>`).join("")}
          ${cells.join("")}
        </div>
      </div>`;
        })
        .join("") +
      "</div>" +
      `<div class="cal-key">
        <span><i style="background:var(--paper)"></i> nothing recorded</span>
        <span><i style="background:#d6e9fb"></i> some of the day</span>
        <span><i style="background:#9dcdf7"></i> most of it</span>
        <span><i style="background:var(--accent)"></i> all of it</span>
        <span><i style="box-shadow:inset 0 0 0 2px var(--accent)"></i> today</span>
      </div>`;
  }

  /* ---- SLEEP --------------------------------------------------- */

  function sleep(state) {
    const window_ = byKind(state.items, "sleep")[0];
    const nights = state.sleep || [];
    const target = window_ && window_.detail ? Number(window_.detail.hours) || 0 : 0;

    const cards = [];

    if (window_) {
      const d = window_.detail || {};
      cards.push(`<div class="card">
        <div class="c-head">
          <div><h3>Your window</h3><div class="sub">${esc(window_.schedule || "Every night")}</div></div>
          ${target ? `<span class="pill on">${esc(F.hours(target))}</span>` : ""}
        </div>
        <div class="win">
          ${d.from ? `<div class="w"><b>${esc(F.clock(d.from))}</b><small>Lights out</small></div>` : ""}
          ${d.to ? `<div class="w"><b>${esc(F.clock(d.to))}</b><small>Up</small></div>` : ""}
          ${target ? `<div class="w"><b>${esc(F.hours(target))}</b><small>Target</small></div>` : ""}
        </div>
        <p style="color:var(--ink-2);font-size:15px;line-height:1.55;margin-top:20px">
          ${esc(window_.label)}
        </p>
      </div>`);
    }

    /* The last seven nights the client recorded. Not a rolling
       Mon–Sun: on a Wednesday, a Mon–Sun chart is four columns of
       nothing and a client reading it as four missed nights. */
    if (nights.length) {
      const week = nights.slice(-7);
      const peak = Math.max(target || 0, ...week.map((n) => n.value));
      const bars = week
        .map((n) => {
          const short = target && n.value < target - 0.25;
          const height = Math.max(8, Math.round((n.value / (peak || 1)) * 100));
          const letter = F.SHORT_DAYS[new Date(n.on).getDay()][0];
          return `<div class="col">
            <div class="bar${short ? " miss" : ""}" style="height:${height}%"
                 title="${esc(F.day(n.on))} · ${esc(F.hours(n.value))}"></div>
            <span class="dl">${esc(letter)}</span>
          </div>`;
        })
        .join("");

      const avg = week.reduce((s, n) => s + n.value, 0) / week.length;
      const gap = target ? avg - target : 0;
      const gapWords =
        !target
          ? "as you recorded it"
          : Math.abs(gap) < 0.1
          ? "right on your target"
          : gap < 0
          ? `${F.hours(Math.abs(gap))} below your target`
          : `${F.hours(gap)} above your target`;

      cards.push(`<div class="card">
        <div class="c-head"><div><h3>What you recorded</h3>
          <div class="sub">The last ${week.length} ${week.length === 1 ? "night" : "nights"}</div></div></div>
        <div class="week">${bars}</div>
        <div class="acc-hairline" style="margin:20px 0"></div>
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
          <b style="font-size:26px;font-weight:500;letter-spacing:-.02em">${esc(F.hours(avg))}</b>
          <span style="color:var(--ink-2);font-size:14px">average · ${esc(gapWords)}</span>
        </div>
      </div>`);
    }

    if (!cards.length) {
      slot("sleep-cards").innerHTML = emptyCard(
        "No sleep guidance yet",
        "When Khadija sets a sleep window it appears here, along with the nights you record."
      );
      return;
    }
    slot("sleep-cards").innerHTML = cards.join("");
  }

  /* ---- MOVEMENT ------------------------------------------------
     Not "Workout". Two of these three clients have a walk and a
     band circuit rather than a gym split, and calling that screen
     Workout tells a fifty-year-old on a blood-pressure plan that
     it is not for them. */

  function workout(state) {
    const moves = byKind(state.items, "activity");
    const grid = slot("workout-grid");

    if (!moves.length) {
      fill("workout-sub", "From your consultation");
      grid.innerHTML = emptyCard(
        "Nothing set yet",
        "If movement is part of your plan, Khadija adds it after your consultation and it appears here."
      );
      return;
    }

    /* Grouped by the days she wrote on each line. A line with no
       days is every day, and gets its own card first. */
    const everyDay = moves.filter((m) => !(m.detail && m.detail.days));
    const byDay = new Map();
    moves.forEach((m) => {
      const days = (m.detail && m.detail.days) || [];
      days.forEach((d) => {
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(m);
      });
    });

    const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const dayCards = [...byDay.entries()].sort(
      (a, b) => order.indexOf(a[0]) - order.indexOf(b[0])
    );

    fill(
      "workout-sub",
      esc(
        dayCards.length
          ? `${dayCards.length} training ${dayCards.length === 1 ? "day" : "days"} a week`
          : "Every day"
      )
    );

    const card = (title, sub, list) => {
      /* THE NUMBER GOES ON ONE SIDE OR THE OTHER, never both.
         Left it read "3 set Strength — squat, row, press … 3 × 10"
         and "Easy run, 5 km … 5 km". On this screen the right-hand
         column is where the amount lives, so the label is left as
         she wrote it. */
      const rows = list
        .map((m) => {
          const d = m.detail || {};
          const right = d.sets
            ? `${d.sets} × ${d.reps || "—"}`
            : F.amount(m.quantity, m.unit);
          return itemRow(m, !!state.today[m.id], right, true);
        })
        .join("");
      const allDone = list.every((m) => state.today[m.id]);
      return `<div class="card">
        <div class="c-head">
          <div><h3>${esc(title)}</h3><div class="sub">${esc(sub)}</div></div>
          <span class="pill${allDone ? " on" : ""}">${allDone ? "Done" : "Pending"}</span>
        </div>
        <ul class="items" style="margin-top:6px">${rows}</ul>
      </div>`;
    };

    const html = [];
    if (everyDay.length) html.push(card("Every day", "Whatever else is on", everyDay));
    const DAY_FULL = {
      Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
      Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
    };
    dayCards.forEach(([day, list]) => {
      const d = list[0].detail || {};
      /* Not the schedule — a card headed "Tue" whose subtitle
         reads "Tue / Thu" tells the reader nothing they cannot
         see. What belongs here is how the session is meant to
         feel: the rest between sets, or the pace. */
      const sub = d.restSeconds
        ? `${d.restSeconds} sec between sets`
        : d.pace
        ? `${d.pace} pace`
        : DAY_FULL[day] || "";
      html.push(card(day, sub, list));
    });
    grid.innerHTML = html.join("");
  }

  /* ---- SUPPLEMENTS --------------------------------------------- */

  /* GROUPED BY WHEN THEY ARE TAKEN, not listed in plan order.

     Iron after food and thyroxine on an empty stomach are not two
     entries on a list — they are two different moments in a day,
     and a client reading one list top to bottom takes them
     together. The order below is the order of a meal, so the
     screen reads as a sequence somebody lives rather than as an
     inventory. */
  const TIMING_ORDER = ["empty_stomach", "before_meal", "with_meal", "after_meal", "bedtime", ""];

  function supplements(state) {
    const list = byKind(state.items, "supplement");
    const holder = slot("supp-card");

    if (!list.length) {
      holder.innerHTML = emptyCard(
        "Nothing prescribed",
        "Khadija has not put any supplements on your plan. That is a decision, not an omission."
      );
      return;
    }

    const taken = list.filter((i) => state.today[i.id]).length;

    const groups = new Map();
    list.forEach((item) => {
      const key = (item.detail && item.detail.timing) || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });

    const cards = TIMING_ORDER.filter((k) => groups.has(k))
      .map((key) => {
        const items = groups.get(key);
        const rows = items
          .map((i) =>
            itemRow(i, !!state.today[i.id], (i.schedule || "").split("·")[0].trim())
          )
          .join("");

        /* THE GAP, SAID ONCE AT THE TOP OF THE GROUP. It is a
           property of the whole moment — "keep these two hours from
           tea" — and repeating it on every row turns the one thing
           somebody has to remember into wallpaper. */
        const gaps = items
          .map((i) => (i.detail && i.detail.gapMinutes) || 0)
          .filter(Boolean);
        const gap = gaps.length ? Math.max(...gaps) : 0;

        const allDone = items.every((i) => state.today[i.id]);

        return `<div class="card" style="margin-bottom:16px">
          <div class="c-head">
            <div>
              <h3>${esc(TIMING_WORDS[key] || "Through the day")}</h3>
              ${
                gap
                  ? `<div class="sub">Keep ${esc(gapWords(gap))} from tea, coffee, milk or another supplement</div>`
                  : ""
              }
            </div>
            <span class="pill${allDone ? " on" : ""}">${
              allDone ? "Taken" : `${items.filter((i) => state.today[i.id]).length} of ${items.length}`
            }</span>
          </div>
          <ul class="items" style="margin-top:6px">${rows}</ul>
        </div>`;
      })
      .join("");

    holder.innerHTML =
      `<p class="acc-lede" style="margin:0 0 20px">${
        taken === list.length
          ? "Everything for today is taken."
          : `${taken} of ${list.length} taken today.`
      }</p>` + cards;
  }

  /* ---- SESSIONS ------------------------------------------------- */

  function sessions(state) {
    const upcoming = state.upcoming || [];
    const past = state.past || [];
    const html = [];

    html.push('<div class="acc-sec">Upcoming</div>');
    if (upcoming.length) {
      html.push(
        upcoming
          .map((s) => {
            const b = F.badge(s.startsAt);
            const how = [
              F.time(s.startsAt),
              s.minutes ? `${s.minutes} min` : "",
              s.mode === "in_person" ? "In person" : s.mode === "audio" ? "Phone call" : "Video call",
            ]
              .filter(Boolean)
              .join(" · ");
            return `<div class="card session">
          <div class="date-badge"><span class="m">${esc(b.m)}</span><span class="d">${esc(b.d)}</span></div>
          <div class="sm"><b>${esc(s.issue)}</b><small>${esc(how)}</small></div>
          <span class="pill${s.status === "confirmed" ? " on" : ""}">${
              s.status === "confirmed" ? "Confirmed" : "Holding"
            }</span>
        </div>`;
          })
          .join("")
      );
    } else {
      html.push(
        `<div class="card"><div class="empty" style="padding:44px 20px">
          <h2>Nothing booked</h2>
          <p>When you are ready to be seen again, ask below.</p>
        </div></div>`
      );
    }

    /* THE COPY IS THE HONEST PART. Asking is not booking: she
       offers a time and the hour is confirmed when it is paid for.
       The button posts a request and says so — anything warmer
       here would leave somebody expecting a call. */
    html.push(`<div class="card req" style="margin-top:20px">
      <div class="rt">
        <b>Need to be seen sooner?</b>
        <p data-slot="req-note">Send a request and Khadija will offer you a time. Nothing is booked until it is confirmed and paid for.</p>
      </div>
      <button class="btn" data-action="ask-session">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        Ask for a session
      </button>
    </div>`);

    if (past.length) {
      html.push('<div class="acc-sec">Past</div>');
      html.push(
        past
          .map((s) => {
            const b = F.badge(s.startsAt);
            const when = s.startsAt ? F.shortDate(s.startsAt) : "Requested";
            return `<div class="card session done">
          <div class="date-badge"><span class="m">${esc(b.m || "—")}</span><span class="d">${esc(b.d || "")}</span></div>
          <div class="sm"><b>${esc(s.issue)}</b><small>${esc(when)}${
              s.minutes ? ` · ${s.minutes} min` : ""
            }</small></div>
        </div>`;
          })
          .join("")
      );
    }

    slot("sessions").innerHTML = html.join("");
  }

  /* ---- HEALTH RECORDS -------------------------------------------- */

  function records(state) {
    const docs = state.documents || [];
    if (!docs.length) {
      slot("rec-list").innerHTML =
        '<p style="color:var(--ink-3);font-size:16px;padding:6px 2px">Nothing here yet — add a report above and Khadija will see it.</p>';
      return;
    }

    slot("rec-list").innerHTML = docs
      .map((d) => {
        const who = d.uploadedBy === "practitioner" ? "From Khadija" : "You added this";
        const kind = d.kind === "other" ? "Document" : d.kind[0].toUpperCase() + d.kind.slice(1);
        return `<div class="card rec">
        <span class="fi">${FILE_IC}</span>
        <div class="rm-meta">
          <b>${esc(d.title)}</b>
          <small>${esc(kind)} · ${esc(who)} · ${esc(F.bytes(d.bytes))} · ${esc(F.shortDate(d.uploadedAt))}</small>
        </div>
        <button class="icon-btn" data-download="${esc(d.id)}" title="Download" aria-label="Download ${esc(d.title)}">${DL_IC}</button>
      </div>`;
      })
      .join("");
  }

  /* ---- QUESTIONS -------------------------------------------------- */

  function faq(state) {
    const questions = state.questions || [];
    if (!questions.length) {
      slot("faq-list").innerHTML = emptyCard(
        "No questions written yet",
        "Khadija adds answers here as they come up. Ask her anything in the meantime."
      );
      return;
    }
    slot("faq-list").innerHTML = questions
      .map(
        (q) => `<div class="acc">
      <button class="acc-head" aria-expanded="false">
        <span class="idx">?</span>${esc(q.q)}<span class="chev">${CHEV_SM}</span>
      </button>
      <div class="acc-body"><div class="acc-inner">${F.prose(q.a)}</div></div>
    </div>`
      )
      .join("");
  }

  /* ---- ACCOUNT ----------------------------------------------------- */

  function account(state) {
    const p = state.person;
    const prog = state.programme;
    const html = [];

    html.push(`<div class="card" style="margin-top:34px">
      <div class="acct-hero">
        <div class="avatar">${esc(F.initials(p.name))}</div>
        <div>
          <h3>${esc(p.name)}</h3>
          <p>${esc(p.email)}</p>
          ${
            prog
              ? `<span class="tag">${
                  prog.expired ? "Programme finished" : `${prog.lengthDays}-day programme`
                }</span>`
              : ""
          }
        </div>
      </div>
    </div>`);

    /* ENTITLEMENT SAID AS A DATE, not as a badge reading "active".
       The date is the thing worth knowing, and the sentence under
       it says what survives the date — because the fear a client
       has at the end of a programme is losing their records. */
    if (prog) {
      const pct = Math.min(
        100,
        Math.round(((prog.lengthDays - prog.daysLeft) / prog.lengthDays) * 100)
      );
      html.push(`<div class="card" style="margin-top:20px">
        <div class="row-eyebrow">Your programme</div>
        <div style="padding:14px 26px 26px">
          <div style="font-size:26px;font-weight:600;letter-spacing:-.02em">${
            prog.expired
              ? `Finished on ${esc(F.day(prog.endsOn))}`
              : `Runs until ${esc(F.day(prog.endsOn))}`
          }</div>
          <div style="color:var(--ink-2);font-size:15px;margin-top:4px">
            ${
              prog.expired
                ? "Ask Khadija about the next one whenever you are ready."
                : `${prog.daysLeft} of ${prog.lengthDays} days left`
            }
          </div>
          <div class="track" style="margin-top:16px"><i style="width:${pct}%"></i></div>
          <p style="color:var(--ink-3);font-size:13px;line-height:1.6;margin-top:14px;max-width:52ch">
            When a programme ends you keep this account, your health records and every receipt.
            The daily plan is what stops.
          </p>
        </div>
      </div>`);
    }

    html.push(`<div class="card" style="margin-top:20px">
      <div class="row-eyebrow">Your details</div>
      <div class="rows">
        <div class="info-row"><span class="k">Name</span><span class="v">${esc(p.name)}</span></div>
        <div class="info-row"><span class="k">Email</span><span class="v">${esc(p.email)}</span></div>
        ${p.phone ? `<div class="info-row"><span class="k">Phone</span><span class="v">${esc(p.phone)}</span></div>` : ""}
        <div class="info-row"><span class="k">With the practice since</span><span class="v">${esc(F.shortDate(p.since))}</span></div>
      </div>
      <p style="color:var(--ink-3);font-size:13px;line-height:1.6;padding:4px 26px 22px;max-width:52ch">
        To change any of these, tell Khadija — she keeps the record, so it is corrected in one place.
      </p>
    </div>`);

    /* What they agreed to, in their words. It belongs on the
       account rather than on the plan: this is the thing they
       said yes to, and it outlasts any one week's plan. */
    if ((state.goals || []).length) {
      html.push(`<div class="card" style="margin-top:20px">
        <div class="row-eyebrow">What we are working on</div>
        <div class="rows">
          ${state.goals
            .map(
              (g) => `<div class="info-row">
                <span class="k">${esc(g.goal)}</span>
                <span class="v">${g.dueOn ? esc(`by ${F.day(g.dueOn)}`) : ""}</span>
              </div>`
            )
            .join("")}
        </div>
      </div>`);
    }

    if ((state.labs || []).length) {
      html.push(`<div class="card" style="margin-top:20px">
        <div class="row-eyebrow">Your last results</div>
        <div class="rows">
          ${state.labs
            .map(
              (l) => `<div class="lab">
                <span class="lk">${esc(F.metricName(l.metric))}
                  <small>${esc(F.shortDate(l.takenAt))}${
                l.refLow != null && l.refHigh != null
                  ? ` · normal ${l.refLow}–${l.refHigh} ${esc(l.unit)}`
                  : ""
              }</small></span>
                <span class="lv">${esc(String(l.value))}<u>${esc(l.unit)}</u>
                  <span class="band ${esc(l.band)}">${esc(F.band(l.band))}</span></span>
              </div>`
            )
            .join("")}
        </div>
        <p style="color:var(--ink-3);font-size:13px;line-height:1.6;padding:4px 26px 22px;max-width:52ch">
          These are from the reports on file. A number outside the normal range is something to
          discuss with Khadija or your doctor — it is not, on its own, a diagnosis.
        </p>
      </div>`);
    }

    if ((state.receipts || []).length) {
      html.push(`<div class="card" style="margin-top:20px">
        <div class="row-eyebrow">Receipts</div>
        <div class="rows">
          ${state.receipts
            .map(
              (r) => `<div class="info-row">
                <span class="k">${esc(r.description)}<br>
                  <small style="color:var(--ink-3)">${esc(r.number)} · ${esc(F.shortDate(r.issuedAt))}</small></span>
                <span class="v">${esc(F.money(r.amountMinor, r.currency))}</span>
              </div>`
            )
            .join("")}
        </div>
      </div>`);
    }

    html.push(`<p style="color:var(--ink-3);font-size:13px;line-height:1.6;margin-top:24px;max-width:56ch">
      Your records are visible to you and to Khadija, and to nobody else.
      To have them removed entirely, ask her — it is your record and your decision.
    </p>`);

    html.push('<button class="sign-out" data-action="sign-out">Sign out</button>');

    slot("account").innerHTML = html.join("");
    fill("nav-name", esc(p.firstName || "Account"));
  }

  window.accountViews = {
    summary, plan, diet, calendar, sleep, workout, supplements, sessions, records, faq, account,
  };
})();
