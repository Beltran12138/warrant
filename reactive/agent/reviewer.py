"""AI reviewer, triggered by the freeze.

When WarrantGuardian emits `Frozen` (the Reactive callback has landed), this reads the on-chain evidence around
it, asks DeepSeek what happened and what the owner should do, and files the recommendation in WarrantReviewLog
on chain with a hash of the full report (saved to reviews/<frozen tx>.json).

    python agent/reviewer.py            # watch: review every new freeze as it lands
    python agent/reviewer.py --latest   # review the most recent freeze and exit

It reads only chain data: the trade, where the money went and whether the agent had ever sent money there,
the disclosures in front of it, draws, the warrant. Advisory only: the review log cannot move funds or lift a
freeze; the owner decides.
"""
import functools
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import chain  # noqa: E402

print = functools.partial(print, flush=True)  # noqa: A001

D = chain.DEPLOY
AGENT = chain.AGENT.lower()
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-flash")
OUT = chain.ROOT / "reviews"
VERDICTS = ["PASS", "WARN", "FAIL"]
REASONS = ["Undisclosed", "TradedAfterFail"]
RECS = ["KeepFrozen", "UnfreezeWithLowerBudget", "Unfreeze"]
SIG = {
    "frozen": "Frozen(address,uint8,uint256,uint256,uint256,bool)",
    "unfrozen": "Unfrozen(address)",
    "drawn": "Drawn(address,uint256,uint256)",
    "transfer": "Transfer(address,address,uint256)",
    "attested": "PreflightAttested(address,address,bytes32,uint32,uint8,bytes32)",
    "signed": "SignedPreflightAttested(address,address,bytes32,uint32,uint8,bytes32,address)",
    "warrant_set": "WarrantSet(address,address,uint32,(uint64,uint16,uint16,uint16,bool,bool,bool,uint64))",
}


def cast(*args):
    for attempt in range(4):
        try:
            return chain._run(list(args))
        except RuntimeError:
            if attempt == 3:
                raise
            time.sleep(2)


def words(h):
    h = h[2:]
    return [int(h[i:i + 64], 16) for i in range(0, len(h), 64)]


def addr(topic):
    return "0x" + topic[-40:]


@functools.lru_cache(maxsize=None)
def block_time(n):
    return int(cast("block", str(n), "-f", "timestamp", "--rpc-url", chain.S_RPC))


@functools.lru_cache(maxsize=1)
def start_block():
    return int(cast("receipt", D["guardian_tx"], "blockNumber", "--rpc-url", chain.S_RPC))


def logs(address, sig, *topics, frm=None):
    frm = start_block() if frm is None else frm
    head = int(cast("block-number", "--rpc-url", chain.S_RPC))
    out = []
    for a in range(frm, head + 1, 2000):
        b = min(a + 1999, head)
        res = cast("logs", "--json", "--rpc-url", chain.S_RPC, "--from-block", str(a), "--to-block", str(b),
                   "--address", address, sig, *topics)
        out += json.loads(res or "[]")
    for log in out:
        log["block"] = int(log["blockNumber"], 16)
        log["time"] = block_time(log["block"])
    return out


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


