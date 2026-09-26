import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_MANDATE, type MandateSpec } from "./score.js";

/** Read mandate fields from mandate.json in cwd; missing fields and a missing file fall back to defaults. */
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

/** Merge overrides onto the defaults with type/range checks; invalid values are ignored. */
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
