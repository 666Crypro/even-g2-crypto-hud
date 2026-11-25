// Read-only EVM wallet balances (e.g. your Trust Wallet address) via public RPCs.
import { cached, postJson } from './util.ts'

const CHAINS = [
  { name: 'Ethereum', rpc: process.env.ETH_RPC_URL ?? 'https://ethereum-rpc.publicnode.com', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  { name: 'Base', rpc: process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
]

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await postJson<{ result?: T; error?: { message: string } }>(url, { jsonrpc: '2.0', id: 1, method, params })
  if (r.error) throw new Error(r.error.message)
  return r.result as T
}

export interface WalletBalances { address: string; eth: number; usdc: number; byChain: { chain: string; eth: number; usdc: number }[] }

export const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a)

const cache = new Map<string, () => Promise<WalletBalances>>()
export function getWallet(address: string): Promise<WalletBalances> {
  if (!isEvmAddress(address)) return Promise.reject(new Error('invalid EVM address'))
  let fn = cache.get(address)
  if (!fn) {
    fn = cached(30_000, async () => {
      const data = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0') // balanceOf(address)
      const byChain = await Promise.all(
        CHAINS.map(async c => {
          const [wei, usdcRaw] = await Promise.all([
            rpc<string>(c.rpc, 'eth_getBalance', [address, 'latest']),
            rpc<string>(c.rpc, 'eth_call', [{ to: c.usdc, data }, 'latest']),
          ])
          return { chain: c.name, eth: Number(BigInt(wei)) / 1e18, usdc: Number(BigInt(usdcRaw || '0x0')) / 1e6 }
        }),
      )
      return { address, eth: byChain.reduce((s, c) => s + c.eth, 0), usdc: byChain.reduce((s, c) => s + c.usdc, 0), byChain }
    })
    cache.set(address, fn)
  }
  return fn()
}

/** Trust Wallet universal link that opens a dApp URL in Trust Wallet's in-app browser (coin_id 60 = Ethereum). */
export function trustWalletLink(url: string, coinId = 60): string {
  return `https://link.trustwallet.com/open_url?coin_id=${coinId}&url=${encodeURIComponent(url)}`
}
