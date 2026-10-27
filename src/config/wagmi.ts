import { createConfig, http, fallback } from 'wagmi'
import { arc, arcTestnet } from 'viem/chains'
import { getDefaultConfig } from 'connectkit'

const isTestnet = (import.meta.env.VITE_ARC_NETWORK ?? 'testnet') !== 'mainnet'

// Arc Testnet RPC — primary + fallback
const testnetTransport = fallback([
  http('https://rpc.testnet.arc.io'),
  http('https://rpc-testnet.arc.io'),
])

// Arc Mainnet RPC — primary + fallback
const mainnetTransport = fallback([
  http('https://rpc.mainnet.arc.io'),
  http('https://rpc.arc.io'),
])

export const TARGET_CHAIN = isTestnet ? arcTestnet : arc
export const TARGET_CHAIN_ID = TARGET_CHAIN.id  // 5042002 | 5042

export const config = createConfig(
  getDefaultConfig({
    chains: isTestnet ? [arcTestnet] : [arc],
    transports: isTestnet
      ? { [arcTestnet.id]: testnetTransport }
      : { [arc.id]: mainnetTransport },
    walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '',
    appName: 'Potly',
    appDescription: 'Conditional group pots in USDC on Arc',
    appUrl: 'https://studio.arc.io',
  }),
)

// USDC — fixed predeploy, same address on both Arc networks
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const
export const USDC_DECIMALS = 6

// Potly contract
// v2 contract — update VITE_POTLY_ADDRESS in .env to the new deployment
export const POTLY_ADDRESS = (import.meta.env.VITE_POTLY_ADDRESS ?? '') as `0x${string}`
export const POTLY_DEPLOY_BLOCK = BigInt(import.meta.env.VITE_POTLY_DEPLOY_BLOCK ?? '0')
export const TREASURY_ADDRESS = (import.meta.env.VITE_TREASURY_ADDRESS ?? '') as `0x${string}`

// Explorer helpers
export const EXPLORER_BASE = isTestnet
  ? 'https://explorer.testnet.arc.io'
  : 'https://explorer.arc.io'
export const buildTxUrl     = (hash: string) => `${EXPLORER_BASE}/tx/${hash}`
export const buildAddrUrl   = (addr: string) => `${EXPLORER_BASE}/address/${addr}`

export const IS_TESTNET = isTestnet
