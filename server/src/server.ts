// Heads-Up Desk backend: aggregates Hyperliquid + Polymarket + wallet reads, renders HUD cards,
// parses voice/typed intents, executes confirmed paper/testnet actions, runs the alert watcher and Telegram bot.
// The glasses WebView talks only to this server (one whitelisted origin, CORS handled here, no keys in the app).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { getMarkets, getCandles, getAccount, getFundingExtremes } from './hyperliquid.ts'
import { getDailyBoard, ladderAroundSpot } from './polymarket.ts'
import { getWallet, isEvmAddress, trustWalletLink } from './wallet.ts'
import { renderCards, header, type HudInput } from './hud.ts'
import { parseIntent, CARDS, type Action, type Card } from './intent.ts'
import { propose, execute, hlTradeLink, type ShareFn } from './actions.ts'
import { state } from './store.ts'
import { evaluate, alertMessage, markNotified } from './alerts.ts'
import { tgEnabled, tgDemo, notifyLinked, onCommand, startPolling, seedDemoFeed, sentLog } from './telegram.ts'
import { transcribe, sttEnabled } from './stt.ts'
import { executorKind } from './executor.ts'
import { fmtPx, fmtPct, fmtUsd } from './util.ts'

const PORT = Number(process.env.PORT ?? 8787)
const DEFAULT_WATCH = (process.env.WATCHLIST ?? 'BTC,ETH,SOL,HYPE').split(',').map(s => s.trim().toUpperCase())
const STATIC_DIR = path.resolve(import.meta.dirname, '../../app/dist')

interface Prefs { coin: string; watchlist: string[]; hl: string | null; wallet: string | null }

function prefsFrom(q: URLSearchParams | Record<string, unknown>): Prefs {
  const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : (q[k] as string | undefined)) ?? undefined
  const watch = (get('watch') ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  const watchlist = watch.length ? watch : DEFAULT_WATCH
  const hl = get('hl') || process.env.HL_WATCH_ADDRESS || ''
  const wallet = get('wallet') || process.env.WALLET_ADDRESS || ''
  return { coin: (get('coin') ?? watchlist[0]).toUpperCase(), watchlist, hl: isEvmAddress(hl) ? hl : null, wallet: isEvmAddress(wallet) ? wallet : null }
}

const soft = <T,>(p: Promise<T>): Promise<T | null> => p.catch(err => { console.warn('[data]', err.message); return null })

async function buildInput(p: Prefs): Promise<HudInput> {
  const [markets, candles, account, wallet, funding, board] = await Promise.all([
    getMarkets(),
    soft(getCandles(p.coin)),
    p.hl ? soft(getAccount(p.hl)) : null,
    p.wallet ? soft(getWallet(p.wallet)) : null,
    getFundingExtremes(),
    soft(getDailyBoard(p.coin)),
  ])
  const spot = markets.get(p.coin)?.mid
  return {
    coin: p.coin, watchlist: p.watchlist, markets, candles: candles ?? [], account, wallet, funding, board,
    ladder: board ? ladderAroundSpot(board.rows, spot, 3) : [], state, tgEnabled, tgDemo, executor: executorKind, now: new Date(),
  }
}

async function snapshot(p: Prefs) {
  const inp = await buildInput(p)
  const cards = renderCards(inp)
  const headers = Object.fromEntries(CARDS.map(c => [c, header(c, inp)])) as Record<Card, string>
  const recentHits = state.alerts.filter(a => a.triggeredAt && Date.now() - a.triggeredAt < 120_000).map(a => ({ id: a.id, text: alertMessage(a), at: a.triggeredAt }))
  return {
    ts: Date.now(), coin: p.coin, watchlist: p.watchlist, cards, headers, recentHits,
    config: { stt: sttEnabled, telegram: tgEnabled, telegramDemo: tgDemo, executor: executorKind, pairCode: state.tg.pairCode, linkedChats: state.tg.linkedChatIds.length },
    log: state.log.slice(0, 8), tgSent: sentLog.slice(0, 5),
  }
}

