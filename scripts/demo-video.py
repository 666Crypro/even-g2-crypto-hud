#!/usr/bin/env python3
"""Record a polished ~2-minute Heads-Up Desk demo from the Even Hub simulator.

Captures the live 576x288 framebuffer at 12 fps while driving the same gestures
as the SUBMISSION.md script, then composites a 1080p H.264 video with captions,
title/end cards, a simulated-mic badge, a stylized Telegram panel, and Piper narration.

    python3 scripts/demo-video.py            # record + compose
    python3 scripts/demo-video.py compose    # reuse /tmp/hud-demo/raw
"""
from __future__ import annotations

import io, json, os, shutil, subprocess, sys, threading, time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SIM = os.environ.get("SIM", "http://127.0.0.1:9898")
API = os.environ.get("API", "http://127.0.0.1:8787")
WORK = Path(os.environ.get("DEMO_WORK", "/tmp/hud-demo"))
RAW = WORK / "raw"
OUT_MP4 = ROOT / "docs" / "demo.mp4"
FPS = 12
W, H = 1920, 1080
HUD_SCALE = 2.5  # 1440x720; use 2.0 when the Telegram panel is on screen

# Visual segment lengths (seconds). Each is at least as long as its VO clip, with
# padding so the on-screen action can finish before the next line.
SEG = {
    "title": 8.3,      # VO 1 = 8.22s (title, then markets on the last sentence)
    "swipe": 22.0,     # VO 2 = 17.3s
    "telegram": 18.0,  # VO 3 = 10.9s
    "voice": 28.0,     # VO 4 = 10.0s — two spoken commands need wall time
    "bet": 16.0,       # VO 5 = 3.74s
    "alert": 15.0,     # VO 6 = 8.44s — wait for the server watcher
    "close": 12.0,     # VO 7 = 11.34s — menu, then end card
}

VO_DIR = Path("/tmp/piper/vo")
PIPER = "/tmp/piper/piper/piper"
VOICE = "/tmp/piper/en_US-lessac-medium.onnx"

# ---------- HTTP ----------
def _get(path: str, base: str = SIM, timeout: float = 8) -> bytes:
    with urlopen(base + path, timeout=timeout) as r:
        return r.read()

def _post(path: str, body: dict, base: str = SIM, timeout: float = 15) -> bytes:
    req = Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(req, timeout=timeout) as r:
        return r.read()

def act(action: str) -> None:
    _post("/api/input", {"action": action})

def execute(action: dict) -> dict:
    return json.loads(_post("/api/execute", {"action": action}, base=API))

def snapshot() -> dict:
    return json.loads(_get("/api/snapshot?coin=BTC", base=API))

def grab() -> Image.Image:
    img = Image.open(io.BytesIO(_get("/api/screenshot/glasses"))).convert("RGBA")
    bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
    bg.alpha_composite(img)
    return bg.convert("RGB")


# ---------- fonts ----------
def _font(path: str, size: int, weight: int | None = None) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(path, size)
    if weight is not None and hasattr(f, "set_variation_by_axes"):
        try:
            f.set_variation_by_axes([weight])
        except Exception:
            pass
    return f

INTER = "/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf"
def font(size: int, weight: int = 500) -> ImageFont.FreeTypeFont:
    try:
        return _font(INTER, size, weight)
    except Exception:
        path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if weight >= 600 else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
        return ImageFont.truetype(path, size)

# Static DejaVu for title/end cards so "Realities" and other words stay unambiguous.
def card_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    return ImageFont.truetype(path, size)


# ---------- recorder ----------
class Recorder:
    def __init__(self) -> None:
        self.caption = ""
        self.kicker = ""
        self.badge = ""
        self.panel: dict | None = None
        self.running = False
        self.n = 0
        self._thr: threading.Thread | None = None
        self.lock = threading.Lock()

    def set(self, **kw) -> None:
        with self.lock:
            for k, v in kw.items():
                setattr(self, k, v)

    def snapshot_ui(self) -> tuple[str, str, str, dict | None]:
        with self.lock:
            return self.caption, self.kicker, self.badge, dict(self.panel) if self.panel else None

    def start(self) -> None:
        RAW.mkdir(parents=True, exist_ok=True)
        self.running = True
        self.n = 0
        self._thr = threading.Thread(target=self._loop, daemon=True)
        self._thr.start()

    def _loop(self) -> None:
        interval = 1.0 / FPS
        while self.running:
            t0 = time.time()
            try:
                img = grab()
            except Exception as e:
                print("grab failed:", e)
                time.sleep(0.05)
                continue
            cap, kick, badge, panel = self.snapshot_ui()
            i = self.n
            self.n += 1
            img.save(RAW / f"{i:05d}.png", optimize=False)
            (RAW / f"{i:05d}.json").write_text(json.dumps({"caption": cap, "kicker": kick, "badge": badge, "panel": panel}))
            dt = time.time() - t0
            if dt < interval:
                time.sleep(interval - dt)

    def stop(self) -> int:
        self.running = False
        if self._thr:
            self._thr.join(timeout=5)
        print(f"recorded {self.n} frames ({self.n / FPS:.1f}s)")
        return self.n


