/** 用合成报价渲染 preflight 输出样例（无需登录）。跑：npm run build && node test/demo.mjs */
import { DEFAULT_MANDATE, renderScorecard, scoreSwap } from "../dist/lib/score.js";

const SELF = "0xA11ce0000000000000000000000000000000dEaD";

const clean = {
  quoteId: "0x9f…a1",
  walletAddress: SELF,
  recipientAddress: SELF,
  srcChainId: 1,
  destChainId: 1,
  srcSymbol: "USDC",
  destSymbol: "WETH",
  fromUsd: 250,
  toUsd: 249.1,
  slippage: 0.005,
  priceImpact: 0.0021,
  feeUsd: 0.35,
  destAmount: 71_000_000_000_000_000,
  minDestAmount: 70_645_000_000_000_000,
  requiresApproval: false,
};

const risky = {
  quoteId: "0x3c…7e",
  walletAddress: SELF,
  recipientAddress: "0xBEEF00000000000000000000000000000000C0DE",
  srcChainId: 1,
  destChainId: 42161,
  srcSymbol: "USDC",
  destSymbol: "PEPE",
  fromUsd: 4200,
  toUsd: 4010,
  slippage: 0.03,
  priceImpact: 0.028,
  feeUsd: 33,
  destAmount: 1000,
  minDestAmount: 970,
  requiresApproval: true,
};

for (const [label, swap] of [["干净小额同链兑换", clean], ["超额·高滑点·跨链·外部收款·高费·需授权", risky]]) {
  console.log(`\n———— ${label} ————`);
  console.log(renderScorecard(scoreSwap(swap, DEFAULT_MANDATE), "(defaults)"));
}
console.log();
