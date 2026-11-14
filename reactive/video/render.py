"""Render the demo video from video/out/recording.json (made by record.py).

    python video/render.py            -> video/out/warrant-guardian.mp4

No screen capture: every agent and chain line on screen is a line from the recording. Narration is Windows
SAPI (Microsoft Zira); captions are the narration text. Long waits are compressed; the times printed on the
chain lines are block timestamps, so the real latency stays readable.
"""
import calendar
import datetime
import json
import pathlib
import re
import subprocess
import sys
import wave

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "video" / "out"
FR = OUT / "frames"
W, H = 1920, 1080
FONTS = pathlib.Path("C:/Windows/Fonts")
MONO = ImageFont.truetype(str(FONTS / "consola.ttf"), 21)
MONO_B = ImageFont.truetype(str(FONTS / "consolab.ttf"), 21)
UI = lambda n, b=False: ImageFont.truetype(str(FONTS / ("segoeuib.ttf" if b else "segoeui.ttf")), n)  # noqa: E731

BG, PANEL, EDGE = "#0d1117", "#161b22", "#30363d"
FG, DIM, ACC = "#c9d1d9", "#8b949e", "#58a6ff"
GREEN, YELLOW, RED, PURPLE, CYAN = "#3fb950", "#e3b341", "#f85149", "#bc8cff", "#56d4dd"

NARRATION = {
    "title": "Warrant Guardian. When an AI agent trades for you without disclosing, it loses its funding, "
             "automatically. Built on Reactive Network.",
    "problem": "Warrant gives an AI trading agent an on-chain mandate, and the agent records a preflight disclosure "
               "before each trade: pass, warn, or fail. But Warrant only reveals. If the agent skips the disclosure, "
               "or trades after a fail, nothing happens until someone audits it. And nothing can intercept a trade "
               "from the agent's own wallet.",
    "design": "So the consequence moves to the funding. The agent draws its money from a guardian contract on "
              "Sepolia. A reactive contract on Reactive Network watches the agent's disclosures, and every transfer "
              "out of its wallet. Each trade needs one unused pass or warn disclosure. If there is none, the sentinel "
              "calls back to the guardian, which zeroes the budget and revokes the warrant.",
    "honest": "This is a live run on testnet. The owner grants a warrant and a budget of one thousand dollars. "
              "A DeepSeek agent buys two hundred dollars of ETH. It runs preflight, which puts a pass on chain, "
              "then draws and trades. About a second after the trade, the sentinel marks it covered.",
    "compromised": "Now the agent is compromised: an attacker replaced its prompt and removed the preflight tool. "
                   "It draws and trades without disclosing. The sentinel flags the violation and calls back. "
                   "Twelve seconds after the trade, the guardian has frozen the agent.",
    "leaked": "The owner lifts the freeze and grants a new warrant. This quote breaks the slippage limit. The agent "
              "discloses fail, and declines to trade. But its key has leaked. Whoever holds it draws, and sends the "
              "money away. The sentinel sees a trade after a fail. Twelve seconds later the agent is frozen again, "
              "and any further draw reverts.",
    "limits": "One finding. In our runs, DeepSeek kept running preflight through a prompt injection and a replaced "
              "system prompt. The model was not the weak point; the plumbing around it was. Limits: detection comes "
              "after the trade, so losses are capped at what the agent already drew. Amounts are not bound to "
              "disclosures. And a failed callback is not retried yet.",
    "end": "Contracts, code, and every transaction hash are in the repository. Thank you.",
}
LIVE = {"honest": ("setup", "honest"), "compromised": ("compromised",), "leaked": ("regrant", "fail", "leaked", "end")}
TITLES = {"honest": "1  Disclosed trade", "compromised": "2  Compromised agent: no disclosure",
          "leaked": "3  FAIL disclosed, leaked key trades anyway"}


# ------------------------------------------------------------------ narration
def tts(name, text):
    wav = OUT / "audio" / f"{name}.wav"
    wav.parent.mkdir(parents=True, exist_ok=True)
    if not wav.exists():
        txt = OUT / "audio" / f"{name}.txt"
        txt.write_text(text, encoding="utf-8")
        ps = ("Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
              "$s.SelectVoice('Microsoft Zira Desktop'); $s.Rate = 1; "
              f"$s.SetOutputToWaveFile('{wav}'); $s.Speak([IO.File]::ReadAllText('{txt}')); $s.Dispose()")
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    with wave.open(str(wav)) as w:
        return wav, w.getnframes() / w.getframerate()


def sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.:])\s+", text) if s.strip()]


