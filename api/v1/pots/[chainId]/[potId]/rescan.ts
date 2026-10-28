// arc-studio-allow-onchain-literal
/**
 * POST /api/v1/pots/:chainId/:potId/rescan
 *
 * Lazily scans ALL on-chain events for this specific pot (from deploy block
 * to chain head), upserts them into pot_events idempotently, then returns
 * the count of rows inserted/merged.
 *
 * Called by the history Refresh button.  Subsequent page loads read from
 * Supabase without re-scanning.
 *
 * Uses getLogs with an indexed potId filter to stay cheap.
 * Block range is chunked at 10 000 to respect RPC limits.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  POTLY_ADDRESS, CHAIN_ID, POTLY_DEPLOY_BLOCK,
  makeClient, sbPost, toIso,
  EVENT_ABI, mapArgs, type DecodedEvent, isRangeErr,
} from '../../../../_shared'

const SB_URL = process.env.SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const CHUNK = 10_000n

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' })

  try {
    const { chainId, potId } = req.query as { chainId: string; potId: string }
    const chainIdN = Number(chainId)
    const potIdN   = BigInt(potId)

    if (!POTLY_ADDRESS) return res.status(503).json({ ok: false, error: 'Contract not configured' })
    if (chainIdN !== CHAIN_ID)  return res.status(400).json({ ok: false, error: 'Wrong chain' })
    if (!SB_URL || !SB_KEY)     return res.status(503).json({ ok: false, error: 'Supabase not configured' })

    const client  = makeClient()
    const head    = await client.getBlockNumber()
    const from    = POTLY_DEPLOY_BLOCK > 0n ? POTLY_DEPLOY_BLOCK : 0n
    const rows: DecodedEvent[] = []

    // Collect all logs for this pot in chunks
    let chunkFrom = from
    while (chunkFrom <= head) {
      const chunkTo = chunkFrom + CHUNK - 1n < head ? chunkFrom + CHUNK - 1n : head
      try {
        const logs = await client.getLogs({
          address:   POTLY_ADDRESS as `0x${string}`,
          events:    EVENT_ABI as typeof EVENT_ABI,
          args:      { potId: potIdN } as Record<string, unknown>,
          fromBlock: chunkFrom,
          toBlock:   chunkTo,
        })

        // Batch-fetch block timestamps for unique block numbers in this chunk
        const blockNums = [...new Set(logs.map(l => l.blockNumber ?? 0n))]
        const blockTimes = new Map<bigint, string>()
        await Promise.all(blockNums.map(async bn => {
          try {
            const b = await client.getBlock({ blockNumber: bn })
            blockTimes.set(bn, toIso(b.timestamp))
          } catch { blockTimes.set(bn, new Date(0).toISOString()) }
        }))

        // Fetch tx senders for each unique tx hash
        const txHashes = [...new Set(logs.map(l => l.transactionHash ?? '').filter(Boolean))]
        const actors = new Map<string, string>()
        await Promise.all(txHashes.map(async h => {
          try {
            const tx = await client.getTransaction({ hash: h as `0x${string}` })
            actors.set(h.toLowerCase(), tx.from.toLowerCase())
          } catch { actors.set(h.toLowerCase(), '') }
        }))

        for (const log of logs) {
          try {
            // decodeEventLog was already done by getLogs — re-decode to get args
            const { decodeEventLog } = await import('viem')
            const decoded = decodeEventLog({ abi: EVENT_ABI, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
            const kind = (() => {
              switch (decoded.eventName) {
                case 'PotCreated':    return 'created' as const
                case 'Deposited':     return 'deposit' as const
                case 'Withdrawn':     return 'withdraw' as const
                case 'PotFilled':     return 'filled' as const
                case 'PayoutClaimed': return 'payout' as const
                case 'PotCancelled':  return 'cancelled' as const
                default:              return null
              }
            })()
            if (!kind) continue
            const args   = decoded.args as Record<string, unknown>
            const actor  = actors.get((log.transactionHash ?? '').toLowerCase()) ?? ''
            const bt     = blockTimes.get(log.blockNumber ?? 0n) ?? new Date(0).toISOString()
            const { wallet, amount, raised_after, extra } = mapArgs(kind, args, actor)
            rows.push({
              kind, wallet, actor, amount, raised_after, extra,
              log_index:    log.logIndex ?? 0,
              block_number: Number(log.blockNumber ?? 0n),
              block_time:   bt,
              tx_hash:      (log.transactionHash ?? '').toLowerCase(),
            })
          } catch { /* skip undecodable */ }
        }
        chunkFrom = chunkTo + 1n
      } catch (e) {
        if (isRangeErr(e)) {
          // RPC rejected the range — skip this chunk and keep going
          chunkFrom = chunkTo + 1n
        } else {
          throw e
        }
      }
    }

    // Upsert all rows into pot_events
    if (rows.length > 0) {
      await sbPost('/pot_events', rows.map(e => ({
        chain_id:         chainIdN,
        contract_address: POTLY_ADDRESS,
        pot_id:           potIdN.toString(),
        ...e,
        extra: JSON.stringify(e.extra),
      })))
    }

    return res.status(200).json({ ok: true, scanned: rows.length })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
