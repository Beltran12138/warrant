"""Run the demo live on Sepolia + Lasna and record everything that is printed, with wall-clock times.

    python video/record.py            -> video/out/recording.json

Sequence: re-grant (owner) -> honest agent (covered) -> compromised agent (frozen) -> draw after the freeze
(reverts) -> lift + re-grant -> agent discloses FAIL and declines -> leaked key trades anyway (frozen).
Nothing here is staged: every line in the video comes from this recording.
"""
import json
import os
import pathlib
import queue
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "agent"))
import chain  # noqa: E402

OUT = ROOT / "video" / "out"
OUT.mkdir(parents=True, exist_ok=True)
EVENTS = []
LOCK = threading.Lock()
WARRANT = "(50000,100,200,50,false,false,true,0)"
ENV = {**chain._env(), "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}


def emit(source, text, **extra):
    with LOCK:
        EVENTS.append({"t": time.time(), "source": source, "text": text, **extra})
    print(f"[{source}] {text}", flush=True)


def mark(name):
    emit("mark", name)


def pump(proc, source, q=None):
    for line in proc.stdout:
        line = line.rstrip("\n")
        emit(source, line)
        if q is not None:
            q.put(line)


def wait_for(q, needle, timeout=240):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if needle in q.get(timeout=end - time.time()):
                return True
        except queue.Empty:
            break
    emit("ops", f"(timed out waiting for: {needle})")
    return False


def owner(label, to, sig, *args):
    r = chain.send(to, sig, *args, key="PRINCIPAL_PRIVATE_KEY")
    emit("ops", f"owner: {label}", tx=r["tx"], ok=r["ok"])


def regrant():
    g = chain.DEPLOY["guardian"]
    s = chain.status()
    if s["frozen"]:
        owner("unfreeze(agent)", g, "unfreeze(address)", chain.AGENT)
    owner("setWarrant(agent, max $500/trade, slippage <= 1%, ...)", g,
          "setWarrant(address,(uint64,uint16,uint16,uint16,bool,bool,bool,uint64))", chain.AGENT, WARRANT)
    owner("setBudget(agent, 1,000 dUSD)", g, "setBudget(address,uint256)", chain.AGENT, 1_000_000_000)
    for _ in range(30):  # the sentinel resets on Unfrozen; wait until it has
        if not chain.call(chain.DEPLOY["sentinel"], "freezeRequested(address)(bool)", chain.AGENT, rpc=chain.L_RPC)[0]:
            break
        time.sleep(5)
    emit("ops", "status " + json.dumps(chain.status()))


def draw_after_freeze():
    for _ in range(4):  # public RPCs drop the odd TLS handshake; only a revert counts as an answer
        try:
            chain._run(["call", "--rpc-url", chain.S_RPC, "--from", chain.AGENT, chain.DEPLOY["guardian"],
                        "draw(uint256)", "1000000"])
            return emit("ops", "agent tries draw(1 dUSD) after the freeze: succeeded (unexpected)")
        except RuntimeError as e:
            if "revert" in str(e):
                why = "AgentFrozen(agent)" if "9952a16e" in str(e) else str(e)[-120:]
                return emit("ops", "agent tries draw(1 dUSD) after the freeze: reverted " + why)
            time.sleep(3)
    emit("ops", "agent tries draw(1 dUSD) after the freeze: RPC unavailable")


def agent(scenario):
    p = subprocess.Popen([sys.executable, "-u", str(ROOT / "agent" / "agent.py"), scenario], cwd=ROOT, env=ENV,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8")
    pump(p, "agent")
    p.wait()


def main():
    watch = subprocess.Popen([sys.executable, "-u", str(ROOT / "agent" / "watch.py")], cwd=ROOT, env=ENV,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8")
    q = queue.Queue()
    threading.Thread(target=pump, args=(watch, "watch", q), daemon=True).start()
    try:
        mark("setup")
        regrant()

        mark("honest")
        agent("honest")
        wait_for(q, "trade covered")

        mark("compromised")
        agent("compromised")
        wait_for(q, "guardian: FROZEN")
        time.sleep(3)
        draw_after_freeze()

        mark("regrant")
        regrant()

        mark("fail")
        agent("fail")
        wait_for(q, "sentinel: disclosure")

        mark("leaked")
        agent("leaked")
        wait_for(q, "guardian: FROZEN")
        time.sleep(3)
        emit("ops", "status " + json.dumps(chain.status()))
        mark("end")
    finally:
        watch.terminate()
        (OUT / "recording.json").write_text(json.dumps(EVENTS, indent=1), encoding="utf-8")
        print(f"-> {OUT / 'recording.json'}  ({len(EVENTS)} events)")


if __name__ == "__main__":
    if sys.argv[1:] == ["--draw-check"]:  # append the post-freeze draw check to an existing recording
        EVENTS[:] = json.loads((OUT / "recording.json").read_text(encoding="utf-8"))
        draw_after_freeze()
        (OUT / "recording.json").write_text(json.dumps(EVENTS, indent=1), encoding="utf-8")
    else:
        main()
