/**
 * Relayer: put an agent-signed preflight attestation on-chain via WarrantAttestor.submit.
 *
 *   node scripts/submit-signed.mjs <typed-data.json> <signature>
 *
 * <typed-data.json> is `attestation.signed.typedData` from `mm warrant preflight --attestor … --json`;
 * <signature> is `data.signature` from `mm wallet sign-typed-data … --json`. The chain and the
 * attestor come from the typed data's domain. Any funded key can relay: RELAYER_PRIVATE_KEY, else
 * DEPLOYER_PRIVATE_KEY from contracts/.env. The relayer is recorded as `submitter`, never trusted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, defineChain, http, publicActions, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WARRANT_ATTESTOR_ABI } from "../dist/lib/onchain.js";

const RPC = { 10143: "https://testnet-rpc.monad.xyz", 43113: "https://api.avax-test.network/ext/bc/C/rpc" };
const TX = {
  10143: (h) => `https://testnet.monadvision.com/tx/${h}`,
  43113: (h) => `https://subnets-test.avax.network/c-chain/tx/${h}`,
};

const [file, signature] = process.argv.slice(2);
if (!file || !signature) {
  console.error("usage: node scripts/submit-signed.mjs <typed-data.json> <signature>");
  process.exit(1);
}
const td = JSON.parse(readFileSync(file, "utf8"));
const chainId = Number(td.domain.chainId);
const rpcUrl = process.env.RPC_URL ?? RPC[chainId];
if (!rpcUrl) throw new Error(`no RPC for chain ${chainId}; set RPC_URL`);

// Check locally first: a signature from anyone but the agent would only waste the relayer's gas.
const { EIP712Domain, ...types } = td.types;
const signer = await recoverTypedDataAddress({ domain: td.domain, types, primaryType: td.primaryType, message: td.message, signature });
if (signer.toLowerCase() !== td.message.agent.toLowerCase()) {
  throw new Error(`signature is from ${signer}, not the agent ${td.message.agent}`);
}

const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "..", "contracts", ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=", 2)),
);
const pk = process.env.RELAYER_PRIVATE_KEY ?? env.RELAYER_PRIVATE_KEY ?? env.DEPLOYER_PRIVATE_KEY;
const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "", symbol: "", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(rpcUrl) }).extend(publicActions);

const m = td.message;
const hash = await client.writeContract({
  address: td.domain.verifyingContract,
  abi: WARRANT_ATTESTOR_ABI,
  functionName: "submit",
  args: [{ ...m, warrantVersion: Number(m.warrantVersion), verdict: Number(m.verdict) }, signature],
});
const r = await client.waitForTransactionReceipt({ hash });
console.log(`${r.status}: agent ${m.agent} attestation relayed by ${client.account.address}\n  ${TX[chainId]?.(hash) ?? hash}`);
if (r.status !== "success") process.exit(1);
