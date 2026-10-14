/**
 * Chainlink price check (WarrantPriceCheck) on the plugin side.
 * Pure part: the plugin's dimension must flag exactly the quotes the contract records as contradicted
 * (thresholds checked against the contract's own unit-test cases), and the terms hash must equal an
 * independent `cast abi-encode` + `cast keccak` of the same terms.
 * Fork part: anvil forks Arc mainnet, forge deploys WarrantPriceCheck against the live USDC/USD and
 * EURC/USD feeds, and readOracleCheck must return the fair output recomputed here from raw `cast` reads.
 * Run: npm run build && node test/pricecheck.test.mjs   (needs foundry; the fork part needs the Arc RPC)
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { quoteTermsHash, readOracleCheck } from "../dist/lib/onchain.js";
import { DEFAULT_WARRANT, oracleDimension, scoreSwap, shortfallBps, withDimension } from "../dist/lib/score.js";

const BIN = process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin");
const exe = (n) => join(BIN, process.platform === "win32" ? `${n}.exe` : n);
const CONTRACTS = join(import.meta.dirname, "..", "contracts");
const PORT = 8549;
const RPC = `http://127.0.0.1:${PORT}`;
const ARC_RPC = process.env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io";
// anvil default account 0 (public test key, local fork only)
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Arc mainnet
const ATTESTOR = "0x33B7B8db2927783dEbb58a589CF5c7B95824fae1";
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const USDC_USD = "0x84EA90AC252Dc437031461836DB5164219147905";
const EURC_USD = "0x361b95c10b76Ca3f35C686d423e43A951755Bf23";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const NATIVE = "0x0000000000000000000000000000000000000000";

const env = { ...process.env };
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"]) delete env[k];
const run = (n, args, cwd) => execFileSync(exe(n), args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let pass = 0;
const t = async (name, fn) => {
  await fn();
  pass++;
  console.log(`  ✓ ${name}`);
};

// ---------- pure ----------
// Same cases as contracts/test/WarrantPriceCheck.t.sol: fair 400_000, budget 200 (150 impact + 50 fee), tolerance 100.
const oc = (quotedOut) => ({ contract: "0xPC", fairOut: 400_000n, quotedOut, budgetBps: 200, toleranceBps: 100 });

await t("shortfallBps matches the contract's cases (1%, 3%, 5%, better than oracle)", () => {
  assert.deepEqual([396_000n, 388_000n, 380_000n, 410_000n].map((q) => shortfallBps(400_000n, q)), [100, 300, 500, 0]);
});
await t("dimension: within budget → pass; budget < s ≤ budget+tolerance → warn; beyond → fail", () => {
  assert.equal(oracleDimension(oc(396_000n)).severity, "pass");
  assert.equal(oracleDimension(oc(390_000n)).severity, "warn"); // 250 bps
  assert.equal(oracleDimension(oc(388_000n)).severity, "warn"); // 300 bps: the contract does not flag it either
  assert.equal(oracleDimension(oc(387_960n)).severity, "fail"); // 301 bps: the contract would flag a PASS
  assert.equal(oracleDimension(oc(410_000n)).severity, "pass");
});
await t("a failing price check turns a passing scorecard into fail", () => {
  const sc = scoreSwap({ quoteId: "q", srcChainId: 5042, destChainId: 5042, fromUsd: 10, toUsd: 9.99, slippage: 0.005, priceImpact: 0.001, feeUsd: 0, requiresApproval: false }, DEFAULT_WARRANT);
  assert.equal(sc.verdict, "pass");
  assert.equal(withDimension(sc, oracleDimension(oc(380_000n))).verdict, "fail");
});
await t("quoteTermsHash equals cast abi-encode + cast keccak of the same terms", () => {
  const terms = { quoteIdHash: `0x${"ab".repeat(32)}`, sellToken: NATIVE, buyToken: EURC, sellAmount: 500000000000000000n, buyAmount: 446059n };
  const encoded = run("cast", ["abi-encode", "f(bytes32,address,address,uint256,uint256)", terms.quoteIdHash, NATIVE, EURC, "500000000000000000", "446059"]);
  assert.equal(quoteTermsHash(terms), run("cast", ["keccak", encoded]));
});

// ---------- Arc mainnet fork ----------
const anvil = spawn(exe("anvil"), ["--port", String(PORT), "--fork-url", ARC_RPC, "--silent"], { env, stdio: "ignore" });
try {
  for (let i = 0; i < 100; i++) {
    try {
      run("cast", ["chain-id", "--rpc-url", RPC]);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const out = run(
    "forge",
    [
      "create", "src/WarrantPriceCheck.sol:WarrantPriceCheck", "--rpc-url", RPC, "--private-key", DEPLOYER_PK, "--broadcast",
      "--constructor-args", ATTESTOR, IDENTITY, REPUTATION, "100", `[${NATIVE},${EURC}]`, `[${USDC_USD},${EURC_USD}]`, "[18,6]", "[90000,90000]",
    ],
    CONTRACTS,
  );
  const pc = out.match(/Deployed to: (0x[0-9a-fA-F]{40})/)[1];
  const answer = (feed) => BigInt(run("cast", ["call", feed, "latestRoundData()(uint80,int256,uint256,uint256,uint80)", "--rpc-url", RPC]).split(/\s+/)[2]);

  await t("readOracleCheck on Arc: fairOut equals the raw feed answers recomputed here, budget from the warrant", async () => {
    const terms = { quoteIdHash: `0x${"cd".repeat(32)}`, sellToken: NATIVE, buyToken: EURC, sellAmount: 500000000000000000n, buyAmount: 446059n };
    const c = await readOracleCheck({ rpcUrl: RPC, priceCheck: pc, terms, spec: DEFAULT_WARRANT });
    // both feeds have 8 decimals; native USDC 18 → EURC 6 decimals
    assert.equal(c.fairOut, (terms.sellAmount * answer(USDC_USD)) / (answer(EURC_USD) * 10n ** 12n));
    assert.equal(c.toleranceBps, 100);
    assert.equal(c.budgetBps, DEFAULT_WARRANT.maxPriceImpactBps + DEFAULT_WARRANT.maxFeeBps);
    assert.equal(c.quotedOut, 446059n);
  });
  await t("the contract's termsHash equals the plugin's quoteTermsHash", async () => {
    const encoded = `(0x${"ef".repeat(32)},${NATIVE},${EURC},1000000000000000000,892118)`;
    const onchain = run("cast", ["call", pc, "termsHash((bytes32,address,address,uint256,uint256))(bytes32)", encoded, "--rpc-url", RPC]);
    const plugin = quoteTermsHash({ quoteIdHash: `0x${"ef".repeat(32)}`, sellToken: NATIVE, buyToken: EURC, sellAmount: 10n ** 18n, buyAmount: 892118n });
    assert.equal(plugin, onchain);
  });
} finally {
  anvil.kill();
}
console.log(`\n${pass} passed`);
