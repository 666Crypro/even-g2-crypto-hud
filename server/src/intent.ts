// Deterministic intent parser for short spoken/typed commands. Whisper output -> one proposed action.
// Every write action is returned as a *proposal*; nothing executes until the user taps to confirm.

export type Card = 'markets' | 'positions' | 'funding' | 'odds' | 'alerts' | 'telegram'
export const CARDS: Card[] = ['markets', 'positions', 'funding', 'odds', 'alerts', 'telegram']

export type Action =
  | { type: 'focus'; coin: string }
  | { type: 'navigate'; card: Card }
  | { type: 'alert'; coin: string; kind: 'price_above' | 'price_below' | 'funding_apr_above'; value?: number; pct?: number }
  | { type: 'order'; coin: string; side: 'LONG' | 'SHORT'; notionalUsd: number }
  | { type: 'close'; coin: string }
  | { type: 'bet'; side: 'YES' | 'NO'; stakeUsd: number; market?: string }
  | { type: 'tg_reply'; text: string; chatId?: number }
  | { type: 'tg_share'; card?: Card }
  | { type: 'unknown'; text: string }

export interface Ctx { coin?: string; card?: Card; knownCoins?: Set<string> }

const ALIASES: Record<string, string> = {
  bitcoin: 'BTC', btc: 'BTC', ethereum: 'ETH', ether: 'ETH', eth: 'ETH', solana: 'SOL', sol: 'SOL', hype: 'HYPE', hyperliquid: 'HYPE',
  doge: 'DOGE', dogecoin: 'DOGE', xrp: 'XRP', ripple: 'XRP', sui: 'SUI', avax: 'AVAX', link: 'LINK', chainlink: 'LINK', ton: 'TON', bnb: 'BNB',
}

const NAV: Record<string, Card> = {
  market: 'markets', markets: 'markets', prices: 'markets', price: 'markets', positions: 'positions', position: 'positions', portfolio: 'positions', wallet: 'positions',
  funding: 'funding', odds: 'odds', polymarket: 'odds', predictions: 'odds', alerts: 'alerts', telegram: 'telegram', messages: 'telegram', chats: 'telegram',
}

/** "100k" -> 100000, "3.2 thousand" -> 3200, "$1,500" -> 1500 */
export function parseAmount(s: string): number | null {
  const m = s.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)\s*(k|thousand|m|million|grand)?\b/i)
  if (!m) return null
  const mult = { k: 1e3, thousand: 1e3, grand: 1e3, m: 1e6, million: 1e6 }[(m[2] ?? '').toLowerCase() as 'k'] ?? 1
  return Number(m[1]) * mult
}

export function findCoin(words: string[], ctx: Ctx): string | undefined {
  for (const w of words) {
    const clean = w.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (ALIASES[clean]) return ALIASES[clean]
    if (ctx.knownCoins?.has(clean.toUpperCase()) && clean.length >= 2 && !/^\d/.test(clean) && !STOP.has(clean)) return clean.toUpperCase()
  }
  return undefined
}
const STOP = new Set(['on', 'at', 'to', 'me', 'my', 'up', 'is', 'it', 'a', 'an', 'the', 'of', 'yes', 'no', 'and', 'for', 'in', 'or', 'if', 'go', 'k'])

export function parseIntent(raw: string, ctx: Ctx = {}): Action {
  const text = raw.trim().replace(/[.!?]+$/, '')
  const lower = text.toLowerCase()
  const words = lower.split(/\s+/)
  const coin = findCoin(words, ctx) ?? ctx.coin ?? 'BTC'

  // Telegram first: free text after "reply"/"tell them"/"send" must not be parsed as trading words.
  const reply = text.match(/^(?:reply|respond|tell (?:them|the group)|send(?: message)?)\s*[:,.]?\s*(.+)$/i)
  if (reply && !/^(to )?telegram$/i.test(reply[1])) return { type: 'tg_reply', text: reply[1].trim() }
  if (/\b(share|send|post)\b.*\b(telegram|tg|group|chat)\b/.test(lower)) return { type: 'tg_share', card: ctx.card }

  if (/\b(alert|notify|ping|warn)\b/.test(lower)) {
    if (/\bfunding\b/.test(lower)) {
      const v = parseAmount(lower.replace(/^[^\d$]*/, ''))
      return { type: 'alert', coin, kind: 'funding_apr_above', value: v ?? 20 }
    }
    const pct = lower.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/)
    const down = /\b(below|under|drops?|falls?|down|beneath|less)\b/.test(lower)
    if (pct) return { type: 'alert', coin, kind: down ? 'price_below' : 'price_above', pct: Number(pct[1]) * (down ? -1 : 1) }
    const afterKeyword = lower.split(/\b(?:above|over|below|under|at|hits?|crosses|reaches|to)\b/).slice(1).join(' ')
    const v = parseAmount(afterKeyword || lower.replace(/^[^\d$]*/, ''))
    if (v !== null) return { type: 'alert', coin, kind: down ? 'price_below' : 'price_above', value: v }
    return { type: 'alert', coin, kind: down ? 'price_below' : 'price_above', pct: down ? -2 : 2 }
  }

  if (/\b(close|flatten|exit)\b/.test(lower)) return { type: 'close', coin }

  const bet = lower.match(/\b(?:bet|buy|take)\s+(yes|no)\b/) ?? lower.match(/\b(yes|no)\b.*\bbet\b/)
  if (bet) {
    const amt = parseAmount(lower.replace(/\b(yes|no)\b/g, '')) ?? 10
    return { type: 'bet', side: bet[1].toUpperCase() as 'YES' | 'NO', stakeUsd: amt }
  }

  const ord = lower.match(/\b(long|buy|short|sell)\b/)
  if (ord) {
    const side = /long|buy/.test(ord[1]) ? 'LONG' : 'SHORT'
    // ignore digits glued to the ticker; take the first standalone amount
    const amt = parseAmount(lower.replace(/\b(btc|eth|sol)\b/g, '')) ?? 100
    return { type: 'order', coin, side, notionalUsd: amt }
  }

  for (const w of words) {
    const nav = NAV[w.replace(/[^a-z]/g, '')]
    if (nav && !(nav === 'markets' && findCoin(words, ctx))) return { type: 'navigate', card: nav }
  }
  const explicit = findCoin(words, ctx)
  if (explicit) return { type: 'focus', coin: explicit }
  return { type: 'unknown', text }
}
