/**
 * Live demo: Chainlink catches an agent that lies about a quote.
 *
 *   node scripts/demo-pricecheck.mjs            (needs foundry's anvil and the Arc RPC; costs nothing)
 *
 * Forks Arc mainnet locally and uses the contracts deployed there: WarrantRegistry, WarrantAttestor,
 * WarrantReputation, WarrantPriceCheck (Chainlink USDC/USD and EURC/USD feeds) and Arc's ERC-8004
 * registries. Two agents get an ERC-8004 identity and the same warrant, and both see the same bad quote:
 * 0.5 USDC → EURC at 5% below the Chainlink-fair output. The honest agent runs preflight and discloses
 * FAIL; the dishonest one signs PASS. Both disclosures are relayed and re-priced on chain. The agents,
 * the principal and the quote are staged with anvil's public test keys; everything they touch is the
 * real contract code and the live feed prices, on a fork.
 */
import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWalletClient, defineChain, http, keccak256, parseEventLogs, publicActions, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ATTESTATION_TYPES, PRICE_CHECK_ABI, quoteTermsHash, readOracleCheck } from "../dist/lib/onchain.js";
import { DEFAULT_WARRANT, oracleDimension } from "../dist/lib/score.js";

const BIN = process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin");
const exe = (n) => join(BIN, process.platform === "win32" ? `${n}.exe` : n);
const PORT = 8551;
const RPC = `http://127.0.0.1:${PORT}`;
const ARC_RPC = process.env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io";

// Arc mainnet deployments
const REGISTRY = "0x80B435fF87276f1302BfCAB4D7202555EeCDe73f";
const ATTESTOR = "0x33B7B8db2927783dEbb58a589CF5c7B95824fae1";
const BRIDGE = "0x30906fFDE26d87868B602D34DA96f2C0006e3962";
const PRICE_CHECK = "0xdF3fE689F0a3C74Ce299018cB573870769f04571";
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const NATIVE = "0x0000000000000000000000000000000000000000";

// Throwaway keys derived from fixed labels, funded on the fork only. Not anvil's default accounts: those
// public keys carry EIP-7702 delegations on Arc mainnet, so an ERC-721 mint to them reverts.
const KEYS = Object.fromEntries(["relayer", "honest", "liar", "principal"].map((n) => [n, keccak256(stringToHex(`warrant-demo:${n}`))]));

const ABI = {
  registry: [
    {
      type: "function", name: "setWarrant", stateMutability: "nonpayable",
      inputs: [{ name: "agent", type: "address" }, { name: "m", type: "tuple", components: [
        { name: "maxUsdPerTradeCents", type: "uint64" }, { name: "maxSlippageBps", type: "uint16" }, { name: "maxPriceImpactBps", type: "uint16" },
        { name: "maxFeeBps", type: "uint16" }, { name: "allowCrossChain", type: "bool" }, { name: "allowNewApproval", type: "bool" },
        { name: "recipientMustBeSelf", type: "bool" }, { name: "expiresAt", type: "uint64" }] }],
      outputs: [{ type: "uint32" }],
    },
  ],
  identity: [
    { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "setAgentWallet", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "deadline", type: "uint256" }, { name: "signature", type: "bytes" }], outputs: [] },
    { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string", indexed: false }, { name: "owner", type: "address", indexed: true }] },
  ],
  bridge: [
    { type: "function", name: "submitAndRate", stateMutability: "nonpayable", inputs: [{ name: "a", type: "tuple", components: ATTESTATION_TYPES.PreflightAttestation }, { name: "signature", type: "bytes" }, { name: "agentId", type: "uint256" }], outputs: [] },
  ],
  reputation: [
    { type: "function", name: "getSummary", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }, { name: "clientAddresses", type: "address[]" }, { name: "tag1", type: "string" }, { name: "tag2", type: "string" }], outputs: [{ name: "count", type: "uint64" }, { name: "summaryValue", type: "int128" }, { name: "summaryValueDecimals", type: "uint8" }] },
  ],
  priceChecked: [
    { type: "event", name: "PriceChecked", inputs: [
      { name: "digest", type: "bytes32", indexed: true }, { name: "agent", type: "address", indexed: true }, { name: "principal", type: "address", indexed: true },
      { name: "fairOut", type: "uint256", indexed: false }, { name: "quotedOut", type: "uint256", indexed: false }, { name: "shortfallBps", type: "uint256", indexed: false },
      { name: "budgetBps", type: "uint256", indexed: false }, { name: "outOfBounds", type: "bool", indexed: false }, { name: "contradicted", type: "bool", indexed: false }] },
  ],
};

const env = { ...process.env };
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"]) delete env[k];
const anvil = spawn(exe("anvil"), ["--port", String(PORT), "--fork-url", ARC_RPC, "--silent"], { env, stdio: "ignore" });
const step = (s) => console.log(`\n▶ ${s}`);

