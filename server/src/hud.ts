// Renders every HUD card as plain text sized for the G2 display (576x288, ~60 chars/line, ~7 body lines),
// plus the list of one-tap actions each card offers. The glasses client just paints these strings,
// and the Telegram bot reuses the same text when you "share" a card.
import type { PerpMarket, AccountState, Candle } from './hyperliquid.ts'
import type { OddsBoard } from './polymarket.ts'
import type { WalletBalances } from './wallet.ts'
import type { State, Alert } from './store.ts'
import { type Action, type Card, CARDS } from './intent.ts'
import { arrow, clip, fmtPct, fmtPx, fmtUsd, shortAddr } from './util.ts'

export interface MenuItem { label: string; action: Action; confirm: boolean }
export interface CardView { id: Card; title: string; body: string; hint: string; actions: MenuItem[]; chart?: number[] }

export interface HudInput {
  coin: string
  watchlist: string[]
  markets: Map<string, PerpMarket>
  candles: Candle[]
  account: AccountState | null
  wallet: WalletBalances | null
  funding: { top: PerpMarket[]; bottom: PerpMarket[]; universe: number }
  board: OddsBoard | null
  ladder: OddsBoard['rows']
  state: State
  tgEnabled: boolean
  tgDemo: boolean
  executor: 'paper' | 'hl-testnet'
  now: Date
}

const TITLES: Record<Card, string> = { markets: 'MARKETS', positions: 'POSITIONS', funding: 'FUNDING', odds: 'ODDS', alerts: 'ALERTS', telegram: 'TELEGRAM' }

export function bar(frac: number, width = 10): string {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)))
  return '█'.repeat(n) + '─'.repeat(width - n)
}

export function pnlOf(o: { side: 'LONG' | 'SHORT'; size: number; entry: number }, px: number) {
  return (px - o.entry) * o.size * (o.side === 'LONG' ? 1 : -1)
}

export function describeAlert(a: Alert): string {
  if (a.kind === 'funding_apr_above') return `${a.coin} funding > ${a.value}% APR`
  return `${a.coin} ${a.kind === 'price_above' ? '>' : '<'} ${fmtPx(a.value)}`
}

function timeLabel(now: Date) {
  return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: process.env.HUD_TZ ?? 'America/Los_Angeles' })
}

export function header(card: Card, inp: HudInput): string {
  const m = inp.markets.get(inp.coin)
  const idx = CARDS.indexOf(card) + 1
  const tick = m ? `${inp.coin} ${fmtPx(m.mid)} ${arrow(m.change24h)}${Math.abs(m.change24h).toFixed(1)}%` : inp.coin
  const armed = inp.state.alerts.filter(a => !a.triggeredAt).length
  return `${TITLES[card]} ${idx}/${CARDS.length}  ·  ${tick}  ·  ${armed ? `●${armed} ` : ''}${timeLabel(inp.now)}`
}

function marketsCard(inp: HudInput): CardView {
  const c = inp.coin
  const m = inp.markets.get(c)
  if (!m) return { id: 'markets', title: 'MARKETS', body: `${c}: no Hyperliquid perp`, hint: 'swipe ▲▼ cards · tap actions', actions: [] }
  const hi = inp.candles.length ? Math.max(...inp.candles.map(k => k.h)) : NaN
  const lo = inp.candles.length ? Math.min(...inp.candles.map(k => k.l)) : NaN
  const body = [
    `${c}-PERP`,
    `$${fmtPx(m.mid)}`,
    `${arrow(m.change24h)} ${Math.abs(m.change24h).toFixed(2)}% 24h`,
    `H ${fmtPx(hi)}  L ${fmtPx(lo)}`,
    `Fund ${fmtPct(m.fundingApr, 1)} APR`,
    `OI ${fmtUsd(m.openInterestUsd)}  Vol ${fmtUsd(m.volume24hUsd)}`,
    others(inp),
  ].join('\n')
  const next = inp.watchlist[(inp.watchlist.indexOf(c) + 1) % inp.watchlist.length]
  const up = m.mid * 1.02, dn = m.mid * 0.98
  return {
    id: 'markets',
    title: 'MARKETS',
    body,
    hint: 'tap: actions · hold: voice · swipe: next card',
    chart: inp.candles.map(k => k.c),
    actions: [
      { label: `Alert ${c} > ${fmtPx(up)} (+2%)`, action: { type: 'alert', coin: c, kind: 'price_above', value: round(up) }, confirm: false },
      { label: `Alert ${c} < ${fmtPx(dn)} (-2%)`, action: { type: 'alert', coin: c, kind: 'price_below', value: round(dn) }, confirm: false },
      { label: `Paper LONG $100 ${c}`, action: { type: 'order', coin: c, side: 'LONG', notionalUsd: 100 }, confirm: true },
      { label: `Paper SHORT $100 ${c}`, action: { type: 'order', coin: c, side: 'SHORT', notionalUsd: 100 }, confirm: true },
      { label: `Next coin: ${next}`, action: { type: 'focus', coin: next }, confirm: false },
      { label: 'Share card to Telegram', action: { type: 'tg_share', card: 'markets' }, confirm: true },
    ],
  }
}

