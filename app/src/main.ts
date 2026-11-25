// Heads-Up Desk: glanceable crypto HUD for Even G2.
// Read: swipe through 6 cards (markets, positions, funding, Polymarket odds, alerts, Telegram).
// Write: tap -> one-tap action list -> tap to confirm; hold -> speak a command -> tap to confirm.
// Nothing that moves (paper) money or sends a message happens without an explicit confirm tap.
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
  AudioInputSource,
  MenuContainerProperty,
  MenuItemProperty,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { Api, CARDS, type Card, type Snapshot, type Proposal, type Prefs, type MenuItem } from './api'
import { sparklinePng, blankPng, pcmLevel, CHART_W, CHART_H } from './chart'
import { mountPhone, type PhoneHooks } from './phone'

const W = 576
const HDR_H = 38
const FOOT_H = 38
const MAIN_H = 288 - HDR_H - FOOT_H
const ID = { hdr: 1, main: 2, foot: 3, chart: 4 } as const
const NAME = { hdr: 'hdr', main: 'main', foot: 'foot', chart: 'chart', list: 'actions' } as const
const POLL_MS = 5000

const MENU = new MenuContainerProperty({
  menuItems: [
    new MenuItemProperty({ itemName: 'Refresh', itemID: 1 }),
    new MenuItemProperty({ itemName: 'Next coin', itemID: 2 }),
    new MenuItemProperty({ itemName: 'Alert +2%', itemID: 3 }),
    new MenuItemProperty({ itemName: 'Alert -2%', itemID: 4 }),
    new MenuItemProperty({ itemName: 'Share to Telegram', itemID: 5 }),
  ],
})

// ---------- prefs (persisted through the bridge so they survive WebView reloads) ----------
const DEFAULT_PREFS: Prefs = { coin: 'BTC', watch: 'BTC,ETH,SOL,HYPE', hl: '', wallet: '' }
let prefs: Prefs = { ...DEFAULT_PREFS }
const apiBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''
const api = new Api(apiBase, () => prefs)

// ---------- UI state ----------
type Mode = 'card' | 'actions' | 'confirm' | 'listening' | 'thinking'
let mode: Mode = 'card'
let layout: 'card' | 'list' = 'card'
let cardIdx = 0
let snap: Snapshot | null = null
let actions: MenuItem[] = []
let pending: Proposal | null = null
let toast: { text: string; until: number } | null = null
let seenHits = new Set<string>()
const sent: Record<string, string> = {}
let imageKey = ''
let imageChain: Promise<unknown> = Promise.resolve()
let pcmChunks: Uint8Array[] = []
let level = 0

const card = (): Card => CARDS[cardIdx]

// ---------- container factories ----------
function hdr(content: string) {
  return new TextContainerProperty({ xPosition: 0, yPosition: 0, width: W, height: HDR_H, borderWidth: 0, paddingLength: 0, containerID: ID.hdr, containerName: NAME.hdr, content, textColor: 2, isEventCapture: 0, zOrderIndex: 2 })
}
function foot(content: string) {
  return new TextContainerProperty({ xPosition: 0, yPosition: 288 - FOOT_H, width: W, height: FOOT_H, borderWidth: 0, paddingLength: 0, containerID: ID.foot, containerName: NAME.foot, content, textColor: 2, isEventCapture: 0, zOrderIndex: 4 })
}
function cardPage(h: string, body: string, f: string) {
  return {
    containerTotalNum: 4,
    textObject: [
      hdr(h),
      new TextContainerProperty({ xPosition: 0, yPosition: HDR_H, width: W, height: MAIN_H, borderWidth: 0, paddingLength: 6, containerID: ID.main, containerName: NAME.main, content: body, textColor: 4, isEventCapture: 1, zOrderIndex: 3 }),
      foot(f),
    ],
    imageObject: [new ImageContainerProperty({ xPosition: W - CHART_W - 8, yPosition: HDR_H + 18, width: CHART_W, height: CHART_H, containerID: ID.chart, containerName: NAME.chart, zOrderIndex: 1 })],
    menuObject: MENU,
  }
}

let bridge: EvenAppBridge

async function upgrade(key: 'hdr' | 'main' | 'foot', content: string, textColor?: number) {
  const v = `${textColor ?? '-'}|${content}`
  if (sent[key] === v) return
  sent[key] = v
  await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: ID[key], containerName: NAME[key], content, ...(textColor !== undefined ? { textColor } : {}) }))
}

