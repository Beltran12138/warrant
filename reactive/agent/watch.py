"""Print the loop as it happens on both chains, with timestamps:

  Sepolia  WarrantRegistry / WarrantAttestor   disclosures (the agent's own record)
  Sepolia  dUSD Transfer from the agent        trades
  Lasna    WarrantSentinel                     Disclosure / TradeCovered / Violation (its reading of them)
  Sepolia  WarrantGuardian                     Frozen / Unfrozen (the callback landing)

    python agent/watch.py            # follow from now
    python agent/watch.py --since 600   # include roughly the last 600 seconds
"""
import functools
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import chain  # noqa: E402

print = functools.partial(print, flush=True)  # noqa: A001

D = chain.DEPLOY
A = chain.AGENT.lower()
REASONS = ["Undisclosed", "TradedAfterFail"]
VERDICTS = ["PASS", "WARN", "FAIL"]

# (chain, address, event signature, label)
STREAMS = [
    ("sepolia", D["registry"], "PreflightAttested(address,address,bytes32,uint32,uint8,bytes32)", "disclosed"),
    ("sepolia", D["attestor"], "SignedPreflightAttested(address,address,bytes32,uint32,uint8,bytes32,address)", "disclosed (signed)"),
    ("sepolia", D["dusd"], "Transfer(address,address,uint256)", "transfer"),
    ("lasna", D["sentinel"], "Disclosure(address,bytes32,uint8,uint256)", "sentinel: disclosure"),
    ("lasna", D["sentinel"], "TradeCovered(address,uint256,uint256,uint256)", "sentinel: trade covered"),
    ("lasna", D["sentinel"], "Violation(address,uint8,uint256,uint256)", "sentinel: VIOLATION -> callback"),
    ("lasna", D["sentinel"], "Reset(address)", "sentinel: reset"),
    ("sepolia", D["guardian"], "Frozen(address,uint8,uint256,uint256,uint256,bool)", "guardian: FROZEN"),
    ("sepolia", D["guardian"], "Unfrozen(address)", "guardian: unfrozen"),
    ("sepolia", D["guardian"], "Drawn(address,uint256,uint256)", "guardian: drawn"),
]
if D.get("review_log"):
    STREAMS.append(("sepolia", D["review_log"], "Reviewed(address,address,bytes32,address,uint8,uint256,bytes32,string)",
                    "AI review filed"))
RPC = {"sepolia": chain.S_RPC, "lasna": chain.L_RPC}


def cast(*args):
    r = subprocess.run([chain.CAST, *args], capture_output=True, text=True, env=chain._env())
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[-200:])
    return r.stdout


def block_now(c):
    return int(cast("block-number", "--rpc-url", RPC[c]))


def ts(c, n, cache={}):
    if (c, n) not in cache:
        cache[(c, n)] = int(cast("block", str(n), "-f", "timestamp", "--rpc-url", RPC[c]))
    return cache[(c, n)]


def words(hexdata):
    h = hexdata[2:]
    return [int(h[i:i + 64], 16) for i in range(0, len(h), 64)]


def describe(label, log):
    t = log["topics"]
    w = words(log["data"])
    addr = lambda x: "0x" + x[-40:]  # noqa: E731
    if label == "transfer":
        frm, to = addr(t[1]), addr(t[2])
        if A not in (frm.lower(), to.lower()):
            return None
        who = "agent -> " + to if frm.lower() == A else frm + " -> agent"
        if to.lower() == D["guardian"].lower():
            who += " (refund to guardian)"
        return f"dUSD {w[0] / 1e6:g}  {who}"
    if label.startswith("disclosed"):
        return f"{VERDICTS[w[1]]}  quote {t[3][:12]}..  v{w[0]}"
    if label == "sentinel: disclosure":
        return f"{VERDICTS[w[0]]}  unused disclosures now {w[1]}"
    if label == "sentinel: trade covered":
        return f"dUSD {w[0] / 1e6:g}  unused left {w[1]}  origin tx 0x{w[2]:064x}"
    if label.startswith("sentinel: VIOLATION"):
        return f"{REASONS[w[0]]}  dUSD {w[1] / 1e6:g}  origin tx 0x{w[2]:064x}"
    if label == "guardian: FROZEN":
        return f"{REASONS[w[0]]}  budget cut {w[3] / 1e6:g}  warrant revoked {bool(w[4])}  origin tx 0x{w[2]:064x}"
    if label == "AI review filed":
        rec = ["KeepFrozen", "UnfreezeWithLowerBudget", "Unfreeze"][w[1]]
        return f"{rec}  suggested budget {w[2] / 1e6:g}  report {('0x%064x' % w[3])[:12]}..  freeze tx {t[3][:12]}.."
    if label == "guardian: drawn":
        return f"dUSD {w[0] / 1e6:g}  remaining {w[1] / 1e6:g}"
    return ""


def main():
    since = int(sys.argv[sys.argv.index("--since") + 1]) if "--since" in sys.argv else 0
    # Sepolia ~12s blocks; Lasna's block time is taken from the chain itself.
    frm = {}
    for c in RPC:
        n = block_now(c)
        if since:
            dt = max(1, ts(c, n) - ts(c, max(0, n - 100))) / 100
            n = max(0, n - int(since / dt))
        frm[c] = n
    seen = set()
    print(f"watching agent {chain.AGENT}  guardian {D['guardian']}  sentinel {D['sentinel']}")
    while True:
        rows = []
        logs = []
        for c in RPC:
            try:
                head = block_now(c)
            except RuntimeError as e:
                print(f"  ({c}: {e})")
                continue
            ok = True
            for start in range(frm[c], head + 1, 2000):  # public RPCs cap the block range per query
                end = min(start + 1999, head)
                for cc, address, sig, label in STREAMS:
                    if cc != c:
                        continue
                    try:
                        out = cast("logs", "--json", "--rpc-url", RPC[c], "--from-block", str(start),
                                   "--to-block", str(end), "--address", address, sig)
                    except RuntimeError as e:
                        print(f"  ({c} {label}: {e or 'query failed'})")
                        ok = False
                        continue
                    logs += [(c, label, log) for log in json.loads(out or "[]")]
            if ok:
                frm[c] = head + 1
        for c, label, log in logs:
            key = (c, log["transactionHash"], log["logIndex"])
            if key in seen:
                continue
            seen.add(key)
            text = describe(label, log)
            if text is None:
                continue
            n = int(log["blockNumber"], 16)
            rows.append((ts(c, n), c, label, text, log["transactionHash"]))
        for t, c, label, text, tx in sorted(rows):
            stamp = time.strftime("%H:%M:%S", time.gmtime(t))
            print(f"{stamp}Z  {c:7}  {label:34} {text}\n{'':19}tx {tx}")
        time.sleep(6)


if __name__ == "__main__":
    main()
