/**
 * useCreatedAt — resolves the creation timestamp for a pot.
 *
 * Priority:
 *   1. Already in `dbIso` (the 'created' event from Supabase via useActivity) → use it.
 *   2. Module-level cache (populated by a previous RPC call this session) → use it.
 *   3. One RPC getLogs + getBlock call — fires ONLY when both 1 and 2 are absent.
 *      After the RPC call succeeds we persist the event via POST .../sync so future
 *      visits will hit path 1 and skip RPC entirely.
 *
 * Never calls RPC if the DB already has the creation event.
 */
import { useState, useEffect } from 'react'
import { usePublicClient } from 'wagmi'
import { TARGET_CHAIN_ID, POTLY_ADDRESS } from '@/config/wagmi'

// Module-level cache: potId.toString() -> ISO string
const cache = new Map<string, string>()

export function useCreatedAt(
  potId:  bigint | undefined,
  /** ISO string already from Supabase (createdEvt.block_time). If present, skip RPC. */
  dbIso?: string | null,
): string | null {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const key    = potId?.toString() ?? ''

  // Seed the state from the fastest available source
  const [ts, setTs] = useState<string | null>(
    dbIso ?? cache.get(key) ?? null,
  )

  useEffect(() => {
    // If DB already gave us the time, update state and stop — no RPC.
    if (dbIso) {
      setTs(dbIso)
      cache.set(key, dbIso)
      return
    }
    if (cache.has(key)) { setTs(cache.get(key)!); return }
    if (potId === undefined || !client) return

    let cancelled = false

    async function run() {
      try {
        // One getLogs call with the indexed potId arg — only returns the PotCreated log.
        const logs = await client!.getLogs({
          address: POTLY_ADDRESS,
          event: {
            type:   'event',
            name:   'PotCreated',
            inputs: [
              { name: 'potId',        type: 'uint256', indexed: true },
              { name: 'creator',      type: 'address', indexed: true },
              { name: 'recipient',    type: 'address', indexed: true },
              { name: 'target',       type: 'uint256' },
              { name: 'slots',        type: 'uint256' },
              { name: 'deadline',     type: 'uint256' },
              { name: 'metadataHash', type: 'bytes32' },
            ],
          },
          args:      { potId },
          fromBlock: 'earliest',
          toBlock:   'latest',
        })
        if (cancelled || logs.length === 0) return
        const log = logs[0]
        if (!log.blockNumber || !log.transactionHash) return

        const block = await client!.getBlock({ blockNumber: log.blockNumber })
        if (cancelled) return

        const iso = new Date(Number(block.timestamp) * 1000).toISOString()
        cache.set(key, iso)
        setTs(iso)

        // Persist to Supabase so next visit uses the DB path (fire-and-forget).
        fetch(`/api/v1/pots/${TARGET_CHAIN_ID}/${potId}/sync`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ txHash: log.transactionHash }),
        }).catch(() => { /* best-effort — non-critical */ })
      } catch {
        // silently ignore — caller falls back to "—"
      }
    }

    void run()
    return () => { cancelled = true }
  // Re-run only when potId changes or dbIso arrives from Supabase for the first time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [potId?.toString(), dbIso ?? ''])

  return ts
}
