/**
 * Track record next to the scorecard: Evidence Deflator's deflatedT feedback read from ERC-8004.
 * Pure part: the bar matches the Python estimator behind evidencedeflator.com (values computed there with
 * hl_wallet.bar, statistics.NormalDist), and the line says what the number supports.
 * Fork part: anvil forks Arc mainnet; an impersonated client writes deflatedT feedback for Warrant's agent 1419
 * into the live ERC-8004 reputation registry, and readTrackRecord must return it, ignoring other writers.
 * Run: npm run build && node test/trackrecord.test.mjs   (needs foundry; the fork part needs the Arc RPC)
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readTrackRecord } from "../dist/lib/onchain.js";
import { barBestOf, trackRecordLine } from "../dist/lib/score.js";

const BIN = process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin");
const exe = (n) => join(BIN, process.platform === "win32" ? `${n}.exe` : n);
const PORT = 8551;
const RPC = `http://127.0.0.1:${PORT}`;
const ARC_RPC = process.env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io";
const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const AGENT_ID = "1419";
// arbitrary addresses that own no agent, impersonated on the local fork only
const ED = "0x00000000000000000000000000000000000e0d01";
const OTHER = "0x00000000000000000000000000000000000e0d02";

const env = { ...process.env };
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"]) delete env[k];
const run = (n, args) => execFileSync(exe(n), args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let pass = 0;
const t = async (name, fn) => {
  await fn();
  pass++;
  console.log(`  ✓ ${name}`);
};

// ---------- pure ----------
await t("barBestOf matches hl_wallet.bar (Python) to 3 decimals", () => {
  const py = { 1: 2, 2: 2.2776, 6: 2.6701, 41: 3.2611, 47310: 4.8993, 1000000: 5.4681 };
  for (const [n, v] of Object.entries(py)) assert.ok(Math.abs(barBestOf(Number(n)) - v) < 1e-3, `bar(${n})`);
});
await t("line: none / luck / clears single / clears field / loses", () => {
  assert.equal(trackRecordLine([], "7").status, "none");
  assert.equal(trackRecordLine([{ t: 1.4, pickedFrom: 1 }], "7").status, "luck");
  assert.equal(trackRecordLine([{ t: 3.42, pickedFrom: 47310 }], "7").status, "clears_single");
  assert.match(trackRecordLine([{ t: 3.42, pickedFrom: 47310 }], "7").line, /bar of 4\.90 for the best of 47,310/);
  assert.equal(trackRecordLine([{ t: 5.1, pickedFrom: 47310 }], "7").status, "clears_field");
  assert.equal(trackRecordLine([{ t: 2.3, pickedFrom: 1 }], "7").status, "clears_single");
  assert.equal(trackRecordLine([{ t: -2.4, pickedFrom: 1 }], "7").status, "loses");
  // the newest entry is the one read
  assert.equal(trackRecordLine([{ t: 5.1, pickedFrom: 47310 }, { t: 0.5, pickedFrom: 47310 }], "7").status, "luck");
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
  const give = (from, value, tag2) => {
    run("cast", ["rpc", "anvil_impersonateAccount", from, "--rpc-url", RPC]);
    run("cast", ["rpc", "anvil_setBalance", from, "0x56BC75E2D63100000", "--rpc-url", RPC]);
    run("cast", ["send", REPUTATION, "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
      AGENT_ID, String(value), "2", "deflatedT", tag2, "https://evidencedeflator.com/wallet/", "", `0x${"00".repeat(32)}`,
      "--from", from, "--unlocked", "--rpc-url", RPC]);
  };
  const before = await readTrackRecord({ rpcUrl: RPC, reputation: REPUTATION, agentId: BigInt(AGENT_ID), clients: [ED] });

  await t("no entry from the chosen client before it writes one", () => assert.equal(before.length, 0));

  give(OTHER, 900, "single");
  give(ED, 342, "bestOf47310");
  const got = await readTrackRecord({ rpcUrl: RPC, reputation: REPUTATION, agentId: BigInt(AGENT_ID), clients: [ED] });

  await t("readTrackRecord returns the chosen client's entry from the live registry, and only that", () => {
    assert.equal(got.length, 1);
    assert.equal(got[0].client.toLowerCase(), ED.toLowerCase());
    assert.equal(got[0].t, 3.42);
    assert.equal(got[0].pickedFrom, 47310);
    assert.equal(trackRecordLine(got, AGENT_ID).status, "clears_single");
  });
  await t("listing both clients returns both, in registry order", async () => {
    const both = await readTrackRecord({ rpcUrl: RPC, reputation: REPUTATION, agentId: BigInt(AGENT_ID), clients: [OTHER, ED] });
    assert.deepEqual(both.map((e) => e.t), [9, 3.42]);
  });
} finally {
  anvil.kill();
}
console.log(`\n${pass} passed`);
