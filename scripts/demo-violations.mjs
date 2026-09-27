/**
 * Stage one of each audit outcome on a testnet, for scripts/audit.mjs to find:
 *   grant → disclose PASS → trade (ok) → trade again with no disclosure (UNATTESTED)
 *   → disclose FAIL → trade anyway (EXECUTED_AFTER_FAIL) → principal revokes → trade (NO_ACTIVE_WARRANT)
 *
 * The "trades" are stand-ins: 1e-6 native-token transfers to 0x…dEaD, sent by the agent. The audit
 * treats any successful non-bookkeeping transaction from the agent as an action, so the verdicts do
 * not depend on what the trade is. Disclosures use the synthetic fixtures' real scorecards.
 *
 *   node scripts/demo-violations.mjs <monad|fuji>     (needs contracts/.env; prints the audit command)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, defineChain, http, parseEther, publicActions } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { quoteHash, scoreAgainstOnchain, readOnchainWarrant, scorecardHash, VERDICT_INDEX, WARRANT_REGISTRY_ABI } from "../dist/lib/onchain.js";
import { clean, risky } from "../test/fixtures.mjs";

const REGISTRY = "0x37cdFe2a144993dC3145367305fF66E29302E673";
const SINK = "0x000000000000000000000000000000000000dEaD";
const NETS = {
  monad: { id: 10143, rpc: "https://testnet-rpc.monad.xyz", tx: (h) => `https://testnet.monadvision.com/tx/${h}` },
  fuji: { id: 43113, rpc: "https://api.avax-test.network/ext/bc/C/rpc", tx: (h) => `https://subnets-test.avax.network/c-chain/tx/${h}` },
};
const WRITE_ABI = [
  ...WARRANT_REGISTRY_ABI,
  {
    type: "function",
    name: "setWarrant",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      {
        name: "m",
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
    ],
    outputs: [{ type: "uint32" }],
  },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [{ name: "agent", type: "address" }], outputs: [] },
];

const net = NETS[process.argv[2]];
if (!net) {
  console.error("usage: node scripts/demo-violations.mjs <monad|fuji>");
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "..", "contracts", ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=", 2)),
);
const chain = defineChain({ id: net.id, name: process.argv[2], nativeCurrency: { name: "", symbol: "", decimals: 18 }, rpcUrls: { default: { http: [net.rpc] } } });
const wallet = (pk) => createWalletClient({ account: privateKeyToAccount(pk, { nonceManager }), chain, transport: http(net.rpc) }).extend(publicActions);
const principal = wallet(env.DEPLOYER_PRIVATE_KEY);
const agent = wallet(env.AGENT_PRIVATE_KEY);
const P = principal.account.address;
const A = agent.account.address;

const wait = async (label, hash) => {
  const r = await principal.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`  ${label.padEnd(34)} block ${r.blockNumber}  ${net.tx(hash)}`);
  return r;
};
const write = (c, functionName, args) => c.writeContract({ address: REGISTRY, abi: WRITE_ABI, functionName, args });
const trade = (label) => agent.sendTransaction({ to: SINK, value: parseEther("0.000001") }).then((h) => wait(label, h));
const disclose = async (label, swap) => {
  const w = await readOnchainWarrant({ rpcUrl: net.rpc, registry: REGISTRY, principal: P, agent: A });
  const sc = scoreAgainstOnchain(swap, w);
  return wait(label, await write(agent, "attestPreflight", [P, quoteHash(swap.quoteId), w.version, VERDICT_INDEX[sc.verdict], scorecardHash(sc)]));
};

console.log(`principal ${P}\nagent     ${A}\n`);
const start = await wait("grant warrant (principal)", await write(principal, "setWarrant", [A, { maxUsdPerTradeCents: 100_000n, maxSlippageBps: 100, maxPriceImpactBps: 150, maxFeeBps: 50, allowCrossChain: true, allowNewApproval: true, recipientMustBeSelf: true, expiresAt: 0n }]));
await disclose("disclose PASS (clean quote)", clean);
await trade("trade 1   expect: ok");
await trade("trade 2   expect: UNATTESTED");
await disclose("disclose FAIL (risky quote)", risky);
await trade("trade 3   expect: EXECUTED_AFTER_FAIL");
await wait("revoke (principal)", await write(principal, "revoke", [A]));
const end = await trade("trade 4   expect: NO_ACTIVE_WARRANT");

console.log(`\nnode scripts/audit.mjs ${process.argv[2]} --principal ${P} --agent ${A} --from-block ${start.blockNumber} --to-block ${end.blockNumber}`);