REC = Recorder()

def hold(seconds: float) -> None:
    time.sleep(seconds)

def seed() -> None:
    """Populate cards without firing the in-the-money alert (that's armed mid-video)."""
    print(execute({"type": "alert", "coin": "BTC", "kind": "price_above", "pct": 3}))
    print(execute({"type": "alert", "coin": "ETH", "kind": "price_below", "pct": -4}))
    print(execute({"type": "alert", "coin": "HYPE", "kind": "funding_apr_above", "value": 25}))
    print(execute({"type": "order", "coin": "ETH", "side": "LONG", "notionalUsd": 250}))
    print(execute({"type": "bet", "side": "YES", "stakeUsd": 20}))
    hold(6.5)  # 5s poll picks this up


# ---------- tour (wall-clock, roughly matching SEG durations) ----------
def tour() -> None:
    # -- title card is composed later; we still record the live Markets card so
    #    it can fade in under the last sentence of VO 1.
    REC.set(kicker="MARKETS", caption="Live Hyperliquid price, 24h chart, and funding — at a glance.", badge="", panel=None)
    hold(SEG["title"])

    # -- swipe through the other five cards (~4.4s each)
    REC.set(kicker="SWIPE TO GLANCE", caption="Swipe to glance: live Hyperliquid price and chart.")
    cards = [
        ("POSITIONS", "My Hyperliquid positions and Trust Wallet balances, read-only."),
        ("FUNDING", "Who's paying funding across liquid perps."),
        ("ODDS", "Polymarket odds for tomorrow's close, laddered around the live price."),
        ("ALERTS", "Alerts watched 24/7 and pushed to Telegram."),
        ("TELEGRAM", "Crypto chatter from my Telegram groups, with live market context."),
    ]
    per = SEG["swipe"] / len(cards)
    for kick, cap in cards:
        act("down")
        REC.set(kicker=kick, caption=cap)
        hold(per)

    # -- Telegram one-tap reply
    REC.set(kicker="TELEGRAM", caption="Someone asks about ETH. The glasses show live context.", badge="", panel=None)
    hold(1.4)
    act("click")  # open actions
    hold(2.0)
    REC.set(caption="The reply is already drafted from real data. One tap to pick it.")
    hold(2.2)
    act("click")  # first item -> confirm
    hold(3.0)
    REC.set(caption="One tap to confirm — and it's in the group.")
    act("click")  # confirm send
    hold(2.0)
    panel = telegram_panel_from_api(kind="reply")
    REC.set(panel=panel)
    hold(SEG["telegram"] - 1.4 - 2.0 - 2.2 - 3.0 - 2.0)

    # -- Voice: wrap to markets, alert, then paper long
    act("down")  # telegram -> markets
    hold(1.2)
    REC.set(
        kicker="VOICE",
        caption="Or just say it. Hold to talk, release, and it's armed.",
        badge="SIMULATED MIC INPUT",
        panel=None,
    )
    act("long_press")
    hold(4.6)  # clip 1 ≈ 3.5s PCM + meter
    act("long_press_release")
    hold(3.4)  # whisper + HEARD + auto-arm
    REC.set(caption="“Alert bitcoin above 60k” — armed. Orders stay paper or testnet.", badge="SIMULATED MIC INPUT")
    hold(2.0)
    REC.set(caption="Nothing happens until I tap to confirm.")
    act("long_press")
    hold(4.6)  # clip 2
    act("long_press_release")
    hold(3.4)
    REC.set(kicker="CONFIRM", caption="“Long ETH $200.” Paper order — tap to confirm.", badge="SIMULATED MIC INPUT")
    hold(2.0)
    act("click")
    hold(2.0)
    REC.set(kicker="POSITIONS", caption="Paper fill at the Hyperliquid mid. PnL tracked. Funds never leave your wallet.", badge="", panel=None)
    # remain on positions (execute navigates there); pad out the segment
    # elapsed so far ≈ 1.2+4.6+3.4+2+4.6+3.4+2+2 = 23.2; segment is 28s
    hold(max(0.4, SEG["voice"] - 23.2))

    # -- Polymarket bet + cancel. Arm the in-the-money alert now so it can fire in the next beat.
    snap = snapshot()
    try:
        mid = float(snap["cards"]["markets"]["body"].split("\n")[1].replace("$", "").replace(",", ""))
        print("arming in-the-money alert at", mid, execute({"type": "alert", "coin": "BTC", "kind": "price_below", "value": round(mid * 1.01)}))
    except Exception as e:
        print("could not arm alert:", e)

    act("down")  # positions -> funding
    hold(0.9)
    act("down")  # funding -> odds
    hold(1.1)
    REC.set(kicker="ODDS", caption="Same for a Polymarket bet.", badge="SIMULATED MIC INPUT", panel=None)
    act("long_press")
    hold(4.2)
    act("long_press_release")
    hold(3.2)
    REC.set(kicker="CONFIRM", caption="“Bet yes $20.” And a double-tap cancels.", badge="SIMULATED MIC INPUT")
    hold(2.4)
    act("double_click")
    hold(1.2)
    REC.set(kicker="ODDS", caption="Double-tap cancels. Back to the card — nothing was placed.", badge="", panel=None)
    hold(max(0.4, SEG["bet"] - 0.9 - 1.1 - 4.2 - 3.2 - 2.4 - 1.2))

    # -- Alert fires (watcher ≤10s from arm at start of this+previous leftover)
    REC.set(kicker="ALERTS", caption="Alerts run on the server 24/7, even when the G2 app is closed.", badge="", panel=None)
    # walk to the alerts card: odds -> alerts
    act("down")
    hold(1.0)
    # wait for the hit to show up in snapshot / toast
    panel = None
    deadline = time.time() + 12
    while time.time() < deadline:
        try:
            s = snapshot()
            hits = s.get("recentHits") or []
            sent = s.get("tgSent") or []
            if hits or (sent and "hit" in sent[0].get("text", "").lower()):
                panel = telegram_panel_from_api(kind="alert", snap=s)
                break
        except Exception:
            pass
        hold(0.6)
    REC.set(
        caption="G2 apps can't pop up in the background, so hits land in Telegram — one tap from Trust Wallet.",
        panel=panel or telegram_panel_from_api(kind="alert"),
        kicker="ALERT HIT",
    )
    hold(max(4.0, SEG["alert"] - 1.0 - 8.0))

    # -- contextual menu, then the composer will fade to the end card
    act("up")  # back toward a clean card if we want; stay on alerts is fine
    hold(0.4)
    REC.set(kicker="MENU", caption="Read at a glance, act with a tap or a phrase. Your funds are never at risk.", panel=None, badge="")
    act("context_menu")
    hold(5.0)
    # leave the rest of SEG["close"] for the end card (composed, not recorded)
    # we only need ~5s of menu footage; composer uses VO 7 over menu then end card


