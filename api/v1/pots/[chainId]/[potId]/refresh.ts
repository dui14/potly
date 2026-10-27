// arc-studio-allow-onchain-literal
/**
 * POST /api/v1/pots/:chainId/:potId/refresh
 *
 * Bounded backfill of pot_events for a single pot.
 * - Topic-filters on the indexed potId.
 * - Adaptive chunks: start 10,000 blocks, halve on range errors.
 * - Stops after 8 seconds of elapsed wall time.
 * - Resumes from pot_scan_state (starts at POTLY_DEPLOY_BLOCK).
 * - All decoded events are upserted into pot_events.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  createPublicClient, http, fallback, decodeEventLog,
} from 'viem'
import { arcTestnet, arc } from 'viem/chains'

const POTLY_ADDRESS       = (process.env.POTLY_ADDRESS ?? '').toLowerCase()
const ARC_NETWORK         = process.env.ARC_NETWORK ?? 'testnet'
const ARC_RPC_URL         = process.env.ARC_RPC_URL
const POTLY_DEPLOY_BLOCK  = BigInt(process.env.POTLY_DEPLOY_BLOCK ?? '0')
const SB_URL              = process.env.SUPABASE_URL
const SB_KEY              = process.env.SUPABASE_SERVICE_ROLE_KEY
const CHAIN               = ARC_NETWORK === 'mainnet' ? arc : arcTestnet
const MAX_ELAPSED_MS      = 8_000
const CHUNK_INIT          = 10_000n
const CHUNK_MIN           = 500n

const MAINNET_RPCS = ['https://rpc.mainnet.arc.io','https://rpc.drpc.mainnet.arc.io','https://arc-rpc.publicnode.com','https://rpc.beamrpc.com']
const TESTNET_RPCS = ['https://rpc.testnet.arc.io']

function makeClient() {
  const rpcs = ARC_NETWORK === 'mainnet' ? MAINNET_RPCS : TESTNET_RPCS
  const urls = ARC_RPC_URL ? [ARC_RPC_URL, ...rpcs] : rpcs
  return createPublicClient({ chain: CHAIN, transport: fallback(urls.map(u => http(u))) })
}

const EVENT_ABI = [
  { type: 'event', name: 'PotCreated',    inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'target', type: 'uint256' }, { name: 'slots', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'metadataHash', type: 'bytes32' }] },
  { type: 'event', name: 'Deposited',     inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'depositor', type: 'address', indexed: true }, { name: 'amount', type: 'uint256' }, { name: 'raised', type: 'uint256' }] },
  { type: 'event', name: 'Withdrawn',     inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'depositor', type: 'address', indexed: true }, { name: 'amount', type: 'uint256' }, { name: 'raised', type: 'uint256' }] },
  { type: 'event', name: 'PotFilled',     inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'filledAt', type: 'uint256' }] },
  { type: 'event', name: 'PayoutClaimed', inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'payout', type: 'uint256' }, { name: 'fee', type: 'uint256' }] },
  { type: 'event', name: 'PotCancelled', inputs: [{ name: 'potId', type: 'uint256', indexed: true }] },
] as const

type EventKind = 'created'|'deposit'|'withdraw'|'filled'|'payout'|'cancelled'
function eventKind(name: string): EventKind | null {
  switch (name) {
    case 'PotCreated': return 'created'; case 'Deposited': return 'deposit'
    case 'Withdrawn': return 'withdraw'; case 'PotFilled': return 'filled'
    case 'PayoutClaimed': return 'payout'; case 'PotCancelled': return 'cancelled'
    default: return null
  }
}

function isRangeErr(e: unknown) {
  const m = String((e as { message?: string })?.message ?? e).toLowerCase()
  return m.includes('block range') || m.includes('limit exceed') || m.includes('too many') || m.includes('range')
}

async function sbUpsert(rows: unknown[]) {
  if (!SB_URL || !SB_KEY || rows.length === 0) return
  await fetch(`${SB_URL}/rest/v1/pot_events`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  })
}

async function sbScanState(chainIdN: number, contract: string, potIdN: string): Promise<bigint> {
  if (!SB_URL || !SB_KEY) return POTLY_DEPLOY_BLOCK
  try {
    const res = await fetch(`${SB_URL}/rest/v1/pot_scan_state?chain_id=eq.${chainIdN}&contract_address=eq.${contract}&pot_id=eq.${potIdN}&select=scanned_to&limit=1`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    })
    const rows = await res.json() as { scanned_to: number }[]
    return rows[0] ? BigInt(rows[0].scanned_to) : POTLY_DEPLOY_BLOCK
  } catch { return POTLY_DEPLOY_BLOCK }
}

async function sbSetScanState(chainIdN: number, contract: string, potIdN: string, scannedTo: bigint) {
  if (!SB_URL || !SB_KEY) return
  await fetch(`${SB_URL}/rest/v1/pot_scan_state`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ chain_id: chainIdN, contract_address: contract, pot_id: potIdN, scanned_to: scannedTo.toString() }),
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })
  try {
    const { chainId, potId } = req.query as { chainId: string; potId: string }
    const chainIdN  = Number(chainId)
    const potIdN    = BigInt(potId)
    const potIdStr  = potIdN.toString()
    const contract  = POTLY_ADDRESS
    if (!contract) return res.status(503).json({ ok: false, error: 'Contract not configured' })

    const client   = makeClient()
    const head     = await client.getBlockNumber()
    const startFrom = await sbScanState(chainIdN, contract, potIdStr)
    if (startFrom >= head) return res.status(200).json({ ok: true, message: 'Already up to date' })

    const started  = Date.now()
    let chunk      = CHUNK_INIT
    let from       = startFrom > POTLY_DEPLOY_BLOCK ? startFrom : POTLY_DEPLOY_BLOCK
    let inserted   = 0

    while (from <= head && Date.now() - started < MAX_ELAPSED_MS) {
      const to = from + chunk - 1n < head ? from + chunk - 1n : head
      try {
        // Build topic filter for potId (topic[1] = first indexed param)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const logs: Awaited<ReturnType<typeof client.getLogs>> = await (client.getLogs as any)({
          address: contract as `0x${string}`,
          fromBlock: from,
          toBlock: to,
          topics: [null, `0x${potIdN.toString(16).padStart(64, '0')}`],
        })

        const rows: unknown[] = []
        for (const log of logs) {
          try {
            const decoded = decodeEventLog({ abi: EVENT_ABI, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
            const kind = eventKind(decoded.eventName as string)
            if (!kind) continue
            const args = decoded.args as Record<string, unknown>
            if (args.potId !== undefined && BigInt(String(args.potId)) !== potIdN) continue
            const wallet = String(args.depositor ?? args.creator ?? '0x')
            const amount = args.amount !== undefined ? String(args.amount) : args.payout !== undefined ? String((args.payout as bigint) + (args.fee as bigint)) : '0'
            const raised_after = args.raised !== undefined ? String(args.raised) : '0'
            const extra: Record<string, string> = {}
            if (args.recipient) extra.recipient = String(args.recipient)
            if (args.fee)       extra.fee       = String(args.fee)
            if (args.payout)    extra.payout    = String(args.payout)
            rows.push({
              chain_id: chainIdN, contract_address: contract, pot_id: potIdStr,
              tx_hash: log.transactionHash?.toLowerCase() ?? '', log_index: log.logIndex ?? 0,
              kind, wallet: wallet.toLowerCase(), actor: wallet.toLowerCase(),
              amount, raised_after, extra,
              block_number: Number(log.blockNumber ?? 0n), block_time: 0,
            })
          } catch { /* not our event */ }
        }
        await sbUpsert(rows)
        inserted += rows.length
        from += chunk
        chunk = CHUNK_INIT
      } catch (e) {
        if (isRangeErr(e) && chunk > CHUNK_MIN) { chunk = chunk / 2n }
        else { from += chunk; chunk = CHUNK_INIT }
      }
    }

    await sbSetScanState(chainIdN, contract, potIdStr, from > head ? head : from)
    return res.status(200).json({ ok: true, inserted, scannedTo: (from > head ? head : from).toString() })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