# ------------------------------------------------------------------ recording -> display lines
def short(s):
    return re.sub(r"0x([0-9a-fA-F]{6})[0-9a-fA-F]{20,}([0-9a-fA-F]{4})", r"0x\1…\2", s)


def chain_line(text):
    m = re.match(r"(\d\d:\d\d:\d\d)Z\s+(\w+)\s+(.+?)\s{2,}(.*)$", text)
    if not m:
        return None
    t, ch, label, rest = m.groups()
    ch = "Sepolia" if ch == "sepolia" else "Lasna  "
    rest = short(rest).replace("origin tx", "trade").strip()
    if label.startswith("transfer"):
        if "-> agent" in rest:
            return None  # the guardian->agent leg of a draw; "guardian: drawn" already says it
        rest = rest.replace("0xe7450f…6d56", "venue").replace("0x8af987…d678", "attacker")
        return (t, f"{t} {ch} trade        {rest}", FG)
    color = {"disclosed": CYAN, "sentinel: disclosure": CYAN, "sentinel: trade covered": GREEN,
             "sentinel: VIOLATION -> callback": RED, "guardian: FROZEN": RED, "guardian: drawn": DIM,
             "guardian: unfrozen": YELLOW, "sentinel: reset": YELLOW}.get(label, FG)
    label = {"disclosed": "disclosure", "sentinel: disclosure": "sentinel saw", "sentinel: trade covered": "COVERED",
             "sentinel: VIOLATION -> callback": "VIOLATION → callback", "guardian: FROZEN": "FROZEN",
             "guardian: drawn": "draw", "guardian: unfrozen": "unfreeze", "sentinel: reset": "sentinel reset"}.get(label, label)
    rest = rest.replace("warrant revoked True", "warrant revoked")
    return (t, f"{t} {ch} {label:<12} {rest}".rstrip(), color)


def agent_line(text):
    s = text.rstrip()
    if not s.strip() or s.startswith(("log:", "status:", "[")) or re.match(r"^\|?-+\|", s.strip()):
        return None
    if s.startswith("     {") or s.startswith("     \""):
        v = re.search(r'"verdict": "(\w+)"', s)
        tx = re.search(r'"tx": "(0x[0-9a-f]+)"', s)
        if v:
            return (f"     verdict {v.group(1)}  (disclosed on chain)", {"PASS": GREEN, "FAIL": RED}.get(v.group(1), YELLOW))
        if tx:
            return (f"     ok  tx {short(tx.group(1))}", DIM)
        return None
    s = s.replace("**", "").replace("`", "").replace("\u2014", "-").replace("\ufffd", "…")
    if s.lstrip().startswith("->"):
        if "draw_funds:" in s or "transfer:" in s:  # leaked-key script
            tx = re.search(r'"tx": "(0x[0-9a-f]+)"', s)
            name = "draw_funds(150)" if "draw_funds" in s else "dUSD.transfer(attacker, 150)"
            return (f"  -> {name}   tx {short(tx.group(1)) if tx else ''}", PURPLE)
        return ("  " + short(s.strip()), ACC)
    if s.startswith("agent> "):
        return (s[len("agent> "):], FG)
    return (s.strip(), FG)


def load():
    ev = json.loads((OUT / "recording.json").read_text(encoding="utf-8"))
    scenes, cur = {}, None
    for e in ev:
        if e["source"] == "mark":
            cur = e["text"]
            continue
        scenes.setdefault(cur, []).append(e)
    # the post-freeze draw check was appended after "end": it belongs to the last scene
    return scenes


def live_items(scenes, marks):
    items = []  # (wall time, pane, text, color)
    for mk in marks:
        for e in scenes.get(mk, []):
            if e["source"] == "watch":
                c = chain_line(e["text"])
                if c:
                    day = datetime.datetime.fromtimestamp(e["t"], datetime.timezone.utc).date()
                    hh, mm, ss = map(int, c[0].split(":"))
                    bt = calendar.timegm((day.year, day.month, day.day, hh, mm, ss)) + 0.5
                    if " Lasna " in c[1]:
                        bt += 1.5  # a reaction: never shown before its cause (the two chains' clocks differ by ~1 s)
                    items.append((min(bt, e["t"]), "chain", c[1], c[2]))
            elif e["source"] == "agent":
                if e["text"].startswith("[") and "model=" in e["text"]:
                    items.append((e["t"], "agent", "$ python agent/agent.py " + e["text"][1:].split("]")[0], DIM))
                    continue
                if e["text"].startswith("[leaked]"):
                    items.append((e["t"], "agent", "$ python agent/agent.py leaked   # no model: a script holding the agent's key", DIM))
                    continue
                a = agent_line(e["text"])
                if a:
                    items.append((e["t"], "agent", a[0], a[1]))
            elif e["source"] == "ops":
                t = e["text"]
                if t.startswith("status "):
                    items.append((e["t"], "status", json.loads(t[7:]), None))
                elif t.startswith("owner:"):
                    items.append((e["t"], "agent", "owner  " + t[7:] + (f"   tx {short(e['tx'])}" if e.get("tx") else ""), YELLOW))
                elif "after the freeze" in t:
                    items.append((e["t"], "agent", t.replace("agent tries ", "agent: "), RED))
                elif "timed out" not in t:
                    items.append((e["t"], "agent", t, DIM))
    # same block second: the Sepolia event (the cause) before the Lasna reaction
    items.sort(key=lambda x: (x[0], 1 if x[1] == "chain" and " Lasna " in x[2] else 0))
    return items