# ------------------------------------------------------------------ evidence
def evidence(frozen_log):
    w = words(frozen_log["data"])
    reason, trade_tx, cut, revoked = w[0], "0x%064x" % w[2], w[3], bool(w[4])
    pad = "0x" + "0" * 24 + AGENT[2:]
    gpad = "0x" + "0" * 24 + D["guardian"][2:].lower()

    transfers = logs(D["dusd"], SIG["transfer"], pad)  # every outflow from the agent's wallet
    trade = next((t for t in transfers if t["transactionHash"].lower() == trade_tx.lower()), None)
    if trade is None:
        raise RuntimeError(f"trade {trade_tx} not found among the agent's transfers")
    to = addr(trade["topics"][2])
    earlier = [t for t in transfers if t["block"] < trade["block"]]
    seen = {}
    for t in earlier:
        r = addr(t["topics"][2])
        seen[r] = seen.get(r, 0) + 1

    disclosures = []
    for kind, address, sig in (("agent-sent", D["registry"], SIG["attested"]),
                               ("agent-signed", D["attestor"], SIG["signed"])):
        for log in logs(address, sig, gpad, pad):
            v = words(log["data"])
            disclosures.append({"time": iso(log["time"]), "block": log["block"], "verdict": VERDICTS[v[1]],
                                "warrant_version": v[0], "quote_hash": log["topics"][3], "via": kind})
    disclosures.sort(key=lambda x: x["block"])

    freezes = logs(D["guardian"], SIG["frozen"], pad)
    unfreezes = logs(D["guardian"], SIG["unfrozen"], pad)
    draws = logs(D["guardian"], SIG["drawn"], pad)
    grants = logs(D["registry"], SIG["warrant_set"], gpad, pad)
    # the window the sentinel judged this trade in: since the last unfreeze (or the start) up to the trade
    window_start = max([u["block"] for u in unfreezes if u["block"] < trade["block"]] or [0])
    in_window = [d for d in disclosures if window_start <= d["block"] <= trade["block"]]
    trades_in_window = [t for t in transfers if window_start <= t["block"] < trade["block"]
                        and addr(t["topics"][2]).lower() != D["guardian"].lower()]
    grant = max((g for g in grants if g["block"] <= trade["block"]), key=lambda g: g["block"], default=None)
    warrant = None
    if grant:
        g = words(grant["data"])
        warrant = dict(zip(["version", *chain.FIELDS], g))
        warrant["maxUsdPerTrade"] = warrant.pop("maxUsdPerTradeCents") / 100
    draw = max((d for d in draws if d["block"] <= trade["block"]), key=lambda d: d["block"], default=None)

    return {
        "freeze": {"tx": frozen_log["transactionHash"], "time": iso(frozen_log["time"]), "reason": REASONS[reason],
                   "budget_cut_dusd": cut / 1e6, "warrant_revoked": revoked,
                   "seconds_after_trade": frozen_log["time"] - trade["time"]},
        "trade": {"tx": trade["transactionHash"], "time": iso(trade["time"]),
                  "amount_dusd": words(trade["data"])[0] / 1e6, "to": to,
                  "agent_payments_to_this_address_before": seen.get(to, 0),
                  "agent_payment_recipients_before": [{"address": k, "payments": v} for k, v in seen.items()]},
        "disclosures_since_last_unfreeze": in_window,
        "other_trades_since_last_unfreeze": len(trades_in_window),
        "draw_before_trade": None if not draw else {"time": iso(draw["time"]), "amount_dusd": words(draw["data"])[0] / 1e6,
                                                    "seconds_before_trade": trade["time"] - draw["time"]},
        "warrant_at_trade": warrant,
        "history": {"disclosures_total": len(disclosures),
                    "disclosure_verdicts": {v: sum(d["verdict"] == v for d in disclosures) for v in VERDICTS},
                    "freezes_before_this": sum(f["block"] < frozen_log["block"] for f in freezes),
                    "unfreezes_before_this": sum(u["block"] < frozen_log["block"] for u in unfreezes),
                    "draws_total": len(draws)},
    }


# ------------------------------------------------------------------ model
SYSTEM = """You review freezes for the owner of an AI trading agent. The owner funds the agent through a guardian
contract. A watcher on Reactive Network froze the agent (budget set to zero, mandate revoked) because a trade from
its wallet had no unused PASS/WARN preflight disclosure in front of it, or came after a FAIL disclosure.

You get only on-chain evidence, as JSON. Work out what most likely happened and what the owner should do next.
Consider in particular: where the money went and whether the agent had ever paid that address before; whether
any disclosure preceded the trade and what it said; how the draw relates to the trade; the agent's history.
Typical readings, not rules: funds sent to an address the agent never paid before suggest a compromised key
(keep frozen, rotate the key); a trade to its usual venue with no disclosure suggests the agent's tooling or
prompt changed (restore preflight, resume with a lower budget); a trade after its own FAIL means it ignored its
own check. Say what the evidence does not show. Do not invent facts that are not in the evidence.

Answer with JSON only:
{"recommendation": "KeepFrozen" | "UnfreezeWithLowerBudget" | "Unfreeze",
 "suggested_budget_dusd": number (0 if KeepFrozen),
 "summary": "one or two sentences for the owner, at most 240 characters",
 "what_happened": "short paragraph",
 "evidence": ["the facts from the input you relied on"],
 "before_unfreezing": ["concrete steps for the owner"],
 "not_shown_by_the_evidence": ["what you could not determine"],
 "confidence": "high" | "medium" | "low"}"""


