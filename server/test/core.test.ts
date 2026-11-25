import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.DATA_DIR = '/tmp/hud-test-data-' + process.pid
import { parseIntent, parseAmount } from '../src/intent.ts'
import { ladderAroundSpot, parseStrike, dailyAboveSlug } from '../src/polymarket.ts'
import { evaluate, isHit } from '../src/alerts.ts'
import { state, resetState } from '../src/store.ts'
import { extractTickers, handleUpdate } from '../src/telegram.ts'
import { pcmToWav } from '../src/stt.ts'
import { bar, pnlOf, renderCards, draftReply } from '../src/hud.ts'
import { hlPrice } from '../src/executor.ts'
import type { PerpMarket } from '../src/hyperliquid.ts'

const known = new Set(['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE'])
const mk = (coin: string, mid: number, fundingApr = 10): PerpMarket => ({ coin, mid, mark: mid, prevDay: mid * 0.98, change24h: 2, fundingHourly: fundingApr / 100 / 8760, fundingApr, openInterestUsd: 5e8, volume24hUsd: 1e9, maxLeverage: 40 })

test('amounts', () => {
  assert.equal(parseAmount('60k'), 60000)
  assert.equal(parseAmount('$1,500'), 1500)
  assert.equal(parseAmount('3.2 thousand'), 3200)
})

test('voice intents', () => {
  assert.deepEqual(parseIntent('Alert bitcoin above 60k.', { knownCoins: known }), { type: 'alert', coin: 'BTC', kind: 'price_above', value: 60000 })
  assert.deepEqual(parseIntent('alert me if eth drops below 2,900', { knownCoins: known }), { type: 'alert', coin: 'ETH', kind: 'price_below', value: 2900 })
  assert.deepEqual(parseIntent('alert sol down 5 percent', { knownCoins: known }), { type: 'alert', coin: 'SOL', kind: 'price_below', pct: -5 })
  assert.deepEqual(parseIntent('notify me when hype funding is above 30', { knownCoins: known }), { type: 'alert', coin: 'HYPE', kind: 'funding_apr_above', value: 30 })
  assert.deepEqual(parseIntent('Long ETH 200 dollars', { knownCoins: known }), { type: 'order', coin: 'ETH', side: 'LONG', notionalUsd: 200 })
  assert.deepEqual(parseIntent('short it', { coin: 'SOL', knownCoins: known }), { type: 'order', coin: 'SOL', side: 'SHORT', notionalUsd: 100 })
  assert.deepEqual(parseIntent('bet yes 20', { knownCoins: known }), { type: 'bet', side: 'YES', stakeUsd: 20 })
  assert.deepEqual(parseIntent('close ETH', { knownCoins: known }), { type: 'close', coin: 'ETH' })
  assert.deepEqual(parseIntent('Reply: on it, buying the dip', { knownCoins: known }), { type: 'tg_reply', text: 'on it, buying the dip' })
  assert.deepEqual(parseIntent('share this to telegram', { card: 'odds', knownCoins: known }), { type: 'tg_share', card: 'odds' })
  assert.deepEqual(parseIntent('show funding', { knownCoins: known }), { type: 'navigate', card: 'funding' })
  assert.deepEqual(parseIntent('doge', { knownCoins: known }), { type: 'focus', coin: 'DOGE' })
  assert.equal(parseIntent('what a lovely day', { knownCoins: known }).type, 'unknown')
})

test('polymarket ladder brackets spot', () => {
  const rows = [52, 54, 56, 58, 60, 62].map(k => ({ label: `${k},000`, strike: k * 1000, yes: 0.5, volume24h: 1, question: '', slug: String(k) }))
  assert.deepEqual(ladderAroundSpot(rows, 58_300).map(r => r.strike), [56000, 58000, 60000])
  assert.equal(parseStrike('↑ 97,500'), 97500)
  assert.equal(dailyAboveSlug('BTC', new Date('2026-11-26T15:00:00Z')), 'bitcoin-above-on-november-26-2026')
})

test('alerts fire once', () => {
  resetState()
  state.alerts.push({ id: 'a', coin: 'BTC', kind: 'price_above', value: 60000, createdAt: 0 })
  state.alerts.push({ id: 'b', coin: 'ETH', kind: 'price_below', value: 2000, createdAt: 0 })
  const m = new Map([['BTC', mk('BTC', 60100)], ['ETH', mk('ETH', 2500)]])
  assert.deepEqual(evaluate(m).map(a => a.id), ['a'])
  assert.deepEqual(evaluate(m), [])
  assert.ok(isHit({ id: 'c', coin: 'HYPE', kind: 'funding_apr_above', value: 20, createdAt: 0 }, mk('HYPE', 30, 25)))
})

test('telegram: only crypto mentions reach the glasses; /link pairs', async () => {
  resetState()
  assert.deepEqual(extractTickers('$ETH reclaiming, bitcoin next', known).sort(), ['BTC', 'ETH'])
  await handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, text: 'lunch at 1?', chat: { id: -5, type: 'group', title: 'G' }, from: { username: 'a' } } }, known)
  await handleUpdate({ update_id: 2, message: { message_id: 2, date: 1, text: 'SOL looks heavy', chat: { id: -5, type: 'group', title: 'G' }, from: { username: 'b' } } }, known)
  assert.equal(state.tg.feed.length, 1)
  assert.equal(state.tg.feed[0].from, '@b')
  await handleUpdate({ update_id: 3, message: { message_id: 3, date: 1, text: `/link ${state.tg.pairCode}`, chat: { id: 42, type: 'private' } } }, known)
  assert.deepEqual(state.tg.linkedChatIds, [42])
})

test('wav header', () => {
  const wav = pcmToWav(new Uint8Array(3200))
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF')
  assert.equal(wav.length, 3244)
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 16000)
})

test('hud helpers', () => {
  assert.equal(bar(0.57), '██████────')
  assert.equal(pnlOf({ side: 'SHORT', size: 2, entry: 100 }, 90), 20)
  assert.equal(hlPrice(58321.77, 5), '58322')
  assert.equal(hlPrice(1.234567, 2), '1.2346')
  assert.match(draftReply({ text: '$ETH', tickers: ['ETH'] }, new Map([['ETH', mk('ETH', 3012)]])), /^ETH 3,012/)
})

test('cards render within display budget', () => {
  resetState()
  const markets = new Map(['BTC', 'ETH', 'SOL', 'HYPE'].map((c, i) => [c, mk(c, [58000, 3000, 140, 30][i])]))
  const cards = renderCards({
    coin: 'BTC', watchlist: ['BTC', 'ETH', 'SOL', 'HYPE'], markets, candles: [], account: null, wallet: null,
    funding: { top: [markets.get('BTC')!], bottom: [markets.get('SOL')!], universe: 4 }, board: null, ladder: [], state,
    tgEnabled: true, tgDemo: false, executor: 'paper', now: new Date(),
  })
  for (const c of Object.values(cards)) {
    assert.ok(c.body.split('\n').length <= 7, `${c.id} too many lines`)
    assert.ok(c.body.length < 1000, `${c.id} over SDK text limit`)
    for (const a of c.actions) assert.ok(a.label.length <= 64, `${a.label} too long for a list item`)
    assert.ok(c.actions.length <= 20)
  }
})
