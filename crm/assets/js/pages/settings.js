/* ============================================================
   SETTINGS — the four numbers every offered slot is built from
   ------------------------------------------------------------
   Saved on change rather than behind a Save button. There are
   four fields and each is independent, so a form-wide submit
   would only add a step and a chance to lose an edit.
   ============================================================ */

import * as api from "../api.js";
import * as settingsPanel from "../settings-panel.js";
import { start, $ } from "../page.js";

start("settings", api.settings, (data) => {
  settingsPanel.draw($("[data-settings]"), data.settings);
}).then(() => {
  document.addEventListener("change", async (e) => {
    const input = e.target.closest("[data-set]");
    if (!input) return;

    const previous = input.defaultValue;
    input.disabled = true;
    try {
      await api.saveSettings({ [input.dataset.set]: Number(input.value) });
      input.defaultValue = input.value; // the new value to revert to
    } catch {
      // Put the old number back rather than leaving a figure on
      // screen that the system does not actually hold.
      input.value = previous;
    } finally {
      input.disabled = false;
    }
  });
});