def ask(ev):
    body = json.dumps({"model": MODEL, "max_tokens": 8000, "response_format": {"type": "json_object"},
                       "messages": [{"role": "system", "content": SYSTEM},
                                    {"role": "user", "content": json.dumps(ev, indent=1)}]}).encode()
    req = urllib.request.Request("https://api.deepseek.com/chat/completions", data=body, headers={
        "Authorization": "Bearer " + chain.ENV["DEEPSEEK_API_KEY"], "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    err = "answer did not match the schema"
    for attempt in range(3):
        try:
            with opener.open(req, timeout=240) as r:
                choice = json.loads(r.read())["choices"][0]
            if not (choice["message"].get("content") or "").strip():
                err = f"empty answer (finish_reason {choice.get('finish_reason')})"
                continue
            out = json.loads(choice["message"]["content"])
            if out.get("recommendation") in RECS and isinstance(out.get("summary"), str):
                out["summary"] = out["summary"][:240]
                return out
        except (urllib.error.URLError, json.JSONDecodeError, KeyError) as e:
            err = e
        time.sleep(3)
    raise RuntimeError(f"no valid answer from {MODEL}: {err}")


# ------------------------------------------------------------------ review one freeze
def review(frozen_log):
    tx = frozen_log["transactionHash"]
    path = OUT / f"{tx}.json"
    if path.exists():
        print(f"already reviewed {tx}")
        return json.loads(path.read_text(encoding="utf-8"))
    print(f"reviewer: Frozen in {tx[:10]}… -> gathering evidence")
    ev = evidence(frozen_log)
    t = ev["trade"]
    print(f"reviewer: trade {t['amount_dusd']:g} dUSD to {t['to'][:10]}… "
          f"(agent paid this address {t['agent_payments_to_this_address_before']} times before), "
          f"{len(ev['disclosures_since_last_unfreeze'])} disclosure(s) in front of it, reason {ev['freeze']['reason']}")
    print(f"reviewer: asking {MODEL}")
    t0 = time.time()
    answer = ask(ev)
    report = {"model": MODEL, "frozen_tx": tx, "agent": chain.AGENT, "guardian": D["guardian"],
              "evidence": ev, "review": answer}
    canon = json.dumps(report, sort_keys=True, separators=(",", ":"))
    report_hash = chain.keccak(canon)
    OUT.mkdir(exist_ok=True)
    path.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(f"reviewer: {answer['recommendation']}  budget {answer.get('suggested_budget_dusd', 0)}  "
          f"({time.time() - t0:.0f}s)  confidence {answer.get('confidence')}")
    print(f"reviewer: \"{answer['summary']}\"")
    rec = RECS.index(answer["recommendation"])
    budget = int(round(float(answer.get("suggested_budget_dusd") or 0) * 1e6))
    r = chain.send(D["review_log"], "review(address,address,bytes32,uint8,uint256,bytes32,string)",
                   D["guardian"], chain.AGENT, tx, rec, budget, report_hash, answer["summary"],
                   key="REVIEWER_PRIVATE_KEY")
    print(f"reviewer: filed on chain  tx {r['tx']}  report {path.name}")
    report["review_tx"] = r["tx"]
    report["report_hash"] = report_hash
    path.write_text(json.dumps(report, indent=1), encoding="utf-8")
    return report


def main():
    pad = "0x" + "0" * 24 + AGENT[2:]
    if "--latest" in sys.argv:
        f = logs(D["guardian"], SIG["frozen"], pad)
        if not f:
            sys.exit("no freeze yet")
        review(f[-1])
        return
    head = int(cast("block-number", "--rpc-url", chain.S_RPC))
    print(f"reviewer: watching {D['guardian']} for Frozen (from block {head})")
    while True:
        for f in logs(D["guardian"], SIG["frozen"], pad, frm=head + 1):
            review(f)
            head = max(head, f["block"])
        time.sleep(6)


if __name__ == "__main__":
    main()
