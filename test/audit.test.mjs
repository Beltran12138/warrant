/**
 * audit.js unit tests: hand-built timelines, expected verdicts written from the rules in
 * src/lib/audit.ts, not from running it. Run: node test/audit.test.mjs (after npm run build)
 */
import assert from "node:assert/strict";
import { audit, renderAudit, seedEvent, warrantActiveAt } from "../dist/lib/audit.js";

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
};

const set = (block, version, expiresAt = 0) => ({ kind: "set", block, txIndex: 0, version, expiresAt });
const revoke = (block, version) => ({ kind: "revoke", block, txIndex: 0, version });
const att = (block, verdict, kind = "tx", txIndex = 0) => ({ kind, block, txIndex, verdict, version: 1, quoteHash: `q${block}`, txHash: `att${block}.${txIndex}` });
const act = (block, txIndex = 0, timestamp = 1_000) => ({ block, txIndex, txHash: `act${block}.${txIndex}`, to: "0xdex", timestamp });
const codes = (r) => r.findings.map((f) => f.code);

t("PASS disclosure then trade → OK", () => {
  const r = audit({ events: [set(1, 1)], attestations: [att(2, 0)], actions: [act(3)] });
  assert.deepEqual(codes(r), ["OK"]);
  assert.equal(r.violations, 0);
});

t("trade with no disclosure → UNATTESTED", () => {
  const r = audit({ events: [set(1, 1)], attestations: [], actions: [act(3)] });
  assert.deepEqual(codes(r), ["UNATTESTED"]);
  assert.equal(r.violations, 1);
});

t("FAIL disclosure then trade → EXECUTED_AFTER_FAIL", () => {
  const r = audit({ events: [set(1, 1)], attestations: [att(2, 2)], actions: [act(3)] });
  assert.deepEqual(codes(r), ["EXECUTED_AFTER_FAIL"]);
});

t("WARN disclosure then trade → EXECUTED_ON_WARN, flagged for review but not a violation", () => {
  const r = audit({ events: [set(1, 1)], attestations: [att(2, 1)], actions: [act(3)] });
  assert.deepEqual(codes(r), ["EXECUTED_ON_WARN"]);
  assert.equal(r.violations, 0);
});

t("trade after revoke → NO_ACTIVE_WARRANT even with a PASS disclosure", () => {
  const r = audit({ events: [set(1, 1), revoke(4, 2)], attestations: [att(2, 0)], actions: [act(5)] });
  assert.deepEqual(codes(r), ["NO_ACTIVE_WARRANT"]);
  assert.match(r.findings[0].notes[0], /revoked/);
});

t("trade before any grant → NO_ACTIVE_WARRANT", () => {
  const r = audit({ events: [set(5, 1)], attestations: [], actions: [act(3)] });
  assert.deepEqual(codes(r), ["NO_ACTIVE_WARRANT"]);
});

t("expiry uses the action's block timestamp", () => {
  assert.equal(warrantActiveAt([set(1, 1, 2_000)], { block: 3, txIndex: 0 }, 1_999).active, true);
  assert.equal(warrantActiveAt([set(1, 1, 2_000)], { block: 3, txIndex: 0 }, 2_000).active, false);
});

t("one disclosure covers one trade: the second trade is UNATTESTED", () => {
  const r = audit({ events: [set(1, 1)], attestations: [att(2, 0)], actions: [act(3), act(4)] });
  assert.deepEqual(codes(r), ["OK", "UNATTESTED"]);
});

t("a disclosure made after the trade does not cover it", () => {
  const r = audit({ events: [set(1, 1)], attestations: [att(4, 0)], actions: [act(3)] });
  assert.deepEqual(codes(r), ["UNATTESTED"]);
});

t("same block: order is by transaction index", () => {
  const ok = audit({ events: [set(1, 1)], attestations: [att(3, 0, "tx", 0)], actions: [act(3, 1)] });
  const late = audit({ events: [set(1, 1)], attestations: [att(3, 0, "tx", 2)], actions: [act(3, 1)] });
  assert.deepEqual(codes(ok), ["OK"]);
  assert.deepEqual(codes(late), ["UNATTESTED"]);
});

t("PASS then FAIL before one trade: the latest (FAIL) applies, ambiguity noted", () => {
  const r = audit({ events: [set(1, 1)], attestations: [att(2, 0), att(3, 2)], actions: [act(4)] });
  assert.deepEqual(codes(r), ["EXECUTED_AFTER_FAIL"]);
  assert.match(r.findings[0].notes.join(), /2 disclosures since the previous action/);
});

t("disclosures before the previous action do not carry over", () => {
  const r = audit({ events: [set(1, 1)], attestations: [att(2, 0), att(3, 0)], actions: [act(4), act(5)] });
  assert.deepEqual(codes(r), ["OK", "UNATTESTED"]);
});

t("signed disclosure is used only as a fallback, with its ordering caveat", () => {
  const r = audit({ events: [set(1, 1)], attestations: [att(9, 2, "signed")], actions: [act(3)] });
  assert.deepEqual(codes(r), ["EXECUTED_AFTER_FAIL"]);
  assert.match(r.findings[0].notes.join(), /submitted after this action/);
});

t("coverage below the nonce count is reported, never hidden", () => {
  const r = audit({ events: [set(1, 1)], attestations: [], actions: [], coverage: { expected: 3, found: 1 } });
  assert.equal(r.findings.length, 0);
  assert.match(r.notes.join(), /only 1 of the agent's 3 outgoing transactions/);
  assert.match(renderAudit(r), /coverage: 1 of 3/);
});

// State before the range (read with getWarrant at from-1), so a grant made earlier still counts.
const inRange = act(10, 0, 1_500);
t("seed: never granted → no event → NO_ACTIVE_WARRANT", () => {
  assert.deepEqual(seedEvent(9, { version: 0, active: false, expiresAt: 0 }, 1_000), []);
  assert.deepEqual(codes(audit({ events: [], attestations: [], actions: [inRange] })), ["NO_ACTIVE_WARRANT"]);
});
t("seed: active before the range → a disclosed trade in range is OK", () => {
  const r = audit({ events: seedEvent(9, { version: 3, active: true, expiresAt: 0 }, 1_000), attestations: [att(10, 0, "tx", 0)], actions: [act(10, 1, 1_500)] });
  assert.deepEqual(codes(r), ["OK"]);
});
t("seed: revoked before the range, even with an expiry still in the future → NO_ACTIVE_WARRANT", () => {
  const ev = seedEvent(9, { version: 4, active: false, expiresAt: 5_000 }, 1_000);
  assert.equal(ev[0].kind, "revoke");
  assert.deepEqual(codes(audit({ events: ev, attestations: [], actions: [inRange] })), ["NO_ACTIVE_WARRANT"]);
});
t("seed: active before the range but expiring inside it → NO_ACTIVE_WARRANT after expiry", () => {
  const ev = seedEvent(9, { version: 3, active: true, expiresAt: 1_200 }, 1_000);
  assert.equal(ev[0].kind, "set");
  const r = audit({ events: ev, attestations: [att(10, 0, "tx", 0)], actions: [act(10, 1, 1_500)] });
  assert.deepEqual(codes(r), ["NO_ACTIVE_WARRANT"]);
  assert.match(r.findings[0].notes[0], /expired/);
});

console.log(`\n${pass} passed`);
