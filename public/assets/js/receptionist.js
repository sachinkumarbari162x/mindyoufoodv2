/* ============================================================
   THE RECEPTIONIST — front desk widget

   Replaces the consultation form. A conversation collects the
   same fields the form did, reads them back on a review card,
   and only then submits.

   Division of labour, deliberately:
     · this file        — DOM, focus, transport, optimistic echo
     · services/node-bff — sessions, ALL business rules, booking
     · services/py-ai    — Groq, wording, field extraction

   The client never decides whether a slot is bookable, whether
   the office is open, or whether a draft is complete. It renders
   what the server says. Every rule is enforced server-side even
   though some are mirrored here for immediate feedback, because
   anything this file checks can be edited in a console.

   Builds its own DOM so index.html carries only the static
   entry panel — which keeps working with scripting off.
   ============================================================ */
"use strict";

(function () {
  const API = window.RECEPTIONIST_API || "/api/chat";
  const STORE_KEY = "myf-rcp-session";
  const MAX_CHARS = 800;
  // How long a reply may take before the desk acknowledges the wait.
  // Comfortably past a normal turn, so it only appears when something
  // really is slow rather than on every message.
  const SLOW_REPLY_MS = 4500;

  /* Palette handed to the canvas. Read from the CSS tokens so the
     scenes and the UI can never drift apart — change tokens.css
     and the ambient scenes follow. */
  function readPalette(el) {
    const cs = getComputedStyle(el);
    const v = (n, fallback) => (cs.getPropertyValue(n) || "").trim() || fallback;
    return {
      ink: v("--rcp-ink", "#14100c"),
      inkSoft: v("--rcp-ink-soft", "#6b5c4d"),
      cream: v("--rcp-cream", "#f6efe2"),
      amber: v("--rcp-amber", "#c88a24"),
      sage: v("--rcp-sage", "#7d9070"),
      sageDeep: v("--rcp-sage-deep", "#5c6e50"),
      rust: v("--rcp-rust", "#a8492a"),
      rustDeep: v("--rcp-rust-deep", "#7f3319"),
    };
  }

  const svg = (paths, extra) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true"${extra || ""}>${paths}</svg>`;

  const ICON = {
    chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    send: svg('<path d="M4 12h15M13 6l6 6-6 6"/>'),
    restart: svg('<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4"/>'),
  };

  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );

  /* ---- transport ----------------------------------------------
     One helper so every call gets the same timeout and the same
     shape of failure. A dead API must degrade to "here is how to
     reach a human", never to a spinner that never resolves. */
  async function call(path, body, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 25000);
    try {
      const res = await fetch(API + path, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.payload = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ============================================================ */
  function mount(root) {
    const palette = readPalette(root);

    /* Two modes.

       "widget" — floating launcher over another page. Not used on
       the marketing site any more, but kept working: the whole
       desk is one component, and having it only function as a
       full page would make it unembeddable later.

       "page"   — consult.html. The desk IS the page, so it opens
       on load, there is no launcher to press, and closing means
       going back to the site rather than revealing a page behind
       it. This is what the main page links to, and it is why
       index.html loads none of this file's ~30 kB or the canvas.  */
    const pageMode = root.dataset.mode === "page";

    /* ---- DOM ---- */
    root.insertAdjacentHTML(
      "beforeend",
      `
      <div class="rcp-stage" aria-hidden="true"></div>
      <p class="rcp-scene-name" aria-hidden="true"></p>

      <button class="rcp-launcher" type="button" aria-expanded="false" aria-controls="rcpWindow">
        <span class="rcp-launcher-icon">${ICON.chat}</span>
        <span class="rcp-launcher-label">Book a consultation</span>
        <span class="rcp-launcher-dot" aria-hidden="true"></span>
      </button>

      <section class="rcp-window" id="rcpWindow" role="dialog" aria-modal="false"
               aria-labelledby="rcpName" tabindex="-1">
        <header class="rcp-head">
          <span class="rcp-avatar" aria-hidden="true">MYF</span>
          <div class="rcp-ident">
            <!-- A greeting, not a department.

                 "Front desk" is what this IS; it is not what somebody
                 wants to be met by. The hours line that sat under it
                 has gone too: it said "Closed · replies from 10:00"
                 above a window that was working perfectly well, which
                 reads as a shut door. When being closed actually
                 changes the answer, the desk says so in the
                 conversation, where it belongs. -->
            <h2 class="rcp-name" id="rcpName">Hello — how are you?</h2>
          </div>
          <div class="rcp-head-actions">
            <button class="rcp-icon-btn" type="button" data-act="close"
                    title="Close" aria-label="Close the front desk">${ICON.close}</button>
          </div>
        </header>

        <!-- What the desk says about its own state: closed, shut for a
             holiday, or having a slow moment. Server-decided and empty
             most of the time; hidden entirely when there is nothing to
             say, so it never sits there as a blank band. -->
        <p class="rcp-notice" data-notice hidden></p>

        <div class="rcp-log" data-log role="log" aria-live="polite" aria-relevant="additions"></div>

        <div class="rcp-foot">
          <form class="rcp-composer" data-composer>
            <label class="rcp-sr-only" for="rcpInput">Message the front desk</label>
            <textarea class="rcp-input" id="rcpInput" rows="1" autocomplete="off"
                      placeholder="Type your message…" maxlength="${MAX_CHARS}"></textarea>
            <span class="rcp-count" data-count aria-hidden="true"></span>
            <button class="rcp-send" type="submit" aria-label="Send">${ICON.send}</button>
          </form>
        </div>
      </section>`
    );

    const stageEl = root.querySelector(".rcp-stage");
    const captionEl = root.querySelector(".rcp-scene-name");
    const launcher = root.querySelector(".rcp-launcher");
    const win = root.querySelector(".rcp-window");
    const log = root.querySelector("[data-log]");
    const form = root.querySelector("[data-composer]");
    const input = root.querySelector(".rcp-input");
    const sendBtn = root.querySelector(".rcp-send");
    const countEl = root.querySelector("[data-count]");
    /* The hours line was removed from the header. Kept as a lookup
       rather than deleted outright because two places still set it,
       and a null here is quieter than a crash there. */
    const presenceEl = root.querySelector("[data-presence]");
    const noticeEl = root.querySelector("[data-notice]");

    /* THE AMBIENT STAGE IS OPTIONAL NOW.

       consult.html stopped loading ambient-canvas.js when the
       background moved to atmosphere.css — and this line, which
       assumed it was always there, threw. A throw inside mount()
       is not a missing background: it abandons the whole desk, so
       the window never opened at all. The page was a blank room.

       Guarded rather than deleted, because the stage still exists
       and something may want it again. When it is absent every
       call below is a no-op, which is exactly what a background
       that is now painted in CSS should be. */
    const stage = typeof window.createAmbientStage === "function"
      ? window.createAmbientStage({ mount: stageEl, caption: captionEl, palette })
      : { set() {}, setPalette() {}, start() {}, stop() {}, destroy() {} };

    /* ---- state ---- */
    let sessionId = null;
    let busy = false;
    let started = false;
    let lastFocus = null;
    let typingEl = null;
    let patience = null;

    try {
      sessionId = sessionStorage.getItem(STORE_KEY);
    } catch {
      /* private mode — a fresh session each load is an acceptable cost */
    }

    /* ---- the transcript, kept in the browser ----------------------
       On THIS machine, in localStorage, and nowhere else. The server
       holds the booking draft because it has to validate it; what was
       said is the visitor's, and there is no reason for us to keep a
       copy of it to redraw a window.

       So a reload finds the conversation where it was left. If the
       browser has nothing — cleared, private mode, a different
       machine — there is simply no history, which is the honest
       outcome and needs no warning. */
    const LOG_KEY = "myf-desk-log";
    const LOG_MAX = 40; // enough to scroll back through, not a diary

    function saveLog() {
      try {
        const kept = [...log.querySelectorAll(".rcp-msg")].slice(-LOG_MAX).map((el) => ({
          from: el.dataset.from,
          text: el.textContent,
          tone: el.dataset.tone || "",
        }));
        localStorage.setItem(LOG_KEY, JSON.stringify({ sessionId, at: Date.now(), kept }));
      } catch {
        /* full or blocked — the conversation still works, it just
           will not survive a reload */
      }
    }

    function loadLog() {
      try {
        const raw = localStorage.getItem(LOG_KEY);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        // A day old is not a conversation any more, it is a diary.
        if (!saved.kept?.length || Date.now() - saved.at > 24 * 3600e3) return null;

        /* Drop any resume cues an earlier build saved as messages.
           Without this, everybody who reloaded while that bug was
           live keeps their pile of them for a day. */
        saved.kept = saved.kept.filter(
          (m) => !/^picking up where we left off/i.test(String(m.text || "").trim())
        );
        if (!saved.kept.length) return null;
        return saved;
      } catch {
        return null;
      }
    }

    function forgetLog() {
      try {
        localStorage.removeItem(LOG_KEY);
      } catch { /* nothing to do */ }
    }

    /* ---- rendering ---- */
    function atBottom() {
      return log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    }

    function scroll(force) {
      // Never yank the view if the visitor has scrolled up to re-read
      // something — only follow when they were already at the bottom.
      if (force || atBottom()) log.scrollTop = log.scrollHeight;
    }

    function bubble(from, text, tone) {
      const stick = atBottom();
      const el = document.createElement("div");
      el.className = "rcp-msg";
      el.dataset.from = from;
      if (tone) el.dataset.tone = tone;
      el.innerHTML = String(text)
        .split(/\n{2,}/)
        .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
      log.appendChild(el);
      scroll(stick);
      saveLog();
      return el;
    }

    function chips(items) {
      root.querySelectorAll(".rcp-chips").forEach((n) => n.remove());
      if (!items || !items.length) return;
      const wrap = document.createElement("div");
      wrap.className = "rcp-chips";
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-label", "Suggested replies");
      for (const label of items.slice(0, 5)) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "rcp-chip";
        b.textContent = label;
        b.addEventListener("click", () => {
          wrap.remove();
          send(label);
        });
        wrap.appendChild(b);
      }
      log.appendChild(wrap);
      scroll(true);
    }

    function typing(on) {
      if (on) {
        if (typingEl) return;
        typingEl = document.createElement("div");
        typingEl.className = "rcp-typing";
        typingEl.setAttribute("aria-label", "The front desk is typing");
        typingEl.innerHTML = "<span></span><span></span><span></span>";
        log.appendChild(typingEl);
        scroll(true);
        /* A wait long enough to feel like nothing is happening gets a
           word about it, the way a person would. It hangs off the
           typing indicator rather than becoming a message, so it
           vanishes with the wait instead of sitting in the transcript
           forever — nobody wants to scroll back past three "one
           moment"s to re-read their own answers. */
        clearTimeout(patience);
        patience = setTimeout(() => {
          if (typingEl) typingEl.dataset.slow = "Still with you — just working through that.";
        }, SLOW_REPLY_MS);
      } else {
        clearTimeout(patience);
        if (typingEl) {
          typingEl.remove();
          typingEl = null;
        }
      }
    }

    /* ---- the booking form (item 3) --------------------------
       All the fields at once instead of eight questions in a row.

       Three controls, and each is a promise:
         Close    keeps what was typed unless discard is confirmed
         Check    validates without submitting, so you can see where
                  you stand before committing to anything
         Submit   goes to the review card, which is still the only
                  thing that sends

       The answers live on the SESSION, not in this markup. A killed
       tab loses nothing because there was nothing here to lose. */
    let picker = null;

    function formCard(spec) {
      root.querySelectorAll(".rcp-form").forEach((n) => n.remove());

      const errs = spec.errors || {};

      const field = (f) => {
        const err = errs[f.id];
        const id = "fld-" + f.id;
        let control;

        if (f.type === "country") {
          control = `<div class="cpick" data-country></div>`;
        } else if (f.type === "phone") {
          /* TWO CONTROLS, ONE FIELD. The code is chosen and the
             number is typed, because they are separately known — and
             a bare national number with no code is not a number
             anybody can ring or message.

             The select is filled after mounting, from the same list
             the country picker uses, so there is one source for what
             a dialling code is. */
          control =
            `<div class="rcp-phone">` +
            `<select name="phoneDial" class="rcp-fld-input rcp-dial" data-dial aria-label="Country dialling code"></select>` +
            `<input id="${id}" name="phone" class="rcp-fld-input" type="tel" inputmode="tel"` +
            ` autocomplete="tel-national" placeholder="Your number"` +
            ` value="${esc(f.value || "")}" /></div>`;
        } else if (f.type === "choice") {
          control =
            `<select id="${id}" name="${f.id}" class="rcp-fld-input">` +
            `<option value="">${f.required ? "Choose one" : "No preference"}</option>` +
            (f.options || [])
              .map(
                (o) =>
                  `<option value="${esc(o.value)}"${o.value === f.value ? " selected" : ""}>${esc(o.label)}</option>`
              )
              .join("") +
            `</select>`;
        } else if (f.type === "textarea") {
          control = `<textarea id="${id}" name="${f.id}" class="rcp-fld-input" rows="2">${esc(f.value || "")}</textarea>`;
        } else {
          control =
            /* The server names the type and the browser gets it —
               date included, so DOB is a calendar. Anything unknown
               falls back to text rather than breaking. */
            `<input id="${id}" name="${f.id}" class="rcp-fld-input" type="${
              ["email", "tel", "date"].includes(f.type) ? f.type : "text"
            }"` +
            (f.type === "date" ? ` max="${new Date().toISOString().slice(0, 10)}"` : "") +
            (f.autocomplete ? ` autocomplete="${esc(f.autocomplete)}"` : "") +
            (f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : "") +
            ` value="${esc(f.value || "")}" />`;
        }

        return `<div class="rcp-fld" data-for="${f.id}"${err ? ' data-invalid="true"' : ""}>
            <label for="${id}">${esc(f.label)}${f.required ? "" : ' <span class="rcp-fld-opt">optional</span>'}</label>
            ${control}
            ${f.hint ? `<p class="rcp-fld-hint">${esc(f.hint)}</p>` : ""}
            ${err ? `<p class="rcp-fld-err">${esc(err)}</p>` : ""}
          </div>`;
      };

      const slotErr = errs.slots;
      const slots = (spec.slots || []).length
        ? `<div class="rcp-fld" data-for="slots"${slotErr ? ' data-invalid="true"' : ""}>
             <label for="fld-slot">When suits you?</label>
             <select id="fld-slot" class="rcp-fld-input" data-slot>
               <option value="">Choose a time</option>
               ${spec.slots
                 .map(
                   (o) =>
                     `<option value="${esc(o.id)}"${o.id === spec.chosenSlot ? " selected" : ""}>${esc(o.label)}</option>`
                 )
                 .join("")}
             </select>
             ${slotErr ? `<p class="rcp-fld-err">${esc(slotErr)}</p>` : ""}
           </div>`
        : `<p class="rcp-fld-hint">She has no free times published just now — send this and she will be in touch with options.</p>`;

      const card = document.createElement("form");
      card.className = "rcp-form";
      card.noValidate = true;
      card.innerHTML = `
        <div class="rcp-form-head">
          <h3>${esc(spec.title)}</h3>
          <p>${esc(spec.note)}</p>
          <button class="rcp-form-x" type="button" data-form="close" aria-label="Close this form">&times;</button>
        </div>
        <div class="rcp-form-body">
          ${(spec.fields || []).map(field).join("")}
          ${slots}
        </div>
        <p class="rcp-form-status" data-status hidden></p>
        <div class="rcp-form-actions">
          <button class="rcp-btn" type="button" data-form="check">Check it over</button>
          <button class="rcp-btn rcp-btn-go" type="submit">Pay and confirm</button>
        </div>`;

      log.appendChild(card);
      scroll(true);

      // The country field is a picker, never a text box — item 2.
      /* The dialling codes, from the same list as the country picker.
         Filled asynchronously: the form is usable the moment it is
         drawn, and the codes arrive a beat later — a visitor reaches
         the phone field several fields after the country one. */
      const dial = card.querySelector("[data-dial]");
      if (dial && window.CountryPicker) {
        window.CountryPicker.load().then(function (rows) {
          dial.innerHTML =
            '<option value="">Code</option>' +
            rows
              .filter(function (r) { return r.dialCode; })
              .map(function (r) {
                return (
                  '<option value="' + esc(r.dialCode) + '">' +
                  esc(r.dialCode) + " " + esc(r.name) +
                  "</option>"
                );
              })
              .join("");
          if (dial.dataset.want) dial.value = dial.dataset.want;
        });

        /* Once she picks it herself it stops following the country.
           Someone living in Dubai on an Indian mobile sets +91 once
           and must not have it overwritten when the country field is
           corrected afterwards. */
        dial.addEventListener("change", function () {
          dial.dataset.chosen = "true";
        });
      }

      const host = card.querySelector("[data-country]");
      if (host && window.CountryPicker) {
        picker = window.CountryPicker.mount(host, {
          placeholder: "Start typing your country",
          /* A default, not a decision. Their country is the best
             guess at their dialling code and is right most of the
             time; it is one tap to change and it never overrides a
             choice already made. */
          onPick: function (c) {
            if (!dial || dial.dataset.chosen === "true" || !c.dialCode) return;
            dial.dataset.want = c.dialCode;
            dial.value = c.dialCode;
          },
        });
        const already = (spec.fields || []).find((f) => f.id === "country");
        if (already && already.value) {
          // Re-selecting by name so a re-rendered form keeps the choice.
          window.CountryPicker.load().then(function (rows) {
            const hit = rows.find((r) => r.name === already.value);
            if (hit) picker.set(hit.iso2);
          });
        }
      }

      card.addEventListener("submit", (e) => {
        e.preventDefault();
        submitForm(card, false);
      });

      card.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-form]");
        if (!btn || busy) return;
        if (btn.dataset.form === "close") closeForm(card);
        if (btn.dataset.form === "check") submitForm(card, true);
      });

      const first = card.querySelector(".rcp-fld-input, .cpick-input");
      if (first) first.focus({ preventScroll: true });
      return card;
    }

    /** Read the controls back out. The picker gives a name, because
        that is what the desk's own validator speaks; it turns into an
        ISO-2 code on the server, in one place. */
    function readForm(card) {
      const values = {};
      card.querySelectorAll("[name]").forEach((el) => {
        values[el.name] = el.value;
      });
      if (picker && picker.name()) values.country = picker.name();
      const slotEl = card.querySelector("[data-slot]");
      return { values, slotId: slotEl ? slotEl.value : null };
    }

    /* Three states, drawn rather than described: sending, sent,
       failed. A submit button that goes quiet for two seconds is
       indistinguishable from one that did nothing, and this is the
       moment where "did that work?" matters most. */
    const SENDING = svg('<circle cx="12" cy="12" r="9" stroke-dasharray="42" stroke-dashoffset="14"/>');
    const SENT = svg('<path d="M20 6 9 17l-5-5"/>');
    const FAILED = svg('<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>');

    function formState(card, state, message) {
      const box = card.querySelector("[data-status]");
      if (!box) return;
      box.hidden = false;
      box.dataset.state = state;
      const mark = state === "sending" ? SENDING : state === "sent" ? SENT : FAILED;
      box.innerHTML = `<span class="rcp-form-mark" data-state="${state}">${mark}</span><span>${message}</span>`;
    }

    async function submitForm(card, checkOnly) {
      const { values, slotId } = readForm(card);

      formState(card, "sending", checkOnly ? "Checking…" : "Sending it to her…");
      lock(true);
      card.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        const turn = await call("/action", {
          sessionId,
          action: "form.submit",
          values,
          slotId,
          checkOnly: !!checkOnly,
        });

        /* Errors come back as a redrawn form, so the card stays and
           the state has to say so — otherwise "Sending…" sits there
           over a form that has already come back with problems. */
        if (turn.form && turn.form.errors) {
          formState(card, "failed", "Some details need another look.");
          card.querySelectorAll("button").forEach((b) => (b.disabled = false));
          card.remove();
          apply(turn);
          return;
        }

        formState(card, "sent", "Sent.");
        card.remove();
        apply(turn);
        /* "Check it over" that found nothing still has to SAY so.
           A button that appears to do nothing is indistinguishable
           from one that is broken. */
        if (checkOnly && turn.form && turn.form.allGood) {
          const again = root.querySelector(".rcp-form [data-status]");
          if (again) {
            again.hidden = false;
            again.textContent = "All good — nothing missing. Submit when you are ready.";
          }
        }
      } catch (err) {
        /* It did NOT send, and it says so rather than closing and
           hoping. The card stays exactly as it was, every field
           still filled, so the only thing lost is a few seconds. */
        card.querySelectorAll("button").forEach((b) => (b.disabled = false));
        formState(
          card,
          "failed",
          "That did not reach the desk — nothing has been sent. Try again in a moment."
        );
      } finally {
        lock(false);
      }
    }

    /** Close means close.

        It used to ask "keep or throw away?" and wait for a second
        click, which is why the X appeared to do nothing: the first
        press only swapped in a question, and the buttons it drew were
        wired after the fact.

        Nothing is lost by closing. The draft is on the session — say
        "book" again and the form comes back with every field still
        filled — so there is nothing to warn about and no decision to
        force. */
    async function closeForm(card) {
      card.remove();
      try {
        apply(await call("/action", { sessionId, action: "form.close" }));
      } catch {
        /* The panel is already gone, which is what was asked for.
           The draft stays on the session either way. */
      }
    }

    /* The review card. Every field the practitioner will receive is
       shown — including the ones left empty — so nothing is
       submitted that the visitor has not actually seen. */
    function review(draft) {
      root.querySelectorAll('.rcp-review[data-state="pending"]').forEach((n) => n.remove());

      const row = (label, value, kind) => {
        const empty = value == null || value === "";
        return `<div class="rcp-field" data-kind="${kind || "text"}" data-empty="${empty}">
            <dt>${esc(label)}</dt>
            <dd>${empty ? "not given" : esc(value)}</dd>
          </div>`;
      };

      const slots = (draft.suggestedSlots || []).length
        ? `<ul class="rcp-slotlist">${draft.suggestedSlots
            .map((s) => `<li>${esc(s.label || [s.date, s.time].filter(Boolean).join(" · "))}</li>`)
            .join("")}</ul>`
        : "";

      const card = document.createElement("article");
      card.className = "rcp-review";
      card.dataset.state = "pending";
      card.innerHTML = `
        <div class="rcp-review-head">
          <h3>Before I send this</h3>
          <p>Please check it over — nothing reaches the practitioner until you confirm.</p>
        </div>
        <dl class="rcp-review-body">
          ${row("Name", draft.name)}
          ${row("Email", draft.email, "data")}
          ${row("Phone", draft.phone, "data")}
          ${row("Focus", draft.focusArea)}
          ${row("Born", draft.dob, "data")}
          ${row("Country", draft.country)}
          ${row("Format", draft.modeLabel || draft.mode)}
          <div class="rcp-field" data-empty="${!slots}">
            <dt>Times</dt>
            <dd>${slots || "not given"}</dd>
          </div>
          ${row("Notes", draft.notes)}
        </dl>
        <div class="rcp-review-actions">
          <button class="rcp-btn" type="button" data-act="confirm">Yes — send it</button>
          <button class="rcp-btn" type="button" data-act="edit">Change something</button>
          <button class="rcp-btn" type="button" data-act="cancel" aria-label="Discard this request">Discard</button>
        </div>`;

      card.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn || busy) return;
        card.querySelectorAll(".rcp-btn").forEach((b) => (b.disabled = true));
        act(btn.dataset.act, card);
      });

      log.appendChild(card);
      scroll(true);
      // Move focus to the primary action: this is a decision point,
      // and a keyboard user should not have to hunt for it.
      card.querySelector('[data-act="confirm"]').focus({ preventScroll: true });
      return card;
    }

    /* The in-window till lived here. It mounted the checkout card
       into this window instead of navigating, and it is gone
       because it worked in a harness and did not work in the
       browser that mattered — and a payment step that sometimes
       appears is worse than one that always costs a page load.

       Nothing is lost: assets/js/checkout.js still exports
       Checkout.mount, so the card can be put back into any
       container the day this is worth revisiting. The desk simply
       does not do it. */

    /* The card shown when a booking lands WITHOUT a checkout —
       somebody she will come back to rather than somebody paying
       now. The till is not drawn here any more: apply() sends the
       browser to checkout.html before this is reached, so the
       branch that used to build a Pay button here was dead code
       pretending to be a feature. */
    function receipt(card, booking) {
      if (!card) return;
      card.dataset.state = "confirmed";
      card.querySelector(".rcp-review-head h3").textContent = "Request sent";
      card.querySelector(".rcp-review-head p").textContent =
        "The practitioner has it. She replies personally, usually within one working day.";

      if (booking && booking.reference) {
        card.insertAdjacentHTML(
          "beforeend",
          `<span class="rcp-ref">REF ${esc(booking.reference)}</span>`
        );
      }
      scroll(true);
    }

    /* ---- turn handling ---- */
    function lock(on) {
      busy = on;
      input.disabled = on;
      sendBtn.disabled = on;
    }

    function apply(turn, card) {
      if (!turn) return;
      if (turn.sessionId && turn.sessionId !== sessionId) {
        sessionId = turn.sessionId;
        try {
          sessionStorage.setItem(STORE_KEY, sessionId);
        } catch {}
      }

      for (const m of turn.messages || []) bubble(m.from || "bot", m.text, m.tone);

      if (turn.office) {
        if (presenceEl) presenceEl.textContent = turn.office.label;
        root.dataset.office = turn.office.open ? "open" : "closed";
      }

      // The server owns this wording — the client never composes it,
      // because it is the copy shown exactly when something behind the
      // desk is broken. `kind` drives the colour, nothing else.
      if (noticeEl) {
        const n = turn.notice;
        noticeEl.textContent = n ? n.text : "";
        noticeEl.dataset.kind = n ? n.kind : "";
        noticeEl.hidden = !n;
      }

      /* THE SERVER DECIDES, THE BROWSER GOES.

         The till used to be mounted into this window. It worked in
         a harness and did not work on the machine that matters,
         and a payment step that sometimes appears is worse than
         one that always costs a page load. So the rule is now the
         simplest one available: if the reply carries a checkout,
         go to it.

         checkoutUrl is set in exactly one place — flow.js, after
         the hour is held and the checkout minted — so there is no
         state in the browser that can disagree about whether
         somebody owes money.

         handover holds the room with a spinner while the page
         loads, and does nothing at all if the load is quick. If
         its script never arrived, the plain assign still goes. */
      if (turn.checkoutUrl) {
        if (window.handover) window.handover.go(turn.checkoutUrl, "Taking you to the till…");
        else location.assign(turn.checkoutUrl);
        return;
      }

      if (turn.booking) {
        receipt(card || root.querySelector('.rcp-review[data-state="pending"]'), turn.booking);
      }
      else if (turn.review) review(turn.review);
      else if (turn.form) formCard(turn.form);

      chips(turn.chips);

      // The server decides whether typing is allowed — e.g. it is off
      // while a review card is awaiting an answer, and after a
      // hand-off, so the visitor is not left talking to a closed desk.
      const allowed = turn.inputEnabled !== false;
      input.disabled = !allowed;
      sendBtn.disabled = !allowed;
      input.placeholder = allowed ? "Type your message…" : "—";
      if (allowed && started) input.focus({ preventScroll: true });
    }

    function fail(err) {
      const offline = !navigator.onLine || err.name === "AbortError";
      bubble(
        "system",
        offline
          ? "I lost the connection there. Your answers are safe — try sending that again."
          : "Something went wrong at my end and I could not save that.",
        "warn"
      );
      if (!offline) {
        bubble(
          "bot",
          "Rather than leave you stuck: email khadija@mindyourfood.co.in with your name, " +
            "what you'd like help with, and two times that suit you, and she'll pick it up directly."
        );
      }
    }

    /* A handoff token from the BMI calculator, if we arrived from
       there. Read once and stripped from the URL immediately: it is
       single-use server-side anyway, but leaving it in the address
       bar means it lands in history and in anything the visitor
       pastes to somebody else. */
    function takeHandoffToken() {
      try {
        const params = new URLSearchParams(location.search);
        const t = params.get("t");
        if (!t) return null;
        params.delete("t");
        params.delete("from");
        const rest = params.toString();
        history.replaceState(null, "", location.pathname + (rest ? "?" + rest : ""));
        return t;
      } catch {
        return null;
      }
    }

    const handoffToken = takeHandoffToken();

    async function open() {
      if (!started) {
        started = true;

        /* A reload finds the conversation where it was left, drawn
           from this browser rather than fetched back from us.

           If there is nothing kept, the desk simply greets — no
           warning, no "your conversation was lost", because nothing
           was: the visitor either has it or does not, and saying so
           in a banner would make an ordinary thing sound like a
           fault. */
        const saved = loadLog();
        const restored = !!(saved && saved.sessionId === sessionId);
        if (restored) {
          for (const m of saved.kept) bubble(m.from, m.text, m.tone || null);
          scroll(true);
        }

        /* The session is established EITHER WAY.

           The first version returned here when it had a transcript to
           redraw, which looked right and was not: the server session
           had never been opened, so the window filled with old
           messages and then failed on the first reply. Drawing the
           past is not the same as being connected. */
        lock(true);
        typing(true);
        try {
          const turn = await call("/session", {
            sessionId,
            locale: navigator.language,
            handoffToken,
          });
          typing(false);
          /* A restored conversation does not want the greeting again
             — it is already three messages up the log. The turn is
             still applied for everything else it carries: the session
             id, the office notice, whether typing is allowed. */
          apply(restored ? { ...turn, messages: [] } : turn);
          if (restored) {
            /* A RULE, not a message.

               This was a chat bubble, which saveLog() then stored
               like any other — so the next reload restored it and
               added another, and another. Three reloads, three
               "picking up where we left off"s, for ever.

               Anything that marks the conversation rather than being
               part of it must not be a .rcp-msg, because that is
               exactly what gets saved. */
            const rule = document.createElement("div");
            rule.className = "rcp-resume";
            rule.textContent = "picking up where you left off";
            log.appendChild(rule);
            chips(["Book a consultation", "What do you help with?", "How does it work?"]);
            scroll(true);
          }
        } catch (err) {
          typing(false);
          fail(err);
        } finally {
          lock(false);
        }
      }
      lastFocus = document.activeElement;
      root.dataset.open = "true";
      root.dataset.unread = "false";
      launcher.setAttribute("aria-expanded", "true");
      stage.start();
      win.focus({ preventScroll: true });
      if (!input.disabled) setTimeout(() => input.focus({ preventScroll: true }), 380);
    }

    function close() {
      // On its own page there is nothing behind the desk to return
      // to, so closing means leaving. Prefer history so the visitor
      // lands back where they actually came from.
      if (pageMode) {
        if (document.referrer && new URL(document.referrer, location.href).origin === location.origin) {
          history.back();
        } else {
          location.href = "./index.html#consult";
        }
        return;
      }
      root.dataset.open = "false";
      launcher.setAttribute("aria-expanded", "false");
      stage.stop();
      if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
      else launcher.focus({ preventScroll: true });
    }

    async function send(text) {
      const body = String(text == null ? input.value : text).trim();
      if (!body || busy) return;
      if (body.length > MAX_CHARS) return;

      input.value = "";
      resize();
      root.querySelectorAll(".rcp-chips").forEach((n) => n.remove());
      bubble("user", body);

      lock(true);
      typing(true);
      try {
        const turn = await call("/message", { sessionId, text: body });
        typing(false);
        apply(turn);
      } catch (err) {
        typing(false);
        // 410 = the session expired server-side. Say so plainly and
        // reopen a fresh one rather than silently losing the thread.
        if (err.status === 410) {
          sessionId = null;
          started = false;
          bubble("system", "That session timed out. Starting a fresh one — I'll need those details again.");
          started = true;
          try {
            apply(await call("/session", { locale: navigator.language }));
          } catch (e2) {
            fail(e2);
          }
        } else if (err.status === 429) {
          bubble("system", err.payload?.message || "That's a lot at once — give me a moment.", "warn");
        } else {
          fail(err);
        }
      } finally {
        lock(false);
        if (!input.disabled) input.focus({ preventScroll: true });
      }
    }

    async function act(action, card) {
      lock(true);
      typing(true);
      try {
        const turn = await call("/action", { sessionId, action });
        typing(false);
        apply(turn, card);
        if (action !== "confirm" && card) card.remove();
      } catch (err) {
        typing(false);
        // The card stays interactive on failure — a booking that did
        // not send must never look like one that did.
        if (card) card.querySelectorAll(".rcp-btn").forEach((b) => (b.disabled = false));
        fail(err);
      } finally {
        lock(false);
      }
    }

    async function restart() {
      if (busy) return;
      if (!confirm("Start the conversation over? Anything not yet sent will be cleared.")) return;
      try {
        await call("/end", { sessionId });
      } catch {
        /* best effort — the local reset matters more than the server's */
      }
      sessionId = null;
      started = false;
      try {
        sessionStorage.removeItem(STORE_KEY);
      } catch {}
      log.innerHTML = "";
      await open();
    }

    /* ---- composer behaviour ---- */
    function resize() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 132) + "px";
      const left = MAX_CHARS - input.value.length;
      form.dataset.nearLimit = String(left <= 80);
      countEl.textContent = left <= 80 ? String(left) : "";
    }

    input.addEventListener("input", resize);
    input.addEventListener("keydown", (e) => {
      // Enter sends; Shift+Enter is a newline. IME composition must
      // never send — pressing Enter to accept a candidate is not a
      // submit, and getting this wrong breaks every non-Latin input.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      send();
    });

    launcher.addEventListener("click", open);
    root.querySelector('[data-act="close"]').addEventListener("click", close);

    win.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    });

    // Any other control on the page that wants to open the desk.
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-rcp-open]")) {
        e.preventDefault();
        open();
      }
    });

    if (pageMode) {
      // The desk is the page. Open it immediately — making someone
      // press a button to start the thing they navigated to is a
      // step that exists only because the widget needed one.
      open();
    } else if (/^#(consult-chat|book)$/.test(location.hash)) {
      open();
    }

    return { open, close, stage };
  }

  /* ---- boot ---- */

  /* The invite panel ships with the hours hard-coded in the markup
     so it is correct with scripting off. Once we can reach the
     server, replace them with what it actually validates against —
     the panel must never promise a window the rules will refuse. */
  async function syncConfig(root) {
    try {
      const cfg = await call("/config", null, 6000);
      const hoursEl = document.querySelector("[data-rcp-hours]");
      if (hoursEl && cfg.office) {
        hoursEl.textContent = `${cfg.office.hoursText} · ${cfg.office.label}`;
      }
      if (cfg.office) root.dataset.office = cfg.office.open ? "open" : "closed";
      const presence = root.querySelector("[data-presence]");
      if (presence && cfg.office) presence.textContent = cfg.office.label;
    } catch {
      // Leave the static copy in place. A desk that cannot be reached
      // is a problem the visitor discovers when they try to open it,
      // with a fallback — not one to announce on page load.
    }
  }

  function boot() {
    const root = document.getElementById("receptionist");
    if (!root) return;
    if (!("fetch" in window) || !document.createElement("canvas").getContext) return;
    root.dataset.open = "false";
    window.receptionist = mount(root);
    syncConfig(root);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
