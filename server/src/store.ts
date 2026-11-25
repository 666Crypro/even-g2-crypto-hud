// Tiny JSON-file state store (alerts, paper book, Telegram links/feed). Lives in server/data/ (git-ignored).
import fs from 'node:fs'
import path from 'node:path'

export interface Alert {
  id: string
  coin: string
  kind: 'price_above' | 'price_below' | 'funding_apr_above'
  value: number
  createdAt: number
  triggeredAt?: number
  triggeredPx?: number
  notified?: boolean
}
export interface PaperOrder { id: string; coin: string; side: 'LONG' | 'SHORT'; notionalUsd: number; size: number; entry: number; openedAt: number; closedAt?: number; exit?: number; venue: 'paper' | 'hl-testnet'; ref?: string }
export interface PaperBet { id: string; market: string; question: string; side: 'YES' | 'NO'; stakeUsd: number; price: number; shares: number; placedAt: number; url: string }
export interface TgMessage { id: number; chatId: number; chatTitle: string; from: string; text: string; date: number; tickers: string[] }
export interface State {
  alerts: Alert[]
  paper: PaperOrder[]
  bets: PaperBet[]
  tg: { linkedChatIds: number[]; feed: TgMessage[]; offset: number; pairCode: string }
  log: { at: number; text: string }[]
}

const DATA_DIR = process.env.DATA_DIR ?? path.resolve(import.meta.dirname, '../data')
const FILE = path.join(DATA_DIR, 'state.json')

function fresh(): State {
  return { alerts: [], paper: [], bets: [], tg: { linkedChatIds: [], feed: [], offset: 0, pairCode: String(Math.floor(100000 + Math.random() * 900000)) }, log: [] }
}

export const state: State = (() => {
  try {
    return { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }
  } catch {
    return fresh()
  }
})()

let saveTimer: NodeJS.Timeout | null = null
export function save() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2))
  }, 200)
}

export function logEvent(text: string) {
  state.log.unshift({ at: Date.now(), text })
  state.log.length = Math.min(state.log.length, 50)
  save()
}

export const newId = () => Math.random().toString(36).slice(2, 10)

export function resetState() {
  Object.assign(state, fresh())
  save()
}
