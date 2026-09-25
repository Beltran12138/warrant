/**
 * Mandate preflight — 纯打分逻辑（不依赖 ctx / 网络，便于独立单测）。
 * 输入=从 stored swap quote 归一化出的 ProposedSwap + 用户的 MandateSpec，
 * 输出=逐维度 suitability scorecard。reveal 不 enforce。
 */

export type Severity = "pass" | "warn" | "fail";

/** 从 mm 的 stored swap quote 归一化出来的「拟议交易」。字段全部可选以容忍报价缺项。 */
export interface ProposedSwap {
  quoteId: string;
  createdAt?: string;
  walletAddress?: string;
  recipientAddress?: string;
  srcChainId?: number;
  destChainId?: number;
  srcSymbol?: string;
  destSymbol?: string;
  /** 卖出方向的 USD 名义额（totalFromAmountUsd）。 */
  fromUsd?: number;
  /** 买入方向的 USD 名义额（totalToAmountUsd）。 */
  toUsd?: number;
  /** 滑点容忍，小数（0.01 = 1%）。 */
  slippage?: number;
  /** 价格冲击，小数（0.015 = 1.5%）。 */
  priceImpact?: number;
  /** 目标资产预期数量（最小单位或十进制字符串），用于最坏情况计算。 */
  destAmount?: number;
  /** 目标资产最坏可接受数量（minDestAssetAmount）。 */
  minDestAmount?: number;
  /** 总费用 USD（metabridge + txFee）。 */
  feeUsd?: number;
  /** 网络费（源链原生币十进制字符串）与符号。 */
  networkFeeAmount?: string;
  networkFeeSymbol?: string;
  requiresApproval?: boolean;
}

/** 用户对 agent 的授权边界（mandate）。阈值单位=bps（1% = 100bps）。 */
export interface MandateSpec {
  maxUsdPerTrade: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeBps: number;
  allowCrossChain: boolean;
  allowNewApproval: boolean;
  recipientMustBeSelf: boolean;
}

export const DEFAULT_MANDATE: MandateSpec = {
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
  /** 实测值的人读字符串。 */
  observed: string;
  /** mandate 里的对应阈值/约束，人读。 */
  limit: string;
  /** 一句话说明为什么是这个 severity。 */
  note: string;
}

export interface Scorecard {
  quoteId: string;
  verdict: Severity;
  /** 最坏情况实现损失（滑点触底）USD，无法算时为 undefined。 */
  worstCaseLossUsd?: number;
  dimensions: Dimension[];
  /** 触发 native Guard Mode 2FA 的预测（基于 maxUsdPerTrade 类比 outflow 限额，仅提示）。 */
  notes: string[];
}

/** mm 的 swap --slippage 是百分数(0–100，默认 0.5)；转小数分数。 */
export const percentToFraction = (p: number): number => p / 100;

/** priceImpact 约定为比率(fraction)；>1 兜底按百分数处理。 */
export const normalizeImpact = (n: number): number => (n > 1 ? n / 100 : n);

const bps = (frac: number) => Math.round(frac * 10000);
const pct = (frac: number) => `${(frac * 100).toFixed(2)}%`;
const usd = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** 取维度里最严重的 severity 作为总裁决。 */
function worst(sevs: Severity[]): Severity {
  if (sevs.includes("fail")) return "fail";
  if (sevs.includes("warn")) return "warn";
  return "pass";
}