try {
  for (let i = 0; i < 100; i++) {
    try {
      execFileSync(exe("cast"), ["chain-id", "--rpc-url", RPC], { env, stdio: "ignore" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const chain = defineChain({ id: 5042, name: "Arc fork", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const wallet = (pk) => createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(RPC) }).extend(publicActions);
  const relayer = wallet(KEYS.relayer);
  const principal = wallet(KEYS.principal);
  const send = async (c, args) => relayer.waitForTransactionReceipt({ hash: await c.writeContract(args) });
  for (const pk of Object.values(KEYS)) {
    await relayer.request({ method: "anvil_setBalance", params: [privateKeyToAccount(pk).address, "0x56BC75E2D63100000"] }); // 100 USDC of gas, fork only
  }

  step("Two agents, one ERC-8004 identity each (agentWallet bound by the agent's own signature)");
  const agents = {};
  for (const name of ["honest", "liar"]) {
    const agent = privateKeyToAccount(KEYS[name]);
    const r = await send(relayer, { address: IDENTITY, abi: ABI.identity, functionName: "register", args: [`data:,warrant-demo-${name}`] });
    const agentId = parseEventLogs({ abi: ABI.identity, logs: r.logs, eventName: "Registered" })[0].args.agentId;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 240);
    const sig = await agent.signTypedData({
      domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: 5042, verifyingContract: IDENTITY },
      types: { AgentWalletSet: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "owner", type: "address" }, { name: "deadline", type: "uint256" }] },
      primaryType: "AgentWalletSet",
      message: { agentId, newWallet: agent.address, owner: relayer.account.address, deadline },
    });
    await send(relayer, { address: IDENTITY, abi: ABI.identity, functionName: "setAgentWallet", args: [agentId, agent.address, deadline, sig] });
    agents[name] = { account: agent, agentId };
    console.log(`  ${name.padEnd(6)} agent ${agent.address}  ERC-8004 agentId ${agentId}`);
  }

  step("The principal grants both the same warrant: price impact ≤ 150 bps, fees ≤ 50 bps");
  const w = { maxUsdPerTradeCents: 100_000n, maxSlippageBps: 100, maxPriceImpactBps: 150, maxFeeBps: 50, allowCrossChain: true, allowNewApproval: true, recipientMustBeSelf: true, expiresAt: 0n };
  for (const a of Object.values(agents)) {
    await principal.waitForTransactionReceipt({ hash: await principal.writeContract({ address: REGISTRY, abi: ABI.registry, functionName: "setWarrant", args: [a.account.address, w] }) });
  }

  step("A bad quote: 0.5 USDC → EURC at 5% below the Chainlink-fair output (live Arc feeds)");
  const probe = { quoteIdHash: keccak256(stringToHex("probe")), sellToken: NATIVE, buyToken: EURC, sellAmount: 5n * 10n ** 17n, buyAmount: 0n };
  const fair = (await readOracleCheck({ rpcUrl: RPC, priceCheck: PRICE_CHECK, terms: probe, spec: DEFAULT_WARRANT })).fairOut;
  const terms = { ...probe, quoteIdHash: keccak256(stringToHex("demo-bad-quote")), buyAmount: (fair * 95n) / 100n };
  const dim = oracleDimension(await readOracleCheck({ rpcUrl: RPC, priceCheck: PRICE_CHECK, terms, spec: DEFAULT_WARRANT }));
  console.log(`  fair ${fair} vs quoted ${terms.buyAmount} EURC base units`);
  console.log(`  preflight: ${dim.severity.toUpperCase()}  ${dim.label}: ${dim.observed}`);

  const disclose = { honest: dim.severity === "fail" ? 2 : 0, liar: 0 }; // the liar signs PASS whatever preflight says
  for (const [name, a] of Object.entries(agents)) {
    step(`${name} agent signs ${["PASS", "WARN", "FAIL"][disclose[name]]}, a relayer puts it on chain and asks Chainlink`);
    const att = { principal: principal.account.address, agent: a.account.address, quoteHash: quoteTermsHash(terms), warrantVersion: 1, verdict: disclose[name], scorecardHash: keccak256(stringToHex(`scorecard-${name}`)) };
    const { EIP712Domain, ...types } = ATTESTATION_TYPES;
    const sig = await a.account.signTypedData({ domain: { name: "Warrant", version: "1", chainId: 5042, verifyingContract: ATTESTOR }, types, primaryType: "PreflightAttestation", message: att });
    await send(relayer, { address: BRIDGE, abi: ABI.bridge, functionName: "submitAndRate", args: [att, sig, a.agentId] });
    const r = await send(relayer, { address: PRICE_CHECK, abi: PRICE_CHECK_ABI, functionName: "checkAndRate", args: [att, terms, a.agentId] });
    const ev = parseEventLogs({ abi: ABI.priceChecked, logs: r.logs, eventName: "PriceChecked" })[0].args;
    console.log(`  PriceChecked: shortfall ${ev.shortfallBps} bps, budget ${ev.budgetBps} bps, out of bounds ${ev.outOfBounds}, contradicted ${ev.contradicted}`);
  }

  step("ERC-8004 reputation from WarrantPriceCheck (tag1 \"warrant-oracle\")");
  for (const [name, a] of Object.entries(agents)) {
    const n = async (tag2) => (await relayer.readContract({ address: REPUTATION, abi: ABI.reputation, functionName: "getSummary", args: [a.agentId, [PRICE_CHECK], "warrant-oracle", tag2] }))[0];
    console.log(`  ${name.padEnd(6)} agentId ${a.agentId}: consistent ${await n("consistent")}, contradicted ${await n("contradicted")}`);
  }
} finally {
  anvil.kill();
}
