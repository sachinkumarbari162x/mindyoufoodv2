/* ============================================================
   COUNTRY PICKER — pick from the list, never spell it
   ------------------------------------------------------------
   Built because the desk used to take whatever was typed. "Indea"
   was accepted, matched nothing in crm.countries, and the booking
   saved with no country at all — no error, nothing in the record
   to say one had ever been given.

   The server side of that is fixed. This is the other half: the
   value that leaves this control is an ISO-2 code chosen from the
   real list, so there is no spelling for anyone to get wrong.

   No dependencies, no framework, one <script> tag. It is used by
   the booking form and it is deliberately not tied to it, because
   the CRM will want the same control.

       const picker = CountryPicker.mount(el, { onPick });
       picker.value()        // -> "GB" | null

   Search matches the START of a word, not any substring: typing
   "ind" should offer India before it offers Finland. That is one
   line of code and the difference between a list that feels like
   it is helping and one that feels broken.
   ============================================================ */
(function (global) {
  "use strict";

  var CACHE = null; // the fetch is shared by every picker on a page
  var URL_DEFAULT = "/api/countries";

  /* The endpoint is an argument rather than a constant because this
     control is meant to be reused — the CRM is served from the same
     origin but not the same path, and a hard-coded relative URL is
     the kind of thing that only shows up as a bug once it is copied
     somewhere else. */
  function load(url) {
    if (CACHE) return CACHE;
    CACHE = fetch(url || URL_DEFAULT, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (d) {
        return d.countries || [];
      })
      .catch(function () {
        /* No list means no picker. The caller is told, and shows a
           plain text field instead — being unable to offer a menu is
           not a reason to block a booking. */
        CACHE = null;
        return [];
      });
    return CACHE;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /** Does an alias match what they typed, or start with it? */
  function aliasHit(row, q) {
    var a = row.aliases || [];
    for (var i = 0; i < a.length; i++) {
      if (a[i] === q || a[i].indexOf(q) === 0) return true;
    }
    return false;
  }

  /** Word-start match, so "ind" finds India before Finland. */
  function matches(row, q) {
    if (!q) return true;
    var name = row.name.toLowerCase();
    if (name.indexOf(q) === 0) return true;
    if (row.iso2.toLowerCase() === q) return true;
    /* The aliases the server sends with the list. Without these,
       "uk" offered Ukraine and not the United Kingdom — the single
       most likely thing a British visitor types. They are served
       rather than copied here, so the desk and the dropdown cannot
       disagree about what "uk" means. */
    if (aliasHit(row, q)) return true;
    // any word after a space or hyphen
    return new RegExp("(^|[\\s-])" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(name);
  }

  function rank(a, b, q) {
    // Hers first while nothing is typed; once searching, best match wins.
    if (!q) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return 0;
    }
    /* An exact alias outranks all of it: somebody typing "uk" has
       said precisely what they mean, and Ukraine sharing two letters
       is a coincidence, not a candidate. */
    var aExact = (a.aliases || []).indexOf(q) !== -1;
    var bExact = (b.aliases || []).indexOf(q) !== -1;
    if (aExact !== bExact) return aExact ? -1 : 1;

    var aStarts = a.name.toLowerCase().indexOf(q) === 0;
    var bStarts = b.name.toLowerCase().indexOf(q) === 0;
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return a.name.localeCompare(b.name);
  }

  function mount(host, opts) {
    opts = opts || {};
    var chosen = null;
    var rows = [];
    var open = false;
    var active = -1;

    host.classList.add("cpick");
    host.innerHTML =
      '<input class="cpick-input" type="text" autocomplete="off" spellcheck="false" ' +
      'role="combobox" aria-expanded="false" aria-autocomplete="list" ' +
      'placeholder="' + esc(opts.placeholder || "Start typing your country") + '" />' +
      '<ul class="cpick-list" role="listbox" hidden></ul>';

    var input = host.querySelector(".cpick-input");
    var list = host.querySelector(".cpick-list");

    function shown() {
      var q = input.value.trim().toLowerCase();
      // Chosen already and untouched: show everything, not one row.
      if (chosen && input.value === chosen.name) q = "";
      return rows
        .filter(function (r) { return matches(r, q); })
        .sort(function (a, b) { return rank(a, b, q); })
        .slice(0, 8);
    }

    function draw() {
      var items = shown();
      if (!items.length || !open) {
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
        return;
      }
      list.innerHTML = items
        .map(function (r, i) {
          return (
            '<li role="option" data-iso="' + r.iso2 + '"' +
            (i === active ? ' aria-selected="true" class="is-active"' : "") +
            "><span>" + esc(r.name) + "</span>" +
            (r.dialCode ? '<span class="cpick-dial">' + esc(r.dialCode) + "</span>" : "") +
            "</li>"
          );
        })
        .join("");
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    function pick(iso) {
      var row = rows.find(function (r) { return r.iso2 === iso; });
      if (!row) return;
      chosen = row;
      input.value = row.name;
      open = false;
      draw();
      if (opts.onPick) opts.onPick({ iso2: row.iso2, name: row.name, dialCode: row.dialCode });
    }

    input.addEventListener("focus", function () { open = true; draw(); });

    input.addEventListener("input", function () {
      // Typing after choosing means they are changing their mind, so
      // the old choice must not survive as a hidden value.
      chosen = null;
      open = true;
      active = -1;
      draw();
    });

    input.addEventListener("keydown", function (e) {
      var items = shown();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!open) { open = true; }
        active += e.key === "ArrowDown" ? 1 : -1;
        if (active < 0) active = items.length - 1;
        if (active >= items.length) active = 0;
        draw();
      } else if (e.key === "Enter") {
        if (open && items[active]) { e.preventDefault(); pick(items[active].iso2); }
      } else if (e.key === "Escape") {
        open = false;
        draw();
      }
    });

    list.addEventListener("mousedown", function (e) {
      // mousedown, not click: blur would close the list first.
      var li = e.target.closest("li[data-iso]");
      if (li) { e.preventDefault(); pick(li.dataset.iso); }
    });

    document.addEventListener("click", function (e) {
      if (!host.contains(e.target)) { open = false; draw(); }
    });

    input.addEventListener("blur", function () {
      /* Free text is never kept. If they typed something and did not
         choose, the box is cleared rather than left looking answered
         — a field that reads "Indea" while holding nothing is exactly
         the silence this control exists to end. */
      setTimeout(function () {
        if (!chosen && input.value) input.value = "";
      }, 120);
    });

    var api = {
      value: function () { return chosen ? chosen.iso2 : null; },
      name: function () { return chosen ? chosen.name : null; },
      dialCode: function () { return chosen ? chosen.dialCode : null; },
      set: function (iso) { pick(iso); },
      focus: function () { input.focus(); },
      ready: function () { return rows.length > 0; },
    };

    load(opts.url).then(function (list) {
      rows = list;
      if (!rows.length && opts.onUnavailable) opts.onUnavailable();
      draw();
    });

    return api;
  }

  global.CountryPicker = { mount: mount, load: load };
})(window);
