/* ============================================================
   UPCOMING — everything confirmed beyond today
   ============================================================ */

import * as api from "../api.js";
import * as rows from "../rows.js";
import { start, fill, setTally } from "../page.js";

start("upcoming", api.upcoming, (data) => {
  fill("upcoming", data.upcoming, rows.session);
  setTally("upcoming", data.upcoming.length);
});
