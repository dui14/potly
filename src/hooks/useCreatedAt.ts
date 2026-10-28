/**
 * useCreatedAt — reads the block timestamp of a pot's PotCreated event
 * directly from the chain (eth_getLogs for this specific potId).
 *
 * Used by StatusTimeline when the database event is not yet indexed.
 * The result is stable (creation time never changes), so we cache it in
 * module memory to avoid re-fetching on re-renders.
 */
import { useState, useEffect } from 'react'
import { usePublicClient } from 'wagmi'
import { TARGET_CHAIN_ID, POTLY_ADDRESS } from '@/config/wagmi'

// Module-level cache: potId.toString() -> ISO string
const cache = new Map<string, string>()

export function useCreatedAt(potId: bigint | undefined): string | null {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const key    = potId?.toString() ?? ''
  const [ts, setTs] = useState<string | null>(cache.get(key) ?? null)

  useEffect(() => {
    if (potId === undefined || !client) return
    if (cache.has(key)) { setTs(cache.get(key)!); return }
    let cancelled = false

    async function fetch() {
      try {
        // getLogs with indexed potId filter — returns just the PotCreated log
        const logs = await client!.getLogs({
          address:   POTLY_ADDRESS,
          event:     {
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
        if (cancelled) return
        if (logs.length === 0) return
        const log = logs[0]
        if (!log.blockNumber) return
        const block = await client!.getBlock({ blockNumber: log.blockNumber })
        if (cancelled) return
        const iso = new Date(Number(block.timestamp) * 1000).toISOString()
        cache.set(key, iso)
        setTs(iso)
      } catch {
        // silently ignore — caller falls back to "—"
      }
    }

    void fetch()
    return () => { cancelled = true }
  }, [potId?.toString(), client])

  return ts
}
