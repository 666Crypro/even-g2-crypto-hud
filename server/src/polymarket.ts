// Read-only Polymarket Gamma API (public, CORS-enabled, no keys).
import { cached, fetchJson } from './util.ts'

const GAMMA = process.env.PM_GAMMA_URL ?? 'https://gamma-api.polymarket.com'

export interface OddsRow { label: string; strike: number | null; yes: number; volume24h: number; question: string; slug: string }
export interface OddsBoard { title: string; eventSlug: string; url: string; rows: OddsRow[]; volume24h: number }

type GammaMarket = { question: string; slug: string; groupItemTitle?: string; outcomePrices?: string; volume24hr?: number; closed?: boolean; active?: boolean }
type GammaEvent = { title: string; slug: string; markets: GammaMarket[]; volume24hr?: number }

const COIN_NAMES: Record<string, string> = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'xrp' }

/** Polymarket dates its daily "above ___ on <date>" markets in US Eastern time. */
export function etDateParts(d: Date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)!.value
  return { month: get('month').toLowerCase(), day: Number(get('day')), year: Number(get('year')) }
}

export function dailyAboveSlug(coin: string, d: Date): string | null {
  const name = COIN_NAMES[coin]
  if (!name) return null
  const { month, day, year } = etDateParts(d)
  return `${name}-above-on-${month}-${day}-${year}`
}

function parseYes(m: GammaMarket): number | null {
  try {
    const p = JSON.parse(m.outcomePrices ?? '[]')
    const y = Number(p[0])
    return Number.isFinite(y) ? y : null
  } catch {
    return null
  }
}

export function parseStrike(label: string): number | null {
  const m = label.replace(/[$,]/g, '').match(/(\d+(?:\.\d+)?)\s*(k)?/i)
  if (!m) return null
  return Number(m[1]) * (m[2] ? 1000 : 1)
}

/** Pick the `n` strikes closest to spot (sorted ascending) so the ladder brackets the live price. */
export function ladderAroundSpot(rows: OddsRow[], spot: number | undefined, n = 3): OddsRow[] {
  const withStrike = rows.filter(r => r.strike !== null)
  if (!spot) return withStrike.sort((a, b) => b.volume24h - a.volume24h).slice(0, n).sort((a, b) => a.strike! - b.strike!)
  return withStrike
    .sort((a, b) => Math.abs(a.strike! - spot) - Math.abs(b.strike! - spot))
    .slice(0, n)
    .sort((a, b) => a.strike! - b.strike!)
}

async function getEvent(slug: string): Promise<GammaEvent | null> {
  const arr = await fetchJson<GammaEvent[]>(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`)
  return arr[0] ?? null
}

function toBoard(ev: GammaEvent): OddsBoard {
  const rows: OddsRow[] = []
  for (const m of ev.markets) {
    if (m.closed) continue
    const yes = parseYes(m)
    if (yes === null) continue
    const label = m.groupItemTitle || m.question
    rows.push({ label, strike: parseStrike(label), yes, volume24h: Number(m.volume24hr ?? 0), question: m.question, slug: m.slug })
  }
  return { title: ev.title, eventSlug: ev.slug, url: `https://polymarket.com/event/${ev.slug}`, rows, volume24h: Number(ev.volume24hr ?? 0) }
}

const boardCache = new Map<string, () => Promise<OddsBoard | null>>()
/** "BTC above ___ on <tomorrow ET>" board, falling back to today's. */
export function getDailyBoard(coin: string): Promise<OddsBoard | null> {
  let fn = boardCache.get(coin)
  if (!fn) {
    fn = cached(30_000, async () => {
      for (const offsetDays of [1, 0, 2]) {
        const slug = dailyAboveSlug(coin, new Date(Date.now() + offsetDays * 86400_000))
        if (!slug) return null
        const ev = await getEvent(slug)
        if (ev && ev.markets.some(m => !m.closed)) return toBoard(ev)
      }
      return null
    })
    boardCache.set(coin, fn)
  }
  return fn()
}

/** Highest-volume live crypto events, used when a coin has no daily board. */
export const getTrendingCrypto = cached(60_000, async (): Promise<OddsBoard[]> => {
  const evs = await fetchJson<GammaEvent[]>(`${GAMMA}/events?tag_slug=crypto&active=true&closed=false&order=volume24hr&ascending=false&limit=6`)
  return evs.map(toBoard).filter(b => b.rows.length)
})
