import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_MANDATE, type MandateSpec } from "./score.js";

/** 从 cwd 的 mandate.json 读取部分/全部 mandate 字段，缺失项回落默认。找不到文件=返回默认。 */
export function loadMandate(cwd = process.cwd(), file = "mandate.json"): {
  spec: MandateSpec;
  source: string;
} {
  const path = resolve(cwd, file);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MandateSpec>;
    return { spec: mergeMandate(raw), source: path };
  } catch {
    return { spec: { ...DEFAULT_MANDATE }, source: "(defaults)" };
  }
}

/** 把部分覆盖合并到默认值上，做类型/范围校验，非法项忽略并回落默认。 */
export function mergeMandate(over: Partial<MandateSpec>): MandateSpec {
  const s: MandateSpec = { ...DEFAULT_MANDATE };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  s.maxUsdPerTrade = num(over.maxUsdPerTrade) ?? s.maxUsdPerTrade;
  s.maxSlippageBps = num(over.maxSlippageBps) ?? s.maxSlippageBps;
  s.maxPriceImpactBps = num(over.maxPriceImpactBps) ?? s.maxPriceImpactBps;
  s.maxFeeBps = num(over.maxFeeBps) ?? s.maxFeeBps;
  s.allowCrossChain = bool(over.allowCrossChain) ?? s.allowCrossChain;
  s.allowNewApproval = bool(over.allowNewApproval) ?? s.allowNewApproval;
  s.recipientMustBeSelf = bool(over.recipientMustBeSelf) ?? s.recipientMustBeSelf;
  return s;
}
