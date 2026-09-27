/**
 * Attestation-call builder tests. The main assertion is anchored to a transaction that really went
 * on-chain: the MetaMask server wallet's attestPreflight on Monad testnet,
 * tx 0xb3628760504e15ec59a3276360c253d60a90b2314b3b6fffe63b80d7f7db8905 (input copied from `cast tx … input`).
 * Run: node test/attest.test.mjs (after npm run build)
 */
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import {
  ATTEST_GAS_LIMIT,
  attestCalldata,
  mmSendTransaction,
  WARRANT_REGISTRY_ABI,
} from "../dist/lib/onchain.js";

let pass = 0;
const t = (name, fn) => {
  fn();
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

t("calldata is byte-identical to the input of the live Monad testnet attestation", () => {
  assert.equal(attestCalldata(LIVE), LIVE_INPUT);
});

t("calldata decodes back to the same arguments", () => {
  const { functionName, args } = decodeFunctionData({ abi: WARRANT_REGISTRY_ABI, data: attestCalldata(LIVE) });
  assert.equal(functionName, "attestPreflight");
  assert.deepEqual(args, [LIVE.principal, LIVE.quoteHash, 1, 0, LIVE.scorecardHash]);
});

t("Fuji: plain payload, no gas fields, no shim note (mm estimates fees itself)", () => {
  const m = mmSendTransaction(LIVE, 43113, 25_000_000_000n);
  assert.deepEqual(Object.keys(m.payload).sort(), ["data", "to", "value"]);
  assert.equal(m.payload.to, REGISTRY);
  assert.equal(m.payload.value, "0x0");
  assert.equal(m.note, undefined);
  assert.match(m.command, /^mm wallet send-transaction --chain-id 43113 --payload '\{.*\}' --intent "Warrant: attest PASS preflight v1 before trading" --wait$/);
});

t("Monad testnet: explicit gas limit and fees, plus the shim note", () => {
  const m = mmSendTransaction(LIVE, 10143, 102_000_000_000n);
  assert.equal(BigInt(m.payload.gas), ATTEST_GAS_LIMIT);
  assert.ok(ATTEST_GAS_LIMIT > 35_130n, "limit must cover the measured 35,130 gas");
  assert.equal(BigInt(m.payload.maxFeePerGas), 204_000_000_000n);
  assert.equal(BigInt(m.payload.maxPriorityFeePerGas), 2_000_000_000n);
  assert.match(m.note, /MM_INFURA_RPC_BASE_URL/);
});

t("the payload embedded in the command is valid JSON equal to .payload", () => {
  const m = mmSendTransaction({ ...LIVE, verdict: 2 }, 10143, 1n);
  const json = m.command.match(/--payload '(.*?)'/)[1];
  assert.deepEqual(JSON.parse(json), m.payload);
  assert.match(m.command, /attest FAIL/);
});

console.log(`\n${pass} passed`);