function round(px: number) {
  const mag = px >= 1000 ? 10 : px >= 10 ? 0.1 : px >= 1 ? 0.001 : 0.00001
  return Math.round(px / mag) * mag
}

function others(inp: HudInput): string {
  return inp.watchlist
    .filter(c => c !== inp.coin)
    .slice(0, 3)
    .map(c => {
      const m = inp.markets.get(c)
      return m ? `${c} ${arrow(m.change24h)}${Math.abs(m.change24h).toFixed(1)}` : c
    })
    .join('  ')
}

function positionsCard(inp: HudInput): CardView {
  const lines: string[] = []
  const actions: MenuItem[] = []
  const open = inp.state.paper.filter(o => !o.closedAt)
  if (inp.account) {
    const a = inp.account
    lines.push(`HL ${shortAddr(a.address)}  eq ${fmtUsd(a.equity)}  (read-only)`)
    for (const p of a.positions.slice(0, 2)) {
      lines.push(`${p.coin} ${p.side} ${p.leverage}x ${fmtUsd(p.valueUsd)}  uPnL ${fmtUsd(p.unrealizedPnl, true)} (${fmtPct(p.roePct)})`)
      if (p.liquidationPx) lines.push(`   liq ${fmtPx(p.liquidationPx)} · mark ${fmtPx(inp.markets.get(p.coin)?.mark ?? NaN)}`)
    }
    if (!a.positions.length) lines.push('no open perp positions')
  }
  if (inp.wallet) {
    const w = inp.wallet
    lines.push(`Wallet ${shortAddr(w.address)}: ${w.eth.toFixed(3)} ETH · ${fmtUsd(w.usdc)} USDC`)
  }
  let total = 0
  const rows = open.map(o => {
    const px = inp.markets.get(o.coin)?.mid ?? o.entry
    const pnl = pnlOf(o, px)
    total += pnl
    return { o, pnl }
  })
  const label = inp.executor === 'hl-testnet' ? 'Testnet' : 'Paper'
  lines.push(`${label}: ${open.length} open · uPnL ${fmtUsd(total, true)}${inp.state.bets.length ? ` · ${inp.state.bets.length} bets` : ''}`)
  for (const { o, pnl } of rows.slice(0, inp.account ? 2 : 4)) {
    lines.push(`  ${o.coin} ${o.side} ${fmtUsd(o.notionalUsd)} @ ${fmtPx(o.entry)}  ${fmtUsd(pnl, true)}`)
    actions.push({ label: `Close ${label.toLowerCase()} ${o.coin} ${o.side}`, action: { type: 'close', coin: o.coin }, confirm: true })
  }
  if (!inp.account && !inp.wallet) lines.unshift('Add HL / wallet address on the phone screen')
  actions.push({ label: 'Send Trust Wallet link to TG', action: { type: 'tg_share', card: 'positions' }, confirm: true })
  return { id: 'positions', title: 'POSITIONS', body: lines.slice(0, 7).join('\n'), hint: 'tap: actions · hold: voice "close ETH"', actions }
}

