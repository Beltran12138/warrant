import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import {
  type MandateSpec,
  normalizeImpact,
  percentToFraction,
  type ProposedSwap,
  renderScorecard,
  type Scorecard,
  scoreSwap,
} from "../../lib/score.js";
import { loadMandate } from "../../lib/spec.js";
import {
  quoteHash,
  readOnchainMandate,
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
  mandateFile: {
    type: InputFieldType.Text,
    flag: "mandate-file",
    message: "Path to a mandate.json overriding the default suitability limits",
    required: false,
    prompt: false,
  },
  registry: {
    type: InputFieldType.Text,
    flag: "registry",
    message: "MandateRegistry contract address — read the mandate on-chain instead of from mandate.json",
    required: false,
    prompt: false,
  },
  principal: {
    type: InputFieldType.Text,
    flag: "principal",
    message: "Address of the principal who granted the on-chain mandate (with --registry)",
    required: false,
    prompt: false,
  },
  agent: {
    type: InputFieldType.Text,
    flag: "agent",
    message: "Agent address the mandate was granted to (default: the quote's wallet address)",
    required: false,
    prompt: false,
  },
  rpcUrl: {
    type: InputFieldType.Text,
    flag: "rpc-url",
    message: "RPC endpoint of the chain the MandateRegistry lives on (with --registry)",
    required: false,
    prompt: false,
  },
} satisfies InputSchema;

/** Everything the agent needs to call MandateRegistry.attestPreflight for this scorecard. */
type Attestation = {
  rpcUrl: string;
  registry: string;
  principal: string;
  agent: string;
  mandateVersion: number;
  quoteHash: string;
  verdict: number;
  scorecardHash: string;
};

type PreflightResult = {
  scorecard: Scorecard | null;
  mandate: MandateSpec;
  mandateSource: string;
  /** Present when the mandate is on-chain: what the agent needs to call attestPreflight. */
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

export default class MandatePreflight extends PluginCommand<PreflightResult> {
  static override description =
    "Preflight a pending swap quote against your mandate: reveal size, slippage, price impact, fees, recipient, cross-chain and approval risk before the agent executes. Reveals — never blocks or bypasses native Guard Mode.";

  static override examples = [
    "<%= config.bin %> mandate preflight",
    "<%= config.bin %> mandate preflight <quote-id>",
    "<%= config.bin %> mandate preflight --mandate-file ./mandate.json --json",
  ];

  // Read-only reveal: needs a logged-in session to read stored quotes, never initialises the submit path.
  static override requiresAuth = true;
  static override requiresInit = false;

  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  /** Must match package.json#mm.commands[].id. */
  protected readonly pluginCommandId = "mandate:preflight";

  async execute(io: CommandIO): Promise<PreflightResult> {
    const { quoteId, mandateFile, registry, principal, agent, rpcUrl } = await io.resolveInputs(inputs);
    const { spec, source } = loadMandate(process.cwd(), mandateFile || "mandate.json");

    const store = this.ctx.swapQuoteStore;

    // Pick the quote to check: explicit id, otherwise the most recent pending one.
    let targetId = quoteId?.trim();
    if (!targetId) {
      const ids = store.listQuoteIds?.() ?? [];
      if (ids.length === 0) {
        return {
          scorecard: null,
          mandate: spec,
          mandateSource: source,
          message:
            "No pending swap quote. Run `mm swap quote ...` first, then `mm mandate preflight` to reveal its risk.",
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
        mandate: spec,
        mandateSource: source,
        message: `Cannot read quote ${targetId}: ${(e as Error).message}`,
      };
    }

    const swap = this.normalize(targetId, loaded);

    if (!registry?.trim()) {
      const scorecard = scoreSwap(swap, spec);
      return { scorecard, mandate: spec, mandateSource: source };
    }

    // On-chain mandate: the limits the principal granted this agent in MandateRegistry.
    const agentAddr = (agent?.trim() || swap.walletAddress) as Address | undefined;
    if (!principal?.trim() || !rpcUrl?.trim() || !agentAddr) {
      return {
        scorecard: null,
        mandate: spec,
        mandateSource: source,
        message: "--registry requires --principal and --rpc-url (the agent defaults to the quote's wallet address; pass --agent if it is missing).",
      };
    }
    let onchain: Awaited<ReturnType<typeof readOnchainMandate>>;
    try {
      onchain = await readOnchainMandate({
        rpcUrl: rpcUrl.trim(),
        registry: registry.trim() as Address,
        principal: principal.trim() as Address,
        agent: agentAddr,
      });
    } catch (e) {
      return {
        scorecard: null,
        mandate: spec,
        mandateSource: source,
        message: `Failed to read the on-chain mandate: ${(e as Error).message}`,
      };
    }

    const scorecard = scoreAgainstOnchain(swap, onchain);
    return {
      scorecard,
      mandate: onchain.spec,
      mandateSource: `${onchain.source} v${onchain.version}${onchain.active ? "" : " (inactive)"}`,
      attestation: onchain.active
        ? {
            rpcUrl: rpcUrl.trim(),
            registry: registry.trim(),
            principal: principal.trim(),
            agent: agentAddr,
            mandateVersion: onchain.version,
            quoteHash: quoteHash(targetId),
            verdict: VERDICT_INDEX[scorecard.verdict],
            scorecardHash: scorecardHash(scorecard),
          }
        : undefined,
    };
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
          srcAsset?: { symbol?: string };
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
    const out = renderScorecard(data.scorecard, data.mandateSource);
    const a = data.attestation;
    if (!a) return out;
    return `${out}\n\nAttest on-chain that this scorecard was shown before execution:\n  cast send ${a.registry} "attestPreflight(address,bytes32,uint32,uint8,bytes32)" ${a.principal} ${a.quoteHash} ${a.mandateVersion} ${a.verdict} ${a.scorecardHash} --rpc-url ${a.rpcUrl} --private-key $AGENT_PRIVATE_KEY   # signer must be agent ${a.agent}`;
  }
}
