import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_WARRANT, type WarrantSpec } from "./score.js";

/** Read warrant fields from warrant.json in cwd; missing fields and a missing file fall back to defaults. */
export function loadWarrant(cwd = process.cwd(), file = "warrant.json"): {
  spec: WarrantSpec;
  source: string;
} {
  const path = resolve(cwd, file);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WarrantSpec>;
    return { spec: mergeWarrant(raw), source: path };
  } catch {
    return { spec: { ...DEFAULT_WARRANT }, source: "(defaults)" };
  }
}

/** Merge overrides onto the defaults with type/range checks; invalid values are ignored. */
export function mergeWarrant(over: Partial<WarrantSpec>): WarrantSpec {
  const s: WarrantSpec = { ...DEFAULT_WARRANT };
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
