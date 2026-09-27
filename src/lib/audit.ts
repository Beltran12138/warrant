/**
 * Warrant audit: did the agent's actual transactions follow its warrant and its own disclosures?
 * Pure functions over data read from chain (see scripts/audit.mjs for the I/O).
 *
 * Every position is (block, txIndex), so events and transactions in the same block order correctly.
 */

export type Pos = { block: number; txIndex: number };

/** WarrantSet / WarrantRevoked for one principal → agent pair. */
export type WarrantEvent = Pos & { kind: "set" | "revoke"; version: number; expiresAt?: number };

/**
 * A preflight disclosure. `tx`: WarrantRegistry.attestPreflight, sent by the agent itself, so its
 * position proves when it happened. `signed`: relayed to WarrantAttestor; the EIP-712 payload has no
 * timestamp, so its position only proves when it was *submitted*, not when it was signed.
 */
export type Attestation = Pos & {
  kind: "tx" | "signed";
  verdict: 0 | 1 | 2;
  version: number;
  quoteHash: string;
  txHash: string;
};

/** An outgoing transaction of the agent that is not Warrant/ERC-8004 bookkeeping. */
export type Action = Pos & { txHash: string; to: string | null; timestamp: number };

export type FindingCode = "OK" | "NO_ACTIVE_WARRANT" | "UNATTESTED" | "EXECUTED_AFTER_FAIL" | "EXECUTED_ON_WARN";

export type Finding = {
  action: Action;
  code: FindingCode;
  /** Violations break the warrant or the agent's own disclosure; EXECUTED_ON_WARN needs a human check. */
  violation: boolean;
  attestation?: Attestation;
  notes: string[];
};

export type Coverage = { expected: number; found: number };

export type AuditReport = {
  findings: Finding[];
  counts: Record<FindingCode, number>;
  violations: number;
  /** Outgoing transactions the agent really sent in the range (nonce delta) vs the ones examined. */
  coverage?: Coverage;
  notes: string[];
};

const VIOLATION: Record<FindingCode, boolean> = {
  OK: false,
  NO_ACTIVE_WARRANT: true,
  UNATTESTED: true,
  EXECUTED_AFTER_FAIL: true,
  EXECUTED_ON_WARN: false,
};

export const before = (a: Pos, b: Pos): boolean => a.block < b.block || (a.block === b.block && a.txIndex < b.txIndex);
const byPos = (a: Pos, b: Pos) => a.block - b.block || a.txIndex - b.txIndex;

/** Was the warrant active at `at` (block position + that block's timestamp)? */
export function warrantActiveAt(events: WarrantEvent[], at: Pos, timestamp: number): { active: boolean; reason?: string } {
  const last = events.filter((e) => before(e, at)).sort(byPos).at(-1);
  if (!last) return { active: false, reason: "no warrant had been granted" };
  if (last.kind === "revoke") return { active: false, reason: `warrant revoked (v${last.version})` };
  if (last.expiresAt && last.expiresAt <= timestamp) return { active: false, reason: `warrant v${last.version} expired` };
  return { active: true };
}

/**
 * The warrant's state just before an audited range, as a timeline event at the end of block
 * `block`, from getWarrant read at that block. Revoking keeps the stored struct (expiresAt
 * included), so "inactive and not yet expired" means revoked.
 */
export function seedEvent(
  block: number,
  w: { version: number; active: boolean; expiresAt: number },
  blockTimestamp: number,
): WarrantEvent[] {
  if (w.version === 0) return [];
  const pos = { block, txIndex: Number.MAX_SAFE_INTEGER, version: w.version };
  const expired = w.expiresAt !== 0 && w.expiresAt <= blockTimestamp;
  return w.active || expired ? [{ ...pos, kind: "set", expiresAt: w.expiresAt }] : [{ ...pos, kind: "revoke" }];
}

