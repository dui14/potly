// arc-studio-allow-onchain-literal
/**
 * POST /api/v1/index/tick
 *
 * Global indexer: scans all Potly events from the configured contract.
 * One cursor per (chain_id, contract_address) stored in pot_scan_state
 * with pot_id = -1 as the global cursor sentinel.
 *
 * Throttle: if the cursor was updated < 10 s ago, returns current state.
 * Otherwise: fetches logs in adaptive chunks (10 000 → 500 on range errors),
 * stops after 8 s wall time, writes via ingest_pot_events (includes fee_wei),
 * advances the cursor only over fully-processed ranges.
 *
 * Returns { ok, scannedTo, head, lagBlocks, inserted, throttled }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { decodeEventLog } from 'viem'
import {
  POTLY_ADDRESS, CHAIN_ID, POTLY_DEPLOY_BLOCK,
  SB_URL, SB_KEY,
  sbGet, sbRpc, sbUpsert,
  makeClient, toIso,
  EVENT_ABI, mapArgs, isRangeErr,
  type EventKind,
} from '../../_shared'

const THROTTLE_MS    = 10_000
const MAX_ELAPSED_MS = 8_000
const CHUNK_INIT     = 10_000n
const CHUNK_MIN      =    500n
const GLOBAL_POT_ID  = -1

function evKind(name: string): EventKind | null {
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

interface CursorRow { scanned_to: string; updated_at?: string }

async function checkThrottle(): Promise<{ throttled: boolean; scannedTo: bigint }> {
  if (!SB_URL || !SB_KEY) return { throttled: false, scannedTo: POTLY_DEPLOY_BLOCK }
  try {
    const rows = await sbGet(
      `/pot_scan_state?chain_id=eq.${CHAIN_ID}&contract_address=eq.${POTLY_ADDRESS}` +
      `&pot_id=eq.${GLOBAL_POT_ID}&select=scanned_to,updated_at&limit=1`,
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

    const { throttled, scannedTo: cursorStart } = await checkThrottle()
    const client = makeClient()
    const head   = await client.getBlockNumber()

    if (throttled) {
      return res.status(200).json({
        ok: true, throttled: true,
        scannedTo: Number(cursorStart), head: Number(head),
        lagBlocks: Number(head > cursorStart ? head - cursorStart : 0n), inserted: 0,
      })
    }

    let from        = cursorStart + 1n > POTLY_DEPLOY_BLOCK ? cursorStart + 1n : POTLY_DEPLOY_BLOCK
    let chunk       = CHUNK_INIT
    let inserted    = 0
    const started   = Date.now()
    let lastGood    = cursorStart

    while (from <= head && Date.now() - started < MAX_ELAPSED_MS) {
      const to = from + chunk - 1n < head ? from + chunk - 1n : head
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const logs: Awaited<ReturnType<typeof client.getLogs>> = await (client.getLogs as any)({
          address: POTLY_ADDRESS as `0x${string}`, fromBlock: from, toBlock: to,
        })

        // Batch-fetch block timestamps
        const blockNums = [...new Set(logs.map(l => l.blockNumber ?? 0n))]
        const blockTimes = new Map<bigint, string>()
        await Promise.all(blockNums.map(async bn => {
          try {
            const b = await client.getBlock({ blockNumber: bn })
            blockTimes.set(bn, toIso(b.timestamp))
          } catch { blockTimes.set(bn, new Date(0).toISOString()) }
        }))

        // Batch-fetch tx senders + fee_wei
        const txHashes = [...new Set(logs.map(l => l.transactionHash ?? '').filter(Boolean))]
        const actors  = new Map<string, string>()
        const feeWei  = new Map<string, string>()
        await Promise.all(txHashes.map(async h => {
          try {
            const [tx, receipt] = await Promise.all([
              client.getTransaction({ hash: h as `0x${string}` }),
              client.getTransactionReceipt({ hash: h as `0x${string}` }),
            ])
            actors.set(h.toLowerCase(), tx.from.toLowerCase())
            feeWei.set(h.toLowerCase(), (receipt.gasUsed * receipt.effectiveGasPrice).toString())
          } catch { actors.set(h.toLowerCase(), '') }
        }))

        // Group by pot_id for ingest_pot_events calls
        interface RowByPot { potId: bigint; rows: ReturnType<typeof mapArgs> & { log_index: number; block_number: number; block_time: string; tx_hash: string; kind: EventKind; actor: string; fee_wei: string | null }[] }
        const byPot = new Map<string, RowByPot>()

        for (const log of logs) {
          try {
            const decoded = decodeEventLog({
              abi: EVENT_ABI, data: log.data,
              topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
            })
            const kind = evKind(decoded.eventName as string)
            if (!kind) continue
            const args    = decoded.args as Record<string, unknown>
            const potIdN  = args.potId !== undefined ? BigInt(String(args.potId)) : null
            if (potIdN === null) continue
            const actor   = actors.get((log.transactionHash ?? '').toLowerCase()) ?? ''
            const bt      = blockTimes.get(log.blockNumber ?? 0n) ?? new Date(0).toISOString()
            const txH     = (log.transactionHash ?? '').toLowerCase()
            const { wallet, amount, raised_after, extra } = mapArgs(kind, args, actor)
            const key     = potIdN.toString()
            if (!byPot.has(key)) byPot.set(key, { potId: potIdN, rows: [] })
            byPot.get(key)!.rows.push({
              kind, wallet, actor, amount, raised_after, extra,
              log_index:    log.logIndex ?? 0,
              block_number: Number(log.blockNumber ?? 0n),
              block_time:   bt,
              tx_hash:      txH,
              fee_wei:      feeWei.get(txH) ?? null,
            })
          } catch { /* skip */ }
        }

        // Ingest each pot's events in one RPC call per pot
        for (const { potId, rows: potRows } of byPot.values()) {
          try {
            const eventsJson = potRows.map(r => ({
              pot_id:       potId.toString(),
              tx_hash:      r.tx_hash,
              log_index:    r.log_index,
              kind:         r.kind,
              wallet:       r.wallet,
              actor:        r.actor,
              amount:       r.amount,
              raised_after: r.raised_after,
              extra:        r.extra,
              block_number: r.block_number,
              block_time:   r.block_time,
              fee_wei:      r.fee_wei,
            }))
            const result = await sbRpc('ingest_pot_events', {
              p_chain:     CHAIN_ID,
              p_contract:  POTLY_ADDRESS,
              p_pot:       Number(potId),
              p_events:    eventsJson,
              p_synced_to: Number(to),
              p_status:    'indexed',
            }) as number
            inserted += result
          } catch (upsertErr) {
            const msg = String((upsertErr as { message?: string })?.message ?? upsertErr)
            const pgCode = msg.match(/\b[0-9A-Z]{5}\b/)?.[0] ?? 'UNKNOWN'
            console.error(`[tick] ingest failed pg=${pgCode} range=${from}-${to}`)
          }
        }

        lastGood = to
        from     = to + 1n
        chunk    = CHUNK_INIT
      } catch (e) {
        if (isRangeErr(e) && chunk > CHUNK_MIN) {
          chunk = chunk / 2n
        } else {
          const msg = String((e as { message?: string })?.message ?? e)
          const pgCode = msg.match(/\b[0-9A-Z]{5}\b/)?.[0] ?? 'UNKNOWN'
          console.error(`[tick] range error pg=${pgCode} range=${from}-${to}`)
          from  = to + 1n
          chunk = CHUNK_INIT
        }
      }
    }

    if (lastGood > cursorStart) await writeCursor(lastGood)

    return res.status(200).json({
      ok: true, throttled: false,
      scannedTo: Number(lastGood), head: Number(head),
      lagBlocks: Number(head > lastGood ? head - lastGood : 0n),
      inserted,
    })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