def telegram_panel_from_api(kind: str, snap: dict | None = None) -> dict:
    try:
        s = snap or snapshot()
    except Exception:
        s = {}
    sent = (s.get("tgSent") or [{}])
    text = (sent[0].get("text") if sent else None) or ""
    if kind == "alert":
        if not text or "hit" not in text.lower():
            # fall back to the most recent alert-shaped log line
            for row in s.get("log") or []:
                if "alert hit" in (row.get("text") or "").lower() or "hit" in (row.get("text") or "").lower():
                    text = row["text"]
                    break
            if not text:
                text = "BTC alert hit — opened in Telegram"
        return {
            "title": "Telegram",
            "subtitle": "Heads-Up Desk  ·  DM",
            "body": text.replace("🔔 ", ""),
            "buttons": ["Open in Trust Wallet", "Hyperliquid"],
            "kind": "alert",
        }
    if not text:
        text = "ETH 1,623 (−4.2% 24h), funding −3% APR. Watching."
    return {
        "title": "Telegram",
        "subtitle": "Alpha Desk  ·  group",
        "body": text,
        "buttons": [],
        "kind": "reply",
    }


# ---------- compose ----------
BG = (8, 10, 9)
GREEN = (57, 211, 83)
DIM = (160, 168, 160)
WHITE = (236, 240, 236)
MUTED = (120, 128, 120)
AMBER = (227, 179, 65)
PANEL_BG = (22, 24, 22)
BEZEL = (40, 48, 40)

