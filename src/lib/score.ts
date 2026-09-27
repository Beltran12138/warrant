/**
 * Warrant preflight — pure scoring logic (no ctx, no network, unit-testable).
 * In: a ProposedSwap normalised from an mm stored swap quote + the principal's WarrantSpec.
 * Out: a per-dimension suitability scorecard. Reveals, does not enforce.
 */

export type Severity = "pass" | "warn" | "fail";

/** The proposed trade, normalised from an mm stored swap quote. All fields optional to tolerate partial quotes. */
export interface ProposedSwap {
  quoteId: string;
  createdAt?: string;
  walletAddress?: string;
  recipientAddress?: string;
  srcChainId?: number;
  destChainId?: number;
  srcSymbol?: string;
  destSymbol?: string;
  /** USD notional of the sell side (totalFromAmountUsd). */
  fromUsd?: number;
  /** USD notional of the buy side (totalToAmountUsd). */
  toUsd?: number;
  /** Slippage tolerance as a fraction (0.01 = 1%). */
  slippage?: number;
  /** Price impact as a fraction (0.015 = 1.5%). */
  priceImpact?: number;
  /** Expected destination amount (base units or decimal), used for the worst case. */
  destAmount?: number;
  /** Worst acceptable destination amount (minDestAssetAmount). */
  minDestAmount?: number;
  /** Total fees in USD (metabridge + txFee). */
  feeUsd?: number;
  /** Network fee (decimal string in the source chain's native coin) and its symbol. */
  networkFeeAmount?: string;
  networkFeeSymbol?: string;
  requiresApproval?: boolean;
}

/** The limits a principal grants an agent (the warrant). Thresholds in bps (1% = 100bps). */
export interface WarrantSpec {
  maxUsdPerTrade: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeBps: number;
  allowCrossChain: boolean;
  allowNewApproval: boolean;
  recipientMustBeSelf: boolean;
}

export const DEFAULT_WARRANT: WarrantSpec = {
  maxUsdPerTrade: 1000,
  maxSlippageBps: 100, // 1%
  maxPriceImpactBps: 150, // 1.5%
  maxFeeBps: 50, // 0.5%
  allowCrossChain: true,
  allowNewApproval: true,
  recipientMustBeSelf: true,
};

export interface Dimension {
  key: string;
  label: string;
  severity: Severity;
  /** Human-readable observed value. */
  observed: string;
  /** The matching warrant limit, human-readable. */
  limit: string;
  /** One line on why this severity. */
  note: string;
}

export interface Scorecard {
  quoteId: string;
  verdict: Severity;
  /** Worst-case realised loss in USD (slippage hits the floor); undefined if not computable. */
  worstCaseLossUsd?: number;
  dimensions: Dimension[];
  /** Free-form notes, e.g. a likely native Guard Mode 2FA prompt (hint only). */
  notes: string[];
}

/** mm swap --slippage is a percentage (0–100, default 0.5); convert to a fraction. */
export const percentToFraction = (p: number): number => p / 100;

/** priceImpact is a fraction; values > 1 are treated as a percentage. */
export const normalizeImpact = (n: number): number => (n > 1 ? n / 100 : n);

const bps = (frac: number) => Math.round(frac * 10000);
const pct = (frac: number) => `${(frac * 100).toFixed(2)}%`;
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** The overall verdict is the most severe dimension. */
function worst(sevs: Severity[]): Severity {
  if (sevs.includes("fail")) return "fail";
  if (sevs.includes("warn")) return "warn";
  return "pass";
}

/** Render a scorecard as human-readable text (used by the CLI success hint; pure). */
export function renderScorecard(sc: Scorecard, warrantSource: string): string {
  const icon: Record<Severity, string> = { pass: "✓", warn: "▲", fail: "✗" };
  const head: Record<Severity, string> = {
    pass: "SUITABLE",
    warn: "REVIEW",
    fail: "UNSUITABLE",
  };
  const lines: string[] = [];
  lines.push(`Warrant preflight — ${head[sc.verdict]}  (quote ${sc.quoteId})`);
  lines.push(`warrant: ${warrantSource}`);
  lines.push("");
  for (const d of sc.dimensions) {
    lines.push(`  ${icon[d.severity]} ${d.label}: ${d.observed}  [limit ${d.limit}] — ${d.note}`);
  }
  if (sc.notes.length) {
    lines.push("");
    for (const n of sc.notes) lines.push(`  · ${n}`);
  }
  return lines.join("\n");
}

