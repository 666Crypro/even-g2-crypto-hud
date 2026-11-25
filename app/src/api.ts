// Thin client for the Heads-Up Desk backend. All third-party calls happen server-side,
// so the WebView only needs one whitelisted origin and never holds a key.
export type Card = 'markets' | 'positions' | 'funding' | 'odds' | 'alerts' | 'telegram'
export const CARDS: Card[] = ['markets', 'positions', 'funding', 'odds', 'alerts', 'telegram']

export interface MenuItem { label: string; action: unknown; confirm: boolean }
export interface CardView { id: Card; title: string; body: string; hint: string; actions: MenuItem[]; chart?: number[] }
export interface Snapshot {
  ts: number
  coin: string
  watchlist: string[]
  cards: Record<Card, CardView>
  headers: Record<Card, string>
  recentHits: { id: string; text: string; at: number }[]
  config: { stt: boolean; telegram: boolean; telegramDemo: boolean; executor: string; pairCode: string; linkedChats: number }
  log: { at: number; text: string }[]
  tgSent: { at: number; chatId: number; text: string }[]
}
export interface Proposal { transcript?: string; action: unknown; prompt: string; confirm: boolean }
export interface Result { ok: boolean; toast: string; focus?: string; card?: Card }

export interface Prefs { coin: string; watch: string; hl: string; wallet: string }

export class Api {
  constructor(public base: string, public prefs: () => Prefs) {}

  private qs(extra: Record<string, string> = {}) {
    const p = this.prefs()
    return new URLSearchParams({ coin: p.coin, watch: p.watch, hl: p.hl, wallet: p.wallet, ...extra }).toString()
  }

  async snapshot(): Promise<Snapshot> {
    const r = await fetch(`${this.base}/api/snapshot?${this.qs()}`)
    if (!r.ok) throw new Error(`snapshot ${r.status}`)
    return r.json()
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...this.prefs(), ...(body as object) }) })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error ?? `${path} ${r.status}`)
    return j
  }

  intent(text: string, card: Card) { return this.post<Proposal>('/api/intent', { text, card }) }
  intentFromAction(action: unknown) { return this.post<Proposal>('/api/propose', { action }) }
  execute(action: unknown) { return this.post<Result>('/api/execute', { action }) }

  async voice(pcm: Uint8Array, card: Card): Promise<Proposal> {
    const r = await fetch(`${this.base}/api/voice?${this.qs({ card })}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm as Uint8Array<ArrayBuffer> })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error ?? `voice ${r.status}`)
    return j
  }
}
