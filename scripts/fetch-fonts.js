/* ============================================================
   FETCH FONTS — pull a family from Google and self-host it

       node scripts/fetch-fonts.js --out crm/assets/fonts \
            --family "Noto Sans" --family "Noto Serif" \
            --family "Noto Sans Mono"

   Downloads every subset as woff2, writes them next to a
   generated fonts.css, and rewrites the URLs to point at the
   local copies. After this runs, the page makes NO request to
   any font host — which is the whole point: a CRM that waits on
   a third party to render its own text is a CRM that is slow in
   exactly the places the network is bad.

   Variable fonts only. One file covers a whole weight range, so
   never add static weight files alongside these.

   Re-runnable: existing files are overwritten in place.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/* Google serves woff2 only to browsers it recognises. With Node's
   own agent it quietly returns TTF instead — three times the bytes,
   and no unicode-range splitting. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/* ---- arguments ---------------------------------------------- */
function args() {
  const out = { families: [], dir: null, weights: "100..900" };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--family") out.families.push(argv[++i]);
    else if (argv[i] === "--out") out.dir = argv[++i];
    else if (argv[i] === "--weights") out.weights = argv[++i];
  }
  if (!out.dir || !out.families.length) {
    console.error("usage: node scripts/fetch-fonts.js --out <dir> --family <name> [--family <name>]");
    process.exit(1);
  }
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ---- one family --------------------------------------------- */
async function fetchFamily(family, weights) {
  const url =
    "https://fonts.googleapis.com/css2?family=" +
    encodeURIComponent(family) +
    `:ital,wght@0,${weights};1,${weights}&display=swap`;

  let res = await fetch(url, { headers: { "User-Agent": UA } });

  // Not every family ships an italic. Fall back to upright only
  // rather than failing the whole run.
  if (!res.ok) {
    res = await fetch(
      "https://fonts.googleapis.com/css2?family=" +
        encodeURIComponent(family) +
        `:wght@${weights}&display=swap`,
      { headers: { "User-Agent": UA } }
    );
  }
  if (!res.ok) throw new Error(`${family}: HTTP ${res.status}`);
  return res.text();
}

/* Google's CSS is a run of `/* subset *​/` comments each followed by
   one @font-face. That comment is the only place the subset name
   appears, so it has to be parsed alongside the block. */
function parseFaces(css) {
  const faces = [];
  const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/gi;
  let m;
  while ((m = re.exec(css))) {
    const [, subset, body] = m;
    const pick = (prop) => (body.match(new RegExp(prop + ":\\s*([^;]+);")) || [])[1]?.trim();
    const src = (body.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
    if (!src) continue;
    faces.push({
      subset,
      family: (pick("font-family") || "").replace(/['"]/g, ""),
      style: pick("font-style") || "normal",
      weight: pick("font-weight") || "400",
      unicodeRange: pick("unicode-range") || "",
      src,
    });
  }
  return faces;
}

/* ---- run ----------------------------------------------------- */
(async () => {
  const { families, dir, weights } = args();
  const outDir = path.resolve(process.cwd(), dir);
  await fsp.mkdir(outDir, { recursive: true });

  const blocks = [];
  let downloaded = 0;
  let bytes = 0;

  for (const family of families) {
    const css = await fetchFamily(family, weights);
    const faces = parseFaces(css);
    if (!faces.length) throw new Error(`${family}: no @font-face blocks parsed`);

    for (const f of faces) {
      const file = `${slug(f.family)}-${f.style}-${f.subset}.woff2`;
      const res = await fetch(f.src, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(path.join(outDir, file), buf);
      downloaded++;
      bytes += buf.length;

      blocks.push(
        `/* ${f.family} · ${f.style} · ${f.subset} */\n` +
          `@font-face {\n` +
          `  font-family: "${f.family}";\n` +
          `  font-style: ${f.style};\n` +
          `  font-weight: ${f.weight};\n` +
          `  font-display: swap;\n` +
          `  src: url("./${file}") format("woff2");\n` +
          (f.unicodeRange ? `  unicode-range: ${f.unicodeRange};\n` : "") +
          `}`
      );
    }
    console.log(`  ${family.padEnd(18)} ${faces.length} face(s)`);
  }

  const header =
    `/* ============================================================\n` +
    `   SELF-HOSTED TYPEFACES — generated, do not edit by hand\n\n` +
    `   ${families.join(" · ")}\n\n` +
    `   Variable fonts: one file covers a whole weight range, so\n` +
    `   font-weight anywhere in the range costs nothing extra and\n` +
    `   static weight files must never be added alongside them.\n\n` +
    `   Split by unicode-range, so a browser downloads only the\n` +
    `   scripts a page actually uses.\n\n` +
    `   Regenerate with:\n` +
    `     node scripts/fetch-fonts.js --out ${dir} \\\n` +
    families.map((f) => `          --family "${f}"`).join(" \\\n") +
    `\n   ============================================================ */\n`;

  await fsp.writeFile(path.join(outDir, "fonts.css"), header + "\n" + blocks.join("\n\n") + "\n");

  console.log(`\n  ${downloaded} files · ${(bytes / 1024).toFixed(0)} kB → ${dir}/`);
})().catch((err) => {
  console.error("failed:", err.message);
  process.exit(1);
});
