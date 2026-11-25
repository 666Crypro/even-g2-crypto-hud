// Server-side alert watcher. Runs 24/7, so alerts still reach Telegram when the glasses app is closed
// (G2 apps cannot show anything in the background).
import { state, save, logEvent, type Alert } from './store.ts'
import type { PerpMarket } from './hyperliquid.ts'
import { describeAlert } from './hud.ts'
import { fmtPx } from './util.ts'

export function isHit(a: Alert, m: PerpMarket): boolean {
  if (a.kind === 'price_above') return m.mid >= a.value
  if (a.kind === 'price_below') return m.mid <= a.value
  return m.fundingApr >= a.value
}

export function evaluate(markets: Map<string, PerpMarket>, now = Date.now()): Alert[] {
  const hits: Alert[] = []
  for (const a of state.alerts) {
    if (a.triggeredAt) continue
    const m = markets.get(a.coin)
    if (m && isHit(a, m)) {
      a.triggeredAt = now
      a.triggeredPx = a.kind === 'funding_apr_above' ? m.fundingApr : m.mid
      hits.push(a)
    }
  }
  if (hits.length) save()
  return hits
}

export function alertMessage(a: Alert): string {
  const px = a.kind === 'funding_apr_above' ? `${a.triggeredPx?.toFixed(1)}% APR` : fmtPx(a.triggeredPx ?? NaN)
  return `🔔 ${describeAlert(a)} hit (${px})`
}

export function markNotified(a: Alert) {
  a.notified = true
  logEvent(`alert hit: ${describeAlert(a)}`)
  save()
}
