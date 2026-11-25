// Order execution: PAPER by default (fills at Hyperliquid mid). If HL_TESTNET_PRIVATE_KEY is set,
// market-style IOC orders go to Hyperliquid TESTNET instead. There is deliberately no mainnet path.
import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { privateKeyToAccount } from 'viem/accounts'
import { state, save, newId, type PaperOrder } from './store.ts'

const TESTNET_KEY = process.env.HL_TESTNET_PRIVATE_KEY ?? ''
export const executorKind: 'paper' | 'hl-testnet' = /^0x[0-9a-fA-F]{64}$/.test(TESTNET_KEY) ? 'hl-testnet' : 'paper'

let testnet: { exchange: ExchangeClient; info: InfoClient; address: string } | null = null
function getTestnet() {
  if (!testnet) {
    const wallet = privateKeyToAccount(TESTNET_KEY as `0x${string}`)
    const transport = new HttpTransport({ isTestnet: true })
    testnet = { exchange: new ExchangeClient({ transport, wallet }), info: new InfoClient({ transport }), address: wallet.address }
  }
  return testnet
}

/** Hyperliquid price rules: <= 5 significant figures, <= (6 - szDecimals) decimals for perps. */
export function hlPrice(px: number, szDecimals: number): string {
  const sig = Number(px.toPrecision(5))
  const dec = Math.max(0, 6 - szDecimals)
  return String(Number(sig.toFixed(dec)))
}

async function testnetOrder(coin: string, isBuy: boolean, notionalUsd: number, reduceOnly = false, sizeOverride?: number) {
  const { exchange, info } = getTestnet()
  const [meta, ctxs] = await info.metaAndAssetCtxs()
  const idx = meta.universe.findIndex(u => u.name === coin)
  if (idx < 0) throw new Error(`${coin} not listed on testnet`)
  const szDec = meta.universe[idx].szDecimals
  const mid = Number(ctxs[idx].midPx ?? ctxs[idx].markPx)
  const size = sizeOverride ?? notionalUsd / mid
  const s = size.toFixed(szDec)
  if (Number(s) <= 0) throw new Error('size rounds to zero')
  const limit = hlPrice(mid * (isBuy ? 1.01 : 0.99), szDec) // 1% slippage cap, IOC = market-like
  const res = await exchange.order({ orders: [{ a: idx, b: isBuy, p: limit, s, r: reduceOnly, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' })
  const st = res.response.data.statuses[0] as { filled?: { avgPx: string; totalSz: string; oid: number }; error?: string }
  if (!st || 'error' in st && st.error) throw new Error(`testnet: ${st?.error ?? 'no status'}`)
  if (!st.filled) throw new Error('testnet: order resting/not filled')
  return { entry: Number(st.filled.avgPx), size: Number(st.filled.totalSz), ref: `oid ${st.filled.oid}` }
}

export async function openOrder(coin: string, side: 'LONG' | 'SHORT', notionalUsd: number, mid: number): Promise<PaperOrder> {
  let entry = mid, size = notionalUsd / mid, ref: string | undefined
  if (executorKind === 'hl-testnet') ({ entry, size, ref } = await testnetOrder(coin, side === 'LONG', notionalUsd))
  const o: PaperOrder = { id: newId(), coin, side, notionalUsd, size, entry, openedAt: Date.now(), venue: executorKind, ref }
  state.paper.push(o)
  save()
  return o
}

export async function closeCoin(coin: string, mid: number): Promise<{ closed: PaperOrder[]; pnl: number }> {
  const open = state.paper.filter(o => !o.closedAt && o.coin === coin)
  let pnl = 0
  for (const o of open) {
    let exit = mid
    if (o.venue === 'hl-testnet') exit = (await testnetOrder(coin, o.side === 'SHORT', 0, true, o.size)).entry
    o.closedAt = Date.now()
    o.exit = exit
    pnl += (exit - o.entry) * o.size * (o.side === 'LONG' ? 1 : -1)
  }
  save()
  return { closed: open, pnl }
}

/** Used by the self-test: proves signing + the testnet round trip with a throwaway key. */
export async function testnetProbe(key: `0x${string}`) {
  const wallet = privateKeyToAccount(key)
  const transport = new HttpTransport({ isTestnet: true })
  const exchange = new ExchangeClient({ transport, wallet })
  try {
    await exchange.order({ orders: [{ a: 0, b: true, p: '1000', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' })
    return 'unexpected success'
  } catch (err) {
    return (err as Error).message
  }
}
