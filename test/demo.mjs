/** 用合成报价渲染 preflight 输出样例（无需登录）。跑：npm run build && node test/demo.mjs */
import { DEFAULT_MANDATE, renderScorecard, scoreSwap } from "../dist/lib/score.js";
import { clean, risky } from "./fixtures.mjs";

for (const [label, swap] of [["干净小额同链兑换", clean], ["超额·高滑点·跨链·外部收款·高费·需授权", risky]]) {
  console.log(`\n———— ${label} ————`);
  console.log(renderScorecard(scoreSwap(swap, DEFAULT_MANDATE), "(defaults)"));
}
console.log();