/**
 * Pair each action with the most recent unused disclosure before it: the last scorecard the agent
 * saw before executing is the one that applies. Each disclosure covers one action. Signed
 * disclosures are a fallback for actions with no transaction disclosure, since their signing time
 * cannot be proven.
 */
export function audit(input: {
  events: WarrantEvent[];
  attestations: Attestation[];
  actions: Action[];
  coverage?: Coverage;
}): AuditReport {
  const actions = [...input.actions].sort(byPos);
  const txAtts = input.attestations.filter((a) => a.kind === "tx").sort(byPos);
  const signedAtts = input.attestations.filter((a) => a.kind === "signed").sort(byPos);
  const used = new Set<Attestation>();
  const findings: Finding[] = [];

  let prev: Pos | undefined;
  for (const action of actions) {
    const notes: string[] = [];
    const candidates = txAtts.filter((a) => !used.has(a) && before(a, action) && (!prev || before(prev, a)));
    let att = candidates.at(-1);
    if (candidates.length > 1) {
      notes.push(`${candidates.length} disclosures since the previous action; paired with the latest`);
    }
    if (!att) {
      att = signedAtts.find((a) => !used.has(a));
      if (att) {
        notes.push(
          before(att, action)
            ? "signed disclosure submitted before this action; when it was signed is not provable"
            : "signed disclosure submitted after this action; it may have been signed before or after",
        );
      }
    }
    if (att) used.add(att);

    const w = warrantActiveAt(input.events, action, action.timestamp);
    let code: FindingCode;
    if (!w.active) {
      code = "NO_ACTIVE_WARRANT";
      notes.unshift(w.reason!);
    } else if (!att) code = "UNATTESTED";
    else if (att.verdict === 2) code = "EXECUTED_AFTER_FAIL";
    else if (att.verdict === 1) code = "EXECUTED_ON_WARN";
    else code = "OK";

    findings.push({ action, code, violation: VIOLATION[code], attestation: att, notes });
    prev = action;
  }

  const counts = { OK: 0, NO_ACTIVE_WARRANT: 0, UNATTESTED: 0, EXECUTED_AFTER_FAIL: 0, EXECUTED_ON_WARN: 0 };
  for (const f of findings) counts[f.code]++;
  const notes: string[] = [];
  const cov = input.coverage;
  if (cov && cov.found < cov.expected) {
    notes.push(`only ${cov.found} of the agent's ${cov.expected} outgoing transactions in range were examined; "no violation" is limited to those`);
  }
  return { findings, counts, violations: findings.filter((f) => f.violation).length, coverage: cov, notes };
}

const LABEL: Record<FindingCode, string> = {
  OK: "ok",
  NO_ACTIVE_WARRANT: "VIOLATION  traded without an active warrant",
  UNATTESTED: "VIOLATION  traded without a preflight disclosure",
  EXECUTED_AFTER_FAIL: "VIOLATION  traded after disclosing FAIL",
  EXECUTED_ON_WARN: "review     traded on WARN (needs a human yes, not visible on-chain)",
};

export function renderAudit(r: AuditReport, txUrl: (h: string) => string = (h) => h): string {
  const lines = r.findings.map((f) => {
    const att = f.attestation ? `  ← ${["PASS", "WARN", "FAIL"][f.attestation.verdict]} ${f.attestation.kind} disclosure ${txUrl(f.attestation.txHash)}` : "";
    const notes = f.notes.map((n) => `\n      · ${n}`).join("");
    return `  block ${f.action.block}  ${LABEL[f.code]}\n      ${txUrl(f.action.txHash)}${att}${notes}`;
  });
  const cov = r.coverage ? `coverage: ${r.coverage.found} of ${r.coverage.expected} outgoing transactions examined\n` : "";
  return [
    `Warrant audit: ${r.findings.length} actions, ${r.violations} violation(s)`,
    cov + Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join("  "),
    ...lines,
    ...r.notes.map((n) => `! ${n}`),
  ].join("\n");
}
