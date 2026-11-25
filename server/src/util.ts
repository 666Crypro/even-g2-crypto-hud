// Small shared helpers: formatting tuned for a ~60-char-wide monochrome HUD,
// a TTL cache, and JSON fetch with timeout.

export async function fetchJson<T = unknown>(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

export function postJson<T = unknown>(url: string, body: unknown, timeoutMs = 8000): Promise<T> {
  return fetchJson<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs)
}

/** Memoize an async producer for `ttlMs`; concurrent callers share one in-flight request; stale value is served if a refresh fails. */
export function cached<T>(ttlMs: number, producer: () => Promise<T>): () => Promise<T> {
  let value: T | undefined
  let at = 0
  let inflight: Promise<T> | null = null
  return async () => {
    if (value !== undefined && Date.now() - at < ttlMs) return value
    if (!inflight) {
      inflight = producer()
        .then(v => { value = v; at = Date.now(); return v })
        .catch(err => { if (value !== undefined) return value; throw err })
        .finally(() => { inflight = null })
    }
    return inflight
  }
}

/** 58321.5 -> "58,322"; 3.0123 -> "3.012"; 0.00001234 -> "0.00001234" */
export function fmtPx(px: number): string {
  if (!Number.isFinite(px)) return '—'
  const abs = Math.abs(px)
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : 8
  return px.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** 1234567 -> "$1.2M" */
export function fmtUsd(n: number, signed = false): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : signed ? '+' : ''
  const a = Math.abs(n)
  const body = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(1)}k` : a.toLocaleString('en-US', { maximumFractionDigits: a < 100 ? 2 : 0, minimumFractionDigits: a < 100 ? 2 : 0 })
  return `${sign}$${body}`
}

export function fmtPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export const arrow = (n: number) => (n >= 0 ? '▲' : '▼')

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

export function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}
