# DoraHacks BUIDL submission: Heads-Up Desk

> Paste-ready text for the BUIDL form on https://dorahacks.io/hackathon/even-realities/detail.
> Fields in [brackets] need Arthur's input before submitting.

**BUIDL name:** Heads-Up Desk: a crypto trading desk you wear

**Tagline (one line):** Hyperliquid, Polymarket and your Telegram crypto chats on Even G2. Glance to read, tap or speak to act, paper/testnet only.

**Tracks:** Main: **02 · Crypto & DeFi** (Hyperliquid, Polymarket, Trust Wallet). Second: **01 · Messaging & News** (Telegram). Also entering **Best Telegram integration**.

**Repo:** https://github.com/666Crypro/even-g2-crypto-hud
**Demo video (≤3 min):** [YouTube/Loom link]
**Team:** Arthur Shavlovsky (solo) · [Telegram/X handle]
**How did you hear about this hackathon?** [community name, which counts toward the Community Partner Award]

---

## Short description

**Problem.** Crypto never closes, and staying on top of it means constant checking: is BTC still above my level, did funding flip, what are tomorrow's odds, what did the group chat just say? Each check is a phone unlock and three apps.

**Who it's for.** Active traders, DeFi users and crypto community members who already live in Hyperliquid, Polymarket and Telegram.

**How it works.** Heads-Up Desk is an Even Hub web app with a small Node backend. You swipe through six glanceable cards on the 576×288 display:

1. **Markets:** live Hyperliquid price, 24h move, funding, OI, and a 24h sparkline drawn in the G2 image container.
2. **Positions:** any Hyperliquid account (read-only), Trust Wallet ETH/USDC balances on Ethereum and Base, and your paper book.
3. **Funding:** the largest funding payers on each side across liquid perps.
4. **Odds:** Polymarket's "BTC above ___ tomorrow" board, laddered around the live Hyperliquid price.
5. **Alerts:** watched 24/7 by the server and pushed to Telegram, so they arrive even when the G2 app is closed.
6. **Telegram:** crypto mentions from your groups, each with live market context, plus one-tap replies drafted from live data.

**Read and write.** Tap opens a one-tap action list with smart defaults (±2% alert levels from the live price, pre-drafted replies). **Hold to talk:** G2 mic PCM goes to Whisper, then a deterministic parser builds a proposed action, then you tap to confirm. "Alert bitcoin above 60k", "long ETH 200 dollars", "bet yes 20", "reply: on it". Double-tap cancels. The G2 contextual menu adds Refresh / Next coin / Alert ±2% / Share to Telegram.

**Safety.** Market and wallet data are read-only public APIs. Orders are **paper** (filled at the Hyperliquid mid) or optionally **Hyperliquid testnet**, and there is no mainnet path. Polymarket bets are paper bets at live prices. Every order, bet and Telegram message needs an explicit confirm tap. No keys in the app: one whitelisted backend origin, secrets in server env. Only coin-mentioning messages from groups that added the bot reach the glasses.

**Tech.** TypeScript end to end. Even Hub SDK 0.0.16: text, image and list containers with zOrderIndex, diffed `textContainerUpgrade`, long-press push-to-talk, contextual menu, `shutDownPageContainer(1)` on root. Backend: Hyperliquid info API, Polymarket Gamma API, Ethereum/Base JSON-RPC, Telegram Bot API (long polling, /link pairing, /price /odds /alerts), any OpenAI-compatible Whisper (incl. a free local faster-whisper server), and `@nktkas/hyperliquid` for testnet signing. 8 unit test suites, plus an automated simulator tour that drives the headless control plane and asserts on the framebuffer. Packs to a valid `.ehpk`.

**Built during the hackathon:** all code (Nov 25–29, 2026). Pre-existing: Even Hub SDK/CLI/simulator and templates (reference), open-source libs listed in the README, public APIs.

## Feature requests (optional field, up to 5)

1. Even Hub: a background "glance notification" API for alerts while another app is in front.
2. Even Hub: built-in speech-to-text in the SDK.
3. Even Hub: in-place list updates and text alignment / tab stops for tables.
4. Polymarket: a public testnet/sandbox CLOB for real test orders.
5. Hyperliquid: a testnet faucet without a mainnet deposit. Telegram: a scoped read-only user API for selected personal chats.

---

## 2-minute demo video script

**Setup before recording:** backend running (`npm run demo`, or with your real `TELEGRAM_BOT_TOKEN` and `STT_API_KEY`), `npm run app`, `npm run sim`. Screen layout: simulator on the left; Telegram Desktop (or the phone mirror) on the right. Arm one alert slightly in the money beforehand so it fires on camera (e.g. `alert bitcoin below <spot + 0.5%>`). Record at 1080p. Use the simulator's glow effect (`-g`) for the hero shot.

| Time | On screen | Voiceover |
|---|---|---|
| 0:00–0:10 | Title card, then the simulator Markets card with its sparkline | "Crypto never closes. Checking it shouldn't mean unlocking your phone fifty times a day. This is Heads-Up Desk for Even G2." |
| 0:10–0:35 | Swipe down through Positions → Funding → Odds → Alerts → Telegram (about 4 s each) | "Swipe to glance: live Hyperliquid price and chart. My Hyperliquid positions and Trust Wallet balances, read-only. Who's paying funding. Polymarket's odds for tomorrow's close, laddered around the live price. My alerts. And the crypto chatter from my Telegram groups." |
| 0:35–0:55 | On Telegram: tap → action list → select the drafted reply → confirm → the message appears in the Telegram window | "Someone asks about ETH. The glasses show live context, and the reply is already drafted from real data. One tap to pick it, one tap to confirm, and it's in the group." |
| 0:55–1:20 | Go to Markets. Hold: live mic meter. Say "alert bitcoin above sixty thousand" → HEARD → armed. Hold again: "long ETH two hundred dollars" → CONFIRM → tap → Positions shows the paper fill | "Or just say it. Hold to talk, release, and it's armed. Orders are paper or Hyperliquid testnet only, and nothing happens until I tap to confirm." |
| 1:20–1:35 | Odds card: "bet yes twenty" → confirm screen → double-tap to cancel | "Same for a Polymarket bet, and a double-tap cancels." |
| 1:35–1:50 | The pre-armed alert fires: ★ toast on the glasses, Telegram DM with "Open in Trust Wallet" and Hyperliquid buttons | "Alerts run on the server 24/7. G2 apps can't pop up in the background, so hits land in Telegram, one tap from Trust Wallet." |
| 1:50–2:00 | Tap + hold contextual menu, then the README GIF / repo URL | "Read at a glance, act with a tap or a phrase, and your funds are never at risk. Heads-Up Desk: github.com/666Crypro/even-g2-crypto-hud." |

**B-roll / backup:** if there's no mic, run `npm run sim:demo-mic`. Each long press replays a bundled speech clip through the same voice pipeline, in the order alert → long ETH → bet yes → reply. Say this on screen ("simulated mic input") to stay transparent.
