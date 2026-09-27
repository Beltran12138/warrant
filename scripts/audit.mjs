/**
 * Warrant audit (violation detector): reads a principal → agent warrant history, the agent's
 * disclosures and the agent's own transactions from chain, and reports trades made without an
 * active warrant, without a disclosure, or after disclosing FAIL.
 *
 *   node scripts/audit.mjs <monad|fuji> --principal 0x… --agent 0x… --from-block N [--to-block M]
 *   add --json for machine-readable output
 *
 * Sources are all on-chain: logs of WarrantRegistry / WarrantAttestor, and a scan of every block in
 * range for transactions sent by the agent. Coverage = the agent's nonce delta over the range, so
 * the report states how many of the agent's outgoing transactions it actually examined.
 * Transactions to Warrant or ERC-8004 contracts are bookkeeping, not trades; everything else the
 * agent sends successfully counts as an action.
 */
import { createPublicClient, getAddress, http, parseAbiItem } from "viem";
import { audit, renderAudit, seedEvent } from "../dist/lib/audit.js";
import { WARRANT_REGISTRY_ABI } from "../dist/lib/onchain.js";

const NETS = {
  monad: { rpc: "https://testnet-rpc.monad.xyz", logChunk: 100, tx: (h) => `https://testnet.monadvision.com/tx/${h}` },
  fuji: { rpc: "https://api.avax-test.network/ext/bc/C/rpc", logChunk: 2000, tx: (h) => `https://subnets-test.avax.network/c-chain/tx/${h}` },
};
const REGISTRY = "0x37cdFe2a144993dC3145367305fF66E29302E673";
const ATTESTOR = "0xC356ac5ebD7d249102D3C9c25764A8815c1718aA";
const BOOKKEEPING = new Set(
  [REGISTRY, ATTESTOR, "0x0FAf92b84f00201e888210B62ef5055Cc3BbefED", "0x8004A818BFB912233c491871b3d84c89A494BD9e", "0x8004B663056A597Dffe9eCcC1965A193B7388713"].map((a) => a.toLowerCase()),
);
const MAX_SCAN = 20_000;

const EV = {
  set: parseAbiItem(
    "event WarrantSet(address indexed principal, address indexed agent, uint32 version, (uint64 maxUsdPerTradeCents, uint16 maxSlippageBps, uint16 maxPriceImpactBps, uint16 maxFeeBps, bool allowCrossChain, bool allowNewApproval, bool recipientMustBeSelf, uint64 expiresAt) warrant)",
  ),
  revoke: parseAbiItem("event WarrantRevoked(address indexed principal, address indexed agent, uint32 version)"),
  tx: parseAbiItem("event PreflightAttested(address indexed principal, address indexed agent, bytes32 indexed quoteHash, uint32 warrantVersion, uint8 verdict, bytes32 scorecardHash)"),
  signed: parseAbiItem(
    "event SignedPreflightAttested(address indexed principal, address indexed agent, bytes32 indexed quoteHash, uint32 warrantVersion, uint8 verdict, bytes32 scorecardHash, address submitter)",
  ),
};

const argv = process.argv.slice(2);
const net = NETS[argv[0]];
const opt = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i > 0 ? argv[i + 1] : undefined;
};
if (!net || !opt("principal") || !opt("agent") || !opt("from-block")) {
  console.error("usage: node scripts/audit.mjs <monad|fuji> --principal 0x… --agent 0x… --from-block N [--to-block M] [--json]");
  process.exit(1);
}
const principal = getAddress(opt("principal"));
const agent = getAddress(opt("agent"));
const client = createPublicClient({ transport: http(net.rpc, { retryCount: 5 }) });
const from = BigInt(opt("from-block"));
const to = opt("to-block") ? BigInt(opt("to-block")) : await client.getBlockNumber();
if (to - from > BigInt(MAX_SCAN)) throw new Error(`range ${to - from} blocks is over ${MAX_SCAN}; narrow it`);

