// Turns a proposed Action into (a) a one-line confirm prompt for the glasses and (b) its execution.
// Reads are instant; anything that moves (paper) money or sends a message requires a tap to confirm.
import type { Action, Card } from './intent.ts'
import { state, save, newId, logEvent } from './store.ts'
import { getMarkets } from './hyperliquid.ts'
import { getDailyBoard } from './polymarket.ts'
import { openOrder, closeCoin, executorKind } from './executor.ts'
import { sendMessage, notifyLinked, tgEnabled, type UrlButton } from './telegram.ts'
import { trustWalletLink } from './wallet.ts'
import { describeAlert } from './hud.ts'
import { fmtPx, fmtUsd } from './util.ts'

export interface Proposal { action: Action; prompt: string; confirm: boolean }
export interface Result { ok: boolean; toast: string; focus?: string; card?: Card }

export const needsConfirm = (a: Action) => ['order', 'close', 'bet', 'tg_reply', 'tg_share'].includes(a.type)

export async function propose(a: Action): Promise<Proposal> {
  const markets = await getMarkets()
  const venue = executorKind === 'hl-testnet' ? 'TESTNET' : 'PAPER'
  let prompt: string
  switch (a.type) {
    case 'order': {
      const m = markets.get(a.coin)
      prompt = m ? `${venue} ${a.side} ${a.coin} ${fmtUsd(a.notionalUsd)} @ ~${fmtPx(m.mid)}?` : `${a.coin} is not a Hyperliquid perp`
      break
    }
    case 'close': prompt = `Close ${venue.toLowerCase()} ${a.coin} position(s)?`; break
    case 'bet': prompt = `PAPER bet ${a.side} ${fmtUsd(a.stakeUsd)} on Polymarket?`; break
    case 'tg_reply': prompt = `Send to Telegram: "${a.text}"`; break
    case 'tg_share': prompt = `Share ${a.card ?? 'this'} card to your Telegram?`; break
    case 'alert': prompt = `Set alert: ${a.coin} ${a.kind === 'funding_apr_above' ? 'funding >' : a.kind === 'price_above' ? '>' : '<'} ${a.value !== undefined ? (a.kind === 'funding_apr_above' ? `${a.value}% APR` : fmtPx(a.value)) : `${a.pct}%`}`; break
    case 'focus': prompt = `Show ${a.coin}`; break
    case 'navigate': prompt = `Open ${a.card}`; break
    default: prompt = `Didn't catch that: "${'text' in a ? a.text : ''}"`
  }
  return { action: a, prompt, confirm: needsConfirm(a) }
}

export type ShareFn = (card: Card | undefined) => Promise<{ text: string; buttons: UrlButton[] }>

