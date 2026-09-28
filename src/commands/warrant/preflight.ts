import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import {
  type WarrantSpec,
  normalizeImpact,
  percentToFraction,
  type ProposedSwap,
  renderScorecard,
  type Scorecard,
  scoreSwap,
  ramsDimension,
  withDimension,
} from "../../lib/score.js";
import { loadWarrant } from "../../lib/spec.js";
import {
  type AttestationTypedData,
  attestationTypedData,
  fetchGasPrice,
  MM_UNSUPPORTED_RPC_CHAINS,
  type MmSendTransaction,
  mmSendTransaction,
  mmSignTypedDataCommand,
  quoteHash,
  readOnchainWarrant,
  readRamsCheck,
  scoreAgainstOnchain,
  scorecardHash,
  VERDICT_INDEX,
} from "../../lib/onchain.js";
import type { Address } from "viem";

const inputs = {
  quoteId: {
    type: InputFieldType.Text,
    flag: "quote-id",
    message: "Quote id to preflight (default: latest pending swap quote)",
    required: false,
    prompt: false,
    index: 0,
  },
  warrantFile: {
    type: InputFieldType.Text,
    flag: "warrant-file",
    message: "Path to a warrant.json overriding the default suitability limits",
    required: false,
    prompt: false,
  },
  registry: {
    type: InputFieldType.Text,
    flag: "registry",
    message: "WarrantRegistry contract address — read the warrant on-chain instead of from warrant.json",
    required: false,
    prompt: false,
  },
  principal: {
    type: InputFieldType.Text,
    flag: "principal",
    message: "Address of the principal who granted the on-chain warrant (with --registry)",
    required: false,
    prompt: false,
  },
  agent: {
    type: InputFieldType.Text,
    flag: "agent",
    message: "Agent address the warrant was granted to (default: the quote's wallet address)",
    required: false,
    prompt: false,
  },
  attestor: {
    type: InputFieldType.Text,
    flag: "attestor",
    message: "WarrantAttestor address — also emit an EIP-712 attestation to sign off-chain (with --registry)",
    required: false,
    prompt: false,
  },
  rams: {
    type: InputFieldType.Text,
    flag: "rams",
    message: "ERC-8226 (RAMS) registry — when the sold asset is gated by it, add the agent's mandate check to the scorecard (with --registry, same RPC)",
    required: false,
    prompt: false,
  },
  rpcUrl: {
    type: InputFieldType.Text,
    flag: "rpc-url",
    message: "RPC endpoint of the chain the WarrantRegistry lives on (with --registry)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

/** Everything the agent needs to call WarrantRegistry.attestPreflight for this scorecard. */
type Attestation = {
  rpcUrl: string;
  registry: string;
  principal: string;
  agent: string;
  warrantVersion: number;
  quoteHash: string;
  verdict: number;
  scorecardHash: string;
  /** The same attestation as an `mm wallet send-transaction` call, signed by the mm wallet itself. */
  mm: MmSendTransaction;
  /** With --attestor: sign this off-chain (no transaction), then anyone submits it to WarrantAttestor. */
  signed?: { attestor: string; typedData: AttestationTypedData; command: string };
};

type PreflightResult = {
  scorecard: Scorecard | null;
  warrant: WarrantSpec;
  warrantSource: string;
  /** Present when the warrant is on-chain: what the agent needs to call attestPreflight. */
  attestation?: Attestation;
  /** Explanation for soft states such as "no pending quote". */
  message?: string;
};

const toNum = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** priceImpact is expected as a fraction; values > 1 are treated as a percentage. */
const normImpact = (v: unknown): number | undefined => {
  const n = toNum(v);
  return n === undefined ? undefined : normalizeImpact(n);
};

export default class WarrantPreflight extends PluginCommand<PreflightResult> {
  static override description =
    "Preflight a pending swap quote against your warrant: reveal size, slippage, price impact, fees, recipient, cross-chain and approval risk before the agent executes. Reveals — never blocks or bypasses native Guard Mode.";

  static override examples = [
    "<%= config.bin %> warrant preflight",
    "<%= config.bin %> warrant preflight <quote-id>",
    "<%= config.bin %> warrant preflight --warrant-file ./warrant.json --json",
  ];

  // Read-only reveal: needs a logged-in session to read stored quotes, never initialises the submit path.
  static override requiresAuth = true;
  static override requiresInit = false;

  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  /** Must match package.json#mm.commands[].id. */
  protected readonly pluginCommandId = "warrant:preflight";

  async execute(io: CommandIO): Promise<PreflightResult> {
    const { quoteId, warrantFile, registry, principal, agent, attestor, rams, rpcUrl } = await io.resolveInputs(inputs);
    const { spec, source } = loadWarrant(process.cwd(), warrantFile || "warrant.json");

    const store = this.ctx.swapQuoteStore;

    // Pick the quote to check: explicit id, otherwise the most recent pending one.
    let targetId = quoteId?.trim();
    if (!targetId) {
      const ids = store.listQuoteIds?.() ?? [];
      if (ids.length === 0) {
        return {
          scorecard: null,
          warrant: spec,
          warrantSource: source,
          message:
            "No pending swap quote. Run `mm swap quote ...` first, then `mm warrant preflight` to reveal its risk.",
        };
      }
      targetId = this.pickLatest(store, ids);
    }

    let loaded: unknown;
    try {
      loaded = store.load(targetId);
    } catch (e) {
      return {
        scorecard: null,
        warrant: spec,
        warrantSource: source,
        message: `Cannot read quote ${targetId}: ${(e as Error).message}`,
      };
    }

    const swap = this.normalize(targetId, loaded);

    if (!registry?.trim()) {
      const scorecard = scoreSwap(swap, spec);
      return { scorecard, warrant: spec, warrantSource: source };
    }

    // On-chain warrant: the limits the principal granted this agent in WarrantRegistry.
    const agentAddr = (agent?.trim() || swap.walletAddress) as Address | undefined;
    if (!principal?.trim() || !rpcUrl?.trim() || !agentAddr) {
      return {
        scorecard: null,
        warrant: spec,
        warrantSource: source,
        message: "--registry requires --principal and --rpc-url (the agent defaults to the quote's wallet address; pass --agent if it is missing).",
      };
    }
    let onchain: Awaited<ReturnType<typeof readOnchainWarrant>>;
    try {
      onchain = await readOnchainWarrant({
        rpcUrl: rpcUrl.trim(),
        registry: registry.trim() as Address,
        principal: principal.trim() as Address,
        agent: agentAddr,
      });
    } catch (e) {
      return {
        scorecard: null,
        warrant: spec,
        warrantSource: source,
        message: `Failed to read the on-chain warrant: ${(e as Error).message}`,
      };
    }

    let scorecard = scoreAgainstOnchain(swap, onchain);
    if (rams?.trim()) scorecard = await this.addRams(scorecard, swap, rams.trim() as Address, rpcUrl.trim(), agentAddr, principal.trim() as Address);
    let attestation: Attestation | undefined;
    if (onchain.active) {
      const args = {
        registry: registry.trim() as Address,
        principal: principal.trim() as Address,
        quoteHash: quoteHash(targetId),
        warrantVersion: onchain.version,
        verdict: VERDICT_INDEX[scorecard.verdict],
        scorecardHash: scorecardHash(scorecard),
      };
      // mm cannot estimate fees on some chains; read the gas price from the warrant's own RPC.
      const gasPrice = MM_UNSUPPORTED_RPC_CHAINS.has(onchain.chainId)
        ? await fetchGasPrice(rpcUrl.trim()).catch(() => undefined)
        : undefined;
      attestation = {
        ...args,
        rpcUrl: rpcUrl.trim(),
        agent: agentAddr,
        mm: mmSendTransaction(args, onchain.chainId, gasPrice),
      };
      if (attestor?.trim()) {
        const typedData = attestationTypedData(args, agentAddr, onchain.chainId, attestor.trim() as Address);
        attestation.signed = { attestor: attestor.trim(), typedData, command: mmSignTypedDataCommand(typedData) };
      }
    }
    return {
      scorecard,
      warrant: onchain.spec,
      warrantSource: `${onchain.source} v${onchain.version}${onchain.active ? "" : " (inactive)"}`,
      attestation,
    };
  }

  /** Fold an ERC-8226 mandate check into the scorecard when the sold asset is gated by that registry. */
  private async addRams(
    sc: Scorecard,
    swap: ProposedSwap,
    registry: Address,
    rpcUrl: string,
    agent: Address,
    principal: Address,
  ): Promise<Scorecard> {
    if (!swap.srcAsset || !swap.srcAmount) {
      return { ...sc, notes: [...sc.notes, "RAMS: the quote has no sell-side asset or amount; mandate not checked."] };
    }
    try {
      const check = await readRamsCheck({ rpcUrl, registry, agent, principal, asset: swap.srcAsset as Address, amount: BigInt(swap.srcAmount) });
      if (!check) {
        return { ...sc, notes: [...sc.notes, `RAMS: ${swap.srcAsset} is not gated by ${registry}; no mandate applies.`] };
      }
      return withDimension(sc, ramsDimension(check));
    } catch (e) {
      return withDimension(sc, {
        key: "ramsMandate",
        label: "ERC-8226 mandate",
        severity: "warn",
        observed: "could not evaluate",
        limit: `mandate in RAMS ${registry}`,
        note: `registry call failed: ${(e as Error).message.split("\n")[0]}`,
      });
    }
  }

  /** Latest by createdAt; falls back to the last id when createdAt is missing. */
  private pickLatest(
    store: { load(id: string): unknown },
    ids: string[],
  ): string {
    let best = ids[ids.length - 1];
    let bestTs = -Infinity;
    for (const id of ids) {
      try {
        const q = store.load(id) as { result?: { createdAt?: string }; createdAt?: string };
        const ts = Date.parse(q?.result?.createdAt ?? q?.createdAt ?? "");
        if (Number.isFinite(ts) && ts > bestTs) {
          bestTs = ts;
          best = id;
        }
      } catch {
        /* skip unreadable quotes */
      }
    }
    return best;
  }

  /** PersistedSwapQuote → ProposedSwap (normalisation + unit conversion). */
  private normalize(quoteId: string, loaded: unknown): ProposedSwap {
    const p = loaded as {
      createdAt?: string;
      result?: {
        createdAt?: string;
        request?: {
          walletAddress?: string;
          recipientAddress?: string;
          srcChainId?: number;
          destChainId?: number;
        };
        quote?: {
          srcChainId?: number;
          destChainId?: number;
          srcAsset?: { symbol?: string; address?: string };
          srcAssetAmount?: string;
          destAsset?: { symbol?: string };
          destAssetAmount?: string;
          minDestAssetAmount?: string;
          slippage?: number;
          requiresApproval?: boolean;
          networkFee?: { amount?: string; symbol?: string };
          priceData?: {
            priceImpact?: string;
            totalFromAmountUsd?: string;
            totalToAmountUsd?: string;
          };
          feeData?: {
            metabridge?: { usd?: string };
            txFee?: { usd?: string };
          };
        };
      };
    };
    const q = p.result?.quote;
    const r = p.result?.request;
    const feeUsd =
      (toNum(q?.feeData?.metabridge?.usd) ?? 0) + (toNum(q?.feeData?.txFee?.usd) ?? 0);
    const hasFee = q?.feeData?.metabridge?.usd !== undefined || q?.feeData?.txFee?.usd !== undefined;

    return {
      quoteId,
      createdAt: p.result?.createdAt ?? p.createdAt,
      walletAddress: r?.walletAddress,
      recipientAddress: r?.recipientAddress ?? r?.walletAddress,
      srcChainId: q?.srcChainId ?? r?.srcChainId,
      destChainId: q?.destChainId ?? r?.destChainId,
      srcSymbol: q?.srcAsset?.symbol,
      srcAsset: q?.srcAsset?.address,
      srcAmount: q?.srcAssetAmount,
      destSymbol: q?.destAsset?.symbol,
      fromUsd: toNum(q?.priceData?.totalFromAmountUsd),
      toUsd: toNum(q?.priceData?.totalToAmountUsd),
      slippage: q?.slippage !== undefined ? percentToFraction(q.slippage) : undefined,
      priceImpact: normImpact(q?.priceData?.priceImpact),
      destAmount: toNum(q?.destAssetAmount),
      minDestAmount: toNum(q?.minDestAssetAmount),
      feeUsd: hasFee ? feeUsd : undefined,
      networkFeeAmount: q?.networkFee?.amount,
      networkFeeSymbol: q?.networkFee?.symbol,
      requiresApproval: q?.requiresApproval,
    };
  }

  override successHint(data: PreflightResult): string {
    if (!data.scorecard) return data.message ?? "No result.";
    const out = renderScorecard(data.scorecard, data.warrantSource);
    const a = data.attestation;
    if (!a) return out;
    return [
      out,
      "",
      ...(a.signed
        ? [
            `Sign the attestation off-chain with the mm wallet (agent ${a.agent}; no transaction, no gas):`,
            `  ${a.signed.command}`,
            `then anyone can put it on-chain (WarrantAttestor ${a.signed.attestor}): save attestation.signed.typedData from --json output, and run node scripts/submit-signed.mjs <typed-data.json> <signature>`,
            "Or send it as a transaction:",
          ]
        : []),
      `Attest on-chain that this scorecard was shown before execution (the active mm wallet must be agent ${a.agent}):`,
      `  ${a.mm.command}`,
      ...(a.mm.note ? [`  note: ${a.mm.note}`] : []),
      "Agent with its own key instead:",
      `  cast send ${a.registry} "attestPreflight(address,bytes32,uint32,uint8,bytes32)" ${a.principal} ${a.quoteHash} ${a.warrantVersion} ${a.verdict} ${a.scorecardHash} --rpc-url ${a.rpcUrl} --private-key $AGENT_PRIVATE_KEY`,
    ].join("\n");
  }
}