def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return m

def upscale_hud(hud: Image.Image, scale: float = HUD_SCALE) -> Image.Image:
    tw, th = int(round(576 * scale)), int(round(288 * scale))
    if abs(scale - round(scale)) < 1e-6:
        return hud.resize((tw, th), Image.Resampling.NEAREST)
    hi = hud.resize((576 * 3, 288 * 3), Image.Resampling.NEAREST)
    return hi.resize((tw, th), Image.Resampling.LANCZOS)

def glow_behind(canvas: Image.Image, box: tuple[int, int, int, int], color=(20, 80, 28), radius=40) -> None:
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, y0, x1, y1 = box
    d.rounded_rectangle((x0 - 18, y0 - 18, x1 + 18, y1 + 18), radius=28, fill=color + (90,))
    layer = layer.filter(ImageFilter.GaussianBlur(radius))
    canvas.alpha_composite(layer)

def wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]

def paste_hud(canvas: Image.Image, hud: Image.Image, x: int, y: int, scale: float = HUD_SCALE) -> tuple[int, int, int, int]:
    disp = upscale_hud(hud, scale)
    pad = 14
    bezel = Image.new("RGBA", (disp.width + pad * 2, disp.height + pad * 2), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bezel)
    bd.rounded_rectangle((0, 0, bezel.width - 1, bezel.height - 1), radius=18, fill=(12, 14, 12, 255), outline=BEZEL + (255,), width=2)
    # inner display with rounded clip
    inner = Image.new("RGBA", disp.size, (0, 0, 0, 255))
    inner.paste(disp.convert("RGBA"), (0, 0))
    inner.putalpha(rounded_mask(disp.size, 8))
    bezel.alpha_composite(inner, (pad, pad))
    glow_behind(canvas, (x, y, x + bezel.width, y + bezel.height))
    canvas.alpha_composite(bezel, (x, y))
    return x, y, x + bezel.width, y + bezel.height

def draw_panel(canvas: Image.Image, panel: dict, x: int, y: int, w: int, h: int) -> None:
    box = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(box)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=18, fill=(28, 32, 28, 250), outline=(70, 90, 70, 255), width=2)
    title_f, sub_f, body_f, btn_f, chip_f = font(26, 700), font(18, 500), font(26, 550), font(17, 700), font(14, 700)
    d.text((24, 20), panel.get("title") or "Telegram", fill=GREEN, font=title_f)
    sent = "SENT" if panel.get("kind") == "reply" else "ALERT"
    chip_w = int(d.textlength(sent, font=chip_f)) + 20
    d.rounded_rectangle((w - 24 - chip_w, 22, w - 24, 46), radius=12, fill=GREEN + (255,))
    d.text((w - 24 - chip_w + 10, 26), sent, fill=(8, 16, 8), font=chip_f)
    d.text((24, 54), panel.get("subtitle") or "", fill=DIM, font=sub_f)
    d.line((24, 86, w - 24, 86), fill=(70, 90, 70, 255), width=1)
    body = panel.get("body") or ""
    lines = wrap_text(d, body, body_f, w - 48)
    yy = 108
    for line in lines[:7]:
        d.text((24, yy), line, fill=WHITE, font=body_f)
        yy += 36
    buttons = panel.get("buttons") or []
    if buttons:
        by = h - 70
        bw = (w - 56) // len(buttons)
        for i, label in enumerate(buttons):
            bx = 24 + i * (bw + 8)
            d.rounded_rectangle((bx, by, bx + bw - 8, by + 44), radius=10, outline=GREEN + (255,), width=2)
            tw = d.textlength(label, font=btn_f)
            d.text((bx + (bw - 8 - tw) / 2, by + 11), label, fill=GREEN, font=btn_f)
    canvas.alpha_composite(box, (x, y))

