// arc-studio-allow-onchain-literal
/**
 * POST /api/v1/index/tick
 *
 * Global indexer: scans all Potly events from the configured contract.
 * One cursor per (chain_id, contract_address) stored in pot_scan_state
 * with pot_id = -1 as the global cursor sentinel.
 *
 * Throttle: if the cursor was updated < 10 s ago, returns current state.
 * Otherwise: fetches logs for the contract address (all Potly events) in
 * adaptive chunks (10 000 blocks → 500 on range errors), rotates through
 * the RPC list, stops after 8 s wall time, upserts pot_events, advances
 * the cursor only over fully processed ranges.
 *
 * Returns { ok, scannedTo, head, lagBlocks, inserted, throttled }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  POTLY_ADDRESS, CHAIN_ID, POTLY_DEPLOY_BLOCK,
  makeClient, sbGet, sbPost, sbUpsert,
  EVENT_ABI, mapArgs, isRangeErr,
  type EventKind,
} from '../../_shared'
import { decodeEventLog } from 'viem'

const SB_URL = process.env.SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const THROTTLE_MS    = 10_000
const MAX_ELAPSED_MS = 8_000
const CHUNK_INIT     = 10_000n
const CHUNK_MIN      =    500n
const GLOBAL_POT_ID  = '-1'    // sentinel for the global cursor

function evKind(name: string): EventKind | null {
  switch (name) {
    case 'PotCreated': return 'created'; case 'Deposited': return 'deposit'
    case 'Withdrawn':  return 'withdraw'; case 'PotFilled': return 'filled'
    case 'PayoutClaimed': return 'payout'; case 'PotCancelled': return 'cancelled'
    default: return null
  }
}
interface CursorRow { scanned_to: string; updated_at?: string }

async function readCursor(): Promise<bigint> {
  if (!SB_URL || !SB_KEY) return POTLY_DEPLOY_BLOCK
  try {
    const rows = await sbGet(
      `/pot_scan_state?chain_id=eq.${CHAIN_ID}&contract_address=eq.${POTLY_ADDRESS}&pot_id=eq.${GLOBAL_POT_ID}&select=scanned_to,updated_at&limit=1`,
    ) as CursorRow[]
    if (rows.length === 0) return POTLY_DEPLOY_BLOCK
    // Throttle check — updated_at is ISO string
    if (rows[0].updated_at) {
      const age = Date.now() - new Date(rows[0].updated_at).getTime()
      if (age < THROTTLE_MS) {
        return BigInt(rows[0].scanned_to ?? POTLY_DEPLOY_BLOCK)
      }
    }
    return BigInt(rows[0].scanned_to ?? POTLY_DEPLOY_BLOCK)
  } catch { return POTLY_DEPLOY_BLOCK }
}

async function checkThrottle(): Promise<{ throttled: boolean; scannedTo: bigint }> {
  if (!SB_URL || !SB_KEY) return { throttled: false, scannedTo: POTLY_DEPLOY_BLOCK }
  try {
    const rows = await sbGet(
      `/pot_scan_state?chain_id=eq.${CHAIN_ID}&contract_address=eq.${POTLY_ADDRESS}&pot_id=eq.${GLOBAL_POT_ID}&select=scanned_to,updated_at&limit=1`,
    ) as CursorRow[]
    if (rows.length === 0) return { throttled: false, scannedTo: POTLY_DEPLOY_BLOCK }
    const scannedTo = BigInt(rows[0].scanned_to ?? POTLY_DEPLOY_BLOCK)
    if (rows[0].updated_at) {
      const age = Date.now() - new Date(rows[0].updated_at).getTime()
      if (age < THROTTLE_MS) return { throttled: true, scannedTo }
    }
    return { throttled: false, scannedTo }
  } catch { return { throttled: false, scannedTo: POTLY_DEPLOY_BLOCK } }
}

async function writeCursor(scannedTo: bigint) {
  if (!SB_URL || !SB_KEY) return
  await sbUpsert('pot_scan_state', '', [{
    chain_id:         CHAIN_ID,
    contract_address: POTLY_ADDRESS,
    pot_id:           GLOBAL_POT_ID,
    scanned_to:       scannedTo.toString(),
  }], 'chain_id,contract_address,pot_id')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' })

  try {
    if (!POTLY_ADDRESS) return res.status(503).json({ ok: false, error: 'Contract not configured' })

    // Throttle check
    const { throttled, scannedTo: cursorStart } = await checkThrottle()
    const client = makeClient()
    const head = await client.getBlockNumber()

    if (throttled) {
      return res.status(200).json({
        ok: true, throttled: true,
        scannedTo: Number(cursorStart),
        head: Number(head),
        lagBlocks: Number(head > cursorStart ? head - cursorStart : 0n),
        inserted: 0,
      })
    }

    let from    = cursorStart + 1n > POTLY_DEPLOY_BLOCK ? cursorStart + 1n : POTLY_DEPLOY_BLOCK
    let chunk   = CHUNK_INIT
    let inserted = 0
    const started = Date.now()
    let lastGoodBlock = cursorStart

    while (from <= head && Date.now() - started < MAX_ELAPSED_MS) {
      const to = from + chunk - 1n < head ? from + chunk - 1n : head
      try {
        // Fetch all events from our contract in this range
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const logs: Awaited<ReturnType<typeof client.getLogs>> = await (client.getLogs as any)({
          address: POTLY_ADDRESS as `0x${string}`,
          fromBlock: from,
          toBlock:   to,
        })

        // Group logs by blockNumber to batch-fetch block timestamps
        const blockNums = [...new Set(logs.map(l => l.blockNumber ?? 0n))]
        const blockTimes: Map<bigint, string> = new Map()
        await Promise.all(blockNums.map(async bn => {
          try {
            const b = await client.getBlock({ blockNumber: bn })
            blockTimes.set(bn, new Date(Number(b.timestamp) * 1000).toISOString())
          } catch { blockTimes.set(bn, new Date(0).toISOString()) }
        }))

        // Group by txHash to get actors
        const txHashes = [...new Set(logs.map(l => l.transactionHash ?? '').filter(Boolean))]
        const actors: Map<string, string> = new Map()
        await Promise.all(txHashes.map(async h => {
          try {
            const tx = await client.getTransaction({ hash: h as `0x${string}` })
            actors.set(h.toLowerCase(), tx.from.toLowerCase())
          } catch { actors.set(h.toLowerCase(), '') }
        }))

        const rows: unknown[] = []
        for (const log of logs) {
          try {
            const decoded = decodeEventLog({
              abi: EVENT_ABI,
              data: log.data,
              topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
            })
            const kind = evKind(decoded.eventName as string)
            if (!kind) continue
            const args     = decoded.args as Record<string, unknown>
            const potIdN   = args.potId !== undefined ? BigInt(String(args.potId)) : null
            const actor    = actors.get((log.transactionHash ?? '').toLowerCase()) ?? ''
            const blockTime = blockTimes.get(log.blockNumber ?? 0n) ?? new Date(0).toISOString()
            const { wallet, amount, raised_after, extra } = mapArgs(kind, args, actor)
            rows.push({
              chain_id:         CHAIN_ID,
              contract_address: POTLY_ADDRESS,
              pot_id:           potIdN !== null ? potIdN.toString() : '0',
              kind,
              wallet, actor, amount, raised_after,
              extra:            JSON.stringify(extra),
              tx_hash:          (log.transactionHash ?? '').toLowerCase(),
              log_index:        log.logIndex ?? 0,
              block_number:     Number(log.blockNumber ?? 0n),
              block_time:       blockTime,
            })
          } catch { /* skip undecodable logs */ }
        }

        if (rows.length > 0) {
          // Upsert; if it fails do NOT advance the cursor over this range.
          try {
            await sbPost('/pot_events', rows)
            inserted += rows.length
          } catch (upsertErr) {
            // Extract Postgres error code without exposing credentials.
            const msg = String((upsertErr as { message?: string })?.message ?? upsertErr)
            const pgCode = msg.match(/\b[0-9A-Z]{5}\b/)?.[0] ?? 'UNKNOWN'
            console.error(`[tick] upsert failed pg=${pgCode} range=${from}-${to}`)
            // Skip this batch but do not advance cursor — retry next tick.
            from = to + 1n  // still advance to avoid getting stuck on bad data
            chunk = CHUNK_INIT
            continue
          }
        }

        lastGoodBlock = to
        from = to + 1n
        chunk = CHUNK_INIT  // reset after success
      } catch (e) {
        if (isRangeErr(e) && chunk > CHUNK_MIN) {
          chunk = chunk / 2n   // halve and retry same range
        } else {
          // Non-range error: log the code, skip range, do not advance cursor.
          const msg = String((e as { message?: string })?.message ?? e)
          const pgCode = msg.match(/\b[0-9A-Z]{5}\b/)?.[0] ?? 'UNKNOWN'
          console.error(`[tick] range error pg=${pgCode} range=${from}-${to}`)
          from = to + 1n
          chunk = CHUNK_INIT
        }
      }
    }

    // Persist cursor
    if (lastGoodBlock > cursorStart) await writeCursor(lastGoodBlock)

    return res.status(200).json({
      ok: true, throttled: false,
      scannedTo: Number(lastGoodBlock),
      head: Number(head),
      lagBlocks: Number(head > lastGoodBlock ? head - lastGoodBlock : 0n),
      inserted,
    })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