export async function execute(a: Action, share: ShareFn, ctx: { coin: string }): Promise<Result> {
  const markets = await getMarkets()
  switch (a.type) {
    case 'focus':
      if (!markets.has(a.coin)) return { ok: false, toast: `${a.coin} not on Hyperliquid` }
      return { ok: true, toast: `Showing ${a.coin}`, focus: a.coin, card: 'markets' }
    case 'navigate':
      return { ok: true, toast: `Opened ${a.card}`, card: a.card }
    case 'alert': {
      const m = markets.get(a.coin)
      if (!m) return { ok: false, toast: `${a.coin} not on Hyperliquid` }
      let value = a.value
      if (value === undefined && a.pct !== undefined) value = Number((m.mid * (1 + a.pct / 100)).toPrecision(5))
      const alert = { id: newId(), coin: a.coin, kind: a.kind, value: value ?? m.mid, createdAt: Date.now() }
      state.alerts.push(alert)
      save()
      logEvent(`alert set: ${describeAlert(alert)}`)
      return { ok: true, toast: `■ Alert armed: ${describeAlert(alert)}`, card: 'alerts' }
    }
    case 'order': {
      const m = markets.get(a.coin)
      if (!m) return { ok: false, toast: `${a.coin} not on Hyperliquid` }
      const o = await openOrder(a.coin, a.side, a.notionalUsd, m.mid)
      logEvent(`${o.venue} ${o.side} ${o.coin} ${fmtUsd(o.notionalUsd)} @ ${fmtPx(o.entry)}`)
      return { ok: true, toast: `■ ${o.venue === 'paper' ? 'Paper' : 'Testnet'} ${o.side} ${o.coin} filled @ ${fmtPx(o.entry)}`, card: 'positions' }
    }
    case 'close': {
      const m = markets.get(a.coin)
      const { closed, pnl } = await closeCoin(a.coin, m?.mid ?? 0)
      if (!closed.length) return { ok: false, toast: `No open ${a.coin} position` }
      logEvent(`closed ${a.coin}: ${fmtUsd(pnl, true)}`)
      return { ok: true, toast: `■ Closed ${a.coin} · PnL ${fmtUsd(pnl, true)}`, card: 'positions' }
    }
    case 'bet': {
      const board = await getDailyBoard(ctx.coin)
      const rows = board?.rows ?? []
      const row = rows.find(r => r.slug === a.market) ?? rows.slice().sort((x, y) => Math.abs(x.yes - 0.5) - Math.abs(y.yes - 0.5))[0]
      if (!row || !board) return { ok: false, toast: 'No live market to bet on' }
      const price = a.side === 'YES' ? row.yes : 1 - row.yes
      if (price <= 0.001 || price >= 0.999) return { ok: false, toast: 'Market is ~settled; skipping' }
      state.bets.push({ id: newId(), market: row.slug, question: row.question, side: a.side, stakeUsd: a.stakeUsd, price, shares: a.stakeUsd / price, placedAt: Date.now(), url: board.url })
      save()
      logEvent(`paper bet ${a.side} ${fmtUsd(a.stakeUsd)} @ ${Math.round(price * 100)}c: ${row.question}`)
      return { ok: true, toast: `■ Paper ${a.side} ${fmtUsd(a.stakeUsd)} @ ${Math.round(price * 100)}c · ${row.label}` }
    }
    case 'tg_reply': {
      if (!tgEnabled) return { ok: false, toast: 'Telegram not configured' }
      const chatId = a.chatId ?? state.tg.feed[0]?.chatId ?? state.tg.linkedChatIds[0]
      if (!chatId) return { ok: false, toast: 'No Telegram chat to reply to' }
      await sendMessage(chatId, a.text)
      logEvent(`tg reply -> ${chatId}: ${a.text}`)
      return { ok: true, toast: '■ Sent to Telegram' }
    }
    case 'tg_share': {
      if (!tgEnabled) return { ok: false, toast: 'Telegram not configured' }
      const { text, buttons } = await share(a.card)
      const n = await notifyLinked(text, buttons)
      if (!n) return { ok: false, toast: `DM the bot /link ${state.tg.pairCode} first` }
      return { ok: true, toast: '■ Shared to Telegram' }
    }
    case 'unknown': {
      if (a.text === '__clear_triggered') {
        state.alerts = state.alerts.filter(x => !x.triggeredAt); save()
        return { ok: true, toast: '■ Cleared triggered alerts', card: 'alerts' }
      }
      if (a.text.startsWith('__delete_alert:')) {
        const id = a.text.split(':')[1]
        state.alerts = state.alerts.filter(x => x.id !== id); save()
        return { ok: true, toast: '■ Alert deleted', card: 'alerts' }
      }
      if (a.text === '__tg_next') {
        state.tg.feed.shift(); save()
        return { ok: true, toast: state.tg.feed.length ? 'Next message' : 'Inbox zero', card: 'telegram' }
      }
      return { ok: false, toast: `Didn't catch: "${a.text}"` }
    }
  }
}

export function hlTradeLink(coin: string) {
  const url = `https://app.hyperliquid.xyz/trade/${coin}`
  return [{ text: `Open ${coin} in Trust Wallet`, url: trustWalletLink(url) }, { text: 'Hyperliquid', url }]
}
