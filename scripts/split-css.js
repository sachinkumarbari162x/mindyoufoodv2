/* ============================================================
   ONE-SHOT: split the monolithic public/style.css into
   public/assets/css/**. Lossless — every line of the original
   lands in exactly one output file, and the @import order in
   main.css reproduces the original cascade byte for byte.

       node scripts/split-css.js            # dry run, prints the plan
       node scripts/split-css.js --write

   Kept in the repo so the split is auditable, not magic. It is
   NOT part of the runtime; running it again just rewrites the
   same files from the parked original.
   ============================================================ */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// The original monolith is parked (not deleted) in unrelated/ — it stays the
// source of truth for this script so a re-run can never be fed its own output.
const SRC = path.join(ROOT, "unrelated", "public", "style.css.v2-monolith");
const DEST = path.join(ROOT, "public", "assets", "css");
const WRITE = process.argv.includes("--write");

// [startLine (1-indexed, inclusive), outputPath]. The range ends where the
// next entry begins; the last runs to EOF. Line numbers come from the banner
// comments in the original file — see `grep -n '^/\* ='`.
const CUTS = [
  [1, null], // file header — folded into main.css instead
  [8, "base/tokens.css"],
  [75, "base/reset.css"],
  [134, "components/shared.css"],
  [254, "layout/nav.css"],
  [474, "layout/hero.css"],
  [588, "layout/hero-split.css"],
  [616, "components/nutrient-list.css"],
  [868, "layout/sheet.css"],
  [1207, "layout/footer.css"],
  [1299, "overrides/responsive.css"],
  [1465, "overrides/reduced-motion.css"],
];

const lines = fs.readFileSync(SRC, "utf8").split(/\r?\n/);

const pieces = CUTS.map(([start, out], i) => {
  const end = i + 1 < CUTS.length ? CUTS[i + 1][0] - 1 : lines.length;
  return { out, text: lines.slice(start - 1, end).join("\n"), start, end };
});

// Fail loudly rather than silently dropping CSS.
const rebuilt = pieces.map((p) => p.text).join("\n");
if (rebuilt !== lines.join("\n")) throw new Error("split is not lossless — aborting");

const FORCE = process.argv.includes("--force");
let skipped = 0;

for (const p of pieces) {
  if (!p.out) continue;
  const target = path.join(DEST, p.out);
  const body = p.text.replace(/\s*$/, "") + "\n";

  // The split files are the SOURCE now — they get edited. A re-run
  // regenerates them from the parked monolith, which would silently
  // throw those edits away, so anything that has diverged is left
  // alone unless --force says otherwise.
  const diverged = fs.existsSync(target) && fs.readFileSync(target, "utf8") !== body;
  const action = !WRITE ? "" : diverged && !FORCE ? "  SKIPPED (edited since split)" : "  written";

  console.log(`${String(p.start).padStart(5)}–${String(p.end).padEnd(5)} → ${p.out}${action}`);

  if (!WRITE || (diverged && !FORCE)) {
    if (diverged && WRITE) skipped++;
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

if (!WRITE) console.log("\ndry run — pass --write to emit files.");
else if (skipped) {
  console.log(
    `\n${skipped} file(s) left untouched because they have been edited since the split.` +
      `\nPass --force to overwrite them with the original sections (you will lose those edits).`
  );
} else console.log("\nwritten.");
