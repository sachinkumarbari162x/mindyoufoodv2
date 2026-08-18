/* ============================================================
   AMBIENT CANVAS — the crossfading scenes behind the receptionist

   Two stacked canvases. Only one is "live" and being painted; the
   other holds the last frame of the outgoing scene while CSS
   fades between them. That split matters: the fade is a CSS
   opacity transition, so a slow frame in the renderer can never
   make the transition itself stutter, and the outgoing scene
   costs nothing to hold.

   Scenes are pure functions of (ctx, elapsed, w, h) — no scene
   keeps state between frames, so any scene can be started,
   stopped, or resumed at an arbitrary time without artefacts.
   None of them is coupled to the hero video or to any other
   clock on the page.

       const stage = createAmbientStage({ mount, palette });
       stage.start();  stage.next();  stage.stop();
   ============================================================ */
"use strict";

(function (global) {
  const TAU = Math.PI * 2;

  /* ---- deterministic noise ------------------------------------
     Math.random() per frame would make every mote jitter. Scenes
     need values that are random-looking but stable for a given
     index, so they get a cheap hash instead. */
  function rnd(i, salt = 0) {
    const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }


  /* ---- the liquid ---------------------------------------------
     Every scene is the same renderer with a different palette: a
     set of large, slowly deforming blobs drifting over a dark base
     and blended additively, so where two overlap they pool into a
     brighter third colour the way mixed liquid does.

     Two things make it read as liquid rather than as moving circles:

       1. The blobs are NOT circles. Each outline is a closed path
          whose radius is modulated by two out-of-phase sine waves,
          so the edge swells and slackens continuously and never
          repeats on a visible cycle.
       2. They are drawn with `lighter`. Additive blending means
          overlaps brighten and bleed into one another instead of
          stacking as discrete discs with visible seams.

     Everything drifts on lissajous paths with irrational-ish period
     ratios, so the whole field never returns to the same
     arrangement — there is no loop point to notice. */

  const BLOB_POINTS = 56; // enough that the outline reads as smooth

  function blob(ctx, cx, cy, radius, wobble, phase, colour) {
    ctx.beginPath();
    for (let i = 0; i <= BLOB_POINTS; i++) {
      const a = (i / BLOB_POINTS) * TAU;
      // Two harmonics, deliberately non-integer-related, so the shape
      // never settles into an obvious flower.
      const r =
        radius *
        (1 +
          wobble * Math.sin(a * 3 + phase) +
          wobble * 0.62 * Math.sin(a * 5.3 - phase * 1.37) +
          wobble * 0.34 * Math.sin(a * 8.1 + phase * 0.71));
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * 0.92; // faintly flattened: liquid pools
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();

    // Soft-edged fill. The hard stop at 1 is never reached because the
    // gradient fades out well before the path edge.
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.5);
    g.addColorStop(0, colour);
    g.addColorStop(0.42, colour);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fill();
  }

  /**
   * @param spec.base   the ground colour
   * @param spec.blobs  [{c, r, sx, sy, px, py, w}] — colour, radius factor,
   *                    drift speeds and phases, wobble amount
   */
  function liquid(ctx, t, w, h, spec) {
    ctx.fillStyle = spec.base;
    ctx.fillRect(0, 0, w, h);

    const scale = Math.hypot(w, h);
    ctx.globalCompositeOperation = "lighter";

    for (const b of spec.blobs) {
      // Lissajous drift. Kept inside a generous margin so a blob never
      // parks against an edge and reads as a corner vignette.
      const cx = w * (0.5 + 0.42 * Math.sin(t * b.sx + b.px));
      const cy = h * (0.5 + 0.40 * Math.cos(t * b.sy + b.py));
      // Radius breathes on a third, slower period.
      const r = scale * b.r * (1 + 0.14 * Math.sin(t * b.sx * 0.53 + b.py));
      blob(ctx, cx, cy, r, b.w, t * b.sx * 6.2 + b.px, b.c);
    }

    ctx.globalCompositeOperation = "source-over";

    // A slow sheen drawn across the whole field — the highlight that
    // sells it as a surface with depth rather than a flat wash.
    const sweep = ((t * 0.00004) % 1) * 2.4 - 0.7;
    const sheen = ctx.createLinearGradient(w * (sweep - 0.35), 0, w * (sweep + 0.35), h);
    sheen.addColorStop(0, "rgba(255,255,255,0)");
    sheen.addColorStop(0.5, "rgba(255,250,240,0.055)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, h);
  }

  /* Each scene is a palette and a temperament. Speeds are in radians
     per millisecond, so the numbers look tiny — a full drift cycle is
     40-90 seconds, which is the point. */
  const SCENES = [
    {
      id: "first-light",
      name: "First light · 06:40",
      draw(ctx, t, w, h, p) {
        liquid(ctx, t, w, h, {
          base: p.ink,
          blobs: [
            { c: "rgba(224,166,63,0.50)",  r: 0.40, sx: 0.000071, sy: 0.000053, px: 0.0, py: 1.9, w: 0.13 },
            { c: "rgba(200,138,36,0.42)",  r: 0.34, sx: 0.000048, sy: 0.000087, px: 2.3, py: 0.4, w: 0.17 },
            { c: "rgba(168,73,42,0.34)",   r: 0.30, sx: 0.000094, sy: 0.000041, px: 4.1, py: 3.2, w: 0.20 },
            { c: "rgba(246,239,226,0.16)", r: 0.24, sx: 0.000062, sy: 0.000110, px: 1.2, py: 5.0, w: 0.15 },
          ],
        });
      },
    },
    {
      id: "herb-garden",
      name: "Herb garden · afternoon",
      // The cool one. Sage over ink, with a single amber pool so it
      // does not drift out of the palette entirely.
      draw(ctx, t, w, h, p) {
        liquid(ctx, t, w, h, {
          base: p.ink,
          blobs: [
            { c: "rgba(125,144,112,0.52)", r: 0.42, sx: 0.000057, sy: 0.000079, px: 1.1, py: 0.0, w: 0.16 },
            { c: "rgba(154,172,140,0.36)", r: 0.33, sx: 0.000089, sy: 0.000046, px: 3.4, py: 2.7, w: 0.19 },
            { c: "rgba(92,110,80,0.44)",   r: 0.37, sx: 0.000039, sy: 0.000101, px: 5.2, py: 4.4, w: 0.13 },
            { c: "rgba(200,138,36,0.20)",  r: 0.22, sx: 0.000117, sy: 0.000064, px: 2.0, py: 1.3, w: 0.22 },
          ],
        });
      },
    },
    {
      id: "clay-spice",
      name: "Clay & spice",
      // The densest and slowest — rust and amber pooling like ground
      // spice stirred into oil.
      draw(ctx, t, w, h, p) {
        liquid(ctx, t, w, h, {
          base: "#0e0a07",
          blobs: [
            { c: "rgba(168,73,42,0.56)",   r: 0.44, sx: 0.000043, sy: 0.000061, px: 0.6, py: 2.2, w: 0.15 },
            { c: "rgba(127,51,25,0.48)",   r: 0.38, sx: 0.000074, sy: 0.000035, px: 2.9, py: 5.1, w: 0.18 },
            { c: "rgba(224,166,63,0.34)",  r: 0.27, sx: 0.000098, sy: 0.000082, px: 4.7, py: 0.8, w: 0.24 },
            { c: "rgba(196,98,63,0.30)",   r: 0.31, sx: 0.000052, sy: 0.000119, px: 1.8, py: 3.6, w: 0.17 },
          ],
        });
      },
    },
    {
      id: "evening-steep",
      name: "Evening steep · 21:15",
      // Night side. Mostly ink, with warmth surfacing and sinking.
      draw(ctx, t, w, h, p) {
        liquid(ctx, t, w, h, {
          base: "#0b0806",
          blobs: [
            { c: "rgba(127,51,25,0.44)",   r: 0.46, sx: 0.000036, sy: 0.000058, px: 3.1, py: 1.4, w: 0.14 },
            { c: "rgba(200,138,36,0.26)",  r: 0.29, sx: 0.000067, sy: 0.000093, px: 0.4, py: 4.8, w: 0.21 },
            { c: "rgba(107,92,77,0.34)",   r: 0.35, sx: 0.000085, sy: 0.000044, px: 5.5, py: 2.6, w: 0.16 },
            { c: "rgba(246,239,226,0.10)", r: 0.20, sx: 0.000123, sy: 0.000071, px: 2.4, py: 0.2, w: 0.26 },
          ],
        });
      },
    },
  ];

  /* ---- stage --------------------------------------------------- */
  function createAmbientStage(opts) {
    const mount = opts.mount;
    const caption = opts.caption || null;
    const palette = opts.palette;
    const holdMs = opts.holdMs || 15000; // time on one scene
    const fadeMs = opts.fadeMs || 2600; // must match --rcp-crossfade

    const reduced = global.matchMedia
      ? global.matchMedia("(prefers-reduced-motion: reduce)")
      : { matches: false };

    const panes = [document.createElement("canvas"), document.createElement("canvas")];
    for (const c of panes) {
      c.setAttribute("aria-hidden", "true");
      mount.appendChild(c);
    }
    mount.style.setProperty("--rcp-crossfade", fadeMs + "ms");

    let live = 0; // index of the pane currently being painted
    let sceneIx = 0;
    let raf = 0;
    let holdTimer = 0;
    let running = false;
    let startedAt = 0;
    let dpr = 1;
    let w = 0;
    let h = 0;

    function size() {
      // Cap DPR at 2: this is out-of-focus scenery, and a 3x retina
      // buffer triples fill cost for detail nobody can resolve
      // through a 22px backdrop blur.
      dpr = Math.min(global.devicePixelRatio || 1, 2);
      const r = mount.getBoundingClientRect();
      w = Math.max(1, Math.round(r.width));
      h = Math.max(1, Math.round(r.height));
      for (const c of panes) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
    }

    function paint(paneIx, elapsed) {
      const ctx = panes[paneIx].getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      SCENES[sceneIx].draw(ctx, elapsed, w, h, palette);
    }

    function frame(now) {
      if (!running) return;
      paint(live, now - startedAt);
      raf = global.requestAnimationFrame(frame);
    }

    function announce() {
      if (caption) caption.textContent = SCENES[sceneIx].name;
    }

    /** Advance to a scene, crossfading via the idle pane. */
    function go(nextIx) {
      sceneIx = ((nextIx % SCENES.length) + SCENES.length) % SCENES.length;
      const incoming = 1 - live;

      // Paint one frame of the new scene before revealing it, so the
      // fade never starts from an empty canvas.
      const at = performance.now() - startedAt;
      const prev = live;
      live = incoming;
      paint(incoming, at);

      panes[incoming].classList.add("is-live");
      panes[prev].classList.remove("is-live");
      announce();
      schedule();
    }

    function schedule() {
      clearTimeout(holdTimer);
      if (!running) return;
      // Under reduced motion the scenes still rotate — a slow opacity
      // crossfade between two still images is not vestibular motion —
      // but each one is a frozen frame and it lingers twice as long.
      holdTimer = setTimeout(() => go(sceneIx + 1), reduced.matches ? holdMs * 2 : holdMs);
    }

    function start() {
      if (running) return;
      running = true;
      startedAt = performance.now();
      size();
      paint(live, 0);
      panes[1 - live].classList.remove("is-live"); // clean slate on re-start

      // Reveal the FIRST scene without the crossfade. There is no
      // outgoing scene to cross from, and waiting 2.6s to fade up
      // from nothing means the desk opens onto a black rectangle.
      // The stage's own 0.8s fade (tied to [data-open]) still gives
      // the soft entrance; this just stops the pane starting at 0
      // and depending on a transition to ever leave it.
      const pane = panes[live];
      pane.style.transition = "none";
      pane.classList.add("is-live");
      void pane.offsetHeight; // flush, so the class lands un-transitioned
      pane.style.transition = "";

      announce();
      if (reduced.matches) {
        // One still frame per scene, no RAF loop at all.
        schedule();
        return;
      }
      raf = global.requestAnimationFrame(frame);
      schedule();
    }

    function stop() {
      running = false;
      cancelAnimationFrame(raf);
      clearTimeout(holdTimer);
    }

    // A stage nobody is looking at should not cost a frame. The
    // window being closed stops it outright; a backgrounded tab
    // pauses it without losing the scene.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        clearTimeout(holdTimer);
      } else if (running && !reduced.matches) {
        raf = global.requestAnimationFrame(frame);
        schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    let resizeTimer = 0;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        size();
        if (running) paint(live, performance.now() - startedAt);
      }, 140);
    };
    global.addEventListener("resize", onResize);

    // Honour a mid-session change to the OS motion setting.
    if (reduced.addEventListener) {
      reduced.addEventListener("change", () => {
        if (!running) return;
        stop();
        running = false;
        start();
      });
    }

    return {
      start,
      stop,
      next: () => go(sceneIx + 1),
      scene: () => SCENES[sceneIx].id,
      scenes: SCENES.map((s) => ({ id: s.id, name: s.name })),
      destroy() {
        stop();
        document.removeEventListener("visibilitychange", onVisibility);
        global.removeEventListener("resize", onResize);
        for (const c of panes) c.remove();
      },
    };
  }

  global.createAmbientStage = createAmbientStage;
})(window);
