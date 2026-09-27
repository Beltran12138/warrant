/**
 * Give the trading agent an ERC-8004 identity whose agentWallet is the mm wallet.
 *
 *   node scripts/register-agent.mjs <monad|fuji> register                 # mint the identity (operator key)
 *   node scripts/register-agent.mjs <monad|fuji> bind <agentId> [wallet]  # agentWallet := mm wallet
 *
 * The operator (AGENT_PRIVATE_KEY in contracts/.env) owns the identity NFT and pays gas. `bind` asks
 * the active mm wallet to sign the registry's AgentWalletSet typed data (`mm wallet sign-typed-data`,
 * no transaction) and submits it; the registry accepts a new agentWallet only with that wallet's own
 * signature, and the deadline may be at most 5 minutes ahead, so both happen in one run.
 * WarrantReputation credits an attestation to agentId only if its agent is this agentWallet.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, defineChain, http, parseEventLogs, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_BRIDGE = "0x0FAf92b84f00201e888210B62ef5055Cc3BbefED";
const NETS = {
  monad: { id: 10143, rpc: "https://testnet-rpc.monad.xyz", tx: (h) => `https://testnet.monadvision.com/tx/${h}` },
  fuji: { id: 43113, rpc: "https://api.avax-test.network/ext/bc/C/rpc", tx: (h) => `https://subnets-test.avax.network/c-chain/tx/${h}` },
};
const ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setAgentWallet", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "deadline", type: "uint256" }, { name: "signature", type: "bytes" }], outputs: [] },
  { type: "function", name: "getMetadata", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }, { name: "metadataKey", type: "string" }], outputs: [{ type: "bytes" }] },
  { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string", indexed: false }, { name: "owner", type: "address", indexed: true }] },
];

const [netName, cmd, idArg, walletArg] = process.argv.slice(2);
const net = NETS[netName];
if (!net || !["register", "bind"].includes(cmd)) {
  console.error("usage: node scripts/register-agent.mjs <monad|fuji> register | bind <agentId> [wallet]");
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "..", "contracts", ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=", 2)),
);
const chain = defineChain({ id: net.id, name: netName, nativeCurrency: { name: "", symbol: "", decimals: 18 }, rpcUrls: { default: { http: [net.rpc] } } });
const client = createWalletClient({ account: privateKeyToAccount(env.AGENT_PRIVATE_KEY), chain, transport: http(net.rpc) }).extend(publicActions);
const operator = client.account.address;

// Run mm's entry point with node directly: on Windows `mm` is a .cmd shim, and going through a
// shell would re-split the JSON payload at spaces.
const MM_ENTRY = join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@metamask", "agent-wallet", "dist", "index.js");

/** Run an mm command and return its JSON `data` (mm prints notices before the JSON). */
const mm = (args) => {
  const out = execFileSync(process.execPath, [MM_ENTRY, ...args, "--json"], { encoding: "utf8" });
  const res = JSON.parse(out.slice(out.indexOf("{")));
  if (!res.ok) throw new Error(`mm ${args[0]} ${args[1]}: ${JSON.stringify(res.error)}`);
  return res.data;
};

if (cmd === "register") {
  const file = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Warrant demo agent",
    description:
      "Trading agent on the MetaMask Agent Wallet. Before every swap it runs a Warrant preflight against the principal's on-chain warrant and signs an EIP-712 attestation of the scorecard. Its reputation entries (tag1 \"warrant-preflight\", tag2 = verdict) come only from WarrantReputation, which credits verified attestations.",
    services: [{ name: "web", endpoint: "https://github.com/Beltran12138/warrant" }],
    x402Support: false,
    active: true,
    supportedTrust: ["reputation"],
    warrant: { attestor: "0xC356ac5ebD7d249102D3C9c25764A8815c1718aA", reputationClient: REPUTATION_BRIDGE },
  };
  const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString("base64")}`;
  const hash = await client.writeContract({ address: IDENTITY, abi: ABI, functionName: "register", args: [uri] });
  const r = await client.waitForTransactionReceipt({ hash });
  const [ev] = parseEventLogs({ abi: ABI, logs: r.logs, eventName: "Registered" });
  console.log(`${r.status}: agentId ${ev.args.agentId} owned by ${operator}\n  ${net.tx(hash)}`);
} else {
  const agentId = BigInt(idArg);
  const wallet = walletArg ?? mm(["wallet", "list"]).wallets[0].address;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 240);
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: net.id, verifyingContract: IDENTITY },
    message: { agentId: agentId.toString(), newWallet: wallet, owner: operator, deadline: deadline.toString() },
  };
  const { signature, status } = mm([
    "wallet", "sign-typed-data", "--chain-id", String(net.id), "--payload", JSON.stringify(typedData),
    "--intent", `ERC-8004: make this wallet the agentWallet of agent ${agentId}`, "--wait",
  ]);
  if (!signature) throw new Error(`mm did not return a signature (status ${status})`);
  const hash = await client.writeContract({ address: IDENTITY, abi: ABI, functionName: "setAgentWallet", args: [agentId, wallet, deadline, signature] });
  const r = await client.waitForTransactionReceipt({ hash });
  const stored = await client.readContract({ address: IDENTITY, abi: ABI, functionName: "getMetadata", args: [agentId, "agentWallet"] });
  console.log(`${r.status}: agent ${agentId} agentWallet = ${stored} (mm wallet ${wallet})\n  ${net.tx(hash)}`);
}
