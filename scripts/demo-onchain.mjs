/**
 * Live testnet walkthrough of the Mandate flow (used for the demo video):
 *   1. principal grants the agent a mandate on MandateRegistry
 *   2. preflight scores two synthetic swap quotes against the ON-CHAIN mandate
 *   3. the agent attests each scorecard on-chain (attestPreflight)
 *   4. principal revokes → preflight now reports the agent as unauthorised
 *
 * Quotes are the synthetic fixtures in test/fixtures.mjs: a live `mm swap quote` needs a funded
 * mainnet wallet, so the scoring input is fixed while every mandate read/write here is real.
 *
 * Usage:  npm run build && node scripts/demo-onchain.mjs <monad|fuji>
 * Needs contracts/.env with DEPLOYER_PRIVATE_KEY (principal) and AGENT_PRIVATE_KEY, both funded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, defineChain, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { renderScorecard } from "../dist/lib/score.js";
import {
  quoteHash,
  readOnchainMandate,
  scoreAgainstOnchain,
  scorecardHash,
  VERDICT_INDEX,
} from "../dist/lib/onchain.js";
import { clean, risky } from "../test/fixtures.mjs";

const REGISTRY = "0xf0145a8b57fb97d352f7a650b4c4ae4488951f48";
const CHAINS = {
  monad: {
    chain: defineChain({
      id: 10143,
      name: "Monad Testnet",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
    }),
    tx: (h) => `https://testnet.monadvision.com/tx/${h}`,
  },
  fuji: {
    chain: defineChain({
      id: 43113,
      name: "Avalanche Fuji",
      nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
      rpcUrls: { default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] } },
    }),
    tx: (h) => `https://testnet.snowtrace.io/tx/${h}`,
  },
};

const ABI = [
  {
    type: "function",
    name: "setMandate",
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
    outputs: [{ name: "version", type: "uint32" }],
  },
  {
    type: "function",
    name: "revoke",
    stateMutability: "nonpayable",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "attestPreflight",
    stateMutability: "nonpayable",
    inputs: [
      { name: "principal", type: "address" },
      { name: "quoteHash", type: "bytes32" },
      { name: "mandateVersion", type: "uint32" },
      { name: "verdict", type: "uint8" },
      { name: "scorecardHash", type: "bytes32" },
    ],
    outputs: [],
  },
];

const which = process.argv[2];
const net = CHAINS[which];
if (!net) {
  console.error("usage: node scripts/demo-onchain.mjs <monad|fuji>");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "..", "contracts", ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=", 2)),
);
const rpcUrl = net.chain.rpcUrls.default.http[0];
const client = (pk) =>
  createWalletClient({ account: privateKeyToAccount(pk), chain: net.chain, transport: http(rpcUrl) }).extend(
    publicActions,
  );
const principal = client(env.DEPLOYER_PRIVATE_KEY);
const agent = client(env.AGENT_PRIVATE_KEY);
const P = principal.account.address;
const A = agent.account.address;

const send = async (c, functionName, args, label) => {
  const hash = await c.writeContract({ address: REGISTRY, abi: ABI, functionName, args });
  const r = await c.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ↳ ${label}: ${net.tx(hash)}`);
  return hash;
};
const read = () => readOnchainMandate({ rpcUrl, registry: REGISTRY, principal: P, agent: A });

console.log(`\n=== Mandate on ${net.chain.name} — registry ${REGISTRY} ===`);
console.log(`principal ${P}\nagent     ${A}\n`);

console.log("1) Principal grants the agent a mandate: ≤$1,000/trade, ≤100bps slippage, ≤150bps impact, ≤50bps fees, self-custody only, 30-day expiry");
await send(
  principal,
  "setMandate",
  [
    A,
    {
      maxUsdPerTradeCents: 100_000n,
      maxSlippageBps: 100,
      maxPriceImpactBps: 150,
      maxFeeBps: 50,
      allowCrossChain: true,
      allowNewApproval: true,
      recipientMustBeSelf: true,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
    },
  ],
  "setMandate",
);

const granted = await read();
console.log(`\n2) Preflight reads it back from chain → v${granted.version}, active=${granted.active}`);

for (const [label, swap] of [
  ["clean $250 same-chain swap", clean],
  ["oversized, high-slippage, cross-chain swap to a foreign address", risky],
]) {
  const sc = scoreAgainstOnchain(swap, granted);
  console.log(`\n--- ${label} ---`);
  console.log(renderScorecard(sc, `${granted.source} v${granted.version}`));
  console.log(`\n3) Agent attests it saw this ${sc.verdict.toUpperCase()} scorecard before acting`);
  await send(
    agent,
    "attestPreflight",
    [P, quoteHash(swap.quoteId), granted.version, VERDICT_INDEX[sc.verdict], scorecardHash(sc)],
    `attestPreflight(${sc.verdict})`,
  );
}

console.log("\n4) Principal revokes the mandate");
await send(principal, "revoke", [A], "revoke");
const revoked = await read();
const after = scoreAgainstOnchain(clean, revoked);
console.log(`\nSame clean swap after revoke → v${revoked.version}, active=${revoked.active}`);
console.log(renderScorecard(after, `${revoked.source} v${revoked.version} (inactive)`));
console.log();