export function scoreSwap(swap: ProposedSwap, warrant: WarrantSpec): Scorecard {
  const dims: Dimension[] = [];
  const notes: string[] = [];

  // 1. Notional
  if (swap.fromUsd !== undefined) {
    const sev: Severity = swap.fromUsd > warrant.maxUsdPerTrade ? "fail" : "pass";
    dims.push({
      key: "size",
      label: "Trade size",
      severity: sev,
      observed: usd(swap.fromUsd),
      limit: `≤ ${usd(warrant.maxUsdPerTrade)}`,
      note: sev === "fail" ? "exceeds the per-trade limit" : "within limit",
    });
  }

  // 2. Slippage tolerance
  if (swap.slippage !== undefined) {
    const b = bps(swap.slippage);
    const sev: Severity = b > warrant.maxSlippageBps ? "fail" : b > warrant.maxSlippageBps * 0.75 ? "warn" : "pass";
    dims.push({
      key: "slippage",
      label: "Slippage tolerance",
      severity: sev,
      observed: `${pct(swap.slippage)} (${b}bps)`,
      limit: `≤ ${warrant.maxSlippageBps}bps`,
      note: sev === "fail" ? "slippage above warrant; sandwichable" : sev === "warn" ? "close to the limit" : "conservative",
    });
  }

  // 3. Price impact
  if (swap.priceImpact !== undefined) {
    const b = bps(swap.priceImpact);
    const sev: Severity = b > warrant.maxPriceImpactBps ? "fail" : b > warrant.maxPriceImpactBps * 0.75 ? "warn" : "pass";
    dims.push({
      key: "priceImpact",
      label: "Price impact",
      severity: sev,
      observed: `${pct(swap.priceImpact)} (${b}bps)`,
      limit: `≤ ${warrant.maxPriceImpactBps}bps`,
      note: sev === "fail" ? "impact too high: thin pool or oversized order" : sev === "warn" ? "close to the limit" : "deep enough",
    });
  }

  // 4. Fee load
  if (swap.feeUsd !== undefined && swap.fromUsd !== undefined && swap.fromUsd > 0) {
    const feeBps = bps(swap.feeUsd / swap.fromUsd);
    const sev: Severity = feeBps > warrant.maxFeeBps ? "fail" : feeBps > warrant.maxFeeBps * 0.75 ? "warn" : "pass";
    dims.push({
      key: "fees",
      label: "Fee load",
      severity: sev,
      observed: `${usd(swap.feeUsd)} (${feeBps}bps)`,
      limit: `≤ ${warrant.maxFeeBps}bps`,
      note: sev === "fail" ? "fees eat the trade" : sev === "warn" ? "fees on the high side" : "reasonable fees",
    });
  }

  // 5. Recipient
  if (swap.recipientAddress && swap.walletAddress) {
    const self = swap.recipientAddress.toLowerCase() === swap.walletAddress.toLowerCase();
    const sev: Severity = self ? "pass" : warrant.recipientMustBeSelf ? "fail" : "warn";
    dims.push({
      key: "recipient",
      label: "Recipient",
      severity: sev,
      observed: self ? "self" : `→ ${swap.recipientAddress}`,
      limit: warrant.recipientMustBeSelf ? "self only" : "any",
      note: sev === "fail" ? "funds go to a foreign address; warrant forbids it" : self ? "back to this wallet" : "to an external address",
    });
  }

  // 6. Cross-chain
  if (swap.srcChainId !== undefined && swap.destChainId !== undefined) {
    const cross = swap.srcChainId !== swap.destChainId;
    const sev: Severity = !cross ? "pass" : warrant.allowCrossChain ? "warn" : "fail";
    dims.push({
      key: "crossChain",
      label: "Cross-chain",
      severity: sev,
      observed: cross ? `${swap.srcChainId} → ${swap.destChainId}` : `same (${swap.srcChainId})`,
      limit: warrant.allowCrossChain ? "allowed" : "same-chain only",
      note: sev === "fail" ? "warrant forbids cross-chain" : cross ? "bridging adds settlement and bridge risk" : "same chain",
    });
  }

  // 7. Approval
  if (swap.requiresApproval !== undefined) {
    const sev: Severity = !swap.requiresApproval ? "pass" : warrant.allowNewApproval ? "warn" : "fail";
    dims.push({
      key: "approval",
      label: "ERC-20 approval",
      severity: sev,
      observed: swap.requiresApproval ? "required" : "none",
      limit: warrant.allowNewApproval ? "allowed" : "no new approval",
      note: sev === "fail" ? "warrant forbids new approvals" : swap.requiresApproval ? "needs an approval first; check it is not unlimited" : "no approval needed",
    });
  }

  // Worst-case loss (slippage hits the floor)
  let worstCaseLossUsd: number | undefined;
  if (
    swap.destAmount !== undefined &&
    swap.minDestAmount !== undefined &&
    swap.destAmount > 0 &&
    swap.toUsd !== undefined
  ) {
    const lossFrac = (swap.destAmount - swap.minDestAmount) / swap.destAmount;
    worstCaseLossUsd = Math.max(0, lossFrac * swap.toUsd);
    notes.push(`Worst case (fill at minDest): realised loss ≈ ${usd(worstCaseLossUsd)} (${pct(lossFrac)})`);
  }

  // Guard Mode 2FA hint (reveal only, never replaces the native decision)
  if (swap.fromUsd !== undefined && swap.fromUsd > warrant.maxUsdPerTrade) {
    notes.push(
      "If native Guard Mode's 24h outflow limit is at or below this amount, execution will likely prompt 2FA. Preflight only reveals; it never replaces or bypasses the native check.",
    );
  }

  return {
    quoteId: swap.quoteId,
    verdict: worst(dims.map((d) => d.severity)),
    worstCaseLossUsd,
    dimensions: dims,
    notes,
  };
}