/** 把 scorecard 渲染成人读的多行文本（供 CLI successHint 复用；纯函数，可测）。 */
export function renderScorecard(sc: Scorecard, mandateSource: string): string {
  const icon: Record<Severity, string> = { pass: "✓", warn: "▲", fail: "✗" };
  const head: Record<Severity, string> = {
    pass: "SUITABLE",
    warn: "REVIEW",
    fail: "UNSUITABLE",
  };
  const lines: string[] = [];
  lines.push(`Mandate preflight — ${head[sc.verdict]}  (quote ${sc.quoteId})`);
  lines.push(`mandate: ${mandateSource}`);
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

export function scoreSwap(swap: ProposedSwap, mandate: MandateSpec): Scorecard {
  const dims: Dimension[] = [];
  const notes: string[] = [];

  // 1. 名义额
  if (swap.fromUsd !== undefined) {
    const sev: Severity = swap.fromUsd > mandate.maxUsdPerTrade ? "fail" : "pass";
    dims.push({
      key: "size",
      label: "Trade size",
      severity: sev,
      observed: usd(swap.fromUsd),
      limit: `≤ ${usd(mandate.maxUsdPerTrade)}`,
      note: sev === "fail" ? "超过单笔额度授权" : "在额度内",
    });
  }

  // 2. 滑点容忍
  if (swap.slippage !== undefined) {
    const b = bps(swap.slippage);
    const sev: Severity = b > mandate.maxSlippageBps ? "fail" : b > mandate.maxSlippageBps * 0.75 ? "warn" : "pass";
    dims.push({
      key: "slippage",
      label: "Slippage tolerance",
      severity: sev,
      observed: `${pct(swap.slippage)} (${b}bps)`,
      limit: `≤ ${mandate.maxSlippageBps}bps`,
      note: sev === "fail" ? "滑点容忍超授权，可被三明治夹" : sev === "warn" ? "接近上限" : "保守",
    });
  }

  // 3. 价格冲击
  if (swap.priceImpact !== undefined) {
    const b = bps(swap.priceImpact);
    const sev: Severity = b > mandate.maxPriceImpactBps ? "fail" : b > mandate.maxPriceImpactBps * 0.75 ? "warn" : "pass";
    dims.push({
      key: "priceImpact",
      label: "Price impact",
      severity: sev,
      observed: `${pct(swap.priceImpact)} (${b}bps)`,
      limit: `≤ ${mandate.maxPriceImpactBps}bps`,
      note: sev === "fail" ? "冲击过大，池子深度不足或单量过大" : sev === "warn" ? "接近上限" : "深度充足",
    });
  }

  // 4. 费用占比
  if (swap.feeUsd !== undefined && swap.fromUsd !== undefined && swap.fromUsd > 0) {
    const feeBps = bps(swap.feeUsd / swap.fromUsd);
    const sev: Severity = feeBps > mandate.maxFeeBps ? "fail" : feeBps > mandate.maxFeeBps * 0.75 ? "warn" : "pass";
    dims.push({
      key: "fees",
      label: "Fee load",
      severity: sev,
      observed: `${usd(swap.feeUsd)} (${feeBps}bps)`,
      limit: `≤ ${mandate.maxFeeBps}bps`,
      note: sev === "fail" ? "费用吞掉收益" : sev === "warn" ? "费用偏高" : "费用合理",
    });
  }

  // 5. 收款地址
  if (swap.recipientAddress && swap.walletAddress) {
    const self = swap.recipientAddress.toLowerCase() === swap.walletAddress.toLowerCase();
    const sev: Severity = self ? "pass" : mandate.recipientMustBeSelf ? "fail" : "warn";
    dims.push({
      key: "recipient",
      label: "Recipient",
      severity: sev,
      observed: self ? "self" : `→ ${swap.recipientAddress}`,
      limit: mandate.recipientMustBeSelf ? "self only" : "any",
      note: sev === "fail" ? "资金流向非本钱包地址，授权禁止" : self ? "回到本钱包" : "流向外部地址",
    });
  }

  // 6. 跨链
  if (swap.srcChainId !== undefined && swap.destChainId !== undefined) {
    const cross = swap.srcChainId !== swap.destChainId;
    const sev: Severity = !cross ? "pass" : mandate.allowCrossChain ? "warn" : "fail";
    dims.push({
      key: "crossChain",
      label: "Cross-chain",
      severity: sev,
      observed: cross ? `${swap.srcChainId} → ${swap.destChainId}` : `same (${swap.srcChainId})`,
      limit: mandate.allowCrossChain ? "allowed" : "same-chain only",
      note: sev === "fail" ? "授权禁止跨链" : cross ? "跨链桥增加结算与桥风险" : "同链",
    });
  }

  // 7. 授权
  if (swap.requiresApproval !== undefined) {
    const sev: Severity = !swap.requiresApproval ? "pass" : mandate.allowNewApproval ? "warn" : "fail";
    dims.push({
      key: "approval",
      label: "ERC-20 approval",
      severity: sev,
      observed: swap.requiresApproval ? "required" : "none",
      limit: mandate.allowNewApproval ? "allowed" : "no new approval",
      note: sev === "fail" ? "授权禁止新增 approval" : swap.requiresApproval ? "需先发 approval，确认额度非无限" : "无需授权",
    });
  }

  // 最坏情况损失（滑点触底）
  let worstCaseLossUsd: number | undefined;
  if (
    swap.destAmount !== undefined &&
    swap.minDestAmount !== undefined &&
    swap.destAmount > 0 &&
    swap.toUsd !== undefined
  ) {
    const lossFrac = (swap.destAmount - swap.minDestAmount) / swap.destAmount;
    worstCaseLossUsd = Math.max(0, lossFrac * swap.toUsd);
    notes.push(`最坏情况（滑点触 minDest）实现损失约 ${usd(worstCaseLossUsd)}（${pct(lossFrac)}）`);
  }

  // Guard Mode 2FA 预测提示（reveal，不代替 native 判定）
  if (swap.fromUsd !== undefined && swap.fromUsd > mandate.maxUsdPerTrade) {
    notes.push(
      "若 native Guard Mode 的 24h outflow 限额 ≤ 本笔额度，执行时预计触发 2FA。preflight 只揭示，不代替也不绕过 native 判定。",
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
