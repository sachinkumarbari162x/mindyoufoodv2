/* ============================================================
   HOURS EDITOR — changing her week without a deploy
   ------------------------------------------------------------
   Until now her working hours lived in a config file, so moving a
   Tuesday afternoon meant an edit, a commit and a restart. These
   two small forms write to the same tables the slot engine reads,
   and the next visitor is offered the new pattern.

   BULK BY DEFAULT. The day picker takes several days at once,
   because "Tuesdays and Thursdays, 11 to 1" is one decision. A
   form that made her repeat it per day is a form she would stop
   using, and a stale pattern means the desk offers hours she is
   not working — which is worse than no pattern at all.

   The forms stay hidden until asked for: this page is mostly read,
   and two open forms above the week would make a glance cost a
   scroll.
   ============================================================ */

import { esc } from "./format.js";

const DAYS = [
  ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4],
  ["Fri", 5], ["Sat", 6], ["Sun", 0],
];

/** "11:00" → 660. The forms use <input type="time">, which always
    hands back HH:MM, so this never sees anything else. */
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

/** Today, in the practice's own reckoning — built from local parts
    rather than sliced off a UTC string, because midnight in Kolkata
    is still yesterday in UTC and the picker would offer a day the
    server then refuses. */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function render(host) {
  if (!host) return;
  host.innerHTML = `
    <form class="editor" data-band-form hidden>
      <p class="editor-title">Add a band</p>

      <div class="daypick">
        ${DAYS.map(
          ([label, dow]) => `
          <label class="daypick-day">
            <input type="checkbox" name="weekday" value="${dow}">
            <span>${esc(label)}</span>
          </label>`
        ).join("")}
      </div>

      <div class="editor-row">
        <label>From <input type="time" name="starts" value="11:00" step="900" required></label>
        <label>To <input type="time" name="ends" value="13:00" step="900" required></label>
        <button class="btn go" type="submit" data-add>Add</button>
        <button class="btn quiet" type="button" data-cancel>Cancel</button>
      </div>

      <p class="editor-note" data-band-error></p>
    </form>

    <form class="editor" data-date-form hidden>
      <p class="editor-title">Close a date</p>
      <div class="editor-row">
        <!-- The minimum is today, so the picker will not offer a day
             that has gone. A courtesy, not the rule: the server
             refuses a past date as well, because a min attribute is
             one devtools edit away from being absent. -->
        <label>Date <input type="date" name="onDate" required data-no-past></label>
        <label class="grow">Reason
          <input type="text" name="reason" maxlength="80" placeholder="Away, clinic closed…">
        </label>
        <button class="btn go" type="submit">Close it</button>
        <button class="btn quiet" type="button" data-cancel>Cancel</button>
      </div>
      <p class="editor-note" data-date-error></p>
    </form>`;

  /* Set after the markup exists, so "today" is whatever today is when
     the page opened rather than whenever this module was written. */
  for (const el of host.querySelectorAll("[data-no-past]")) el.min = todayISO();
}

/**
 * @param {object} handlers  { onAddBands, onCloseDate }  both async
 */
export function mount(host, handlers) {
  if (!host) return;

  const bandForm = host.querySelector("[data-band-form]");
  const dateForm = host.querySelector("[data-date-form]");

  const show = (form) => {
    for (const f of [bandForm, dateForm]) f.hidden = f !== form;
    form.querySelector("input")?.focus();
  };

  // The two buttons live in the section header, outside this host.
  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="add-band"]')) show(bandForm);
    if (e.target.closest('[data-act="close-date"]')) show(dateForm);
    if (e.target.closest("[data-cancel]")) {
      bandForm.hidden = true;
      dateForm.hidden = true;
    }
  });

  /* ---- is that time already covered? --------------------------
     Asked as she picks, so Add is simply not clickable when it would
     be refused. A button that looks available and then says no has
     taught her nothing except not to trust the button — and the
     refusal used to arrive as a bare HTTP 409.

     Every chosen day is checked, so picking Monday and Tuesday when
     only Monday clashes still stops the whole thing: the request
     writes all the days or none, and half a week saved is worse than
     none of it. */
  const addBtn = bandForm.querySelector("[data-add]");
  const bandErr = bandForm.querySelector("[data-band-error]");
  let checking = null;

  async function checkClash() {
    const days = [...bandForm.querySelectorAll('input[name="weekday"]:checked')].map((c) => c.value);
    const startsMin = toMinutes(bandForm.starts.value);
    const endsMin = toMinutes(bandForm.ends.value);

    if (!days.length || startsMin === null || endsMin === null || endsMin <= startsMin) {
      addBtn.disabled = !days.length;
      bandErr.textContent = "";
      bandErr.dataset.tone = "";
      return;
    }

    // One in flight at a time; she can click faster than a round trip.
    const mine = Symbol();
    checking = mine;
    try {
      const res = await fetch(
        `/api/crm/hours/clash?weekdays=${days.join(",")}&startsMin=${startsMin}&endsMin=${endsMin}`,
        { headers: { Accept: "application/json" } }
      );
      const { clashes = [] } = await res.json();
      if (checking !== mine) return; // a newer answer has landed

      if (clashes.length) {
        addBtn.disabled = true;
        bandErr.dataset.tone = "warn";
        bandErr.textContent =
          clashes.length === 1
            ? `${clashes[0].day} is already open ${clashes[0].with}.`
            : clashes.map((c) => `${c.day} (${c.with})`).join(", ") + " are already open then.";
      } else {
        addBtn.disabled = false;
        bandErr.dataset.tone = "";
        bandErr.textContent = "";
      }
    } catch {
      /* If the check itself fails, the button stays usable. The
         database still refuses an overlap, so the worst case is the
         old behaviour rather than a form she cannot submit. */
      if (checking === mine) addBtn.disabled = false;
    }
  }

  bandForm.addEventListener("change", checkClash);
  bandForm.addEventListener("input", checkClash);

  bandForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = bandForm.querySelector("[data-band-error]");
    err.textContent = "";

    const weekdays = [...bandForm.querySelectorAll('input[name="weekday"]:checked')].map((i) =>
      Number(i.value)
    );
    const startsMin = toMinutes(bandForm.starts.value);
    const endsMin = toMinutes(bandForm.ends.value);

    // Checked here as well as in Go, so the answer is immediate. The
    // server still refuses it — a check the browser can edit away is
    // not a check.
    if (!weekdays.length) return void (err.textContent = "Pick at least one day.");
    if (startsMin === null || endsMin === null) return void (err.textContent = "Both times are needed.");
    if (endsMin <= startsMin) return void (err.textContent = "The finish has to be after the start.");

    const btn = bandForm.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await handlers.onAddBands({ weekdays, startsMin, endsMin });
      bandForm.reset();
      bandForm.hidden = true;
    } catch (ex) {
      err.textContent = ex.message || "That did not save.";
    } finally {
      btn.disabled = false;
    }
  });

  dateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = dateForm.querySelector("[data-date-error]");
    err.textContent = "";

    const btn = dateForm.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await handlers.onCloseDate({
        onDate: dateForm.onDate.value,
        kind: "closed",
        reason: dateForm.reason.value.trim() || null,
      });
      dateForm.reset();
      dateForm.hidden = true;
    } catch (ex) {
      // 409 means it is already closed — a fact, not a failure.
      err.textContent =
        ex.status === 409 ? "That date is already closed." : ex.message || "That did not save.";
    } finally {
      btn.disabled = false;
    }
  });
}
