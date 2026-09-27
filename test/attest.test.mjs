/**
 * Attestation-call builder tests. The main assertion is anchored to a transaction that really went
 * on-chain: the MetaMask server wallet's attestPreflight on Monad testnet,
 * tx 0xb3628760504e15ec59a3276360c253d60a90b2314b3b6fffe63b80d7f7db8905 (input copied from `cast tx … input`).
 * Run: node test/attest.test.mjs (after npm run build)
 */
import assert from "node:assert/strict";
import { decodeFunctionData, hashTypedData, recoverTypedDataAddress } from "viem";
import {
  ATTEST_GAS_LIMIT,
  attestCalldata,
  attestationTypedData,
  mmSendTransaction,
  mmSignTypedDataCommand,
  WARRANT_REGISTRY_ABI,
} from "../dist/lib/onchain.js";

let pass = 0;
const t = async (name, fn) => {
  await fn();
  pass++;
  console.log(`  ✓ ${name}`);
};

const REGISTRY = "0x37cdFe2a144993dC3145367305fF66E29302E673";
// Arguments of the Monad testnet transaction above (PASS, warrant v1).
const LIVE = {
  registry: REGISTRY,
  principal: "0xe4ebDEbd84f80bF592ca61C6eA56d10568D23aeA",
  quoteHash: "0x6cabd9cfc3bdb93ddec19a6e2c4e14e8c51efe146d4a618e0c931932b9d037e2",
  warrantVersion: 1,
  verdict: 0,
  scorecardHash: "0x04a4119075295429492b005178dc13c8f071964499009bd74fce5c1afd5e1c4c",
};
const LIVE_INPUT =
  "0x3822e671000000000000000000000000e4ebdebd84f80bf592ca61c6ea56d10568d23aea6cabd9cfc3bdb93ddec19a6e2c4e14e8c51efe146d4a618e0c931932b9d037e20000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000004a4119075295429492b005178dc13c8f071964499009bd74fce5c1afd5e1c4c";

await t("calldata is byte-identical to the input of the live Monad testnet attestation", () => {
  assert.equal(attestCalldata(LIVE), LIVE_INPUT);
});

await t("calldata decodes back to the same arguments", () => {
  const { functionName, args } = decodeFunctionData({ abi: WARRANT_REGISTRY_ABI, data: attestCalldata(LIVE) });
  assert.equal(functionName, "attestPreflight");
  assert.deepEqual(args, [LIVE.principal, LIVE.quoteHash, 1, 0, LIVE.scorecardHash]);
});

await t("Fuji: plain payload, no gas fields, no shim note (mm estimates fees itself)", () => {
  const m = mmSendTransaction(LIVE, 43113, 25_000_000_000n);
  assert.deepEqual(Object.keys(m.payload).sort(), ["data", "to", "value"]);
  assert.equal(m.payload.to, REGISTRY);
  assert.equal(m.payload.value, "0x0");
  assert.equal(m.note, undefined);
  assert.match(m.command, /^mm wallet send-transaction --chain-id 43113 --payload '\{.*\}' --intent "Warrant: attest PASS preflight v1 before trading" --wait$/);
});

await t("Monad testnet: explicit gas limit and fees, plus the shim note", () => {
  const m = mmSendTransaction(LIVE, 10143, 102_000_000_000n);
  assert.equal(BigInt(m.payload.gas), ATTEST_GAS_LIMIT);
  assert.ok(ATTEST_GAS_LIMIT > 35_130n, "limit must cover the measured 35,130 gas");
  assert.equal(BigInt(m.payload.maxFeePerGas), 204_000_000_000n);
  assert.equal(BigInt(m.payload.maxPriorityFeePerGas), 2_000_000_000n);
  assert.match(m.note, /MM_INFURA_RPC_BASE_URL/);
});

await t("the payload embedded in the command is valid JSON equal to .payload", () => {
  const m = mmSendTransaction({ ...LIVE, verdict: 2 }, 10143, 1n);
  const json = m.command.match(/--payload '(.*?)'/)[1];
  assert.deepEqual(JSON.parse(json), m.payload);
  assert.match(m.command, /attest FAIL/);
});

// Off-chain (EIP-712) attestation. Anchors: the digest WarrantAttestor 0xC356…18aA itself computed
// (`cast call … digest(…)` on each chain), and the signatures MetaMask's wallet service returned for
// `mm wallet sign-typed-data` from the server wallet; both were then relayed on-chain
// (Fuji 0x0f5a267d…0cfd, Monad 0x05409071…1f6f).
const ATTESTOR = "0xC356ac5ebD7d249102D3C9c25764A8815c1718aA";
const SERVER_WALLET = "0x299e298ded14b36412a7857ed02b844e7fb58e0e";
const SIGNED = {
  43113: {
    digest: "0x443da409e67a25a9a905cdf324793b59e0c6a0956dda9183ed3ec53139ec4411",
    sig: "0x2d6abe0c653fea2727463bee37fb4128f25af6bebbbe22cbaa5b21c69ed1262f60a764012fabc42b7b8086ef19329e5ddfe7434559a17896f55d1f59b9a0b5a91c",
  },
  10143: {
    digest: "0x6a80878d227ab1a93adeae036679a3b2e80f04df34d3904574f2c5fd99363786",
    sig: "0x9349250779e5327b713a5a28739cb429ca07b07f1b0c67b4fb2385abd8128e856fd2745956db7b4361349961ddc35a62217061178788480ad8d4c0883a4d7eb01c",
  },
};
const viemArgs = (td) => {
  const { EIP712Domain, ...types } = td.types;
  return { domain: td.domain, types, primaryType: td.primaryType, message: td.message };
};

for (const chainId of [43113, 10143]) {
  await t(`typed data (chain ${chainId}) hashes to the digest the deployed WarrantAttestor computes`, () => {
    const td = attestationTypedData(LIVE, SERVER_WALLET, chainId, ATTESTOR);
    assert.equal(hashTypedData(viemArgs(td)), SIGNED[chainId].digest);
  });
  await t(`MetaMask's real signature (chain ${chainId}) recovers to the server wallet`, async () => {
    const td = attestationTypedData(LIVE, SERVER_WALLET, chainId, ATTESTOR);
    const signer = await recoverTypedDataAddress({ ...viemArgs(td), signature: SIGNED[chainId].sig });
    assert.equal(signer.toLowerCase(), SERVER_WALLET);
  });
}

await t("a PASS signature does not verify as FAIL", async () => {
  const td = attestationTypedData({ ...LIVE, verdict: 2 }, SERVER_WALLET, 43113, ATTESTOR);
  const signer = await recoverTypedDataAddress({ ...viemArgs(td), signature: SIGNED[43113].sig });
  assert.notEqual(signer.toLowerCase(), SERVER_WALLET);
});

await t("sign-typed-data command carries the exact typed data", () => {
  const td = attestationTypedData(LIVE, SERVER_WALLET, 10143, ATTESTOR);
  const cmd = mmSignTypedDataCommand(td);
  assert.match(cmd, /^mm wallet sign-typed-data --chain-id 10143 --payload '/);
  assert.deepEqual(JSON.parse(cmd.match(/--payload '(.*?)'/)[1]), td);
});

console.log(`\n${pass} passed`);
