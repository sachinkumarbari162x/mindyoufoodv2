/* ============================================================
   PEOPLE — one record per person, however often they book
   ============================================================ */

import * as api from "../api.js";
import * as rows from "../rows.js";
import { start, fill, setTally } from "../page.js";

start("people", api.people, (data) => {
  fill("people", data.people, rows.person);
  setTally("people", data.people.length);
});