function pushImage(key: string, make: () => Promise<Uint8Array>) {
  if (layout !== 'card' || key === imageKey) return
  imageKey = key
  imageChain = imageChain.then(async () => {
    if (imageKey !== key) return // superseded while queued
    const r = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: ID.chart, containerName: NAME.chart, imageData: await make() }))
    if (r !== 'success') console.warn('[heads-up] image', r)
  }).catch(err => console.warn('[heads-up] image error', err))
}

async function toCardLayout() {
  if (layout === 'card') return
  layout = 'card'
  for (const k of Object.keys(sent)) delete sent[k]
  imageKey = ''
  await bridge.rebuildPageContainer(new RebuildPageContainer(cardPage(' ', ' ', ' ')))
}

async function toListLayout(title: string, items: string[]) {
  layout = 'list'
  for (const k of Object.keys(sent)) delete sent[k]
  imageKey = ''
  await bridge.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 3,
    textObject: [hdr(title), foot('swipe: move · tap: select · double-tap: back')],
    listObject: [new ListContainerProperty({
      xPosition: 0, yPosition: HDR_H, width: W, height: MAIN_H, borderWidth: 1, borderColor: 6, borderRadius: 6, paddingLength: 4,
      containerID: ID.main, containerName: NAME.list, isEventCapture: 1, zOrderIndex: 3,
      itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: W - 16, isItemSelectBorderEn: 1, itemName: items }),
    })],
    menuObject: MENU,
  }))
}

// ---------- rendering ----------
function footerText(): string {
  if (toast && Date.now() < toast.until) return toast.text
  toast = null
  return snap?.cards[card()].hint ?? 'loading…'
}

const VOICE_TIPS: Record<Card, string> = {
  markets: 'Try: "alert bitcoin above 60k"\n"long ETH 200"   "show solana"',
  positions: 'Try: "close ETH"   "short SOL 100"\n"share to telegram"',
  funding: 'Try: "alert hype funding above 30"\n"show funding"   "show doge"',
  odds: 'Try: "bet yes 20"   "bet no 10"\n"alert bitcoin above 58k"',
  alerts: 'Try: "alert eth below 2.9k"\n"alert sol up 5 percent"',
  telegram: 'Say your reply, e.g.\n"reply: on it, adding on dips"',
}

function meter(l: number) {
  const n = Math.round(l * 16)
  return '█'.repeat(n) + '─'.repeat(16 - n)
}

async function render() {
  phone.update({ snap, mode, card: card(), pending, toast: toast?.text })
  if (mode === 'actions') return
  await toCardLayout()
  if (mode === 'listening') {
    await upgrade('hdr', `VOICE · ${card().toUpperCase()}  ·  ${prefs.coin}`)
    await upgrade('main', `● Listening…\n\n${meter(level)}\n\n${VOICE_TIPS[card()]}`)
    await upgrade('foot', 'release to send')
    pushImage('blank', blankPng)
    return
  }
  if (mode === 'thinking') {
    await upgrade('main', '◌ Transcribing…')
    return
  }
  if (mode === 'confirm' && pending) {
    await upgrade('hdr', pending.confirm ? 'CONFIRM' : 'HEARD')
    const heard = pending.transcript ? `"${pending.transcript}"\n\n` : ''
    const unknown = (pending.action as { type?: string })?.type === 'unknown'
    const choices = unknown ? 'hold to try again · double-tap = back' : pending.confirm ? '▶ tap = confirm\n   double-tap = cancel' : '▶ doing it…'
    await upgrade('main', `${heard}${pending.prompt}\n\n${choices}`)
    await upgrade('foot', 'paper / testnet only · nothing sent until you tap')
    pushImage('blank', blankPng)
    return
  }
  if (!snap) {
    await upgrade('main', 'HEADS-UP DESK\n\nConnecting to market data…')
    return
  }
  const view = snap.cards[card()]
  await upgrade('hdr', snap.headers[card()])
  await upgrade('main', view.body)
  await upgrade('foot', footerText(), toast ? 4 : 2)
  if (view.chart?.length) pushImage(`chart:${snap.coin}:${view.chart.length}:${view.chart[view.chart.length - 1]}`, () => sparklinePng(view.chart!))
  else pushImage('blank', blankPng)
}

function showToast(text: string, ms = 3000) {
  toast = { text: text.length > 60 ? text.slice(0, 59) + '…' : text, until: Date.now() + ms }
  setTimeout(() => void render(), ms + 50)
}

