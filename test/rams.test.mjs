/**
 * ERC-8226 (RAMS) integration test: local anvil → forge deploys the unmodified reference implementation
 * in rams/ → cast grants a principal, a mandate and balances → the plugin's readRamsCheck reads it.
 * Anchors: the action label is checked against the known transferFrom selector and `cast sig`; every
 * verdict the plugin reports is checked against what the gated token actually does with the same call.
 * Run: npm run build && node test/rams.test.mjs   (needs foundry, and rams/lib: see README "Tests")
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RAMS_TRANSFER_FROM, readRamsCheck } from "../dist/lib/onchain.js";
import { ramsDimension, RAMS_REASONS, scoreSwap, withDimension, DEFAULT_WARRANT } from "../dist/lib/score.js";

const BIN = process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin");
const exe = (n) => join(BIN, process.platform === "win32" ? `${n}.exe` : n);
const RAMS_DIR = join(import.meta.dirname, "..", "rams");
const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
// anvil default accounts 0-2 (public test keys, local chain only)
const ADMIN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADMIN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PRINCIPAL_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PRINCIPAL = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const AGENT_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const VENUE = "0x000000000000000000000000000000000000bEEF";
const E18 = 10n ** 18n;

const env = { ...process.env };
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"]) delete env[k];
const run = (n, args, cwd) => execFileSync(exe(n), args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let pass = 0;
const t = async (name, fn) => {
  await fn();
  pass++;
  console.log(`  ✓ ${name}`);
};

await t("action label = bytes32(transferFrom selector 0x23b872dd), left-aligned", () => {
  assert.equal(RAMS_TRANSFER_FROM, `0x23b872dd${"0".repeat(56)}`);
  assert.equal(run("cast", ["sig", "transferFrom(address,address,uint256)"]).trim(), "0x23b872dd");
});
await t("reason table matches the ERC-8226 enum order (OVER_TX_CAP = 9)", () => {
  assert.equal(RAMS_REASONS.length, 12);
  assert.equal(RAMS_REASONS[9], "OVER_TX_CAP");
  assert.equal(RAMS_REASONS[1], "NONEXISTENT");
});
await t("a refused mandate turns a passing scorecard into fail; a granted one never improves a fail", () => {
  const clean = scoreSwap({ quoteId: "q", fromUsd: 10, slippage: 0.005 }, DEFAULT_WARRANT);
  assert.equal(clean.verdict, "pass");
  const refused = { registry: "0xR", asset: "0xA", action: "transferFrom", amount: "1", ok: false, reason: 9 };
  const got = withDimension(clean, ramsDimension(refused));
  assert.equal(got.verdict, "fail");
  assert.match(got.dimensions.at(-1).observed, /OVER_TX_CAP/);
  const granted = { ...refused, ok: true, reason: 0 };
  assert.equal(withDimension({ ...clean, verdict: "fail" }, ramsDimension(granted)).verdict, "fail");
});

if (!existsSync(join(RAMS_DIR, "lib", "openzeppelin-contracts"))) {
  console.log("  - skipped the anvil part: rams/lib is missing (see README \"Tests\")");
  console.log(`\n${pass} passed`);
  process.exit(0);
}

const anvil = spawn(exe("anvil"), ["--port", String(PORT), "--silent"], { env, stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    try {
      run("cast", ["chain-id", "--rpc-url", RPC]);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const create = (contract, args) => {
    const out = run("forge", ["create", contract, "--rpc-url", RPC, "--private-key", ADMIN_PK, "--broadcast", "--constructor-args", ...args], RAMS_DIR);
    return out.match(/Deployed to: (0x[0-9a-fA-F]{40})/)[1];
  };
  const send = (pk, to, sig, ...args) => run("cast", ["send", to, sig, ...args, "--rpc-url", RPC, "--private-key", pk]);

  const provider = create("contracts/ComplianceProvider.sol:ComplianceProvider", [ADMIN]);
  const rams = create("contracts/AgentMandate.sol:AgentMandate", [ADMIN]);
  const bond = create("contracts/mocks/RamsGatedURWA20.sol:RamsGatedURWA20", ["Bond", "BND", ADMIN, rams]);

  send(ADMIN_PK, provider, "grantPrincipal(address,bytes32,uint48)", PRINCIPAL, `0x${"11".repeat(32)}`, "0");
  send(ADMIN_PK, bond, "changeSendWhitelist(address,bool)", PRINCIPAL, "true");
  send(ADMIN_PK, bond, "changeReceiveWhitelist(address,bool)", PRINCIPAL, "true");
  send(ADMIN_PK, bond, "changeReceiveWhitelist(address,bool)", VENUE, "true");
  send(ADMIN_PK, bond, "mint(address,uint256)", PRINCIPAL, (1000n * E18).toString());
  send(PRINCIPAL_PK, bond, "approve(address,uint256)", AGENT, (1000n * E18).toString());
  // Mandate: the agent may transferFrom up to 100 BND per trade, 250 BND in total.
  send(
    PRINCIPAL_PK,
    rams,
    "grantMandate((address,uint48,uint48,address,address,bytes32,address,uint256,uint256,bytes32,bytes32[],uint256),bytes)",
    `(${AGENT},0,4102444800,${PRINCIPAL},${provider},0x${"11".repeat(32)},${bond},${100n * E18},${250n * E18},0x${"00".repeat(32)},[${RAMS_TRANSFER_FROM}],0)`,
    "0x",
  );

  const check = (amount, agent = AGENT, asset = bond) => readRamsCheck({ rpcUrl: RPC, registry: rams, agent, principal: PRINCIPAL, asset, amount });
  const tokenAccepts = (amount) => {
    try {
      run("cast", ["call", bond, "transferFrom(address,address,uint256)", PRINCIPAL, VENUE, amount.toString(), "--from", AGENT, "--rpc-url", RPC]);
      return true;
    } catch {
      return false;
    }
  };

  await t("within the mandate: plugin says OK, and the gated token accepts the same transferFrom", async () => {
    const c = await check(50n * E18);
    assert.deepEqual([c.ok, c.reason, c.action, c.amount], [true, 0, "transferFrom", (50n * E18).toString()]);
    assert.equal(tokenAccepts(50n * E18), true);
  });
  await t("over the per-trade cap: plugin says OVER_TX_CAP, and the token reverts", async () => {
    const c = await check(150n * E18);
    assert.deepEqual([c.ok, RAMS_REASONS[c.reason]], [false, "OVER_TX_CAP"]);
    assert.equal(tokenAccepts(150n * E18), false);
  });
  await t("an agent with no mandate: NONEXISTENT", async () => {
    const c = await check(1n, "0x90F79bf6EB2c4f870365E785982E1f101E93b906");
    assert.equal(RAMS_REASONS[c.reason], "NONEXISTENT");
  });
  await t("an asset that is not RAMS-gated (no rams()) → no check at all, so no fail", async () => {
    assert.equal(await check(1n, AGENT, provider), undefined);
  });
  await t("cumulative cap: after two real 100 BND sales, a third 100 is OVER_CUMULATIVE_CAP", async () => {
    send(AGENT_PK, bond, "transferFrom(address,address,uint256)", PRINCIPAL, VENUE, (100n * E18).toString());
    send(AGENT_PK, bond, "transferFrom(address,address,uint256)", PRINCIPAL, VENUE, (100n * E18).toString());
    const c = await check(100n * E18);
    assert.deepEqual([c.ok, RAMS_REASONS[c.reason]], [false, "OVER_CUMULATIVE_CAP"]);
    assert.equal(tokenAccepts(100n * E18), false);
  });
} finally {
  anvil.kill();
}
console.log(`\n${pass} passed`);