function fundingCard(inp: HudInput): CardView {
  const f = inp.funding
  const fmt = (m: PerpMarket) => `${m.coin} ${fmtPct(m.fundingApr, 0)}`
  const focus = inp.markets.get(inp.coin)
  const body = [
    `Annualized funding · ${f.universe} perps with OI > $10M`,
    `Longs pay:   ${f.top.map(fmt).join('   ')}`,
    `Shorts pay:  ${f.bottom.map(fmt).join('   ')}`,
    focus ? `${inp.coin}: ${fmtPct(focus.fundingApr, 1)} APR (${(focus.fundingHourly * 100).toFixed(4)}%/h)` : '',
    'Next funding: top of the hour',
    'Info only · not financial advice',
  ].join('\n')
  const top = f.top[0]
  const actions: MenuItem[] = []
  if (top) {
    actions.push({ label: `Alert ${top.coin} funding > ${Math.ceil(top.fundingApr + 5)}% APR`, action: { type: 'alert', coin: top.coin, kind: 'funding_apr_above', value: Math.ceil(top.fundingApr + 5) }, confirm: false })
    actions.push({ label: `Focus ${top.coin}`, action: { type: 'focus', coin: top.coin }, confirm: false })
  }
  if (f.bottom[0]) actions.push({ label: `Focus ${f.bottom[0].coin}`, action: { type: 'focus', coin: f.bottom[0].coin }, confirm: false })
  actions.push({ label: 'Share card to Telegram', action: { type: 'tg_share', card: 'funding' }, confirm: true })
  return { id: 'funding', title: 'FUNDING', body, hint: 'tap: actions · swipe: next card', actions }
}

function oddsCard(inp: HudInput): CardView {
  const b = inp.board
  if (!b || !inp.ladder.length) return { id: 'odds', title: 'ODDS', body: `No live Polymarket daily board for ${inp.coin}.\nTry BTC or ETH (hold: "show bitcoin").`, hint: 'swipe: next card', actions: [] }
  const spot = inp.markets.get(inp.coin)?.mid
  const lines = [clip(`Polymarket: ${b.title}`, 58)]
  for (const r of inp.ladder) {
    const pct = Math.round(r.yes * 100)
    lines.push(`${r.label.padEnd(8)} ${bar(r.yes)} ${pct}% YES`)
  }
  if (spot) lines.push(`Hyperliquid spot ${fmtPx(spot)} · 24h vol ${fmtUsd(b.volume24h)}`)
  lines.push('Paper bets only · read-only odds')
  const mid = inp.ladder[Math.floor(inp.ladder.length / 2)]
  const yesC = Math.round(mid.yes * 100), noC = 100 - yesC
  return {
    id: 'odds',
    title: 'ODDS',
    body: lines.join('\n'),
    hint: 'tap: bet (paper) · hold: "bet yes 20"',
    actions: [
      { label: `Paper YES $10 @ ${yesC}c · ${mid.label}`, action: { type: 'bet', side: 'YES', stakeUsd: 10, market: mid.slug }, confirm: true },
      { label: `Paper NO $10 @ ${noC}c · ${mid.label}`, action: { type: 'bet', side: 'NO', stakeUsd: 10, market: mid.slug }, confirm: true },
      ...(mid.strike ? [{ label: `Alert ${inp.coin} > ${fmtPx(mid.strike)}`, action: { type: 'alert', coin: inp.coin, kind: 'price_above', value: mid.strike } as Action, confirm: false }] : []),
      { label: 'Share odds to Telegram', action: { type: 'tg_share', card: 'odds' }, confirm: true },
    ],
  }
}