// ---------- data ----------
async function refresh() {
  try {
    snap = await api.snapshot()
    for (const h of snap.recentHits) {
      if (seenHits.has(h.id)) continue
      seenHits.add(h.id)
      if (snap.ts - h.at < 60_000) showToast(`★ ${h.text.replace(/^\S+\s/, '')}`, 6000)
    }
  } catch (err) {
    console.warn('[heads-up] snapshot failed', err)
    showToast('⚠ offline · retrying')
  }
  if (mode === 'card') await render()
}

// ---------- actions ----------
async function openActions() {
  const view = snap?.cards[card()]
  if (!view?.actions.length) return showToast('no actions on this card')
  actions = view.actions.slice(0, 20)
  mode = 'actions'
  phone.update({ snap, mode, card: card(), pending, toast: toast?.text })
  await toListLayout(`${view.title} · ACTIONS`, actions.map(a => a.label.slice(0, 64)))
}

async function choose(item: MenuItem) {
  if (item.confirm) {
    pending = { action: item.action, prompt: item.label + '?', confirm: true }
    try { pending = { ...(await api.intentFromAction(item.action)) } } catch { /* keep label */ }
    mode = 'confirm'
    return render()
  }
  return run(item.action)
}

async function run(action: unknown) {
  mode = 'card'
  pending = null
  try {
    const r = await api.execute(action)
    if (r.focus) prefs.coin = r.focus
    if (r.card) cardIdx = CARDS.indexOf(r.card)
    showToast(r.toast)
    if (r.focus || r.card) { snap = null; await refresh(); return }
  } catch (err) {
    showToast(`⚠ ${(err as Error).message}`)
  }
  await refresh()
}

async function handleProposal(p: Proposal) {
  pending = p
  mode = 'confirm'
  if (!p.confirm && (p.action as { type?: string })?.type !== 'unknown') {
    // reads and alerts run immediately (still shown, so you know what was heard)
    await render()
    setTimeout(() => { if (pending === p) void run(p.action) }, 900)
    return
  }
  await render()
}

async function command(text: string) {
  try {
    await handleProposal(await api.intent(text, card()))
  } catch (err) {
    showToast(`⚠ ${(err as Error).message}`)
  }
}

// ---------- voice (push-to-talk on long press) ----------
// ?demoMic in the URL replays bundled 16 kHz PCM clips (synthesized speech) as if they came from the G2 mic,
// paced at the device's 100 ms / 3200-byte frames. Only for headless simulator runs and demos without a mic.
const demoMic = new URLSearchParams(location.search).has('demoMic')
let demoClip = 0
let demoTimer = 0
async function feedDemoMic() {
  const clip = (demoClip++ % 4) + 1
  const buf = new Uint8Array(await (await fetch(`${import.meta.env.BASE_URL}demo-mic/${clip}.pcm`)).arrayBuffer())
  let off = 0
  demoTimer = window.setInterval(() => {
    if (mode !== 'listening' || off >= buf.length) return clearInterval(demoTimer)
    onPcm(buf.slice(off, off + 3200))
    off += 3200
  }, 100)
}

async function startListening() {
  if (mode === 'confirm' && (pending?.action as { type?: string })?.type === 'unknown') mode = 'card'
  if (mode !== 'card') return
  pcmChunks = []
  level = 0
  mode = 'listening'
  await render()
  if (demoMic) return void feedDemoMic()
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
  if (!ok) console.warn('[heads-up] mic did not start')
}

async function stopListening() {
  if (mode !== 'listening') return
  clearInterval(demoTimer)
  if (!demoMic) await bridge.audioControl(false)
  mode = 'thinking'
  await render()
  const total = pcmChunks.reduce((s, c) => s + c.length, 0)
  const pcm = new Uint8Array(total)
  let o = 0
  for (const c of pcmChunks) { pcm.set(c, o); o += c.length }
  console.log(`[heads-up] voice: ${pcmChunks.length} frames, ${total} bytes`)
  try {
    await handleProposal(await api.voice(pcm, card()))
  } catch (err) {
    mode = 'card'
    showToast(`⚠ ${(err as Error).message}`, 4000)
    await render()
  }
}

let meterTimer = 0
function onPcm(chunk: Uint8Array) {
  if (mode !== 'listening') return
  pcmChunks.push(chunk)
  level = level * 0.6 + pcmLevel(chunk) * 0.4
  if (!meterTimer) meterTimer = window.setTimeout(() => { meterTimer = 0; void render() }, 150) // BLE-friendly throttle
}