async function logs(address, event) {
  const out = [];
  for (let a = from; a <= to; a += BigInt(net.logChunk)) {
    const b = a + BigInt(net.logChunk) - 1n > to ? to : a + BigInt(net.logChunk) - 1n;
    out.push(...(await client.getLogs({ address, event, args: { principal, agent }, fromBlock: a, toBlock: b })));
  }
  return out;
}
const pos = (l) => ({ block: Number(l.blockNumber), txIndex: l.transactionIndex });

const [sets, revokes, txAtts, signedAtts] = await Promise.all([
  logs(REGISTRY, EV.set),
  logs(REGISTRY, EV.revoke),
  logs(REGISTRY, EV.tx),
  logs(ATTESTOR, EV.signed),
]);
// The warrant may have been granted before the range: seed the timeline with its state at from-1.
const [w0, v0, active0] = await client.readContract({
  address: REGISTRY,
  abi: WARRANT_REGISTRY_ABI,
  functionName: "getWarrant",
  args: [principal, agent],
  blockNumber: from - 1n,
});
const t0 = (await client.getBlock({ blockNumber: from - 1n })).timestamp;
const initial = seedEvent(Number(from - 1n), { version: v0, active: active0, expiresAt: Number(w0.expiresAt) }, Number(t0));
const events = [
  ...initial,
  ...sets.map((l) => ({ ...pos(l), kind: "set", version: l.args.version, expiresAt: Number(l.args.warrant.expiresAt) })),
  ...revokes.map((l) => ({ ...pos(l), kind: "revoke", version: l.args.version })),
];
const att = (kind) => (l) => ({ ...pos(l), kind, verdict: l.args.verdict, version: l.args.warrantVersion, quoteHash: l.args.quoteHash, txHash: l.transactionHash });
const attestations = [...txAtts.map(att("tx")), ...signedAtts.map(att("signed"))];

// Every transaction the agent sent in range, from the blocks themselves.
const sent = [];
const blocks = [];
for (let b = from; b <= to; b++) blocks.push(b);
for (let i = 0; i < blocks.length; i += 20) {
  const batch = await Promise.all(blocks.slice(i, i + 20).map((n) => client.getBlock({ blockNumber: n, includeTransactions: true })));
  for (const blk of batch) {
    for (const tx of blk.transactions) {
      if (tx.from.toLowerCase() === agent.toLowerCase()) sent.push({ tx, timestamp: Number(blk.timestamp) });
    }
  }
}
const receipts = await Promise.all(sent.map(({ tx }) => client.getTransactionReceipt({ hash: tx.hash })));
const actions = [];
const skipped = { bookkeeping: 0, reverted: 0 };
sent.forEach(({ tx, timestamp }, i) => {
  if (tx.to && BOOKKEEPING.has(tx.to.toLowerCase())) return void skipped.bookkeeping++;
  if (receipts[i].status !== "success") return void skipped.reverted++;
  actions.push({ block: Number(tx.blockNumber), txIndex: tx.transactionIndex, txHash: tx.hash, to: tx.to, timestamp });
});

// Coverage denominator: how many transactions the agent really sent in [from, to].
const [n0, n1] = await Promise.all([
  client.getTransactionCount({ address: agent, blockNumber: from - 1n }),
  client.getTransactionCount({ address: agent, blockNumber: to }),
]);
const report = audit({ events, attestations, actions, coverage: { expected: n1 - n0, found: sent.length } });
report.notes.push(
  `blocks ${from}–${to}; agent sent ${sent.length} tx: ${actions.length} action(s), ${skipped.bookkeeping} Warrant/ERC-8004 bookkeeping, ${skipped.reverted} reverted`,
  `${events.length - initial.length} warrant event(s) in range (state before: ${v0 === 0 ? "never granted" : `v${v0} ${active0 ? "active" : "inactive"}`}), ${txAtts.length} transaction disclosure(s), ${signedAtts.length} signed disclosure(s) for principal ${principal}`,
);

if (argv.includes("--json")) {
  console.log(JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
} else {
  console.log(`principal ${principal}\nagent     ${agent}\n`);
  console.log(renderAudit(report, net.tx));
}
process.exitCode = report.violations > 0 ? 2 : 0;