def draw_chrome(canvas: Image.Image, kicker: str, caption: str, badge: str, t_label: str) -> None:
    d = ImageDraw.Draw(canvas)
    d.text((64, 36), "HEADS-UP DESK", fill=WHITE, font=font(28, 700))
    d.text((64, 74), "Even G2  ·  Even Hub simulator  ·  576×288", fill=MUTED, font=font(16, 500))
    if t_label:
        tw = d.textlength(t_label, font=font(16, 500))
        d.text((W - 64 - tw, 42), t_label, fill=MUTED, font=font(16, 500))
    if kicker:
        # right-aligned kicker in green
        tw = d.textlength(kicker, font=font(20, 650))
        d.text((W - 64 - tw, 72), kicker, fill=GREEN, font=font(20, 650))
    if badge:
        bf = font(15, 700)
        tw = d.textlength(badge, font=bf)
        bx, by, bw, bh = 64, 108, int(tw) + 28, 28
        d.rounded_rectangle((bx, by, bx + bw, by + bh), radius=14, fill=AMBER + (255,))
        d.text((bx + 14, by + 5), badge, fill=(20, 16, 4), font=bf)
    # caption bar
    cf = font(28, 500)
    lines = wrap_text(d, caption, cf, W - 128)[:3]
    yy = H - 64 - 36 * len(lines)
    d.rectangle((0, yy - 24, W, H), fill=(8, 10, 9, 230))
    for i, line in enumerate(lines):
        d.text((64, yy + i * 36), line, fill=WHITE, font=cf)

def compose_frame(hud: Image.Image, kicker: str, caption: str, badge: str, panel: dict | None, t_label: str = "") -> Image.Image:
    canvas = Image.new("RGBA", (W, H), BG + (255,))
    if panel:
        scale = 2
        hx, hy = 56, 160
        paste_hud(canvas, hud, hx, hy, scale=scale)
        bezel_w = int(576 * scale) + 28
        px = hx + bezel_w + 36
        draw_panel(canvas, panel, px, 200, W - px - 56, 520)
    else:
        scale = 2.5
        bezel_w = int(round(576 * scale)) + 28
        hx = (W - bezel_w) // 2
        hy = 128
        paste_hud(canvas, hud, hx, hy, scale=scale)
    draw_chrome(canvas, kicker, caption, badge, t_label)
    return canvas.convert("RGB")

def title_card() -> Image.Image:
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    d.text((64, 36), "HEADS-UP DESK", fill=MUTED, font=card_font(22, True))
    y = 320
    d.text((120, y), "A crypto trading desk", fill=WHITE, font=card_font(72, True))
    d.text((120, y + 92), "you wear.", fill=GREEN, font=card_font(72, True))
    d.text((120, y + 220), "Hyperliquid  ·  Polymarket  ·  Telegram  ·  Trust Wallet", fill=DIM, font=card_font(26))
    d.text((120, y + 270), "Even Realities G2  ·  Crypto & DeFi  ·  Best Telegram", fill=MUTED, font=card_font(22))
    d.text((120, H - 90), "github.com/666Crypro/even-g2-crypto-hud", fill=GREEN, font=card_font(22, True))
    return canvas

def end_card() -> Image.Image:
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    d.text((120, 280), "HEADS-UP DESK", fill=GREEN, font=card_font(28, True))
    d.text((120, 340), "Read at a glance.", fill=WHITE, font=card_font(64, True))
    d.text((120, 422), "Act with a tap or a phrase.", fill=WHITE, font=card_font(64, True))
    d.text((120, 530), "Paper and testnet only  ·  your funds stay in your wallet", fill=DIM, font=card_font(26))
    d.text((120, 680), "github.com/666Crypro/even-g2-crypto-hud", fill=GREEN, font=card_font(32, True))
    d.text((120, 740), "Heads Up: Even Realities Hackathon  ·  Nov 2026", fill=MUTED, font=card_font(24))
    return canvas

def fade(a: Image.Image, b: Image.Image, t: float) -> Image.Image:
    return Image.blend(a.convert("RGB"), b.convert("RGB"), max(0.0, min(1.0, t)))


# Source-time keep ranges (seconds from the first raw frame). Silences in the
# gaps are trimmed to ~1s each so the voiceover stays tight.
KEEP = [
    (0.00, 26.90),    # title + markets + swipe + 1s on Telegram
    (30.30, 42.30),   # drafted reply, confirm, 1s of the sent panel
    (49.50, 72.40),   # voice alert + paper long + 1s of the fill
    (78.30, 105.20),  # bet / cancel, alert hit, context menu
]

