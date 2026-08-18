/* ============================================================
   DATABASE — every table, master view
   ============================================================ */

import * as masthead from "../masthead.js";
import * as datatable from "../datatable.js";
import { $, setTally, markSource } from "../page.js";

masthead.mount("database");

datatable
  .mount({
    tablesHost: $("[data-tables]"),
    rowsHost: $("[data-rows]"),
    pagerHost: $("[data-pager]"),
    titleHost: $("[data-title]"),
  })
  .then(({ count }) => {
    setTally("tables", count);
    // Straight from Postgres, so it is real by definition — there is
    // no sample fallback on this page and there must not be one.
    markSource(true);
  })
  .catch(() => {
    $("[data-rows]").innerHTML =
      `<p class="empty">The data service is not answering, so there is nothing to show.</p>`;
    markSource(false);
  });