function alertsCard(inp: HudInput): CardView {
  const all = [...inp.state.alerts].sort((a, b) => (b.triggeredAt ?? 0) - (a.triggeredAt ?? 0) || b.createdAt - a.createdAt)
  const armed = all.filter(a => !a.triggeredAt)
  const lines = [`${armed.length} armed · server watches 24/7${inp.tgEnabled ? ' → Telegram' : ''}`]
  for (const a of all.slice(0, 5)) {
    if (a.triggeredAt) lines.push(`★ ${describeAlert(a)}  hit ${timeLabel(new Date(a.triggeredAt))}${a.notified ? ' · TG sent' : ''}`)
    else {
      const m = inp.markets.get(a.coin)
      const dist = m && a.kind !== 'funding_apr_above' ? `  (${fmtPct(((a.value - m.mid) / m.mid) * 100)})` : ''
      lines.push(`● ${describeAlert(a)}${dist}`)
    }
  }
  if (!all.length) lines.push('No alerts yet. Hold and say', '"alert bitcoin above 60k"')
  const actions: MenuItem[] = []
  if (all.some(a => a.triggeredAt)) actions.push({ label: 'Clear triggered alerts', action: { type: 'unknown', text: '__clear_triggered' }, confirm: false })
  for (const a of armed.slice(0, 5)) actions.push({ label: `Delete ${describeAlert(a)}`, action: { type: 'unknown', text: `__delete_alert:${a.id}` }, confirm: false })
  actions.push({ label: 'Share alerts to Telegram', action: { type: 'tg_share', card: 'alerts' }, confirm: true })
  return { id: 'alerts', title: 'ALERTS', body: lines.join('\n'), hint: 'tap: manage · hold: voice "alert eth below 2.9k"', actions }
}

export function draftReply(msg: { text: string; tickers: string[] }, markets: Map<string, PerpMarket>): string {
  const t = msg.tickers.find(x => markets.has(x))
  if (!t) return 'Seen, thanks. Watching.'
  const m = markets.get(t)!
  return `${t} ${fmtPx(m.mid)} (${fmtPct(m.change24h)} 24h), funding ${fmtPct(m.fundingApr, 0)} APR. Watching.`
}

function telegramCard(inp: HudInput): CardView {
  const feed = inp.state.tg.feed
  if (!inp.tgEnabled) {
    return { id: 'telegram', title: 'TELEGRAM', body: 'Telegram bot not configured.\nSet TELEGRAM_BOT_TOKEN on the server,\nthen DM the bot: /link ' + inp.state.tg.pairCode, hint: 'swipe: next card', actions: [] }
  }
  if (!feed.length) {
    return { id: 'telegram', title: 'TELEGRAM', body: `No crypto mentions yet.\nAdd the bot to your group, or DM it.\nLink alerts: /link ${inp.state.tg.pairCode}`, hint: 'swipe: next card', actions: [] }
  }
  const msg = feed[0]
  const lines = [clip(`${msg.chatTitle}${inp.tgDemo ? ' (demo feed)' : ''} · ${feed.length} new`, 58)]
  lines.push(clip(`${msg.from}: ${msg.text}`, 120))
  for (const t of msg.tickers.slice(0, 2)) {
    const m = inp.markets.get(t)
    if (m) lines.push(`  → ${t} ${fmtPx(m.mid)} ${arrow(m.change24h)}${Math.abs(m.change24h).toFixed(1)}% · fund ${fmtPct(m.fundingApr, 0)}`)
  }
  if (feed[1]) lines.push(clip(`${feed[1].from}: ${feed[1].text}`, 58))
  const draft = draftReply(msg, inp.markets)
  const t0 = msg.tickers.find(t => inp.markets.has(t))
  const actions: MenuItem[] = [
    { label: clip(`Reply: ${draft}`, 64), action: { type: 'tg_reply', text: draft, chatId: msg.chatId }, confirm: true },
    { label: 'Reply: On it.', action: { type: 'tg_reply', text: 'On it.', chatId: msg.chatId }, confirm: true },
  ]
  if (t0) {
    const m = inp.markets.get(t0)!
    actions.push({ label: `Alert ${t0} > ${fmtPx(round(m.mid * 1.02))} (+2%)`, action: { type: 'alert', coin: t0, kind: 'price_above', value: round(m.mid * 1.02) }, confirm: false })
    actions.push({ label: `Open ${t0} card`, action: { type: 'focus', coin: t0 }, confirm: false })
  }
  actions.push({ label: 'Mark read · next message', action: { type: 'unknown', text: '__tg_next' }, confirm: false })
  return { id: 'telegram', title: 'TELEGRAM', body: lines.slice(0, 7).join('\n'), hint: 'tap: reply/act · hold: dictate reply', actions }
}

export function renderCards(inp: HudInput): Record<Card, CardView> {
  return {
    markets: marketsCard(inp),
    positions: positionsCard(inp),
    funding: fundingCard(inp),
    odds: oddsCard(inp),
    alerts: alertsCard(inp),
    telegram: telegramCard(inp),
  }
}
