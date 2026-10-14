/**
 * Ask ERC-8004's ValidationRegistry on Arc mainnet to validate a Warrant disclosure with WarrantValidator,
 * then have the validator answer.
 *
 *   node scripts/validate-arc.mjs <signed.json> <agentId> [validator]
 *
 * <signed.json> is `attestation.signed` from `mm warrant preflight --attestor … --price-check … --json`
 * (typed data plus the quote terms); the disclosure must already be on chain (submit-signed.mjs).
 * The request must come from the agent identity's owner or an approved operator: ARC_PRIVATE_KEY in
 * contracts/.env, which registered agent 1419. The answer (`respond`) can come from anyone; the same key
 * sends it here. Two transactions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, defineChain, hashTypedData, http, parseEventLogs, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ATTESTATION_TYPES, QUOTE_TERMS_COMPONENTS } from "../dist/lib/onchain.js";

const RPC = process.env.RPC_URL ?? "https://rpc.mainnet.arc.io";
const TX = (h) => `https://explorer.arc.io/tx/${h}`;
const VALIDATION = "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58";
const DEFAULT_VALIDATOR = process.env.WARRANT_VALIDATOR;

const [file, agentIdArg, validatorArg] = process.argv.slice(2);
const validator = validatorArg ?? DEFAULT_VALIDATOR;
if (!file || !agentIdArg || !validator) {
  console.error("usage: node scripts/validate-arc.mjs <signed.json> <agentId> [validator]");
  process.exit(1);
}
const input = JSON.parse(readFileSync(file, "utf8"));
const td = input.typedData;
const p = input.priceCheck?.terms;
if (!td || !p) throw new Error("signed.json must be attestation.signed from preflight with --price-check");

const ABI = [
  { type: "function", name: "validationRequest", stateMutability: "nonpayable", inputs: [{ name: "validatorAddress", type: "address" }, { name: "agentId", type: "uint256" }, { name: "requestURI", type: "string" }, { name: "requestHash", type: "bytes32" }], outputs: [] },
  { type: "function", name: "getSummary", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }, { name: "validatorAddresses", type: "address[]" }, { name: "tag", type: "string" }], outputs: [{ name: "count", type: "uint64" }, { name: "avgResponse", type: "uint8" }] },
  { type: "function", name: "respond", stateMutability: "nonpayable", inputs: [{ name: "a", type: "tuple", components: ATTESTATION_TYPES.PreflightAttestation }, { name: "t", type: "tuple", components: QUOTE_TERMS_COMPONENTS }], outputs: [{ name: "response", type: "uint8" }] },
  { type: "event", name: "Validated", inputs: [{ name: "requestHash", type: "bytes32", indexed: true }, { name: "agentId", type: "uint256", indexed: true }, { name: "response", type: "uint8", indexed: false }, { name: "shortfallBps", type: "uint256", indexed: false }, { name: "budgetBps", type: "uint256", indexed: false }] },
];

const envPath = process.env.WARRANT_ENV_FILE ?? join(import.meta.dirname, "..", "contracts", ".env"); // override only for a fork rehearsal
const env = Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => l.split("=", 2)));
const chain = defineChain({ id: 5042, name: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const client = createWalletClient({ account: privateKeyToAccount(env.ARC_PRIVATE_KEY), chain, transport: http(RPC) }).extend(publicActions);

const m = td.message;
const a = { ...m, warrantVersion: Number(m.warrantVersion), verdict: Number(m.verdict) };
const t = { ...p, sellAmount: BigInt(p.sellAmount), buyAmount: BigInt(p.buyAmount) };
const { EIP712Domain, ...types } = td.types;
const digest = hashTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
const agentId = BigInt(agentIdArg);

const send = async (label, args) => {
  const hash = await client.writeContract(args);
  const r = await client.waitForTransactionReceipt({ hash });
  console.log(`  ${r.status === "success" ? "✓" : "✗"} ${label}  ${TX(hash)}`);
  if (r.status !== "success") process.exit(1);
  return r;
};

console.log(`Disclosure ${digest} (agent ${m.agent}, verdict ${["PASS", "WARN", "FAIL"][a.verdict]}), validator ${validator}`);
await send(`validationRequest by ${client.account.address}`, { address: VALIDATION, abi: ABI, functionName: "validationRequest", args: [validator, agentId, "", digest] });
const r = await send("WarrantValidator.respond", { address: validator, abi: ABI, functionName: "respond", args: [a, t] });
const ev = parseEventLogs({ abi: ABI, logs: r.logs, eventName: "Validated" })[0].args;
console.log(`  Validated: response ${ev.response}, shortfall ${ev.shortfallBps} bps, budget ${ev.budgetBps} bps`);
const [count, avg] = await client.readContract({ address: VALIDATION, abi: ABI, functionName: "getSummary", args: [agentId, [validator], "warrant-oracle"] });
console.log(`  ERC-8004 validation summary for agent ${agentId}: count ${count}, average response ${avg}`);
