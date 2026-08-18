/* ============================================================
   LIQUID — a flow field, not four drifting circles
   ------------------------------------------------------------
   The first version of this background translated four radial
   gradients around. It was smooth and it was not liquid: shapes
   that move without ever changing shape read as objects sliding,
   which is what they were.

   Liquid folds. So this is a real field — value noise, warped by
   another copy of itself, twice — sampled every frame. Warping
   the domain is the whole trick: `noise(p + noise(p))` is the
   difference between a lava lamp and a cloud, and doing it a
   second time is the difference between a cloud and something
   that looks like it is being stirred.

   ---- WHY THIS IS CHEAP ENOUGH FOR A PAYMENT PAGE ------------
   It renders at 160×90 — fourteen thousand pixels — and the
   browser scales that up to the whole window. Upscaling is
   bilinear and free, and it does the smoothing that a blur filter
   would otherwise cost a full-screen repaint to achieve. The
   canvas is a rounding error; the effect is full screen.

   At 24fps, because liquid this slow has nothing to gain from 60
   and the machine has better things to do while somebody is
   typing a card number.

   ---- AND WHY THE CSS FIELDS ARE STILL THERE ------------------
   They sit underneath as the floor. No canvas, no 2D context, a
   browser that refuses — the page still has its warm drifting
   background and nobody sees a white rectangle. This layer is an
   improvement on something that already worked.
   ============================================================ */
(() => {
  "use strict";

  const canvas = document.querySelector(".liquid-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return; // the CSS fields carry it

  /* Small on purpose. Every pixel here becomes roughly a 9×9 block
     on a laptop screen, and the interpolation between them is what
     makes the result look soft rather than blocky. */
  const W = 160, H = 90;
  canvas.width = W;
  canvas.height = H;

  const image = ctx.createImageData(W, H);
  const pixels = new Uint32Array(image.data.buffer);

  /* ---- value noise ------------------------------------------
     A hash, and smooth interpolation between the lattice points
     around a sample. Deterministic, so the field is the same
     every load and there is no first-frame flash of something
     different. */
  const hash = (x, y) => {
    let h = x * 374761393 + y * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  };

  const smooth = (t) => t * t * (3 - 2 * t);

  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** Three octaves is enough at this resolution — a fourth would
      land below one output pixel and only cost time. */
  function fbm(x, y) {
    return noise(x, y) * 0.5 + noise(x * 2.03, y * 2.03) * 0.25
         + noise(x * 4.01, y * 4.01) * 0.125;
  }

  /* ---- the palette ------------------------------------------
     The site's own colours, as stops on a ramp. The field picks a
     position along it; nothing here invents a hue. */
  const STOPS = [
    [251, 250, 248],  // --bg, off-white canvas
    [244, 226, 205],  // warm cream, the light in the room
    [214, 175, 178],  // rose, lifted
    [183, 132, 138],  // rose-deep, softened
    [150, 126, 110],  // brown
  ];

  function ramp(t, out) {
    const x = Math.max(0, Math.min(0.9999, t)) * (STOPS.length - 1);
    const i = x | 0, f = x - i;
    const a = STOPS[i], b = STOPS[i + 1] || a;
    out[0] = (a[0] + (b[0] - a[0]) * f) | 0;
    out[1] = (a[1] + (b[1] - a[1]) * f) | 0;
    out[2] = (a[2] + (b[2] - a[2]) * f) | 0;
  }

  const rgb = [0, 0, 0];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  function draw(time) {
    const t = time * 0.00005; // a full turn of the field takes minutes

    let p = 0;
    for (let y = 0; y < H; y++) {
      const fy = y / H * 2.2;
      for (let x = 0; x < W; x++, p++) {
        const fx = x / W * 3.4;

        /* DOMAIN WARPING, TWICE. Each pass asks the field where
           to look next, so the shapes fold into each other
           instead of sliding past. */
        const q1 = fbm(fx + 0.0, fy + 0.0);
        const q2 = fbm(fx + 5.2, fy + 1.3);

        const r1 = fbm(fx + 4.0 * q1 + 1.7 + t, fy + 4.0 * q2 + 9.2 + t * 0.8);
        const r2 = fbm(fx + 4.0 * q1 + 8.3 - t * 0.6, fy + 4.0 * q2 + 2.8 + t * 0.4);

        const v = fbm(fx + 4.0 * r1, fy + 4.0 * r2);

        /* Pushed towards the pale end: this is a background for a
           card with a price on it, not a poster. */
        ramp(Math.pow(v * 1.35, 1.6), rgb);

        // little-endian ABGR
        pixels[p] = (255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0];
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  /* One frame and stop, for anyone who asked for less motion.
     They still get the field; it simply holds still. */
  if (reduced.matches) {
    draw(0);
    return;
  }

  let last = 0;
  const FRAME = 1000 / 24;

  function loop(now) {
    /* Paused while the tab is in the background — there is no
       reason to stir a field nobody is looking at, and a phone
       will thank us for it. */
    if (!document.hidden && now - last >= FRAME) {
      last = now;
      draw(now);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
