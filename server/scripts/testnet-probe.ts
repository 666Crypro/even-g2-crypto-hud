// Proves the Hyperliquid TESTNET signing path end to end with a throwaway key (no funds involved).
// Expected output: an exchange-side rejection such as "User or API Wallet ... does not exist".
import { testnetProbe } from '../src/executor.ts'
import { generatePrivateKey } from 'viem/accounts'
console.log('testnet response:', await testnetProbe(generatePrivateKey()))
