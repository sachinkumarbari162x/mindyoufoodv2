/* ============================================================
   MESSAGES — what the system sent, and whether it arrived
   ------------------------------------------------------------
   A failed message is the one thing here that needs acting on,
   so it is the only row that carries a button.
   ============================================================ */

import * as api from "../api.js";
import * as rows from "../rows.js";
import * as masthead from "../masthead.js";
import { start, fill, setTally, markSource } from "../page.js";

function paint(data) {
  fill("messages", data.messages, rows.message);
  setTally("messages", data.messages.length);
}

start("messages", api.messages, paint).then(() => {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-retry]");
    if (!btn) return;

    btn.disabled = true;
    try {
      await api.retryMessage(btn.dataset.retry);
      const { data, live } = await api.messages();
      masthead.setCounts(data.counts);
      paint(data);
      markSource(live);
    } catch {
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  });
});
