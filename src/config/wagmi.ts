// arc-studio-allow-onchain-literal
import { createConfig, http, fallback } from 'wagmi'
import { arc, arcTestnet } from 'viem/chains'
import { getDefaultConfig } from 'connectkit'

export const IS_TESTNET = (import.meta.env.VITE_ARC_NETWORK ?? 'testnet') !== 'mainnet'

// Arc Testnet — single public RPC (no additional public endpoints available)
const testnetTransport = http('https://rpc.testnet.arc.io')

// Arc Mainnet — primary + three public fallbacks for robustness
const mainnetTransport = fallback([
  http('https://rpc.mainnet.arc.io'),
  http('https://rpc.drpc.mainnet.arc.io'),
  http('https://arc-rpc.publicnode.com'),
  http('https://rpc.beamrpc.com'),
])

export const TARGET_CHAIN    = IS_TESTNET ? arcTestnet : arc
export const TARGET_CHAIN_ID = TARGET_CHAIN.id  // 5042002 (testnet) | 5042 (mainnet)

export const config = createConfig(
  getDefaultConfig({
    chains: IS_TESTNET ? [arcTestnet] : [arc],
    transports: IS_TESTNET
      ? { [arcTestnet.id]: testnetTransport }
      : { [arc.id]: mainnetTransport },
    walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '',
    appName: 'Potly',
    appDescription: 'Conditional group pots in USDC on Arc',
    appUrl: 'https://potly.app',
  }),
)

// USDC — fixed predeploy, same address on both Arc networks
export const USDC_ADDRESS   = '0x3600000000000000000000000000000000000000' as const
export const USDC_DECIMALS  = 6

// Potly contract (v2)
export const POTLY_ADDRESS      = (import.meta.env.VITE_POTLY_ADDRESS      ?? '') as `0x${string}`
export const POTLY_DEPLOY_BLOCK = BigInt(import.meta.env.VITE_POTLY_DEPLOY_BLOCK ?? '0')
export const TREASURY_ADDRESS   = (import.meta.env.VITE_TREASURY_ADDRESS   ?? '') as `0x${string}`

// Explorer helpers
export const EXPLORER_BASE = IS_TESTNET
  ? 'https://explorer.testnet.arc.io'
  : 'https://explorer.arc.io'
export const buildTxUrl   = (hash: string) => `${EXPLORER_BASE}/tx/${hash}`
export const buildAddrUrl = (addr: string) => `${EXPLORER_BASE}/address/${addr}`

// FEE_BPS — matches constructor arg; used for display only
export const FEE_BPS = 5
