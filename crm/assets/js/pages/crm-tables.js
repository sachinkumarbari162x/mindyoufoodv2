/* ============================================================
   CRM TABLES — the crm schema only
   ------------------------------------------------------------
   Same component as the master view, one filter's difference.
   The filter is applied to what the server returned rather than
   asked for in the request, so the two pages can never disagree
   about which tables exist.
   ============================================================ */

import * as masthead from "../masthead.js";
import * as datatable from "../datatable.js";
import { $, setTally, markSource } from "../page.js";

masthead.mount("crm-tables");

datatable
  .mount({
    tablesHost: $("[data-tables]"),
    rowsHost: $("[data-rows]"),
    pagerHost: $("[data-pager]"),
    titleHost: $("[data-title]"),
    filter: (t) => t.schema === "crm",
  })
  .then(({ count }) => {
    setTally("tables", count);
    markSource(true);
  })
  .catch(() => {
    $("[data-rows]").innerHTML =
      `<p class="empty">The data service is not answering, so there is nothing to show.</p>`;
    markSource(false);
  });
