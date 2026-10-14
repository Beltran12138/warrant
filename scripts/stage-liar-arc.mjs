/**
 * Stage a dishonest agent on Arc mainnet and let Chainlink catch it.
 *
 *   node scripts/stage-liar-arc.mjs
 *
 * The agent is staged, and labelled so in its ERC-8004 registration: a fresh throwaway key
 * (LIAR_AGENT_PRIVATE_KEY, appended to contracts/.env on first run; it only signs, it never holds
 * funds). ARC_PRIVATE_KEY (the deployer) acts as its operator, as the principal that grants it the
 * same warrant the mm wallet has, and as the relayer. The quote is staged too: 0.5 USDC → EURC at 5%
 * below the Chainlink-fair output read from WarrantPriceCheck at run time. The agent signs PASS on it
 * without running preflight; the relayer puts the disclosure on chain through WarrantReputation and
 * asks WarrantPriceCheck to re-price it. Six transactions, about 0.02 USDC of gas.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, defineChain, http, keccak256, parseEventLogs, publicActions, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ATTESTATION_TYPES, PRICE_CHECK_ABI, quoteTermsHash } from "../dist/lib/onchain.js";

const RPC = process.env.RPC_URL ?? "https://rpc.mainnet.arc.io";
const TX = (h) => `https://explorer.arc.io/tx/${h}`;
const REGISTRY = "0x80B435fF87276f1302BfCAB4D7202555EeCDe73f";
const ATTESTOR = "0x33B7B8db2927783dEbb58a589CF5c7B95824fae1";
const BRIDGE = "0x30906fFDE26d87868B602D34DA96f2C0006e3962";
const PRICE_CHECK = "0xdF3fE689F0a3C74Ce299018cB573870769f04571";
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const NATIVE = "0x0000000000000000000000000000000000000000";

const WARRANT = { type: "tuple", components: [
  { name: "maxUsdPerTradeCents", type: "uint64" }, { name: "maxSlippageBps", type: "uint16" }, { name: "maxPriceImpactBps", type: "uint16" },
  { name: "maxFeeBps", type: "uint16" }, { name: "allowCrossChain", type: "bool" }, { name: "allowNewApproval", type: "bool" },
  { name: "recipientMustBeSelf", type: "bool" }, { name: "expiresAt", type: "uint64" }] };
const ABI = [
  { type: "function", name: "setWarrant", stateMutability: "nonpayable", inputs: [{ name: "agent", type: "address" }, { name: "m", ...WARRANT }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "getWarrant", stateMutability: "view", inputs: [{ name: "principal", type: "address" }, { name: "agent", type: "address" }], outputs: [{ name: "warrant", ...WARRANT }, { name: "version", type: "uint32" }, { name: "active", type: "bool" }] },
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setAgentWallet", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "deadline", type: "uint256" }, { name: "signature", type: "bytes" }], outputs: [] },
  { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string", indexed: false }, { name: "owner", type: "address", indexed: true }] },
  { type: "function", name: "submitAndRate", stateMutability: "nonpayable", inputs: [{ name: "a", type: "tuple", components: ATTESTATION_TYPES.PreflightAttestation }, { name: "signature", type: "bytes" }, { name: "agentId", type: "uint256" }], outputs: [] },
  { type: "function", name: "getSummary", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }, { name: "clientAddresses", type: "address[]" }, { name: "tag1", type: "string" }, { name: "tag2", type: "string" }], outputs: [{ name: "count", type: "uint64" }, { name: "summaryValue", type: "int128" }, { name: "summaryValueDecimals", type: "uint8" }] },
  { type: "event", name: "PriceChecked", inputs: [
    { name: "digest", type: "bytes32", indexed: true }, { name: "agent", type: "address", indexed: true }, { name: "principal", type: "address", indexed: true },
    { name: "fairOut", type: "uint256", indexed: false }, { name: "quotedOut", type: "uint256", indexed: false }, { name: "shortfallBps", type: "uint256", indexed: false },
    { name: "budgetBps", type: "uint256", indexed: false }, { name: "outOfBounds", type: "bool", indexed: false }, { name: "contradicted", type: "bool", indexed: false }] },
];

const envPath = process.env.WARRANT_ENV_FILE ?? join(import.meta.dirname, "..", "contracts", ".env"); // override only for a fork rehearsal
const readEnv = () =>
  Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => l.split("=", 2)));
let env = readEnv();
if (!env.LIAR_AGENT_PRIVATE_KEY) {
  appendFileSync(envPath, `\nLIAR_AGENT_PRIVATE_KEY=${generatePrivateKey()}\n`);
  env = readEnv();
}
const liar = privateKeyToAccount(env.LIAR_AGENT_PRIVATE_KEY);
const chain = defineChain({ id: 5042, name: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const deployer = createWalletClient({ account: privateKeyToAccount(env.ARC_PRIVATE_KEY), chain, transport: http(RPC) }).extend(publicActions);
const me = deployer.account.address;
if ((await deployer.getChainId()) !== 5042) throw new Error("not Arc mainnet");

const send = async (label, args) => {
  const hash = await deployer.writeContract(args);
  const r = await deployer.waitForTransactionReceipt({ hash });
  console.log(`  ${r.status === "success" ? "✓" : "✗"} ${label}  ${TX(hash)}`);
  if (r.status !== "success") process.exit(1);
  return r;
};

console.log(`Staged dishonest agent ${liar.address} (throwaway key; operator, principal and relayer ${me})`);

// 1. ERC-8004 identity, labelled as staged, bound to the liar's key by its own signature.
const uri = `data:application/json;base64,${Buffer.from(JSON.stringify({
  name: "Warrant demo: staged dishonest agent",
  description: "Staged on purpose: signs PASS without running preflight, to show WarrantPriceCheck (Chainlink Data Feeds) recording it as contradicted. Not a real trading agent. https://github.com/Beltran12138/warrant",
})).toString("base64")}`;
const reg = await send("register ERC-8004 identity", { address: IDENTITY, abi: ABI, functionName: "register", args: [uri] });
const agentId = parseEventLogs({ abi: ABI, logs: reg.logs, eventName: "Registered" })[0].args.agentId;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 240);
const bindSig = await liar.signTypedData({
  domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: 5042, verifyingContract: IDENTITY },
  types: { AgentWalletSet: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "owner", type: "address" }, { name: "deadline", type: "uint256" }] },
  primaryType: "AgentWalletSet",
  message: { agentId, newWallet: liar.address, owner: me, deadline },
});
await send(`agentWallet of agentId ${agentId} := ${liar.address}`, { address: IDENTITY, abi: ABI, functionName: "setAgentWallet", args: [agentId, liar.address, deadline, bindSig] });

// 2. The same warrant the mm wallet holds: $1,000/trade, 1% slippage, 1.5% impact, 0.5% fees.
const w = { maxUsdPerTradeCents: 100_000n, maxSlippageBps: 100, maxPriceImpactBps: 150, maxFeeBps: 50, allowCrossChain: true, allowNewApproval: true, recipientMustBeSelf: true, expiresAt: 0n };
await send("principal grants the warrant", { address: REGISTRY, abi: ABI, functionName: "setWarrant", args: [liar.address, w] });
const [, version] = await deployer.readContract({ address: REGISTRY, abi: ABI, functionName: "getWarrant", args: [me, liar.address] });

// 3. A staged bad quote, 5% below what Chainlink says 0.5 USDC buys.
const sellAmount = 5n * 10n ** 17n;
const fair = await deployer.readContract({ address: PRICE_CHECK, abi: PRICE_CHECK_ABI, functionName: "fairOut", args: [NATIVE, EURC, sellAmount] });
const terms = { quoteIdHash: keccak256(stringToHex(`staged-bad-quote:${Date.now()}`)), sellToken: NATIVE, buyToken: EURC, sellAmount, buyAmount: (fair * 95n) / 100n };
console.log(`  staged quote: 0.5 USDC → ${terms.buyAmount} EURC base units; Chainlink-fair ${fair}`);

// 4. The liar signs PASS without running preflight.
const att = {
  principal: me, agent: liar.address, quoteHash: quoteTermsHash(terms), warrantVersion: Number(version), verdict: 0,
  scorecardHash: keccak256(stringToHex("staged: PASS signed without running preflight")),
};
const { EIP712Domain, ...types } = ATTESTATION_TYPES;
const sig = await liar.signTypedData({ domain: { name: "Warrant", version: "1", chainId: 5042, verifyingContract: ATTESTOR }, types, primaryType: "PreflightAttestation", message: att });

// 5. Relayed like any disclosure, then re-priced against Chainlink.
await send("disclosure relayed and rated (warrant-preflight / pass)", { address: BRIDGE, abi: ABI, functionName: "submitAndRate", args: [att, sig, agentId] });
const pc = await send("WarrantPriceCheck.checkAndRate", { address: PRICE_CHECK, abi: PRICE_CHECK_ABI, functionName: "checkAndRate", args: [att, terms, agentId] });
const ev = parseEventLogs({ abi: ABI, logs: pc.logs, eventName: "PriceChecked" })[0].args;
console.log(`  PriceChecked: fair ${ev.fairOut}, quoted ${ev.quotedOut}, shortfall ${ev.shortfallBps} bps, budget ${ev.budgetBps} bps, out of bounds ${ev.outOfBounds}, contradicted ${ev.contradicted}`);
const [n] = await deployer.readContract({ address: REPUTATION, abi: ABI, functionName: "getSummary", args: [agentId, [PRICE_CHECK], "warrant-oracle", "contradicted"] });
console.log(`  ERC-8004 agentId ${agentId}: warrant-oracle / contradicted = ${n}`);
