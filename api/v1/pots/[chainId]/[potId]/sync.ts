// arc-studio-allow-onchain-literal
/**
 * POST /api/v1/pots/:chainId/:potId/sync
 * Body: { txHash }
 *
 * Reads the receipt from the chain, accepts only logs emitted by the
 * configured Potly contract for this pot, decodes them with the ABI,
 * and upserts into pot_events (ignoring duplicates).
 * block_time comes from the block; actor = transaction sender.
 * amount is stored in USDC base units (uint256 as string).
 *
 * GET /api/v1/pots/:chainId/:potId/activity
 * Returns pot_events in order plus an alias map from profiles.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  createPublicClient, http, fallback, decodeEventLog,
  type Log, type Hash,
} from 'viem'
import { arcTestnet, arc } from 'viem/chains'

const POTLY_ADDRESS = (process.env.POTLY_ADDRESS ?? '').toLowerCase()
const ARC_NETWORK   = process.env.ARC_NETWORK ?? 'testnet'
const ARC_RPC_URL   = process.env.ARC_RPC_URL
const SB_URL        = process.env.SUPABASE_URL
const SB_KEY        = process.env.SUPABASE_SERVICE_ROLE_KEY
const CHAIN         = ARC_NETWORK === 'mainnet' ? arc : arcTestnet

const MAINNET_RPCS = [
  'https://rpc.mainnet.arc.io',
  'https://rpc.drpc.mainnet.arc.io',
  'https://arc-rpc.publicnode.com',
  'https://rpc.beamrpc.com',
]
const TESTNET_RPCS = ['https://rpc.testnet.arc.io']

function makeClient() {
  const rpcs = ARC_NETWORK === 'mainnet' ? MAINNET_RPCS : TESTNET_RPCS
  const urls = ARC_RPC_URL ? [ARC_RPC_URL, ...rpcs] : rpcs
  return createPublicClient({
    chain: CHAIN,
    transport: fallback(urls.map(u => http(u))),
  })
}

// Minimal ABI for decoding the events we care about
const EVENT_ABI = [
  { type: 'event', name: 'PotCreated',    inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'target', type: 'uint256' }, { name: 'slots', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'metadataHash', type: 'bytes32' }] },
  { type: 'event', name: 'Deposited',     inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'depositor', type: 'address', indexed: true }, { name: 'amount', type: 'uint256' }, { name: 'raised', type: 'uint256' }] },
  { type: 'event', name: 'Withdrawn',     inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'depositor', type: 'address', indexed: true }, { name: 'amount', type: 'uint256' }, { name: 'raised', type: 'uint256' }] },
  { type: 'event', name: 'PotFilled',     inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'filledAt', type: 'uint256' }] },
  { type: 'event', name: 'PayoutClaimed', inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'payout', type: 'uint256' }, { name: 'fee', type: 'uint256' }] },
  { type: 'event', name: 'PotCancelled', inputs: [{ name: 'potId', type: 'uint256', indexed: true }] },
] as const

type EventKind = 'created' | 'deposit' | 'withdraw' | 'filled' | 'payout' | 'cancelled'

function eventKind(name: string): EventKind | null {
  switch (name) {
    case 'PotCreated':    return 'created'
    case 'Deposited':     return 'deposit'
    case 'Withdrawn':     return 'withdraw'
    case 'PotFilled':     return 'filled'
    case 'PayoutClaimed': return 'payout'
    case 'PotCancelled':  return 'cancelled'
    default:              return null
  }
}

interface DecodedEvent {
  kind: EventKind
  wallet: string
  actor: string
  amount: string
  raised_after: string
  extra: Record<string, string>
  log_index: number
  block_number: number
  block_time: number
  tx_hash: string
}

async function decodeReceiptLogs(
  potIdN: bigint,
  txHash: Hash,
  contractAddress: string,
): Promise<DecodedEvent[]> {
  const client = makeClient()
  const [receipt, tx] = await Promise.all([
    client.getTransactionReceipt({ hash: txHash }),
    client.getTransaction({ hash: txHash }),
  ])
  const actor = tx.from.toLowerCase()
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  const blockTime = Number(block.timestamp)
  const blockNum  = Number(receipt.blockNumber)

  const results: DecodedEvent[] = []
  for (const log of receipt.logs as Log[]) {
    if (log.address.toLowerCase() !== contractAddress) continue
    try {
      const decoded = decodeEventLog({ abi: EVENT_ABI, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
      const kind = eventKind(decoded.eventName as string)
      if (!kind) continue
      const args = decoded.args as Record<string, unknown>
      // Only include logs for this potId
      if (args.potId !== undefined && BigInt(String(args.potId)) !== potIdN) continue

      const wallet = (args.depositor ?? args.creator ?? actor) as string
      const amount = args.amount !== undefined ? String(args.amount) : args.payout !== undefined ? String((args.payout as bigint) + (args.fee as bigint)) : '0'
      const raised_after = args.raised !== undefined ? String(args.raised) : '0'
      const extra: Record<string, string> = {}
      if (args.recipient) extra.recipient = String(args.recipient)
      if (args.fee)       extra.fee       = String(args.fee)
      if (args.payout)    extra.payout    = String(args.payout)
      if (args.target)    extra.target    = String(args.target)
      if (args.deadline)  extra.deadline  = String(args.deadline)

      results.push({
        kind, wallet: (wallet as string).toLowerCase(), actor,
        amount, raised_after,
        extra, log_index: log.logIndex ?? 0,
        block_number: blockNum, block_time: blockTime,
        tx_hash: txHash.toLowerCase(),
      })
    } catch { /* not one of our events */ }
  }
  return results
}

