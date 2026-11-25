// Read-only Hyperliquid public info API (no keys). https://api.hyperliquid.xyz/info
import { cached, postJson } from './util.ts'

const INFO = process.env.HL_INFO_URL ?? 'https://api.hyperliquid.xyz/info'

export interface PerpMarket {
  coin: string
  mid: number
  mark: number
  prevDay: number
  change24h: number // percent
  fundingHourly: number // fraction per hour
  fundingApr: number // percent, annualized (hourly * 24 * 365)
  openInterestUsd: number
  volume24hUsd: number
  maxLeverage: number
}

type Meta = { universe: { name: string; maxLeverage: number; isDelisted?: boolean }[] }
type Ctx = { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; markPx: string; midPx: string | null }

export const getMarkets = cached(4000, async (): Promise<Map<string, PerpMarket>> => {
  const [meta, ctxs] = await postJson<[Meta, Ctx[]]>(INFO, { type: 'metaAndAssetCtxs' })
  const out = new Map<string, PerpMarket>()
  meta.universe.forEach((u, i) => {
    const c = ctxs[i]
    if (!c || u.isDelisted) return
    const mark = Number(c.markPx)
    const mid = c.midPx ? Number(c.midPx) : mark
    const prev = Number(c.prevDayPx)
    const f = Number(c.funding)
    out.set(u.name, {
      coin: u.name,
      mid,
      mark,
      prevDay: prev,
      change24h: prev ? ((mid - prev) / prev) * 100 : 0,
      fundingHourly: f,
      fundingApr: f * 24 * 365 * 100,
      openInterestUsd: Number(c.openInterest) * mark,
      volume24hUsd: Number(c.dayNtlVlm),
      maxLeverage: u.maxLeverage,
    })
  })
  return out
})

export interface Candle { t: number; o: number; h: number; l: number; c: number }

const candleCache = new Map<string, () => Promise<Candle[]>>()
/** Last 24h of 30m candles, cached 60s per coin. */
export function getCandles(coin: string): Promise<Candle[]> {
  let fn = candleCache.get(coin)
  if (!fn) {
    fn = cached(60_000, async () => {
      const raw = await postJson<{ t: number; o: string; h: string; l: string; c: string }[]>(INFO, {
        type: 'candleSnapshot',
        req: { coin, interval: '30m', startTime: Date.now() - 24 * 3600_000 },
      })
      return raw.map(k => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c }))
    })
    candleCache.set(coin, fn)
  }
  return fn()
}

export interface Position {
  coin: string
  side: 'LONG' | 'SHORT'
  size: number
  entry: number
  leverage: number
  unrealizedPnl: number
  roePct: number
  liquidationPx: number | null
  valueUsd: number
}
export interface AccountState { address: string; equity: number; marginUsed: number; withdrawable: number; positions: Position[] }

type ClearinghouseState = {
  marginSummary: { accountValue: string; totalMarginUsed: string }
  withdrawable: string
  assetPositions: { position: { coin: string; szi: string; entryPx: string; leverage: { value: number }; unrealizedPnl: string; returnOnEquity: string; liquidationPx: string | null; positionValue: string } }[]
}

const acctCache = new Map<string, () => Promise<AccountState>>()
export function getAccount(address: string): Promise<AccountState> {
  let fn = acctCache.get(address)
  if (!fn) {
    fn = cached(5000, async () => {
      const s = await postJson<ClearinghouseState>(INFO, { type: 'clearinghouseState', user: address })
      return {
        address,
        equity: Number(s.marginSummary.accountValue),
        marginUsed: Number(s.marginSummary.totalMarginUsed),
        withdrawable: Number(s.withdrawable),
        positions: s.assetPositions
          .map(({ position: p }) => ({
            coin: p.coin,
            side: Number(p.szi) >= 0 ? ('LONG' as const) : ('SHORT' as const),
            size: Math.abs(Number(p.szi)),
            entry: Number(p.entryPx),
            leverage: p.leverage?.value ?? 1,
            unrealizedPnl: Number(p.unrealizedPnl),
            roePct: Number(p.returnOnEquity) * 100,
            liquidationPx: p.liquidationPx ? Number(p.liquidationPx) : null,
            valueUsd: Number(p.positionValue),
          }))
          .sort((a, b) => b.valueUsd - a.valueUsd),
      }
    })
    acctCache.set(address, fn)
  }
  return fn()
}

/** Biggest funding payers/receivers among liquid perps (OI above threshold). */
export async function getFundingExtremes(minOiUsd = 10_000_000, n = 3) {
  const m = [...(await getMarkets()).values()].filter(x => x.openInterestUsd >= minOiUsd)
  const sorted = m.sort((a, b) => b.fundingApr - a.fundingApr)
  return { top: sorted.slice(0, n), bottom: sorted.slice(-n).reverse(), universe: m.length }
}
