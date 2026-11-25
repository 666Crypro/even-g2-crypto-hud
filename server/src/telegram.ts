// Telegram companion bot (Bot API, long polling - no webhook or public URL needed).
// - Reads crypto mentions from groups the bot is added to -> TELEGRAM card on the glasses.
// - Sends replies you approve on the glasses back into that chat.
// - Pushes price alerts to your linked DM even when the glasses app is closed.
// Without TELEGRAM_BOT_TOKEN it is disabled; TG_DEMO=1 seeds a sample feed and logs sends instead.
import { state, save, logEvent, type TgMessage } from './store.ts'
import { fetchJson } from './util.ts'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
export const tgDemo = !TOKEN && process.env.TG_DEMO === '1'
export const tgEnabled = Boolean(TOKEN) || tgDemo
const API = `https://api.telegram.org/bot${TOKEN}`

export const sentLog: { at: number; chatId: number; text: string }[] = []

type Handler = (cmd: string, args: string, chatId: number) => Promise<string | null>
let commandHandler: Handler = async () => null
export function onCommand(h: Handler) { commandHandler = h }

const TICKER_WORDS: Record<string, string> = { bitcoin: 'BTC', btc: 'BTC', ethereum: 'ETH', eth: 'ETH', solana: 'SOL', sol: 'SOL', hype: 'HYPE', hyperliquid: 'HYPE', doge: 'DOGE', xrp: 'XRP', ton: 'TON' }

export function extractTickers(text: string, known?: Set<string>): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\$([A-Za-z]{2,10})\b/g)) out.add(m[1].toUpperCase())
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) if (TICKER_WORDS[w]) out.add(TICKER_WORDS[w])
  return [...out].filter(t => !known || known.has(t))
}

async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<T> {
  const r = await fetchJson<{ ok: boolean; result: T; description?: string }>(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs)
  if (!r.ok) throw new Error(r.description ?? `telegram ${method} failed`)
  return r.result
}

export interface UrlButton { text: string; url: string }

export async function sendMessage(chatId: number, text: string, buttons: UrlButton[] = []): Promise<void> {
  sentLog.unshift({ at: Date.now(), chatId, text })
  sentLog.length = Math.min(sentLog.length, 30)
  if (!TOKEN) {
    return
  }
  await call('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons.map(b => ({ text: b.text, url: b.url }))] } } : {}),
  }, 10_000)
}

/** Push to every DM that linked itself with /link <code>. */
export async function notifyLinked(text: string, buttons: UrlButton[] = []): Promise<number> {
  const ids = state.tg.linkedChatIds.length ? state.tg.linkedChatIds : tgDemo ? [1] : []
  await Promise.all(ids.map(id => sendMessage(id, text, buttons).catch(err => console.error('[tg] send failed', err.message))))
  return ids.length
}

export function ingest(msg: TgMessage) {
  state.tg.feed = [msg, ...state.tg.feed.filter(m => !(m.chatId === msg.chatId && m.id === msg.id))].slice(0, 50)
  save()
}

type Update = { update_id: number; message?: { message_id: number; date: number; text?: string; chat: { id: number; type: string; title?: string; first_name?: string }; from?: { first_name?: string; username?: string } } }

export async function handleUpdate(u: Update, known?: Set<string>) {
  const msg = u.message
  if (!msg?.text) return
  const chatId = msg.chat.id
  const text = msg.text.trim()
  const cmd = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s)
  if (cmd) {
    const [, name, args] = cmd
    if (name === 'link') {
      if (args.trim() === state.tg.pairCode) {
        if (!state.tg.linkedChatIds.includes(chatId)) state.tg.linkedChatIds.push(chatId)
        save()
        logEvent(`Telegram chat ${chatId} linked`)
        return sendMessage(chatId, 'Linked. Alerts and shared HUD cards from your Even G2 will arrive here.')
      }
      return sendMessage(chatId, 'Wrong code. The pairing code is shown on the TELEGRAM card / phone screen of the G2 app.')
    }
    if (name === 'start' || name === 'help') {
      return sendMessage(chatId, 'Heads-Up Desk for Even G2.\n/link <code> - receive alerts here\n/price BTC - live Hyperliquid price\n/odds BTC - Polymarket ladder\n/alerts - armed alerts\nAdd me to a group (privacy mode off) to see $TICKER mentions on your glasses.')
    }
    const reply = await commandHandler(name, args.trim(), chatId)
    if (reply) await sendMessage(chatId, reply)
    return
  }
  const tickers = extractTickers(text, known)
  if (!tickers.length) return // only crypto-relevant messages make it to the glasses
  ingest({
    id: msg.message_id,
    chatId,
    chatTitle: msg.chat.title ?? msg.chat.first_name ?? 'DM',
    from: msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name ?? '?',
    text,
    date: msg.date * 1000,
    tickers,
  })
}

export function seedDemoFeed() {
  if (!tgDemo || state.tg.feed.length) return
  const now = Date.now()
  ingest({ id: 2, chatId: -1001, chatTitle: 'Alpha Desk', from: '@lena', text: 'SOL funding flipped negative, shorts crowded?', date: now - 300_000, tickers: ['SOL'] })
  ingest({ id: 3, chatId: -1001, chatTitle: 'Alpha Desk', from: '@mira', text: '$ETH reclaiming the range, anyone adding here?', date: now - 60_000, tickers: ['ETH'] })
}

export async function startPolling(getKnown: () => Promise<Set<string>>) {
  if (!TOKEN) return
  console.log('[tg] long polling started')
  for (;;) {
    try {
      const updates = await call<Update[]>('getUpdates', { offset: state.tg.offset, timeout: 25, allowed_updates: ['message'] })
      const known = await getKnown().catch(() => undefined)
      for (const u of updates) {
        state.tg.offset = u.update_id + 1
        await handleUpdate(u, known).catch(err => console.error('[tg] handler', err.message))
      }
      if (updates.length) save()
    } catch (err) {
      console.error('[tg] poll error', (err as Error).message)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}