def _segments():
    segs, t = [], 0.0
    for a, b in KEEP:
        segs.append((t, t + (b - a), a))
        t += b - a
    return segs, t

OUT_SEGS, KEPT_DUR = _segments()

def out_to_src(t: float) -> float:
    for o0, o1, s0 in OUT_SEGS:
        if o0 <= t < o1:
            return s0 + (t - o0)
    return KEEP[-1][1]

# Voiceover cues in OUTPUT time (after silence trims).
CUES = [
    ("1", 0.00),     # title + markets
    ("2", 8.30),     # swipe
    ("3", 26.90),    # telegram reply  (was 30.30)
    ("4", 38.90),    # voice commands  (was 49.50)
    ("5", 61.80),    # polymarket bet   (was 78.30)
    ("6", 75.80),    # alert hit        (was 92.30)
    ("7", 84.30),    # menu + end card  (was 100.80)
]
TITLE_HOLD = 5.0
FADE_THRU = 0.30       # fade to/from black so cards never superimpose
FADE_BLACK = 0.15
END_AT = KEPT_DUR       # ~88.70s — last kept menu frame
# VO 7 is 7.92s starting at 84.30 → 92.22; hold the end card a beat after.
VIDEO_END = 92.80


def clean_menu_hud(hud: Image.Image) -> Image.Image:
    """If a full-height G2 contextual-menu border is present, black out leftover pixels to its right.

    The Even Hub simulator sometimes leaves the previous card's text visible beside the menu.
    """
    im = hud.convert("RGB")
    pixels = im.load()
    w, h = im.size
    best_x, best = 0, 0
    for x in range(160, min(360, w)):
        score = 0
        for y in range(h):
            r, g, b = pixels[x, y]
            if g > 160 and g > r + 30 and g > b + 30:
                score += 1
        if score > best:
            best, best_x = score, x
    if best >= 200 and 200 <= best_x <= 320:
        out = im.copy()
        ImageDraw.Draw(out).rectangle((best_x + 1, 0, w, h), fill=(0, 0, 0))
        return out
    return im


def vo_duration(path: Path) -> float:
    return float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]
    ).decode().strip())


