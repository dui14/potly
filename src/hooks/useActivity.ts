/**
 * useActivity
 *
 * - Calls POST /api/v1/index/tick at most once per 15 s per tab.
 * - Polls GET .../activity every 15 s.
 * - syncTx(hash): POST .../sync then re-fetch.
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { TARGET_CHAIN_ID, POTLY_ADDRESS } from '@/config/wagmi'

export interface PotEvent {
  kind: 'created' | 'deposit' | 'withdraw' | 'filled' | 'payout' | 'cancelled'
  wallet:      string
  actor:       string
  amount:      string
  raised_after: string
  extra:       Record<string, unknown>
  tx_hash:     string
  block_number: number
  block_time:  number
  log_index:   number
}

interface ActivityState {
  events:  PotEvent[]
  aliases: Record<string, string>
  loading: boolean
  error:   string | null
}

const POLL_MS    = 15_000
const TICK_MS    = 15_000

void POTLY_ADDRESS  // referenced only for type narrowing in the URL

export function useActivity(potId: bigint | undefined) {
  const [state, setState] = useState<ActivityState>({
    events: [], aliases: {}, loading: false, error: null,
  })
  const tickThrottle = useRef(0)

  // ── Fetch activity events ───────────────────────────────────────────────
  const fetchActivity = useCallback(async () => {
    if (potId === undefined) return
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const r = await fetch(`/api/v1/pots/${TARGET_CHAIN_ID}/${potId}/activity`)
      if (!r.ok) { setState(s => ({ ...s, loading: false })); return }
      const data = await r.json() as { events?: PotEvent[]; aliases?: Record<string, string> }
      setState({ events: data.events ?? [], aliases: data.aliases ?? {}, loading: false, error: null })
    } catch {
      setState(s => ({ ...s, loading: false, error: 'Could not load activity' }))
    }
  }, [potId?.toString()])

  // ── Trigger global indexer tick ─────────────────────────────────────────
  const triggerTick = useCallback(async () => {
    const now = Date.now()
    if (now - tickThrottle.current < TICK_MS) return
    tickThrottle.current = now
    try { await fetch('/api/v1/index/tick', { method: 'POST' }) } catch { /* ok */ }
  }, [])

  // ── Refresh: tick + re-fetch ────────────────────────────────────────────
  const triggerRefresh = useCallback(async () => {
    await triggerTick()
    await fetchActivity()
  }, [triggerTick, fetchActivity])

  // ── Sync a specific tx ──────────────────────────────────────────────────
  const syncTx = useCallback(async (txHash: string) => {
    if (potId === undefined) return
    try {
      await fetch(`/api/v1/pots/${TARGET_CHAIN_ID}/${potId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash }),
      })
      await fetchActivity()
    } catch { /* ok */ }
  }, [potId?.toString(), fetchActivity])

  // ── Mount: tick + poll ──────────────────────────────────────────────────
  useEffect(() => {
    if (potId === undefined) return
    void triggerRefresh()
    const id = setInterval(fetchActivity, POLL_MS)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [potId?.toString()])

  return { ...state, syncTx, triggerRefresh }
}