# ------------------------------------------------------------------ drawing
def wrap(text, font, width):
    out, line = [], ""
    for word in text.split(" "):
        trial = (line + " " + word) if line else word
        if font.getlength(trial) <= width:
            line = trial
        else:
            if line:
                out.append(line)
            while font.getlength(word) > width:  # hard-break very long tokens
                k = len(word)
                while k > 1 and font.getlength(word[:k]) > width:
                    k -= 1
                out.append(word[:k])
                word = word[k:]
            line = word
    out.append(line)
    return out


def caption(d, text):
    if not text:
        return
    f = UI(30)
    lines = wrap(text, f, W - 360)
    y = H - 40 - 42 * len(lines)
    d.rounded_rectangle([160, y - 14, W - 160, H - 26], 12, fill="#000000c8")
    for i, ln in enumerate(lines):
        d.text((W / 2, y + i * 42), ln, font=f, fill="#ffffff", anchor="ma")


def header(d, title, sub=""):
    d.rectangle([0, 0, W, 64], fill=PANEL)
    d.text((32, 32), "Warrant Guardian", font=UI(26, True), fill=FG, anchor="lm")
    d.text((290, 32), title, font=UI(26), fill=ACC, anchor="lm")
    if sub:
        d.text((W - 32, 32), sub, font=UI(20), fill=DIM, anchor="rm")


def base():
    im = Image.new("RGB", (W, H), BG)
    return im, ImageDraw.Draw(im, "RGBA")


def pane(d, box, title, rows, max_rows):
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, 10, fill=PANEL, outline=EDGE)
    d.text((x0 + 18, y0 + 14), title, font=UI(20, True), fill=DIM)
    y = y0 + 52
    for text, color, bold in rows[-max_rows:]:
        d.text((x0 + 18, y), text, font=MONO_B if bold else MONO, fill=color)
        y += 27


def status_bar(d, st, banner):
    y = 860
    d.rounded_rectangle([40, y, W - 40, y + 56], 10, fill=PANEL, outline=EDGE)
    if st:
        frozen = st.get("frozen")
        parts = [("guardian", DIM), (f"warrant v{st['warrant_version']} " + ("active" if st["warrant_active"] else "REVOKED"),
                                     GREEN if st["warrant_active"] else RED),
                 (f"budget {st['budget_dusd']:,.0f} dUSD", FG), ("FROZEN" if frozen else "not frozen", RED if frozen else GREEN)]
        x = 64
        for t, c in parts:
            d.text((x, y + 28), t, font=UI(24, True), fill=c, anchor="lm")
            x += UI(24, True).getlength(t) + 48
    if banner:
        d.text((W - 64, y + 28), banner, font=UI(24, True), fill=RED, anchor="rm")