async function sbPost(path: string, body: unknown) {
  if (!SB_URL || !SB_KEY) throw new Error('Supabase not configured')
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(body),
  })
  if (res.status !== 201 && res.status !== 204) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${text}`)
  }
}

async function sbGet(path: string): Promise<unknown> {
  if (!SB_URL || !SB_KEY) throw new Error('Supabase not configured')
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  })
  if (!res.ok) throw new Error(`Supabase ${res.status}`)
  return res.json()
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { chainId, potId } = req.query as { chainId: string; potId: string }
    const chainIdN = Number(chainId)
    const potIdN   = BigInt(potId)
    const contract = POTLY_ADDRESS

    if (!contract) return res.status(503).json({ ok: false, error: 'Contract address not configured' })

    // ── GET activity ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (!SB_URL || !SB_KEY) return res.status(503).json({ ok: false, error: 'Not configured' })
      const [events, profiles] = await Promise.all([
        sbGet(`/pot_events?chain_id=eq.${chainIdN}&contract_address=eq.${contract}&pot_id=eq.${potIdN}&order=block_number.asc,log_index.asc`),
        sbGet(`/profiles?select=wallet_address,alias`),
      ])
      const aliasMap: Record<string, string> = {}
      for (const p of profiles as { wallet_address: string; alias: string }[]) {
        aliasMap[p.wallet_address] = p.alias
      }
      return res.status(200).json({ ok: true, events, aliases: aliasMap })
    }

    // ── POST sync ─────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { txHash } = req.body as { txHash?: string }
      if (!txHash) return res.status(400).json({ ok: false, error: 'Missing txHash' })
      if (!SB_URL || !SB_KEY) return res.status(503).json({ ok: false, error: 'Not configured' })

      const events = await decodeReceiptLogs(potIdN, txHash as Hash, contract)
      if (events.length > 0) {
        await sbPost('/pot_events', events.map(e => ({
          chain_id: chainIdN,
          contract_address: contract,
          pot_id: potIdN.toString(),
          ...e,
        })))
      }
      return res.status(200).json({ ok: true, inserted: events.length })
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