/** Text + Trust Wallet / Hyperliquid buttons for sharing a card to Telegram. */
const shareFor = (p: Prefs): ShareFn => async card => {
  const inp = await buildInput(p)
  const c = card ?? 'markets'
  const view = renderCards(inp)[c]
  const buttons = c === 'odds' && inp.board ? [{ text: 'Open on Polymarket', url: inp.board.url }] : hlTradeLink(p.coin)
  if (c === 'positions' && p.wallet) buttons.unshift({ text: 'Open Trust Wallet', url: trustWalletLink('https://app.hyperliquid.xyz/portfolio') })
  return { text: `👓 ${header(c, inp)}\n\n${view.body}`, buttons: buttons.slice(0, 3) }
}

// ---- Telegram slash commands reuse the same data layer ----
onCommand(async (cmd, args) => {
  const coin = (args.split(/\s+/)[0] || 'BTC').toUpperCase()
  if (cmd === 'price') {
    const m = (await getMarkets()).get(coin)
    return m ? `${coin} ${fmtPx(m.mid)} (${fmtPct(m.change24h)} 24h)\nFunding ${fmtPct(m.fundingApr)} APR · OI ${fmtUsd(m.openInterestUsd)}` : `${coin} not on Hyperliquid`
  }
  if (cmd === 'odds') {
    const { body } = renderCards(await buildInput(prefsFrom({ coin })))['odds']
    return body
  }
  if (cmd === 'alerts') return renderCards(await buildInput(prefsFrom({})))['alerts'].body
  return null
})

// ---- Alert watcher ----
async function watchLoop() {
  try {
    const hits = evaluate(await getMarkets())
    for (const a of hits) {
      await notifyLinked(alertMessage(a), a.kind === 'funding_apr_above' ? [] : hlTradeLink(a.coin))
      markNotified(a)
    }
  } catch (err) {
    console.warn('[alerts]', (err as Error).message)
  }
}

/** On the TELEGRAM card, free speech that isn't a command becomes a reply draft (still needs a tap to send). */
function withCardFallback(a: Action, card?: Card): Action {
  if (card === 'telegram' && a.type === 'unknown' && a.text.trim()) return { type: 'tg_reply', text: a.text.trim() }
  return a
}

// ---- HTTP ----
function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  })
  res.end(type === 'application/json' ? JSON.stringify(body) : (body as Buffer))
}

async function readBody(req: http.IncomingMessage, limit = 2_000_000): Promise<Buffer> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) throw new Error('body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' }

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '')
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, executor: executorKind, telegram: tgEnabled, stt: sttEnabled })
    if (url.pathname === '/api/snapshot') return send(res, 200, await snapshot(prefsFrom(url.searchParams)))
    if (url.pathname === '/api/intent' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}')
      const p = prefsFrom(b)
      const known = new Set((await getMarkets()).keys())
      const action = withCardFallback(parseIntent(String(b.text ?? ''), { coin: p.coin, card: b.card, knownCoins: known }), b.card)
      return send(res, 200, { transcript: b.text, ...(await propose(action)) })
    }
    if (url.pathname === '/api/voice' && req.method === 'POST') {
      const pcm = new Uint8Array(await readBody(req))
      const p = prefsFrom(url.searchParams)
      const transcript = await transcribe(pcm)
      const known = new Set((await getMarkets()).keys())
      const card = (url.searchParams.get('card') as Card) ?? undefined
      const action = withCardFallback(parseIntent(transcript, { coin: p.coin, card, knownCoins: known }), card)
      return send(res, 200, { transcript, ...(await propose(action)) })
    }
    if (url.pathname === '/api/propose' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}')
      return send(res, 200, await propose(b.action as Action))
    }
    if (url.pathname === '/api/execute' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}')
      const p = prefsFrom(b)
      const result = await execute(b.action as Action, shareFor(p), { coin: p.coin })
      return send(res, 200, result)
    }
    // static app build (optional): lets one deployment serve both the WebView app and the API
    const file = path.join(STATIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''))
    if (file.startsWith(STATIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] ?? 'application/octet-stream')
    }
    return send(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[http]', url.pathname, (err as Error).message)
    return send(res, 500, { error: (err as Error).message })
  }
})

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  seedDemoFeed()
  server.listen(PORT, () => console.log(`[heads-up] api on http://localhost:${PORT}  executor=${executorKind} telegram=${tgEnabled ? (tgDemo ? 'demo' : 'live') : 'off'} stt=${sttEnabled ? 'on' : 'off'}`))
  setInterval(watchLoop, 10_000)
  void watchLoop()
  void startPolling(async () => new Set((await getMarkets()).keys()))
}
