// arc-studio-allow-onchain-literal
/**
 * GET  /api/v1/pots/:chainId/:potId/history
 *   DB-first: reads pot_events from Supabase (newest first), one alias query.
 *   Also reads pot_scan_state to surface needsSync and syncedTo.
 *   Never calls RPC. Cache-Control: s-maxage=5, stale-while-revalidate=30.
 *
 * POST /api/v1/pots/:chainId/:potId/sync  { mode: "cold"|"refresh"|"tx", txHash? }
 *   mode "cold":    scan for the PotCreated log only (no created event in DB).
 *                   Uses claim_pot_sync (lease 20 s, cooldown 10 s).
 *   mode "refresh": scan from syncedTo+1 to head for all events of this pot.
 *                   Uses claim_pot_sync (lease 20 s, cooldown 10 s).
 *   mode "tx":      read one receipt + block time; compute feeWei; no lease.
 *   All modes write via ingest_pot_events in a single call, then return the
 *   same { created, events, hasMore, nextCursor, syncedTo, needsSync } payload
 *   from in-memory data so the client renders without a second request.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { decodeEventLog } from 'viem'
import {
  POTLY_ADDRESS, CHAIN_ID, POTLY_DEPLOY_BLOCK,
  SB_URL, SB_KEY,
  sbGet, sbRpc,
  makeClient, toIso,
  EVENT_ABI, mapArgs, isRangeErr,
  validateAddress,
  type DecodedEvent,
} from '../../../../_shared'

// ── Types ────────────────────────────────────────────────────────────────────

interface DbEvent {
  kind:         string
  wallet:       string
  actor:        string
  amount:       string
  raised_after: string
  extra:        Record<string, unknown>
  fee_wei:      string | null
  tx_hash:      string
  block_number: number
  block_time:   string
  log_index:    number
}

interface ScanState {
  scanned_to:   string | null
  last_status:  string | null
}

interface HistoryPayload {
  ok:          boolean
  created:     { time: string; txHash: string } | null
  events:      DbEvent[]
  hasMore:     boolean
  nextCursor:  string | null   // "<block_number>:<log_index>" of last event returned
  syncedTo:    number | null
  needsSync:   boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAliasMap(wallets: string[]): Promise<Record<string, string>> {
  if (!SB_URL || !SB_KEY || wallets.length === 0) return {}
  try {
    const lower = [...new Set(wallets.map(w => w.toLowerCase()).filter(Boolean))]
    if (!lower.length) return {}
    const clause = lower.map(w => `"${w}"`).join(',')
    const rows = await sbGet(
      `/profiles?wallet_address=in.(${clause})&select=wallet_address,alias`,
    ) as { wallet_address: string; alias: string }[]
    const m: Record<string, string> = {}
    for (const r of rows) m[r.wallet_address] = r.alias
    return m
  } catch { return {} }
}

async function readDbEvents(
  chainIdN: number, potIdN: bigint,
  limit: number, before?: string,
): Promise<DbEvent[]> {
  let beforeFilter = ''
  if (before) {
    const [bn, li] = before.split(':').map(Number)
    if (isFinite(bn) && isFinite(li)) {
      beforeFilter = `&or=(block_number.lt.${bn},and(block_number.eq.${bn},log_index.lt.${li}))`
    }
  }
  const fetch1 = limit + 1
  return await sbGet(
    `/pot_events` +
    `?chain_id=eq.${chainIdN}&contract_address=eq.${POTLY_ADDRESS}&pot_id=eq.${potIdN.toString()}` +
    `&select=kind,wallet,actor,amount,raised_after,extra,fee_wei,tx_hash,block_number,block_time,log_index` +
    `&order=block_number.desc,log_index.desc&limit=${fetch1}${beforeFilter}`,
  ) as DbEvent[]
}

async function readScanState(chainIdN: number, potIdN: bigint): Promise<ScanState | null> {
  try {
    const rows = await sbGet(
      `/pot_scan_state?chain_id=eq.${chainIdN}&contract_address=eq.${POTLY_ADDRESS}` +
      `&pot_id=eq.${potIdN.toString()}&select=scanned_to,last_status&limit=1`,
    ) as ScanState[]
    return rows[0] ?? null
  } catch { return null }
}

function buildPayload(
  allRows: DbEvent[], limit: number,
  state: ScanState | null,
): Omit<HistoryPayload, 'ok'> {
  const hasMore = allRows.length > limit
  const page    = hasMore ? allRows.slice(0, limit) : allRows
  const last    = page[page.length - 1]
  const nextCursor = last ? `${last.block_number}:${last.log_index}` : null

  const createdRow = page.find(e => e.kind === 'created')
    ?? allRows.find(e => e.kind === 'created')
  const created = createdRow
    ? { time: createdRow.block_time, txHash: createdRow.tx_hash }
    : null

  const syncedTo = state?.scanned_to ? Number(state.scanned_to) : null
  const needsSync = !created

  return { created, events: page, hasMore, nextCursor, syncedTo, needsSync }
}

// Calls ingest_pot_events RPC (one round-trip for events + scan state).
async function ingest(
  chainIdN: number, potIdN: bigint, rows: DecodedEvent[], feeWeiMap: Map<string, string>,
  syncedTo: bigint, status: string,
): Promise<void> {
  const eventsJson = rows.map(e => ({
    pot_id:       potIdN.toString(),
    tx_hash:      e.tx_hash,
    log_index:    e.log_index,
    kind:         e.kind,
    wallet:       e.wallet,
    actor:        e.actor,
    amount:       e.amount,
    raised_after: e.raised_after,
    extra:        e.extra,
    block_number: e.block_number,
    block_time:   e.block_time,
    fee_wei:      feeWeiMap.get(e.tx_hash) ?? null,
  }))
  await sbRpc('ingest_pot_events', {
    p_chain:     chainIdN,
    p_contract:  POTLY_ADDRESS,
    p_pot:       Number(potIdN),
    p_events:    eventsJson,
    p_synced_to: Number(syncedTo),
    p_status:    status,
  })
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { chainId, potId } = req.query as { chainId: string; potId: string }
    const chainIdN = Number(chainId)
    const potIdN   = BigInt(potId)

    if (!POTLY_ADDRESS)     return res.status(503).json({ ok: false, error: 'Contract not configured' })
    if (chainIdN !== CHAIN_ID) return res.status(400).json({ ok: false, error: 'Wrong chain' })
    if (!SB_URL || !SB_KEY) return res.status(503).json({ ok: false, error: 'Supabase not configured' })

    // ── GET history ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const rawLimit = Number(req.query.limit ?? 20)
      const limit    = Math.min(Math.max(1, isFinite(rawLimit) ? rawLimit : 20), 100)
      const before   = req.query.before as string | undefined

      const [allRows, state] = await Promise.all([
        readDbEvents(chainIdN, potIdN, limit, before),
        readScanState(chainIdN, potIdN),
      ])

      const payload = buildPayload(allRows, limit, state)
      const wallets = [...new Set(payload.events.map(e => e.wallet).filter(Boolean))]
      const aliases = await getAliasMap(wallets)

      res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=30')
      return res.status(200).json({ ok: true, ...payload, aliases })
    }

    // ── POST sync ────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { mode, txHash } = req.body as { mode?: string; txHash?: string }

      if (!mode || !['cold', 'refresh', 'tx'].includes(mode)) {
        return res.status(400).json({ ok: false, error: 'mode must be cold | refresh | tx' })
      }

      const client  = makeClient()
      const rows: DecodedEvent[] = []
      const feeWei  = new Map<string, string>()
      let syncedTo  = 0n
      const CHUNK_INIT = 10_000n
      const CHUNK_MIN  =    500n
      const MAX_MS     = 8_000

      // ── mode "tx" ─────────────────────────────────────────────────────────
      if (mode === 'tx') {
        if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
          return res.status(400).json({ ok: false, error: 'txHash required for mode tx' })
        }
        const hash = txHash as `0x${string}`

        // JSON-RPC batch: receipt + block in parallel
        const [receipt, tx] = await Promise.all([
          client.getTransactionReceipt({ hash }),
          client.getTransaction({ hash }),
        ])
        const block = await client.getBlock({ blockNumber: receipt.blockNumber })
        const blockTime = toIso(block.timestamp)
        const actor = tx.from.toLowerCase()
        // fee = gasUsed * effectiveGasPrice (native USDC wei, 18 dec)
        const txFeeWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString()

        for (const log of receipt.logs) {
          if ((log.address as string).toLowerCase() !== POTLY_ADDRESS) continue
          try {
            const decoded = decodeEventLog({
              abi: EVENT_ABI, data: log.data,
              topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
            })
            const args = decoded.args as Record<string, unknown>
            if (args.potId !== undefined && BigInt(String(args.potId)) !== potIdN) continue
            const kind = (() => {
              switch (decoded.eventName) {
                case 'PotCreated':    return 'created' as const
                case 'Deposited':     return 'deposit' as const
                case 'Withdrawn':     return 'withdraw' as const
                case 'PotFilled':     return 'filled' as const
                case 'PayoutClaimed': return 'payout' as const
                case 'PotCancelled':  return 'cancelled' as const
                default: return null
              }
            })()
            if (!kind) continue
            const { wallet, amount, raised_after, extra } = mapArgs(kind, args, actor)
            rows.push({
              kind, wallet, actor, amount, raised_after, extra,
              log_index:    log.logIndex ?? 0,
              block_number: Number(receipt.blockNumber),
              block_time:   blockTime,
              tx_hash:      hash.toLowerCase(),
            })
          } catch { /* skip non-Potly logs */ }
        }
        if (rows.length > 0) feeWei.set(hash.toLowerCase(), txFeeWei)
        syncedTo = receipt.blockNumber

        await ingest(chainIdN, potIdN, rows, feeWei, syncedTo, 'tx')
      }

      // ── mode "cold" or "refresh" ──────────────────────────────────────────
      if (mode === 'cold' || mode === 'refresh') {
        // claim_pot_sync: lease 20 s, cooldown 10 s
        const claimResult = await sbRpc('claim_pot_sync', {
          p_chain:            chainIdN,
          p_contract:         POTLY_ADDRESS,
          p_pot:              Number(potIdN),
          p_lease_seconds:    20,
          p_cooldown_seconds: 10,
        }) as string

        if (claimResult === 'busy') {
          return res.status(200).json({ ok: true, status: 'busy', retryAfterMs: 11_000 })
        }

        const head    = await client.getBlockNumber()
        syncedTo      = head

        // Determine scan range
        let scanFrom: bigint
        if (mode === 'cold') {
          // Narrow the range: bracket between neighbouring pot IDs already in pot_events
          let lower = POTLY_DEPLOY_BLOCK
          let upper = head
          try {
            // Find the nearest pot with id < potIdN that has a created event (gives a lower bound)
            const prevRows = await sbGet(
              `/pot_events?chain_id=eq.${chainIdN}&contract_address=eq.${POTLY_ADDRESS}` +
              `&kind=eq.created&pot_id=lt.${potIdN.toString()}` +
              `&select=block_number&order=pot_id.desc&limit=1`,
            ) as { block_number: number }[]
            if (prevRows.length > 0) lower = BigInt(prevRows[0].block_number)

            // Upper bound from the next pot's created event
            const nextRows = await sbGet(
              `/pot_events?chain_id=eq.${chainIdN}&contract_address=eq.${POTLY_ADDRESS}` +
              `&kind=eq.created&pot_id=gt.${potIdN.toString()}` +
              `&select=block_number&order=pot_id.asc&limit=1`,
            ) as { block_number: number }[]
            if (nextRows.length > 0) upper = BigInt(nextRows[0].block_number) + 1n
          } catch { /* use defaults */ }
          scanFrom = lower
          syncedTo = upper < head ? upper : head
        } else {
          // refresh: scan from last scanned_to + 1 to head
          const state = await readScanState(chainIdN, potIdN)
          const lastScanned = state?.scanned_to ? BigInt(state.scanned_to) : POTLY_DEPLOY_BLOCK
          scanFrom = lastScanned + 1n > POTLY_DEPLOY_BLOCK ? lastScanned + 1n : POTLY_DEPLOY_BLOCK
        }

        const started = Date.now()
        let chunk     = CHUNK_INIT
        let from      = scanFrom

        while (from <= syncedTo && Date.now() - started < MAX_MS) {
          const to = from + chunk - 1n < syncedTo ? from + chunk - 1n : syncedTo
          try {
            const logs = await client.getLogs({
              address:   POTLY_ADDRESS as `0x${string}`,
              events:    EVENT_ABI as typeof EVENT_ABI,
              args:      { potId: potIdN } as Record<string, unknown>,
              fromBlock: from,
              toBlock:   to,
            })

            // Batch-fetch block timestamps
            const blockNums = [...new Set(logs.map(l => l.blockNumber ?? 0n))]
            const blockTimes = new Map<bigint, string>()
            await Promise.all(blockNums.map(async bn => {
              const b = await client.getBlock({ blockNumber: bn })
              blockTimes.set(bn, toIso(b.timestamp))
            }))

            // Batch-fetch tx senders + gas for fee_wei
            const txHashes = [...new Set(logs.map(l => l.transactionHash ?? '').filter(Boolean))]
            const actors  = new Map<string, string>()
            const gasMap  = new Map<string, string>()
            await Promise.all(txHashes.map(async h => {
              try {
                const [tx, receipt] = await Promise.all([
                  client.getTransaction({ hash: h as `0x${string}` }),
                  client.getTransactionReceipt({ hash: h as `0x${string}` }),
                ])
                actors.set(h.toLowerCase(), tx.from.toLowerCase())
                gasMap.set(h.toLowerCase(), (receipt.gasUsed * receipt.effectiveGasPrice).toString())
              } catch { actors.set(h.toLowerCase(), '') }
            }))

            for (const log of logs) {
              try {
                const decoded = decodeEventLog({
                  abi: EVENT_ABI, data: log.data,
                  topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
                })
                const kind = (() => {
                  switch (decoded.eventName) {
                    case 'PotCreated':    return 'created' as const
                    case 'Deposited':     return 'deposit' as const
                    case 'Withdrawn':     return 'withdraw' as const
                    case 'PotFilled':     return 'filled' as const
                    case 'PayoutClaimed': return 'payout' as const
                    case 'PotCancelled':  return 'cancelled' as const
                    default: return null
                  }
                })()
                if (!kind) continue
                const args   = decoded.args as Record<string, unknown>
                const actor  = actors.get((log.transactionHash ?? '').toLowerCase()) ?? ''
                const bt     = blockTimes.get(log.blockNumber ?? 0n) ?? new Date(0).toISOString()
                const { wallet, amount, raised_after, extra } = mapArgs(kind, args, actor)
                const txH    = (log.transactionHash ?? '').toLowerCase()
                rows.push({ kind, wallet, actor, amount, raised_after, extra,
                  log_index:    log.logIndex ?? 0,
                  block_number: Number(log.blockNumber ?? 0n),
                  block_time:   bt,
                  tx_hash:      txH,
                })
                const gw = gasMap.get(txH)
                if (gw) feeWei.set(txH, gw)
              } catch { /* skip */ }
            }

            from  = to + 1n
            chunk = CHUNK_INIT
          } catch (e) {
            if (isRangeErr(e) && chunk > CHUNK_MIN) {
              chunk = chunk / 2n
            } else {
              from = to + 1n
              chunk = CHUNK_INIT
            }
          }
        }

        await ingest(chainIdN, potIdN, rows, feeWei, syncedTo, mode === 'cold' ? 'cold' : 'refreshed')
      }

      // Build and return payload from in-memory rows + a DB re-read for consistent ordering
      const state = await readScanState(chainIdN, potIdN)
      const LIMIT = 20
      const allRows = await readDbEvents(chainIdN, potIdN, LIMIT)
      const payload = buildPayload(allRows, LIMIT, state)
      const wallets = [...new Set(payload.events.map(e => e.wallet).filter(Boolean))]
      const aliases = await getAliasMap(wallets)

      return res.status(200).json({ ok: true, status: 'ok', ...payload, aliases })
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  } catch (err) {
    const pgCode = String((err as { message?: string })?.message ?? err).match(/\b[0-9A-Z]{5}\b/)?.[0]
    return res.status(500).json({ ok: false, error: pgCode ? `DB error ${pgCode}` : 'Internal error' })
  }
}
