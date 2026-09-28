/**
 * Warrant × ERC-8226 (RAMS) on Monad testnet: a RAMS mandate says whether the agent may sell the
 * principal's tokenized bond at all; Warrant says whether a particular sale is suitable. Three sales:
 *   A. 50 wDBOND at 0.5% slippage  → RAMS OK, Warrant PASS → attest PASS, agent executes the transfer
 *   B. 80 wDBOND at 3% slippage    → RAMS OK, Warrant FAIL (slippage) → attest FAIL, agent stops
 *   C. 150 wDBOND at 0.5% slippage → RAMS OVER_TX_CAP → attest FAIL; the token itself would revert
 *
 * The RAMS contracts are the unmodified ERC-8226 reference implementation (rams/), deployed with
 * rams/script/DeployRams.s.sol. wDBOND is its ERC-7943 mock asset standing in for a tokenized bond;
 * the "sale" settles as transferFrom(principal → venue), standing in for the swap. Quotes are
 * synthetic (no DEX lists wDBOND); every mandate, warrant, attestation and transfer is a real
 * testnet transaction. The deployer key is principal, compliance operator and token admin here.
 *
 * Usage: npm run build && node scripts/demo-rams.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, defineChain, http, parseAbi, publicActions } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { ramsDimension, renderScorecard, withDimension, RAMS_REASONS } from "../dist/lib/score.js";
import {
  quoteHash,
  RAMS_TRANSFER_FROM,
  readOnchainWarrant,
  readRamsCheck,
  scoreAgainstOnchain,
  scorecardHash,
  VERDICT_INDEX,
} from "../dist/lib/onchain.js";

const REGISTRY = "0x37cdFe2a144993dC3145367305fF66E29302E673";
const PROVIDER = "0xC43b6E7DF15e3a04B52156F2884De95d07a081Aa";
const RAMS = "0x47ad95a1F151A2432F62ff77DcD8CAE19f61d2ab";
const BOND = "0x6D7cfE98BE90b318a6456B7f75eF15F34720FaF2";
const VENUE = "0x000000000000000000000000000000000000dEaD";
const E18 = 10n ** 18n;
const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
});
const rpcUrl = chain.rpcUrls.default.http[0];
const link = (h) => `https://testnet.monadvision.com/tx/${h}`;

const ABI = parseAbi([
  "function grantPrincipal(address principal, bytes32 identityRef, uint48 expiresAt)",
  "function changeSendWhitelist(address account, bool status)",
  "function changeReceiveWhitelist(address account, bool status)",
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function grantMandate((address agent, uint48 validFrom, uint48 validUntil, address principal, address complianceProvider, bytes32 identityRef, address asset, uint256 maxTransactionValue, uint256 maxCumulativeValue, bytes32 metadata, bytes32[] actions, uint256 deadline) params, bytes signature)",
  "function setWarrant(address agent, (uint64 maxUsdPerTradeCents, uint16 maxSlippageBps, uint16 maxPriceImpactBps, uint16 maxFeeBps, bool allowCrossChain, bool allowNewApproval, bool recipientMustBeSelf, uint64 expiresAt) m) returns (uint32)",
  "function attestPreflight(address principal, bytes32 quoteHash, uint32 warrantVersion, uint8 verdict, bytes32 scorecardHash)",
  "error MandateBlocked(uint8 reason)",
]);

const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "..", "contracts", ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=", 2)),
);
const client = (pk) =>
  createWalletClient({ account: privateKeyToAccount(pk, { nonceManager }), chain, transport: http(rpcUrl) }).extend(publicActions);
const principal = client(env.DEPLOYER_PRIVATE_KEY);
const agent = client(env.AGENT_PRIVATE_KEY);
const P = principal.account.address;
const A = agent.account.address;

const send = async (c, address, functionName, args, label) => {
  const hash = await c.writeContract({ address, abi: ABI, functionName, args });
  const r = await c.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ↳ ${label}: ${link(hash)}`);
  return hash;
};

console.log(`\n=== Warrant × ERC-8226 on Monad testnet ===`);
console.log(`principal ${P}\nagent     ${A}\nRAMS      ${RAMS}\nwDBOND    ${BOND}\n`);

console.log("1) Compliance operator marks the principal eligible; the bond is whitelisted and minted to the principal");
const idRef = `0x${"b0".repeat(32)}`;
await send(principal, PROVIDER, "grantPrincipal", [P, idRef, 0], "grantPrincipal");
await send(principal, BOND, "changeSendWhitelist", [P, true], "whitelist principal (send)");
await send(principal, BOND, "changeReceiveWhitelist", [P, true], "whitelist principal (receive)");
await send(principal, BOND, "changeReceiveWhitelist", [VENUE, true], "whitelist venue (receive)");
await send(principal, BOND, "mint", [P, 1000n * E18], "mint 1,000 wDBOND");
await send(principal, BOND, "approve", [A, 1000n * E18], "principal approves the agent");

console.log("\n2) Principal grants the agent a RAMS mandate: transferFrom only, ≤100 wDBOND per trade, ≤250 in total, 30 days");
const now = Math.floor(Date.now() / 1000);
const existing = await readRamsCheck({ rpcUrl, registry: RAMS, agent: A, principal: P, asset: BOND, amount: 1n });
if (["NONEXISTENT", "EXPIRED", "REVOKED"].includes(RAMS_REASONS[existing.reason])) {
  await send(
    principal,
    RAMS,
    "grantMandate",
    [
      {
        agent: A,
        validFrom: 0,
        validUntil: now + 30 * 86400,
        principal: P,
        complianceProvider: PROVIDER,
        identityRef: idRef,
        asset: BOND,
        maxTransactionValue: 100n * E18,
        maxCumulativeValue: 250n * E18,
        metadata: `0x${"00".repeat(32)}`,
        actions: [RAMS_TRANSFER_FROM],
        deadline: 0n,
      },
      "0x",
    ],
    "grantMandate",
  );
} else {
  console.log(`  ↳ mandate already active (${RAMS_REASONS[existing.reason]}), reusing it`);
}

console.log("\n3) Principal grants the agent a Warrant: ≤$1,000/trade, ≤100bps slippage, ≤150bps impact, ≤50bps fees, 30 days");
await send(
  principal,
  REGISTRY,
  "setWarrant",
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
      expiresAt: BigInt(now + 30 * 86400),
    },
  ],
  "setWarrant",
);
const warrant = await readOnchainWarrant({ rpcUrl, registry: REGISTRY, principal: P, agent: A });

const sale = (id, units, slippage) => ({
  quoteId: `rams-demo-${id}-${now}`,
  walletAddress: A,
  recipientAddress: A,
  srcChainId: 10143,
  destChainId: 10143,
  srcSymbol: "wDBOND",
  destSymbol: "USDC",
  srcAsset: BOND,
  srcAmount: (BigInt(units) * E18).toString(),
  fromUsd: units,
  toUsd: units * 0.998,
  slippage,
  priceImpact: 0.002,
  feeUsd: units * 0.001,
  requiresApproval: false,
});

for (const [label, swap] of [
  ["A. sell 50 wDBOND at 0.5% slippage", sale("A", 50, 0.005)],
  ["B. sell 80 wDBOND at 3% slippage", sale("B", 80, 0.03)],
  ["C. sell 150 wDBOND at 0.5% slippage", sale("C", 150, 0.005)],
]) {
  const check = await readRamsCheck({ rpcUrl, registry: RAMS, agent: A, principal: P, asset: BOND, amount: BigInt(swap.srcAmount) });
  const sc = withDimension(scoreAgainstOnchain(swap, warrant), ramsDimension(check));
  console.log(`\n--- ${label} ---`);
  console.log(renderScorecard(sc, `${warrant.source} v${warrant.version} + RAMS ${RAMS}`));
  await send(
    agent,
    REGISTRY,
    "attestPreflight",
    [P, quoteHash(swap.quoteId), warrant.version, VERDICT_INDEX[sc.verdict], scorecardHash(sc)],
    `attestPreflight(${sc.verdict})`,
  );
  if (sc.verdict === "pass") {
    await send(agent, BOND, "transferFrom", [P, VENUE, BigInt(swap.srcAmount)], "agent executes the sale (transferFrom → venue)");
  } else if (!check.ok) {
    try {
      await agent.simulateContract({ address: BOND, abi: ABI, functionName: "transferFrom", args: [P, VENUE, BigInt(swap.srcAmount)] });
      console.log("  ↳ unexpected: the token would accept this transfer");
    } catch (e) {
      const d = e.walk?.((x) => x.data?.errorName)?.data;
      const why = d ? `${d.errorName}(${d.args.map((r) => RAMS_REASONS[r] ?? r).join(",")})` : (e.shortMessage ?? e.message.split("\n")[0]);
      console.log(`  ↳ the token itself agrees: transferFrom would revert with ${why}`);
    }
  } else {
    console.log("  ↳ agent stops: RAMS would let it sell, the Warrant scorecard says the sale is unsuitable");
  }
}
console.log(`\nprincipal wDBOND balance: ${(await principal.readContract({ address: BOND, abi: ABI, functionName: "balanceOf", args: [P] })) / E18}\n`);
