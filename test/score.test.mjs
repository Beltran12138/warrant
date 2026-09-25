/**
 * score.js 纯逻辑单测（不依赖 mm/ctx，独立断言，避免实现与断言共享失败模式）。
 * 跑：node test/score.test.mjs（先 npm run build）
 */
import assert from "node:assert/strict";
import {
  DEFAULT_MANDATE,
  normalizeImpact,
  percentToFraction,
  scoreSwap,
} from "../dist/lib/score.js";

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
};

const SELF = "0xabc0000000000000000000000000000000000001";

// 单位换算
t("percentToFraction: mm 的 0.5 (%) → 0.005", () => {
  assert.equal(percentToFraction(0.5), 0.005);
});
t("normalizeImpact: 分数 0.0123 原样", () => {
  assert.equal(normalizeImpact(0.0123), 0.0123);
});
t("normalizeImpact: >1 视为百分数 1.23 → 0.0123", () => {
  assert.ok(Math.abs(normalizeImpact(1.23) - 0.0123) < 1e-9);
});

// 干净小额交易 → 全 pass
t("干净交易 → SUITABLE(pass)", () => {
  const sc = scoreSwap(
    {
      quoteId: "q1",
      walletAddress: SELF,
      recipientAddress: SELF,
      srcChainId: 1,
      destChainId: 1,
      fromUsd: 200,
      toUsd: 199,
      slippage: percentToFraction(0.5), // 0.5%
      priceImpact: 0.003,
      feeUsd: 0.4,
      destAmount: 1_000_000,
      minDestAmount: 998_000,
      requiresApproval: false,
    },
    DEFAULT_MANDATE,
  );
  assert.equal(sc.verdict, "pass", JSON.stringify(sc.dimensions));
});

// 超额 + 高滑点 → fail
t("超额+高滑点 → UNSUITABLE(fail)", () => {
  const sc = scoreSwap(
    {
      quoteId: "q2",
      walletAddress: SELF,
      recipientAddress: SELF,
      srcChainId: 1,
      destChainId: 1,
      fromUsd: 5000, // > 1000
      slippage: percentToFraction(3), // 3% > 1%
      priceImpact: 0.004,
      requiresApproval: false,
    },
    DEFAULT_MANDATE,
  );
  assert.equal(sc.verdict, "fail");
  assert.equal(sc.dimensions.find((d) => d.key === "size")?.severity, "fail");
  assert.equal(sc.dimensions.find((d) => d.key === "slippage")?.severity, "fail");
});

// 收款到外部地址 → fail（默认 recipientMustBeSelf）
t("外部收款地址 → recipient fail", () => {
  const sc = scoreSwap(
    {
      quoteId: "q3",
      walletAddress: SELF,
      recipientAddress: "0xdead000000000000000000000000000000000000",
      srcChainId: 1,
      destChainId: 1,
      fromUsd: 100,
      slippage: percentToFraction(0.5),
    },
    DEFAULT_MANDATE,
  );
  assert.equal(sc.dimensions.find((d) => d.key === "recipient")?.severity, "fail");
  assert.equal(sc.verdict, "fail");
});

// 跨链 + 需授权 → warn（默认都允许）
t("跨链+需授权 → REVIEW(warn)", () => {
  const sc = scoreSwap(
    {
      quoteId: "q4",
      walletAddress: SELF,
      recipientAddress: SELF,
      srcChainId: 1,
      destChainId: 42161,
      fromUsd: 100,
      slippage: percentToFraction(0.5),
      priceImpact: 0.002,
      requiresApproval: true,
    },
    DEFAULT_MANDATE,
  );
  assert.equal(sc.dimensions.find((d) => d.key === "crossChain")?.severity, "warn");
  assert.equal(sc.dimensions.find((d) => d.key === "approval")?.severity, "warn");
  assert.equal(sc.verdict, "warn");
});

// 最坏情况损失计算
t("worstCaseLossUsd = (dest-minDest)/dest * toUsd", () => {
  const sc = scoreSwap(
    {
      quoteId: "q5",
      walletAddress: SELF,
      recipientAddress: SELF,
      srcChainId: 1,
      destChainId: 1,
      fromUsd: 100,
      toUsd: 100,
      slippage: percentToFraction(0.5),
      destAmount: 1000,
      minDestAmount: 990, // 1% 触底
    },
    DEFAULT_MANDATE,
  );
  assert.ok(Math.abs((sc.worstCaseLossUsd ?? 0) - 1.0) < 1e-9, `got ${sc.worstCaseLossUsd}`);
});

// mandate 覆盖：禁跨链 → 跨链 fail
t("禁跨链 mandate → crossChain fail", () => {
  const sc = scoreSwap(
    {
      quoteId: "q6",
      walletAddress: SELF,
      recipientAddress: SELF,
      srcChainId: 1,
      destChainId: 10,
      fromUsd: 100,
      slippage: percentToFraction(0.5),
    },
    { ...DEFAULT_MANDATE, allowCrossChain: false },
  );
  assert.equal(sc.dimensions.find((d) => d.key === "crossChain")?.severity, "fail");
});

console.log(`\n${pass} passed`);