# ------------------------------------------------------------------ scenes
def static_frames(name, dur):
    """Yield (image, seconds) for non-live scenes."""
    caps = sentences(NARRATION[name])
    total = sum(len(c) for c in caps)
    for c in caps:
        im, d = base()
        if name == "title":
            d.text((W / 2, 380), "Warrant Guardian", font=UI(96, True), fill=FG, anchor="mm")
            d.text((W / 2, 480), "An AI agent that trades without disclosing loses its funding, automatically.",
                   font=UI(36), fill=ACC, anchor="mm")
            d.text((W / 2, 560), "Reactive Omni Buildathon · Track 3: Reactive Meets AI",
                   font=UI(28), fill=DIM, anchor="mm")
            d.text((W / 2, 610), "Ethereum Sepolia  +  Reactive Lasna  ·  agent model: DeepSeek",
                   font=UI(28), fill=DIM, anchor="mm")
        elif name == "problem":
            header(d, "The gap")
            pts = [("Warrant (prior work)", "an on-chain, revocable mandate for an AI trading agent"),
                   ("Preflight disclosure", "before each trade the agent records PASS / WARN / FAIL on chain"),
                   ("But it only reveals", "skip the disclosure, or trade after FAIL: nothing happens until an audit"),
                   ("And nothing can intercept", "the agent trades from its own wallet with ordinary tools")]
            for i, (a, b) in enumerate(pts):
                y = 200 + i * 140
                d.text((160, y), a, font=UI(44, True), fill=RED if i >= 2 else FG)
                d.text((160, y + 62), b, font=UI(30), fill=DIM)
        elif name == "design":
            header(d, "Consequences without interception")
            draw_design(d)
        elif name == "limits":
            header(d, "Finding and limits")
            d.text((140, 150), "Finding (one run per variant, not a rate)", font=UI(36, True), fill=GREEN)
            for i, t in enumerate(["DeepSeek ran preflight through an injected venue note, an appended override",
                                   "and a fully replaced system prompt, and refused a FAIL quote.",
                                   "The model was not the weak point; the plumbing around it was."]):
                d.text((140, 210 + i * 46), t, font=UI(30), fill=FG)
            d.text((140, 400), "Limits", font=UI(36, True), fill=YELLOW)
            for i, t in enumerate(["Detection is after the trade: losses are capped at what the agent already drew.",
                                   "Amounts are not bound to disclosures; the budget caps size.",
                                   "Disclosures must be mined before the trade they cover.",
                                   "A failed callback is not retried yet (it happened once, on gas)."]):
                d.text((140, 460 + i * 46), "·  " + t, font=UI(30), fill=FG)
        elif name == "end":
            d.text((W / 2, 400), "github.com/Beltran12138/warrant", font=UI(56, True), fill=FG, anchor="mm")
            d.text((W / 2, 480), "reactive/  ·  contracts, agent, watcher, tests, every tx hash", font=UI(32),
                   fill=DIM, anchor="mm")
            d.text((W / 2, 560), "Guardian 0x1cFb…9Ba2 (Sepolia)   ·   Sentinel 0xF668…0781 (Lasna)",
                   font=UI(28), fill=DIM, anchor="mm")
        caption(d, c)
        yield im, dur * len(c) / total


def box(d, xy, title, lines, color):
    d.rounded_rectangle(xy, 14, fill=PANEL, outline=color, width=3)
    x0, y0 = xy[0], xy[1]
    d.text((x0 + 22, y0 + 18), title, font=UI(28, True), fill=color)
    for i, ln in enumerate(lines):
        d.text((x0 + 22, y0 + 62 + i * 34), ln, font=UI(23), fill=FG)


def arrow(d, a, b, color, label="", up=0):
    d.line([a, b], fill=color, width=4)
    import math
    ang = math.atan2(b[1] - a[1], b[0] - a[0])
    for s in (2.6, -2.6):
        d.line([b, (b[0] + 18 * math.cos(ang + s), b[1] + 18 * math.sin(ang + s))], fill=color, width=4)
    if label:
        d.text(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 22 - up), label, font=UI(21), fill=color, anchor="mm")


def draw_design(d):
    d.text((80, 110), "Ethereum Sepolia (origin + destination)", font=UI(26, True), fill=DIM)
    d.text((1300, 110), "Reactive Lasna", font=UI(26, True), fill=DIM)
    box(d, (80, 160, 560, 380), "AI agent wallet", ["DeepSeek, ordinary tools", "draw · preflight · trade"], ACC)
    box(d, (80, 470, 560, 720), "WarrantGuardian", ["holds the funds, is the principal", "draw() needs warrant + budget",
                                                    "freeze(): budget → 0, revoke"], YELLOW)
    box(d, (720, 160, 1160, 380), "WarrantRegistry · dUSD", ["PreflightAttested (disclosure)", "Transfer (trade)",
                                                             "WarrantSet"], CYAN)
    box(d, (1300, 300, 1840, 600), "WarrantSentinel", ["subscribes to all of the left", "1 PASS/WARN covers 1 trade",
                                                       "none, or after FAIL:", "requestCallback(freeze)"], PURPLE)
    arrow(d, (560, 270), (720, 270), ACC, "disclose, trade")
    arrow(d, (320, 470), (320, 380), DIM, "draw", up=-30)
    arrow(d, (1160, 270), (1300, 380), CYAN, "events")
    arrow(d, (1300, 520), (560, 600), RED, "callback via proxy: freeze(agent)")
    d.text((80, 780), "Rule: every outflow from the agent's wallet needs one unused PASS/WARN disclosure in front of it.",
           font=UI(28, True), fill=FG)


CARRY = {}


