#!/usr/bin/env python3
"""Drive the Even Hub simulator's headless control plane and capture HUD screenshots.

Usage:  python3 scripts/sim.py shot NAME          # save docs/screenshots/NAME.png
        python3 scripts/sim.py input ACTION       # up|down|click|double_click|long_press|long_press_release|context_menu
        python3 scripts/sim.py console            # print app console
        python3 scripts/sim.py tour               # full demo tour -> docs/screenshots/*.png
Needs: simulator started with --automation-port 9898, Pillow.
"""
import io, json, sys, time, os
from urllib.request import Request, urlopen
from PIL import Image

BASE = os.environ.get("SIM", "http://127.0.0.1:9898")
API = os.environ.get("API", "http://127.0.0.1:8787")
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots")


def get(path, base=BASE):
    with urlopen(base + path) as r:
        return r.read()


def post(path, body, base=BASE):
    req = Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(req) as r:
        return r.read()


def act(action, wait=1.2):
    post("/api/input", {"action": action})
    time.sleep(wait)


def shot(name):
    """Glasses framebuffer is RGBA (lit = alpha>0). Composite on black so it reads like the real display."""
    img = Image.open(io.BytesIO(get("/api/screenshot/glasses"))).convert("RGBA")
    lit = sum(1 for p in img.getdata() if p[3] > 0)
    bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
    bg.alpha_composite(img)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.abspath(os.path.join(OUT, f"{name}.png"))
    bg.convert("RGB").save(path)
    print(f"{path}  lit_pixels={lit}")
    assert lit > 200, f"{name}: framebuffer looks blank"
    return path


def console():
    for e in json.loads(get("/api/console"))["entries"]:
        if "ShadowTimers" in e["message"] or "Flutter Bridge" in e["message"]:
            continue
        print(e["level"], e["message"][:300])


def command(text, card="markets"):
    """Same path as push-to-talk after transcription (POST /api/intent), shown via the phone command box."""
    return json.loads(post("/api/intent", {"text": text, "card": card}, base=API))


def execute(action):
    return json.loads(post("/api/execute", {"action": action}, base=API))


def seed():
    """Arm a few alerts and open a paper position so every card has something to show."""
    snap = json.loads(get("/api/snapshot?coin=BTC", base=API))
    print(execute({"type": "alert", "coin": "BTC", "kind": "price_above", "pct": 3}))
    print(execute({"type": "alert", "coin": "ETH", "kind": "price_below", "pct": -4}))
    print(execute({"type": "alert", "coin": "HYPE", "kind": "funding_apr_above", "value": 25}))
    print(execute({"type": "order", "coin": "ETH", "side": "LONG", "notionalUsd": 250}))
    print(execute({"type": "bet", "side": "YES", "stakeUsd": 20}))
    # an alert that is already true fires on the next watcher tick (<=10 s) -> shows as "hit" + Telegram push
    mid = float(snap["cards"]["markets"]["body"].split("\n")[1].replace("$", "").replace(",", ""))
    print(execute({"type": "alert", "coin": "BTC", "kind": "price_below", "value": round(mid * 1.01)}))
    time.sleep(11)


FRAMES = []


def frame(name, caption):
    FRAMES.append((shot(name), caption))


def voice(name, caption, hold=4.0):
    """Push-to-talk: long press, speak (demoMic replays a clip), release."""
    post("/api/input", {"action": "long_press"})
    time.sleep(1.6)
    frame(f"{name}-listening", "Hold = push-to-talk (live mic level)")
    time.sleep(hold - 1.6)
    post("/api/input", {"action": "long_press_release"})
    time.sleep(3.2)  # local Whisper small.en takes ~1 s on CPU
    frame(name, caption)


def tour():
    seed()
    time.sleep(6)  # let the 5 s poll pick up the seeded state
    frame("01-markets", "Glance: live Hyperliquid price, 24h chart, funding")
    caps = ["Hyperliquid account + Trust Wallet balances (read-only)", "Funding extremes across liquid perps",
            "Polymarket odds laddered around the live price", "Alerts watched 24/7, pushed to Telegram", "Telegram crypto mentions + live context"]
    for n, c in zip(["02-positions", "03-funding", "04-odds", "05-alerts", "06-telegram"], caps):
        act("down")
        frame(n, c)
    act("click", 2.0)
    frame("07-telegram-actions", "Tap: one-tap replies drafted with live data")
    act("click", 2.0)
    frame("08-telegram-confirm", "Nothing is sent until you confirm")
    act("click", 2.5)
    frame("09-telegram-sent", "Tap: reply sent to the Telegram group")
    act("down", 1.5)  # wrap to markets
    voice("10-voice-alert", '"Alert bitcoin above 60k" -> armed instantly')
    time.sleep(2.0)
    act("up", 1.0); act("up", 1.0); act("up", 1.0); act("up", 1.5)  # alerts -> markets
    voice("11-voice-long", '"Long ETH 200 dollars" -> paper order, confirm')
    act("click", 3.0)
    frame("12-paper-filled", "Tap: paper fill at Hyperliquid mid, PnL tracked")
    act("down", 1.0); act("down", 1.5)  # positions -> funding -> odds
    voice("13-voice-bet", '"Bet yes 20" on the Polymarket strike nearest spot')
    act("double_click", 1.5)
    frame("14-cancelled", "Double-tap: cancel. Back to the card")
    act("down", 1.0); act("down", 1.5)  # odds -> alerts -> telegram
    voice("15-voice-reply", "Dictate a Telegram reply, confirm with one tap", hold=6.6)
    act("click", 2.5)
    frame("16-reply-sent", "Sent from the glasses, phone stays in your pocket")
    act("context_menu", 1.5)
    frame("17-context-menu", "Tap + hold: G2 contextual menu shortcuts")
    act("context_menu", 1.0)
    gif()


def gif():
    """Animated README preview: each framebuffer on a dark bezel with a caption."""
    from PIL import ImageDraw, ImageFont
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 18)
    except OSError:
        font = ImageFont.load_default()
    out = []
    for path, cap in FRAMES:
        if "listening" in path and len(out) and "listening" in FRAMES[len(out) - 1][0]:
            pass
        im = Image.open(path).convert("RGB")
        canvas = Image.new("RGB", (616, 360), (18, 18, 18))
        d = ImageDraw.Draw(canvas)
        d.rounded_rectangle((8, 8, 608, 312), radius=14, outline=(60, 60, 60), width=2)
        canvas.paste(im, (20, 20))
        d.text((20, 324), cap, fill=(200, 200, 200), font=font)
        out.append(canvas)
    path = os.path.abspath(os.path.join(OUT, "..", "demo.gif"))
    out[0].save(path, save_all=True, append_images=out[1:], duration=2200, loop=0, optimize=True)
    print("gif:", path)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "tour"
    if cmd == "shot":
        shot(sys.argv[2])
    elif cmd == "input":
        act(sys.argv[2])
    elif cmd == "console":
        console()
    else:
        tour()
