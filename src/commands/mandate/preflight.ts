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
} satisfies InputSchema;

type PreflightResult = {
  scorecard: Scorecard | null;
  mandate: MandateSpec;
  mandateSource: string;
  /** 无待检报价等软状态的说明。 */
  message?: string;
};

const toNum = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** priceImpact 约定为比率(fraction)；>1 视为百分数兜底。附原值供人核。 */
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

  // 只读揭示：需要已登录会话以访问 stored quote，但不初始化钱包提交路径。
  static override requiresAuth = true;
  static override requiresInit = false;

  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  /** Must match package.json#mm.commands[].id. */
  protected readonly pluginCommandId = "mandate:preflight";

  async execute(io: CommandIO): Promise<PreflightResult> {
    const { quoteId, mandateFile } = await io.resolveInputs(inputs);
    const { spec, source } = loadMandate(process.cwd(), mandateFile || "mandate.json");

    const store = this.ctx.swapQuoteStore;

    // 选定要检的报价：显式 id，否则取最近一条 pending。
    let targetId = quoteId?.trim();
    if (!targetId) {
      const ids = store.listQuoteIds?.() ?? [];
      if (ids.length === 0) {
        return {
          scorecard: null,
          mandate: spec,
          mandateSource: source,
          message:
            "没有待检的 swap 报价。先运行 `mm swap quote ...` 生成报价，再 `mm mandate preflight` 揭示其风险。",
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
        message: `无法读取报价 ${targetId}：${(e as Error).message}`,
      };
    }

    const swap = this.normalize(targetId, loaded);
    const scorecard = scoreSwap(swap, spec);
    return { scorecard, mandate: spec, mandateSource: source };
  }

  /** 按 createdAt 取最近；无 createdAt 时取数组最后一个。 */
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
        /* 跳过坏报价 */
      }
    }
    return best;
  }

  /** PersistedSwapQuote → ProposedSwap（归一化 + 单位换算）。 */
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
    if (!data.scorecard) return data.message ?? "无结果。";
    return renderScorecard(data.scorecard, data.mandateSource);
  }
}
