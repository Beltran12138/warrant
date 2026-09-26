/** Render sample preflight output from synthetic quotes (no login). Run: npm run build && node test/demo.mjs */
import { DEFAULT_MANDATE, renderScorecard, scoreSwap } from "../dist/lib/score.js";
import { clean, risky } from "./fixtures.mjs";

for (const [label, swap] of [["clean small same-chain swap", clean], ["oversized · high slippage · cross-chain · foreign recipient · high fees · needs approval", risky]]) {
  console.log(`\n———— ${label} ————`);
  console.log(renderScorecard(scoreSwap(swap, DEFAULT_MANDATE), "(defaults)"));
}
console.log();
