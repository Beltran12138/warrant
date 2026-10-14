/**
 * An ERC-8183 swap job on Arc mainnet, settled by WarrantSwapJob against the agent's warrant and Chainlink.
 *
 *   node scripts/swap-job-arc.mjs open                          client opens the job and places the order
 *   node scripts/swap-job-arc.mjs fund   <jobId>                client funds it (the agent receives the capital)
 *   node scripts/swap-job-arc.mjs submit <jobId> <signed.json> <outAmount>   prints the agent's mm commands
 *   node scripts/swap-job-arc.mjs status <jobId>                job, order and what settle would decide
 *   node scripts/swap-job-arc.mjs settle <jobId>                anyone settles it
 *
 * Client = ARC_PRIVATE_KEY (contracts/.env), which is also the principal of the agent's warrant. Agent =
 * the mm wallet (ERC-8004 agent 1419): its steps (setBudget, approve, submit) are printed as
 * `mm wallet send-transaction` commands, never sent from here. Addresses: SWAP_JOB_CORE and SWAP_JOB_HOOK
 * env vars (from DeploySwapJobArc.s.sol). Order: 0.5 USDC → EURC, service fee 0.01 USDC.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, hashTypedData, http, parseEventLogs, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ATTESTATION_TYPES, QUOTE_TERMS_COMPONENTS } from "../dist/lib/onchain.js";

const RPC = process.env.RPC_URL ?? "https://rpc.mainnet.arc.io";
const TX = (h) => `https://explorer.arc.io/tx/${h}`;
const CORE = process.env.SWAP_JOB_CORE;
const HOOK = process.env.SWAP_JOB_HOOK;
const USDC = "0x3600000000000000000000000000000000000000"; // ERC-20 interface, 6 decimals
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const AGENT = (process.env.AGENT ?? "0x299e298ded14b36412a7857ed02b844e7fb58e0e");
const AGENT_ID = BigInt(process.env.AGENT_ID ?? "1419");
const CAPITAL = 500_000n; // 0.5 USDC
const FEE = 10_000n; // 0.01 USDC
if (!CORE || !HOOK) throw new Error("set SWAP_JOB_CORE and SWAP_JOB_HOOK");

const ATT = { type: "tuple", components: ATTESTATION_TYPES.PreflightAttestation };
const TERMS = { type: "tuple", components: QUOTE_TERMS_COMPONENTS };
const JOB = { type: "tuple", components: [
  { name: "client", type: "address" }, { name: "status", type: "uint8" }, { name: "provider", type: "address" }, { name: "expiredAt", type: "uint48" },
  { name: "evaluator", type: "address" }, { name: "submittedAt", type: "uint48" }, { name: "budget", type: "uint256" }, { name: "hook", type: "address" },
  { name: "paymentToken", type: "address" }, { name: "providerAgentId", type: "uint256" }, { name: "description", type: "string" },
  { name: "settledAmount", type: "uint256" }, { name: "payoutReceiver", type: "address" }] };
const CORE_ABI = [
  { type: "function", name: "createJob", stateMutability: "nonpayable", inputs: [{ name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "expiredAt", type: "uint48" }, { name: "description", type: "string" }, { name: "hook", type: "address" }, { name: "providerAgentId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setBudget", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { type: "function", name: "fund", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "expectedToken", type: "address" }, { name: "expectedBudget", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { type: "function", name: "submit", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "deliverable", type: "bytes32" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { type: "function", name: "getJob", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }], outputs: [JOB] },
  { type: "event", name: "JobCreated", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "client", type: "address", indexed: true }, { name: "provider", type: "address", indexed: true }, { name: "evaluator", type: "address", indexed: false }, { name: "expiredAt", type: "uint48", indexed: false }, { name: "hook", type: "address", indexed: false }] },
];
const HOOK_ABI = [
  { type: "function", name: "placeOrder", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "sellToken", type: "address" }, { name: "sellAmount", type: "uint256" }, { name: "buyToken", type: "address" }, { name: "buyer", type: "address" }], outputs: [] },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [{ name: "paid", type: "bool" }] },
  { type: "function", name: "preview", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }], outputs: [{ name: "r", type: "tuple", components: [
    { name: "paid", type: "bool" }, { name: "fairOut", type: "uint256" }, { name: "shortfallBps", type: "uint256" }, { name: "budgetBps", type: "uint256" },
    { name: "slippageBps", type: "uint256" }, { name: "maxSlippageBps", type: "uint256" }, { name: "warrantOk", type: "bool" }, { name: "tradedAgainstFail", type: "bool" }] }] },
  { type: "function", name: "orders", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }], outputs: [
    { name: "sellToken", type: "address" }, { name: "sellAmount", type: "uint256" }, { name: "buyToken", type: "address" }, { name: "buyer", type: "address" },
    { name: "funded", type: "bool" }, { name: "delivered", type: "bool" }, { name: "outAmount", type: "uint256" }, { name: "disclosure", type: "bytes32" },
    { name: "warrantVersion", type: "uint32" }, { name: "verdict", type: "uint8" }, { name: "quotedOut", type: "uint256" }] },
  { type: "event", name: "Settled", inputs: [{ name: "jobId", type: "uint256", indexed: true }, { name: "disclosure", type: "bytes32", indexed: true }, { name: "paid", type: "bool", indexed: false }, { name: "fairOut", type: "uint256", indexed: false }, { name: "outAmount", type: "uint256", indexed: false }, { name: "shortfallBps", type: "uint256", indexed: false }, { name: "budgetBps", type: "uint256", indexed: false }, { name: "slippageBps", type: "uint256", indexed: false }, { name: "maxSlippageBps", type: "uint256", indexed: false }] },
];
const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];
const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

const envPath = process.env.WARRANT_ENV_FILE ?? join(import.meta.dirname, "..", "contracts", ".env"); // override only for a fork rehearsal
const env = Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => l.split("=", 2)));
const chain = defineChain({ id: 5042, name: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const client = createWalletClient({ account: privateKeyToAccount(env.ARC_PRIVATE_KEY), chain, transport: http(RPC) }).extend(publicActions);
const me = client.account.address;

const send = async (label, args) => {
  const hash = await client.writeContract(args);
  const r = await client.waitForTransactionReceipt({ hash });
  console.log(`  ${r.status === "success" ? "✓" : "✗"} ${label}  ${TX(hash)}`);
  if (r.status !== "success") process.exit(1);
  return r;
};
const mmCommand = (to, data, intent) =>
  `mm wallet send-transaction --chain-id 5042 --payload '${JSON.stringify({ to, value: "0x0", data })}' --intent "${intent}" --wait`;

const [cmd, a1, a2, a3] = process.argv.slice(2);

async function placeOrder(jobId) {
  await send(`placeOrder(job ${jobId}: 0.5 USDC → EURC, buyer = client)`, { address: HOOK, abi: HOOK_ABI, functionName: "placeOrder", args: [jobId, USDC, CAPITAL, EURC, me] });
  console.log(`
Job ${jobId}. The agent (mm wallet) now sets the 0.01 USDC fee:
`);
  console.log(mmCommand(CORE, encodeFunctionData({ abi: CORE_ABI, functionName: "setBudget", args: [jobId, USDC, FEE, "0x"] }), `Warrant: accept swap job ${jobId} for a 0.01 USDC fee`));
}

if (cmd === "warrant") {
  // Principal (= client) re-grants the agent's warrant with a fee limit that fits a $0.50 trade on Arc, where
  // gas alone is ~2% of the notional: $1,000/trade, 1% slippage, 1.5% impact, 3% fees, same-wallet return.
  const REG = "0x80B435fF87276f1302BfCAB4D7202555EeCDe73f";
  const W = { type: "tuple", components: [
    { name: "maxUsdPerTradeCents", type: "uint64" }, { name: "maxSlippageBps", type: "uint16" }, { name: "maxPriceImpactBps", type: "uint16" },
    { name: "maxFeeBps", type: "uint16" }, { name: "allowCrossChain", type: "bool" }, { name: "allowNewApproval", type: "bool" },
    { name: "recipientMustBeSelf", type: "bool" }, { name: "expiresAt", type: "uint64" }] };
  const ABI = [{ type: "function", name: "setWarrant", stateMutability: "nonpayable", inputs: [{ name: "agent", type: "address" }, { name: "m", ...W }], outputs: [{ type: "uint32" }] }];
  const maxFeeBps = Number(a1 ?? 300);
  await send(`setWarrant(agent ${AGENT}, maxFeeBps ${maxFeeBps})`, {
    address: REG, abi: ABI, functionName: "setWarrant",
    args: [AGENT, { maxUsdPerTradeCents: 100_000n, maxSlippageBps: 100, maxPriceImpactBps: 150, maxFeeBps, allowCrossChain: true, allowNewApproval: true, recipientMustBeSelf: true, expiresAt: 0n }],
  });
} else if (cmd === "open") {
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3 * 24 * 3600);
  const r = await send("createJob (client → agent, evaluator = hook = WarrantSwapJob)", {
    address: CORE, abi: CORE_ABI, functionName: "createJob",
    args: [AGENT, HOOK, Number(expiredAt), "Warrant swap job: 0.5 USDC to EURC within the agent's warrant", HOOK, AGENT_ID],
  });
  const jobId = parseEventLogs({ abi: CORE_ABI, logs: r.logs, eventName: "JobCreated" })[0].args.jobId;
  await placeOrder(jobId);
} else if (cmd === "order") {
  await placeOrder(BigInt(a1)); // resume a job whose order was not placed
} else if (cmd === "fund") {
  const jobId = BigInt(a1);
  await send("approve core for the 0.01 USDC fee", { address: USDC, abi: ERC20, functionName: "approve", args: [CORE, FEE] });
  await send("approve hook for the 0.5 USDC capital", { address: USDC, abi: ERC20, functionName: "approve", args: [HOOK, CAPITAL] });
  await send(`fund job ${jobId} (fee escrowed, capital forwarded to the agent)`, { address: CORE, abi: CORE_ABI, functionName: "fund", args: [jobId, USDC, FEE, "0x"] });
} else if (cmd === "submit") {
  const jobId = BigInt(a1);
  const s = JSON.parse(readFileSync(a2, "utf8"));
  const out = BigInt(a3);
  const td = s.typedData;
  const p = s.priceCheck.terms;
  const att = { ...td.message, warrantVersion: Number(td.message.warrantVersion), verdict: Number(td.message.verdict) };
  const terms = { ...p, sellAmount: BigInt(p.sellAmount), buyAmount: BigInt(p.buyAmount) };
  const { EIP712Domain, ...types } = td.types;
  const digest = hashTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
  const opt = encodeAbiParameters([ATT, TERMS, { type: "uint256" }], [att, terms, out]);
  console.log(`Disclosure ${digest}; delivering ${out} EURC base units (quoted ${terms.buyAmount}). The agent runs:\n`);
  console.log(mmCommand(EURC, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [HOOK, out] }), `Warrant: let job ${jobId} escrow ${out} EURC units`));
  console.log();
  console.log(mmCommand(CORE, encodeFunctionData({ abi: CORE_ABI, functionName: "submit", args: [jobId, digest, opt] }), `Warrant: deliver swap job ${jobId} with disclosure`));
} else if (cmd === "status" || cmd === "settle") {
  const jobId = BigInt(a1);
  const job = await client.readContract({ address: CORE, abi: CORE_ABI, functionName: "getJob", args: [jobId] });
  const o = await client.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "orders", args: [jobId] });
  console.log(`Job ${jobId}: ${STATUS[job.status]}, provider ${job.provider}, agentId ${job.providerAgentId}, fee ${job.budget}`);
  console.log(`  order: sell ${o[1]} of ${o[0]} → ${o[2]}, funded ${o[4]}, delivered ${o[5]} (${o[6]} units vs quoted ${o[10]}), disclosure ${o[7]}`);
  if (o[5] && STATUS[job.status] === "Submitted") {
    const r = await client.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "preview", args: [jobId] });
    console.log(`  preview: paid ${r.paid}; Chainlink-fair ${r.fairOut}, shortfall ${r.shortfallBps}/${r.budgetBps}(+tolerance) bps, slippage vs quote ${r.slippageBps}/${r.maxSlippageBps} bps, warrant ok ${r.warrantOk}, traded against FAIL ${r.tradedAgainstFail}`);
    if (cmd === "settle") {
      const rc = await send(`settle job ${jobId}`, { address: HOOK, abi: HOOK_ABI, functionName: "settle", args: [jobId] });
      const ev = parseEventLogs({ abi: HOOK_ABI, logs: rc.logs, eventName: "Settled" })[0].args;
      const after = await client.readContract({ address: CORE, abi: CORE_ABI, functionName: "getJob", args: [jobId] });
      console.log(`  Settled: ${ev.paid ? "PAID" : "REJECTED"} → job ${STATUS[after.status]}; buyer EURC balance ${await client.readContract({ address: EURC, abi: ERC20, functionName: "balanceOf", args: [o[3]] })}`);
    }
  }
} else {
  console.error("usage: node scripts/swap-job-arc.mjs open | fund <jobId> | submit <jobId> <signed.json> <outAmount> | status <jobId> | settle <jobId>");
  process.exit(1);
}