def build_narration() -> Path:
    """Lay each VO clip at its (output-time) cue, with silence in between, up to VIDEO_END."""
    WORK.mkdir(parents=True, exist_ok=True)
    pieces: list[Path] = []

    def silence(dur: float, name: str) -> Path:
        out = WORK / f"sil_{name}.wav"
        dur = max(0.02, dur)
        subprocess.check_call(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", f"{dur:.3f}",
             "-c:a", "pcm_s16le", str(out)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return out

    def resample(src: Path, name: str) -> Path:
        out = WORK / f"vo_{name}.wav"
        subprocess.check_call(
            ["ffmpeg", "-y", "-i", str(src), "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", str(out)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return out

    t = 0.0
    for name, start in CUES:
        if start - t > 0.02:
            pieces.append(silence(start - t, f"pre{name}"))
            t = start
        wav = resample(VO_DIR / f"{name}.wav", name)
        pieces.append(wav)
        t = start + vo_duration(wav)
    if VIDEO_END - t > 0.02:
        pieces.append(silence(VIDEO_END - t, "tail"))

    listfile = WORK / "concat.txt"
    listfile.write_text("".join(f"file '{p}'\n" for p in pieces))
    out = WORK / "narration.wav"
    subprocess.check_call(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(listfile), "-c", "copy", str(out)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    print(f"narration {vo_duration(out):.2f}s")
    return out


def rebuild_gif() -> Path:
    """Regenerate docs/demo.gif from the existing GIF, with the stale menu frame cleaned."""
    src = ROOT / "docs" / "demo.gif"
    gif = Image.open(src)
    frames = []
    # HUD is pasted at (20, 20) into a 616x360 canvas (see scripts/sim.py).
    box = (20, 20, 20 + 576, 20 + 288)
    for i in range(gif.n_frames):
        gif.seek(i)
        fr = gif.convert("RGB")
        hud = fr.crop(box)
        cleaned = clean_menu_hud(hud)
        if cleaned.tobytes() != hud.convert("RGB").tobytes():
            print(f"  cleaned gif frame {i}")
            fr.paste(cleaned, box[:2])
        frames.append(fr)
    out = ROOT / "docs" / "demo.gif"
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=2200, loop=0, optimize=True)
    print("gif:", out, out.stat().st_size)
    return out


def compose() -> Path:
    WORK.mkdir(parents=True, exist_ok=True)
    frames_dir = WORK / "out"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir()

    raws = sorted(RAW.glob("*.png"))
    if not raws:
        raise SystemExit("no raw frames — run record first")
    n_raw = len(raws)
    rec_dur = n_raw / FPS
    print(f"compose: {n_raw} raw frames, {rec_dur:.1f}s recorded, kept {KEPT_DUR:.1f}s, video end {VIDEO_END:.1f}s")

    title = title_card()
    end = end_card()
    black = Image.new("RGB", (W, H), BG)

    def raw_at(src_t: float):
        idx = int(round(src_t * FPS))
        idx = max(0, min(n_raw - 1, idx))
        img = Image.open(raws[idx]).convert("RGB")
        meta_p = raws[idx].with_suffix(".json")
        meta = json.loads(meta_p.read_text()) if meta_p.exists() else {}
        if (meta.get("kicker") or "") == "MENU":
            img = clean_menu_hud(img)
        return img, meta

    def live_at(out_t: float) -> Image.Image:
        hud, meta = raw_at(out_to_src(out_t))
        return compose_frame(
            hud,
            meta.get("kicker") or "",
            meta.get("caption") or "",
            meta.get("badge") or "",
            meta.get("panel"),
            "",
        )

    def thru_black(a: Image.Image, b: Image.Image, dt: float) -> Image.Image:
        """dt seconds into a fade-out / black / fade-in of duration 2*FADE_THRU+FADE_BLACK."""
        if dt < FADE_THRU:
            return fade(a, black, dt / FADE_THRU)
        if dt < FADE_THRU + FADE_BLACK:
            return black
        u = (dt - FADE_THRU - FADE_BLACK) / FADE_THRU
        return fade(black, b, u)

    TRANS = 2 * FADE_THRU + FADE_BLACK  # 0.75s
    total_frames = int(round(VIDEO_END * FPS))
    t0 = time.time()
    last_live = None
    for i in range(total_frames):
        t = i / FPS
        if t < TITLE_HOLD:
            frame = title
        elif t < TITLE_HOLD + TRANS:
            frame = thru_black(title, live_at(t), t - TITLE_HOLD)
            last_live = live_at(t)
        elif t < END_AT:
            frame = live_at(t)
            last_live = frame
        elif t < END_AT + TRANS:
            frame = thru_black(last_live or live_at(END_AT - 0.05), end, t - END_AT)
        else:
            frame = end
        frame.convert("RGB").save(frames_dir / f"{i:05d}.png")
        if i % 60 == 0:
            print(f"  composed {i}/{total_frames} ({t:.1f}s)")

    print(f"compose frames in {time.time() - t0:.1f}s")
    narration = build_narration()
    OUT_MP4.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(FPS),
        "-i", str(frames_dir / "%05d.png"),
        "-i", str(narration),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "19", "-preset", "medium",
        "-movflags", "+faststart",
        "-af", "loudnorm=I=-16:LRA=11:TP=-1.5", "-c:a", "aac", "-b:a", "160k",
        "-shortest",
        str(OUT_MP4),
    ]
    print("+", " ".join(cmd))
    subprocess.check_call(cmd)
    size = OUT_MP4.stat().st_size
    dur = vo_duration(OUT_MP4)
    print(f"wrote {OUT_MP4}  {dur:.2f}s  {size/1e6:.1f} MB")
    rebuild_gif()
    return OUT_MP4


def wait_ready(timeout: float = 30) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            data = json.loads(_get("/api/console"))
            if any("[heads-up] ready" in e.get("message", "") for e in data.get("entries", [])):
                return
        except Exception:
            pass
        time.sleep(0.4)
    raise SystemExit("simulator not ready")


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    if mode in ("all", "record"):
        wait_ready()
        if RAW.exists():
            shutil.rmtree(RAW)
        RAW.mkdir(parents=True)
        print("seeding…")
        seed()
        print("recording tour…")
        REC.start()
        try:
            tour()
        finally:
            hold(0.4)
            REC.stop()
    if mode in ("all", "compose"):
        compose()


if __name__ == "__main__":
    main()
