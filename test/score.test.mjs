/**
 * score.js unit tests (no mm/ctx; assertions are independent so implementation and test cannot share a mistake).
 * Run: node test/score.test.mjs (after npm run build)
 */
import assert from "node:assert/strict";
import {
  DEFAULT_WARRANT,
  networkFeeUsd,
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

// Network fee in USD, from a real Arc mainnet quote (0xb5a7cebf…9ad3, 2026-10-05): selling 0.5 USDC,
// gas 0.009968918446718688 USDC. By hand: 0.0099689184 × (0.499968 / 0.5) = 0.0099682804.
const ARC_Q = {
  networkFeeAmount: "0.009968918446718688",
  networkFeeSymbol: "USDC",
  srcSymbol: "USDC",
  srcAmount: "500000000000000000",
  srcDecimals: 18,
  fromUsd: 0.499968,
};
t("networkFeeUsd: Arc gas in USDC priced at the sell side's rate", () => {
  assert.ok(Math.abs(networkFeeUsd(ARC_Q) - 0.0099682804) < 1e-9);
});
t("networkFeeUsd: fee coin differs from the sold coin → undefined (not guessed)", () => {
  assert.equal(networkFeeUsd({ ...ARC_Q, networkFeeSymbol: "ETH" }), undefined);
});
t("networkFeeUsd: unknown decimals → undefined", () => {
  assert.equal(networkFeeUsd({ ...ARC_Q, srcDecimals: undefined }), undefined);
});
t("fee load with Arc gas included: ~199bps fails a 50bps warrant", () => {
  const sc = scoreSwap(
    { quoteId: "arc", walletAddress: SELF, recipientAddress: SELF, srcChainId: 5042, destChainId: 5042, fromUsd: 0.499968, feeUsd: 0.0099682804 },
    DEFAULT_WARRANT,
  );
  const fees = sc.dimensions.find((d) => d.key === "fees");
  assert.equal(fees.severity, "fail");
  assert.equal(fees.observed, "$0.01 (199bps)");
});

// Unit conversion
t("percentToFraction: mm's 0.5 (%) → 0.005", () => {
  assert.equal(percentToFraction(0.5), 0.005);
});
t("normalizeImpact: fraction 0.0123 unchanged", () => {
  assert.equal(normalizeImpact(0.0123), 0.0123);
});
t("normalizeImpact: >1 treated as percent, 1.23 → 0.0123", () => {
  assert.ok(Math.abs(normalizeImpact(1.23) - 0.0123) < 1e-9);
});

// Clean small trade → all pass
t("clean trade → SUITABLE (pass)", () => {
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
    DEFAULT_WARRANT,
  );
  assert.equal(sc.verdict, "pass", JSON.stringify(sc.dimensions));
});

// Oversized + high slippage → fail
t("oversized + high slippage → UNSUITABLE (fail)", () => {
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
    DEFAULT_WARRANT,
  );
  assert.equal(sc.verdict, "fail");
  assert.equal(sc.dimensions.find((d) => d.key === "size")?.severity, "fail");
  assert.equal(sc.dimensions.find((d) => d.key === "slippage")?.severity, "fail");
});

// Payout to an external address → fail (recipientMustBeSelf by default)
t("external recipient → recipient fail", () => {
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
    DEFAULT_WARRANT,
  );
  assert.equal(sc.dimensions.find((d) => d.key === "recipient")?.severity, "fail");
  assert.equal(sc.verdict, "fail");
});

// Cross-chain + needs approval → warn (both allowed by default)
t("cross-chain + approval → REVIEW (warn)", () => {
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
    DEFAULT_WARRANT,
  );
  assert.equal(sc.dimensions.find((d) => d.key === "crossChain")?.severity, "warn");
  assert.equal(sc.dimensions.find((d) => d.key === "approval")?.severity, "warn");
  assert.equal(sc.verdict, "warn");
});

// Worst-case loss
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
      minDestAmount: 990, // 1% floor
    },
    DEFAULT_WARRANT,
  );
  assert.ok(Math.abs((sc.worstCaseLossUsd ?? 0) - 1.0) < 1e-9, `got ${sc.worstCaseLossUsd}`);
});

// Warrant override: no cross-chain → cross-chain fail
t("no-cross-chain warrant → crossChain fail", () => {
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
    { ...DEFAULT_WARRANT, allowCrossChain: false },
  );
  assert.equal(sc.dimensions.find((d) => d.key === "crossChain")?.severity, "fail");
});

// Real Monad quote 0x2ade8da4…5256 (2026-09-27): fromUsd 0.02667, toUsd 0.02730, mm priceImpact -0.0236,
// i.e. (fromUsd - toUsd) / fromUsd: negative means the quote pays more than the USD reference.
t("negative price impact → pass, noted as in the trader's favour (not 'deep enough')", () => {
  const sc = scoreSwap(
    {
      quoteId: "0x2ade8da4",
      walletAddress: SELF,
      recipientAddress: SELF,
      srcChainId: 143,
      destChainId: 143,
      fromUsd: 0.0266708,
      toUsd: 0.027307,
      slippage: percentToFraction(0.5),
      priceImpact: -0.0236,
      feeUsd: 0,
      destAmount: 27311,
      minDestAmount: 27174,
      requiresApproval: false,
    },
    DEFAULT_WARRANT,
  );
  const d = sc.dimensions.find((x) => x.key === "priceImpact");
  assert.equal(d.severity, "pass");
  assert.match(d.note, /in your favour/);
});

console.log(`\n${pass} passed`);
