/**
 * onchain.js 集成测试：起本地 anvil → forge 部署 MandateRegistry → cast 写 mandate → 插件读回。
 * 断言锚定在「我们用 cast 写进去的原值」，不复用插件自己的换算逻辑。
 * 跑：npm run build && node test/onchain.test.mjs   （需要 ~/.foundry/bin 下的 anvil/forge/cast）
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  onchainToSpec,
  quoteHash,
  readOnchainMandate,
  scorecardHash,
} from "../dist/lib/onchain.js";

const BIN = process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin");
const exe = (n) => join(BIN, process.platform === "win32" ? `${n}.exe` : n);
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
// anvil 默认助记词的前两个账户（公开测试密钥，仅本地链）
const PRINCIPAL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PRINCIPAL = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const AGENT_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const env = { ...process.env };
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"]) delete env[k];
const run = (n, args, cwd) => execFileSync(exe(n), args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let pass = 0;
const t = async (name, fn) => {
  await fn();
  pass++;
  console.log(`  ✓ ${name}`);
};

// ---------- pure ----------
await t("onchainToSpec: cents→USD、其余字段原样", () => {
  const s = onchainToSpec({
    maxUsdPerTradeCents: 123456n,
    maxSlippageBps: 80,
    maxPriceImpactBps: 120,
    maxFeeBps: 30,
    allowCrossChain: false,
    allowNewApproval: true,
    recipientMustBeSelf: true,
    expiresAt: 0n,
  });
  assert.deepEqual(s, {
    maxUsdPerTrade: 1234.56,
    maxSlippageBps: 80,
    maxPriceImpactBps: 120,
    maxFeeBps: 30,
    allowCrossChain: false,
    allowNewApproval: true,
    recipientMustBeSelf: true,
  });
});
await t("canonicalJson: 键序无关、丢弃 undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});
await t("scorecardHash: 键序不同的同一 scorecard 哈希相同，内容不同则不同", () => {
  const a = { quoteId: "q", verdict: "warn", dimensions: [], notes: [] };
  const b = { notes: [], dimensions: [], verdict: "warn", quoteId: "q" };
  assert.equal(scorecardHash(a), scorecardHash(b));
  assert.notEqual(scorecardHash(a), scorecardHash({ ...a, verdict: "fail" }));
});
await t("quoteHash 与 cast keccak 一致（独立实现对照）", () => {
  assert.equal(quoteHash("quote-abc"), run("cast", ["keccak", "quote-abc"]).trim());
});

// ---------- anvil ----------
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
  const contracts = join(import.meta.dirname, "..", "contracts");
  const out = run(
    "forge",
    ["create", "src/MandateRegistry.sol:MandateRegistry", "--rpc-url", RPC, "--private-key", PRINCIPAL_PK, "--broadcast"],
    contracts,
  );
  const registry = out.match(/Deployed to: (0x[0-9a-fA-F]{40})/)[1];

  await t("未设置时 active=false、version=0", async () => {
    const m = await readOnchainMandate({ rpcUrl: RPC, registry, principal: PRINCIPAL, agent: AGENT });
    assert.equal(m.active, false);
    assert.equal(m.version, 0);
  });

  run("cast", [
    "send", registry,
    "setMandate(address,(uint64,uint16,uint16,uint16,bool,bool,bool,uint64))",
    AGENT, "(250000,75,110,40,false,true,true,0)",
    "--rpc-url", RPC, "--private-key", PRINCIPAL_PK,
  ]);

  await t("cast 写入的 mandate 被插件原样读回（$2,500 / 75 / 110 / 40 / false,true,true）", async () => {
    const m = await readOnchainMandate({ rpcUrl: RPC, registry, principal: PRINCIPAL, agent: AGENT });
    assert.equal(m.active, true);
    assert.equal(m.version, 1);
    assert.deepEqual(m.spec, {
      maxUsdPerTrade: 2500,
      maxSlippageBps: 75,
      maxPriceImpactBps: 110,
      maxFeeBps: 40,
      allowCrossChain: false,
      allowNewApproval: true,
      recipientMustBeSelf: true,
    });
  });

  await t("agent 用插件给出的哈希 attest 成功，事件里的值与之一致", async () => {
    const qh = quoteHash("quote-xyz");
    const sh = scorecardHash({ quoteId: "quote-xyz", verdict: "warn", dimensions: [], notes: [] });
    const rcpt = JSON.parse(
      run("cast", [
        "send", registry, "attestPreflight(address,bytes32,uint32,uint8,bytes32)",
        PRINCIPAL, qh, "1", "1", sh,
        "--rpc-url", RPC, "--private-key", AGENT_PK, "--json",
      ]),
    );
    assert.equal(rcpt.status, "0x1");
    const log = rcpt.logs[0];
    assert.equal(log.topics[3], qh, "quoteHash 是第三个 indexed topic");
    assert.ok(log.data.toLowerCase().endsWith(sh.slice(2).toLowerCase()), "scorecardHash 在 data 末尾");
  });

  run("cast", ["send", registry, "revoke(address)", AGENT, "--rpc-url", RPC, "--private-key", PRINCIPAL_PK]);

  await t("principal 撤销后插件读到 inactive、version=2", async () => {
    const m = await readOnchainMandate({ rpcUrl: RPC, registry, principal: PRINCIPAL, agent: AGENT });
    assert.equal(m.active, false);
    assert.equal(m.version, 2);
  });
} finally {
  anvil.kill();
}

console.log(`\n${pass} passed`);