def live_frames(name, dur, scenes):
    items = live_items(scenes, LIVE[name])
    caps = sentences(NARRATION[name])
    # reveal schedule: wall-clock order, long waits compressed, then stretched to fit the narration
    gaps, last = [], items[0][0] if items else 0
    for it in items:
        gaps.append(min(max(it[0] - last, 0.12), 1.6))
        last = it[0]
    span = dur - 1.2
    scale = span / max(sum(gaps), 1e-6)
    times, acc = [], 0.4
    for g in gaps:
        acc += g * scale
        times.append(min(acc, dur - 0.6))
    # caption schedule
    ctimes, acc, total = [], 0.0, sum(len(c) for c in caps)
    for c in caps:
        ctimes.append(acc)
        acc += dur * len(c) / total
    cuts = sorted(set([0.0] + times + ctimes + [dur]))
    agent_rows, chain_rows, st, banner = [], [], CARRY.get("st"), ""
    trade_t = None
    shown = 0
    for i in range(len(cuts) - 1):
        t0, t1 = cuts[i], cuts[i + 1]
        while shown < len(items) and times[shown] <= t0 + 1e-6:
            _, where, text, color = items[shown]
            if where == "status":
                st = text
            elif where == "chain":
                chain_rows += [(ln, color, color == RED) for ln in wrap(text, MONO, 880)]
                if "trade" in text.split()[2:3] and ("venue" in text or "attacker" in text):
                    trade_t = text[:8]
                if " FROZEN " in text:
                    st = dict(st or {}, frozen=True, warrant_active=False, budget_dusd=0.0,
                              warrant_version=(st or {}).get("warrant_version", 0) + 1)
                    if trade_t:
                        h1, m1, s1 = map(int, trade_t.split(":"))
                        h2, m2, s2 = map(int, text[:8].split(":"))
                        banner = f"frozen {(h2 * 3600 + m2 * 60 + s2) - (h1 * 3600 + m1 * 60 + s1)} s after the trade"
                if "unfreeze" in text:
                    banner = ""
            else:
                agent_rows += [(ln, color, False) for ln in wrap(text, MONO, 820)]
            shown += 1
        cap = caps[max(j for j, c in enumerate(ctimes) if c <= t0 + 1e-6)]
        im, d = base()
        header(d, TITLES[name], "live · Ethereum Sepolia 11155111 + Reactive Lasna 5318007")
        pane(d, (40, 84, 900, 840), "Agent and owner (terminal)", agent_rows, 25)
        pane(d, (920, 84, W - 40, 840), "On chain (block time, UTC)", chain_rows, 25)
        status_bar(d, st, banner)
        caption(d, cap)
        CARRY["st"] = st
        yield im, t1 - t0


# ------------------------------------------------------------------ main
def main():
    scenes = load()
    if "end" in scenes:  # post-freeze draw check, recorded after the last mark
        scenes["leaked"] = scenes.get("leaked", []) + scenes.pop("end")
    FR.mkdir(parents=True, exist_ok=True)
    order = ["title", "problem", "design", "honest", "compromised", "leaked", "limits", "end"]
    frames, audio = [], []
    t = 0.0
    for name in order:
        wav, secs = tts(name, NARRATION[name])
        dur = secs + 0.9 + (2.0 if name == "leaked" else 0)  # hold the post-freeze revert on screen
        audio.append((wav, t))
        gen = live_frames(name, dur, scenes) if name in LIVE else static_frames(name, dur)
        for im, s in gen:
            if s <= 0.01:
                continue
            p = FR / f"f{len(frames):05d}.png"
            im.save(p)
            frames.append((p, s))
        t += dur
        print(f"{name:12} {dur:5.1f}s  (total {t:5.1f}s)", flush=True)
    lst = OUT / "frames.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\nduration {s:.3f}\n" for p, s in frames) +
                   f"file '{frames[-1][0].as_posix()}'\n", encoding="utf-8")
    inputs, filt = [], []
    for i, (wav, start) in enumerate(audio):
        inputs += ["-i", str(wav)]
        filt.append(f"[{i + 1}:a]adelay={int(start * 1000)}|{int(start * 1000)}[a{i}]")
    filt.append("".join(f"[a{i}]" for i in range(len(audio))) + f"amix=inputs={len(audio)}:normalize=0[aout]")
    out = OUT / "warrant-guardian.mp4"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                    *inputs, "-filter_complex", ";".join(filt), "-map", "0:v", "-map", "[aout]",
                    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-c:a", "aac", "-b:a", "160k", "-t", f"{t:.2f}", "-movflags", "+faststart", str(out)], check=True)
    print(f"-> {out}  {t:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
