"""Thin wrapper over Foundry's `cast` for the agent and the watcher. Keys come from .env and are
never printed. Stdlib only."""
import json
import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
CAST = str(pathlib.Path.home() / ".foundry" / "bin" / ("cast.exe" if os.name == "nt" else "cast"))

WARRANT_T = "(uint64,uint16,uint16,uint16,bool,bool,bool,uint64)"
FIELDS = ["maxUsdPerTradeCents", "maxSlippageBps", "maxPriceImpactBps", "maxFeeBps",
          "allowCrossChain", "allowNewApproval", "recipientMustBeSelf", "expiresAt"]


def load_env():
    env = {}
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    for k in ("SEPOLIA_RPC", "LASNA_RPC", "DEEPSEEK_API_KEY", "DEPLOYMENTS"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


ENV = load_env()
DEPLOY = json.loads((ROOT / ENV.get("DEPLOYMENTS", "deployments/sepolia.json")).read_text())
S_RPC = ENV.get("SEPOLIA_RPC", "https://ethereum-sepolia-rpc.publicnode.com")
L_RPC = ENV.get("LASNA_RPC", "https://lasna-rpc.rnk.dev/")
AGENT = ENV["AGENT_ADDRESS"]


def _env():
    e = dict(os.environ)
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        e.pop(k, None)
    return e


def _run(args):
    r = subprocess.run([CAST, *args], capture_output=True, text=True, env=_env())
    if r.returncode != 0:
        # cast puts the revert reason on stderr; keys are passed as args, never echoed back by cast
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "cast failed")
    return r.stdout


def call(to, sig, *args, rpc=None):
    return json.loads(_run(["call", "--json", "--rpc-url", rpc or S_RPC, to, sig, *map(str, args)]))


def send(to, sig, *args, rpc=None, key="AGENT_PRIVATE_KEY"):
    out = json.loads(_run(["send", "--json", "--rpc-url", rpc or S_RPC, "--private-key", ENV[key],
                           to, sig, *map(str, args)]))
    return {"tx": out["transactionHash"], "ok": out["status"] == "0x1", "block": int(out["blockNumber"], 16)}


def keccak(text):
    return _run(["keccak", text]).strip()


def warrant():
    w, version, active = call(DEPLOY["registry"], f"getWarrant(address,address)({WARRANT_T},uint32,bool)",
                              DEPLOY["guardian"], AGENT)
    return dict(zip(FIELDS, w)), int(version), bool(active)


def status():
    w, version, active = warrant()
    dusd = DEPLOY["dusd"]
    return {
        "agent": AGENT,
        "warrant_active": active,
        "warrant_version": version,
        "budget_dusd": int(call(DEPLOY["guardian"], "budget(address)(uint256)", AGENT)[0]) / 1e6,
        "frozen": bool(call(DEPLOY["guardian"], "frozen(address)(bool)", AGENT)[0]),
        "wallet_dusd": int(call(dusd, "balanceOf(address)(uint256)", AGENT)[0]) / 1e6,
    }
