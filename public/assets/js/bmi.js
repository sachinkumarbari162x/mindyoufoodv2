/* ============================================================
   BMI CALCULATOR

   Two jobs, deliberately separated:

     1. Compute and show the number, entirely in the browser. No
        request, no storage. Somebody who only wants to know their
        BMI never sends their body measurements anywhere.

     2. On the CTA — and ONLY on the CTA — post the figures to the
        data service, take back a single-use token, and hand that
        to the front desk.

   That split is the point. The calculation is free and private;
   sending it is an explicit act.

   The number the server classifies is the number the visitor was
   shown: the same rounding, the same reference table. A result
   that changed between the page and the booking would be the kind
   of small discrepancy nobody can explain later.
   ============================================================ */
"use strict";

(function () {
  var form = document.getElementById("bmiForm");
  if (!form) return;

  var $ = function (id) { return document.getElementById(id); };

  var heightEl = $("bmiHeight");
  var heightInEl = $("bmiHeightIn");
  var weightEl = $("bmiWeight");
  var basisEl = $("bmiBasis");
  var goalEl = $("bmiGoal");
  var errEl = $("bmiError");
  var resultEl = $("bmiResult");
  var valueEl = $("bmiValue");
  var bandEl = $("bmiBand");
  var markerEl = $("bmiMarker");
  var ticksEl = $("bmiTicks");
  var ctaEl = $("bmiGo");
  var ctaCopy = $("bmiCtaCopy");

  var units = "metric";
  var current = null; // last valid calculation, or null

  /* ---- units ---- */
  form.querySelectorAll("[data-units]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      units = btn.dataset.units;
      form.querySelectorAll("[data-units]").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b === btn));
      });
      var imperial = units === "imperial";
      // Imperial height is feet + inches, so a second box appears.
      heightInEl.hidden = !imperial;
      form.querySelector('[data-suffix="heightIn"]').hidden = !imperial;
      form.querySelector('[data-suffix="height"]').textContent = imperial ? "ft" : "cm";
      form.querySelector('[data-suffix="weight"]').textContent = imperial ? "lb" : "kg";
      heightEl.placeholder = imperial ? "5" : "168";
      heightInEl.placeholder = "6";
      weightEl.placeholder = imperial ? "158" : "72";
      heightEl.value = "";
      heightInEl.value = "";
      weightEl.value = "";
      compute();
    });
  });

  /* ---- the maths ----
     Everything converts to metric first; BMI is kg/m² and there is
     no reason to carry two formulas. */
  function readMetric() {
    var h = parseFloat(heightEl.value);
    var w = parseFloat(weightEl.value);

    if (units === "imperial") {
      var feet = h;
      var inches = parseFloat(heightInEl.value) || 0;
      if (!isFinite(feet)) return null;
      var totalIn = feet * 12 + inches;
      h = totalIn * 2.54;
      w = isFinite(w) ? w * 0.45359237 : NaN;
    }

    if (!isFinite(h) || !isFinite(w)) return null;
    return { heightCm: h, weightKg: w };
  }

  // One decimal. Four would imply a precision the input never had —
  // people round their own weight to the nearest kilo.
  function round1(n) { return Math.round(n * 10) / 10; }

  /* Must stay identical to classify() in services/go-data/handlers.go.
     If these two ever disagree, the visitor sees one band and the
     practitioner receives another. */
  function classify(bmi, basis) {
    if (basis === "asian") {
      if (bmi < 18.5) return "underweight";
      if (bmi < 23) return "healthy";
      if (bmi < 25) return "at risk";
      if (bmi < 30) return "obese I";
      return "obese II";
    }
    if (bmi < 18.5) return "underweight";
    if (bmi < 25) return "healthy";
    if (bmi < 30) return "overweight";
    if (bmi < 35) return "obese I";
    if (bmi < 40) return "obese II";
    return "obese III";
  }

  function say(msg, isError) {
    errEl.textContent = msg || "";
    errEl.dataset.error = String(Boolean(isError));
  }

  function compute() {
    var m = readMetric();
    current = null;

    // Empty is not an error — it is the starting state.
    if (!m) {
      resultEl.dataset.state = "empty";
      say("");
      return;
    }

    if (m.heightCm < 60 || m.heightCm > 260) {
      resultEl.dataset.state = "empty";
      say("That height looks out of range — check the units?", true);
      return;
    }
    if (m.weightKg < 20 || m.weightKg > 400) {
      resultEl.dataset.state = "empty";
      say("That weight looks out of range — check the units?", true);
      return;
    }

    var metres = m.heightCm / 100;
    var bmi = round1(m.weightKg / (metres * metres));
    var basis = basisEl.value;
    var band = classify(bmi, basis);

    say("");
    current = {
      heightCm: round1(m.heightCm),
      weightKg: round1(m.weightKg),
      bmi: bmi,
      category: band,
      categoryBasis: basis,
      units: units,
      goal: (goalEl.value || "").trim() || null
    };

    valueEl.firstChild.nodeValue = bmi.toFixed(1);
    bandEl.textContent = band;
    bandEl.dataset.band = band;

    // The scale runs 15–40; anything outside pins to an end rather
    // than sliding off the track.
    var pct = Math.max(0, Math.min(100, ((bmi - 15) / 25) * 100));
    markerEl.style.left = pct + "%";

    // Tick labels follow the chosen table, so the marker's position
    // always lines up with the boundaries actually being applied.
    ticksEl.innerHTML = (basis === "asian"
      ? [15, 18.5, 23, 25, 30, 40]
      : [15, 18.5, 25, 30, 35, 40]
    ).map(function (t) { return "<span>" + t + "</span>"; }).join("");

    resultEl.dataset.state = "ready";
    ctaCopy.textContent =
      "Take this to the front desk and it will start from your numbers — you'll only need to " +
      "fill in the rest.";
  }

  ["input", "change"].forEach(function (ev) {
    form.addEventListener(ev, compute);
  });

  /* ---- the handoff ----
     Only now does anything leave the browser. */
  ctaEl.addEventListener("click", function (e) {
    if (!current) return; // no number yet — let the plain link work

    e.preventDefault();
    if (ctaEl.getAttribute("aria-busy") === "true") return;
    ctaEl.setAttribute("aria-busy", "true");
    var original = ctaEl.textContent;
    ctaEl.textContent = "Handing over…";

    fetch("/api/bmi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current)
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; })
          .then(function (d) { return { ok: r.ok, data: d }; });
      })
      .then(function (r) {
        if (!r.ok || !r.data.handoffToken) throw new Error(r.data.message || "handoff failed");
        // The token travels in the URL; the measurements never do.
        window.location.href = "./consult.html?from=bmi&t=" +
          encodeURIComponent(r.data.handoffToken);
      })
      .catch(function () {
        ctaEl.removeAttribute("aria-busy");
        ctaEl.textContent = original;
        // The desk still works without the handoff — it just starts
        // cold. Say that plainly rather than blocking the visitor.
        say("I couldn't pass your numbers over just now. The front desk still works — " +
            "you'll just need to mention them yourself.", true);
        ctaEl.setAttribute("href", "./consult.html");
      });
  });

  compute();
})();
