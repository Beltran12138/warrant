import { createPublicClient, http, keccak256, stringToHex, type Address, type Hex } from "viem";
import { scoreSwap, type MandateSpec, type ProposedSwap, type Scorecard, type Severity } from "./score.js";

/** Minimal ABI slice of contracts/src/MandateRegistry.sol used by the plugin. */
export const MANDATE_REGISTRY_ABI = [
  {
    type: "function",
    name: "getMandate",
    stateMutability: "view",
    inputs: [
      { name: "principal", type: "address" },
      { name: "agent", type: "address" },
    ],
    outputs: [
      {
        name: "mandate",
        type: "tuple",
        components: [
          { name: "maxUsdPerTradeCents", type: "uint64" },
          { name: "maxSlippageBps", type: "uint16" },
          { name: "maxPriceImpactBps", type: "uint16" },
          { name: "maxFeeBps", type: "uint16" },
          { name: "allowCrossChain", type: "bool" },
          { name: "allowNewApproval", type: "bool" },
          { name: "recipientMustBeSelf", type: "bool" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      { name: "version", type: "uint32" },
      { name: "active", type: "bool" },
    ],
  },
] as const;

export interface OnchainMandateTuple {
  maxUsdPerTradeCents: bigint;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeBps: number;
  allowCrossChain: boolean;
  allowNewApproval: boolean;
  recipientMustBeSelf: boolean;
  expiresAt: bigint;
}

export interface OnchainMandate {
  spec: MandateSpec;
  version: number;
  active: boolean;
  expiresAt: number;
  /** Human-readable provenance, e.g. "onchain:10143:0xabc…/principal→agent". */
  source: string;
}

/** Contract tuple → plugin MandateSpec (cents → USD). Pure, unit-tested. */
export function onchainToSpec(m: OnchainMandateTuple): MandateSpec {
  return {
    maxUsdPerTrade: Number(m.maxUsdPerTradeCents) / 100,
    maxSlippageBps: m.maxSlippageBps,
    maxPriceImpactBps: m.maxPriceImpactBps,
    maxFeeBps: m.maxFeeBps,
    allowCrossChain: m.allowCrossChain,
    allowNewApproval: m.allowNewApproval,
    recipientMustBeSelf: m.recipientMustBeSelf,
  };
}

export async function readOnchainMandate(opts: {
  rpcUrl: string;
  registry: Address;
  principal: Address;
  agent: Address;
}): Promise<OnchainMandate> {
  const client = createPublicClient({ transport: http(opts.rpcUrl) });
  const chainId = await client.getChainId();
  const [m, version, active] = await client.readContract({
    address: opts.registry,
    abi: MANDATE_REGISTRY_ABI,
    functionName: "getMandate",
    args: [opts.principal, opts.agent],
  });
  return {
    spec: onchainToSpec(m),
    version,
    active,
    expiresAt: Number(m.expiresAt),
    source: `onchain:${chainId}:${opts.registry} principal=${opts.principal} agent=${opts.agent}`,
  };
}

/** Score a swap against an on-chain mandate; a missing/revoked/expired mandate forces verdict=fail. */
export function scoreAgainstOnchain(swap: ProposedSwap, onchain: OnchainMandate): Scorecard {
  const scorecard = scoreSwap(swap, onchain.spec);
  if (!onchain.active) {
    scorecard.verdict = "fail";
    scorecard.notes.unshift(
      onchain.version === 0
        ? "链上没有该 principal 授予此 agent 的 mandate：agent 未获授权。"
        : `链上 mandate v${onchain.version} 已撤销或过期：agent 当前未获授权。`,
    );
  }
  return scorecard;
}

/** Verdict enum index in MandateRegistry (Pass=0, Warn=1, Fail=2). */
export const VERDICT_INDEX: Record<Severity, number> = { pass: 0, warn: 1, fail: 2 };

export const quoteHash = (quoteId: string): Hex => keccak256(stringToHex(quoteId));

/** keccak256 of the scorecard serialised with sorted keys, so the same scorecard always hashes the same. */
export function scorecardHash(sc: Scorecard): Hex {
  return keccak256(stringToHex(canonicalJson(sc)));
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}
