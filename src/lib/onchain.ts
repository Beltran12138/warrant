import { createPublicClient, encodeFunctionData, http, keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { scoreSwap, type WarrantSpec, type ProposedSwap, type Scorecard, type Severity } from "./score.js";

/** Minimal ABI slice of contracts/src/WarrantRegistry.sol used by the plugin. */
export const WARRANT_REGISTRY_ABI = [
  {
    type: "function",
    name: "getWarrant",
    stateMutability: "view",
    inputs: [
      { name: "principal", type: "address" },
      { name: "agent", type: "address" },
    ],
    outputs: [
      {
        name: "warrant",
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
  {
    type: "function",
    name: "attestPreflight",
    stateMutability: "nonpayable",
    inputs: [
      { name: "principal", type: "address" },
      { name: "quoteHash", type: "bytes32" },
      { name: "warrantVersion", type: "uint32" },
      { name: "verdict", type: "uint8" },
      { name: "scorecardHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

export interface OnchainWarrantTuple {
  maxUsdPerTradeCents: bigint;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  maxFeeBps: number;
  allowCrossChain: boolean;
  allowNewApproval: boolean;
  recipientMustBeSelf: boolean;
  expiresAt: bigint;
}

export interface OnchainWarrant {
  spec: WarrantSpec;
  version: number;
  active: boolean;
  expiresAt: number;
  chainId: number;
  /** Human-readable provenance, e.g. "onchain:10143:0xabc…/principal→agent". */
  source: string;
}

/** Contract tuple → plugin WarrantSpec (cents → USD). Pure, unit-tested. */
export function onchainToSpec(m: OnchainWarrantTuple): WarrantSpec {
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

export async function readOnchainWarrant(opts: {
  rpcUrl: string;
  registry: Address;
  principal: Address;
  agent: Address;
}): Promise<OnchainWarrant> {
  const client = createPublicClient({ transport: http(opts.rpcUrl) });
  const chainId = await client.getChainId();
  const [m, version, active] = await client.readContract({
    address: opts.registry,
    abi: WARRANT_REGISTRY_ABI,
    functionName: "getWarrant",
    args: [opts.principal, opts.agent],
  });
  return {
    spec: onchainToSpec(m),
    version,
    active,
    expiresAt: Number(m.expiresAt),
    chainId,
    source: `onchain:${chainId}:${opts.registry} principal=${opts.principal} agent=${opts.agent}`,
  };
}

export const fetchGasPrice = (rpcUrl: string): Promise<bigint> =>
  createPublicClient({ transport: http(rpcUrl) }).getGasPrice();

/** Score a swap against an on-chain warrant; a missing/revoked/expired warrant forces verdict=fail. */
export function scoreAgainstOnchain(swap: ProposedSwap, onchain: OnchainWarrant): Scorecard {
  const scorecard = scoreSwap(swap, onchain.spec);
  if (!onchain.active) {
    scorecard.verdict = "fail";
    scorecard.notes.unshift(
      onchain.version === 0
        ? "No on-chain warrant from this principal to this agent: the agent is not authorised."
        : `On-chain warrant v${onchain.version} is revoked or expired: the agent is not currently authorised.`,
    );
  }
  return scorecard;
}

/** Verdict enum index in WarrantRegistry (Pass=0, Warn=1, Fail=2). */
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

export interface AttestArgs {
  registry: Address;
  principal: Address;
  quoteHash: Hex;
  warrantVersion: number;
  verdict: number;
  scorecardHash: Hex;
}

export const attestCalldata = (a: AttestArgs): Hex =>
  encodeFunctionData({
    abi: WARRANT_REGISTRY_ABI,
    functionName: "attestPreflight",
    args: [a.principal, a.quoteHash, a.warrantVersion, a.verdict, a.scorecardHash],
  });

/**
 * Chains where mm 6.2.0 cannot prepare a transaction on its own: MetaMask's gas-fee API and RPC
 * proxy answer "Invalid chainId", so the payload must carry gas and fees, and mm must be pointed at
 * a working RPC (MM_INFURA_RPC_BASE_URL, see scripts/mm-rpc-shim.mjs). Tested on Monad testnet.
 */
export const MM_UNSUPPORTED_RPC_CHAINS = new Set([10143]);

/** Gas limit for attestPreflight: measured 30,788 (Fuji) and 35,130 (Monad), plus headroom. */
export const ATTEST_GAS_LIMIT = 45_000n;

export interface MmSendTransaction {
  chainId: number;
  payload: { to: Address; value: Hex; data: Hex; gas?: Hex; maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex };
  /** Ready-to-run command; the active mm wallet must be the agent the warrant was granted to. */
  command: string;
  /** Set when the chain needs the RPC shim (MM_UNSUPPORTED_RPC_CHAINS). */
  note?: string;
}

/**
 * Build the `mm wallet send-transaction` call that attests this scorecard from the mm wallet itself.
 * gasPriceWei is only used on MM_UNSUPPORTED_RPC_CHAINS, where mm cannot estimate fees.
 */
export function mmSendTransaction(a: AttestArgs, chainId: number, gasPriceWei?: bigint): MmSendTransaction {
  const payload: MmSendTransaction["payload"] = { to: a.registry, value: "0x0", data: attestCalldata(a) };
  const unsupported = MM_UNSUPPORTED_RPC_CHAINS.has(chainId);
  if (unsupported && gasPriceWei !== undefined) {
    payload.gas = toHex(ATTEST_GAS_LIMIT);
    payload.maxFeePerGas = toHex(gasPriceWei * 2n);
    payload.maxPriorityFeePerGas = toHex(2_000_000_000n);
  }
  const verdict = ["PASS", "WARN", "FAIL"][a.verdict] ?? String(a.verdict);
  const command = `mm wallet send-transaction --chain-id ${chainId} --payload '${JSON.stringify(payload)}' --intent "Warrant: attest ${verdict} preflight v${a.warrantVersion} before trading" --wait`;
  return {
    chainId,
    payload,
    command,
    note: unsupported
      ? "mm's RPC proxy does not serve this chain yet: start `node scripts/mm-rpc-shim.mjs` and prefix the command with MM_INFURA_RPC_BASE_URL=http://127.0.0.1:47812"
      : undefined,
  };
}