// ---------- input routing ----------
function typeOf(env?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!env) return null
  return env.eventType ?? OsEventTypeList.CLICK_EVENT // CLICK (0) is omitted on the wire
}

async function onBack() {
  if (mode === 'card') return bridge.shutDownPageContainer(1) // root: system exit dialog
  if (mode === 'listening') await bridge.audioControl(false)
  mode = 'card'
  pending = null
  await render()
}

async function onTap() {
  if (mode === 'card') return openActions()
  if (mode === 'confirm' && pending && (pending.action as { type?: string })?.type !== 'unknown') return run(pending.action)
}

async function step(dir: 1 | -1) {
  if (mode !== 'card') return
  cardIdx = (cardIdx + dir + CARDS.length) % CARDS.length
  await render()
}

const menuHandlers: Record<number, () => unknown> = {
  1: () => refresh(),
  2: () => {
    const w = snap?.watchlist ?? ['BTC']
    return run({ type: 'focus', coin: w[(w.indexOf(prefs.coin) + 1) % w.length] })
  },
  3: () => command(`alert ${prefs.coin} up 2%`),
  4: () => command(`alert ${prefs.coin} down 2%`),
  5: () => handleProposal({ action: { type: 'tg_share', card: card() }, prompt: `Share ${card()} card to your Telegram?`, confirm: true }),
}

function onEvent(event: Parameters<Parameters<EvenAppBridge['onEvenHubEvent']>[0]>[0]) {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) return onPcm(pcm)

  const menuId = event.menuItemClickEvent?.itemID
  if (menuId !== undefined) { if (mode === 'actions') void onBack(); return void menuHandlers[menuId]?.() }

  const sys = typeOf(event.sysEvent)
  if (sys === OsEventTypeList.LONG_PRESS_EVENT) return void startListening()
  if (sys === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return void stopListening()
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) return cleanup()

  const list = event.listEvent
  const lt = typeOf(list)
  const tt = typeOf(event.textEvent)
  const any = sys ?? lt ?? tt

  if (any === OsEventTypeList.DOUBLE_CLICK_EVENT) return void onBack()

  if (mode === 'actions' && list && lt === OsEventTypeList.CLICK_EVENT) {
    const byName = actions.findIndex(a => a.label.slice(0, 64) === list.currentSelectItemName)
    const idx = byName >= 0 ? byName : list.currentSelectItemIndex ?? 0
    const item = actions[idx]
    if (item) { mode = 'card'; void choose(item) }
    return
  }
  if (tt === OsEventTypeList.SCROLL_BOTTOM_EVENT) return void step(1)
  if (tt === OsEventTypeList.SCROLL_TOP_EVENT) return void step(-1)
  if (any === OsEventTypeList.CLICK_EVENT && mode !== 'actions') return void onTap()
}

let pollTimer = 0
let unsubscribe = () => {}
function cleanup() {
  clearInterval(pollTimer)
  void bridge.audioControl(false)
  unsubscribe()
}

// ---------- phone companion screen ----------
const hooks: PhoneHooks = {
  async savePrefs(p) {
    prefs = { ...prefs, ...p }
    await bridge?.setLocalStorage('hud.prefs', JSON.stringify(prefs))
    snap = null
    await refresh()
  },
  command: text => command(text),
  tap: () => void onTap(),
  back: () => void onBack(),
  next: () => void step(1),
  prev: () => void step(-1),
}
const phone = mountPhone(hooks, () => prefs)

// ---------- boot ----------
bridge = await waitForEvenAppBridge()
try {
  const raw = await bridge.getLocalStorage('hud.prefs')
  if (raw) prefs = { ...DEFAULT_PREFS, ...JSON.parse(raw) }
} catch { /* first run */ }
phone.loadPrefs(prefs)

const created = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(cardPage('HEADS-UP DESK', 'HEADS-UP DESK\n\nConnecting to Hyperliquid · Polymarket · Telegram…', 'swipe: cards · tap: act · hold: speak')))
if (created !== 0) console.error('[heads-up] createStartUpPageContainer failed', created)
unsubscribe = bridge.onEvenHubEvent(onEvent)
await refresh()
pollTimer = window.setInterval(() => { if (mode === 'card') void refresh() }, POLL_MS)
console.log('[heads-up] ready')

// expose for the simulator automation harness / debugging
Object.assign(window as object, { hud: { command, step, onTap, onBack, refresh, state: () => ({ mode, card: card(), prefs }) } })
