/**
 * useActivity — polls GET .../activity every 15 s, triggers refresh on mount,
 * and exposes a syncTx(txHash) helper to call after a confirmed transaction.
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { TARGET_CHAIN_ID, POTLY_ADDRESS } from '@/config/wagmi'

export interface PotEvent {
  kind: 'created' | 'deposit' | 'withdraw' | 'filled' | 'payout' | 'cancelled'
  wallet: string
  actor: string
  amount: string
  raised_after: string
  extra: Record<string, string>
  tx_hash: string
  block_number: number
  block_time: number
  log_index: number
}

interface ActivityState {
  events: PotEvent[]
  aliases: Record<string, string>
  loading: boolean
  error: string | null
}

const POLL_MS = 15_000
const contract = POTLY_ADDRESS.toLowerCase()

export function useActivity(potId: bigint | undefined) {
  const [state, setState] = useState<ActivityState>({ events: [], aliases: {}, loading: false, error: null })
  const refreshThrottle = useRef(0)

  const fetchActivity = useCallback(async () => {
    if (potId === undefined) return
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const res = await fetch(`/api/v1/pots/${TARGET_CHAIN_ID}/${potId}/sync`)
      if (!res.ok) { setState(s => ({ ...s, loading: false })); return }
      const data = await res.json() as { events?: PotEvent[]; aliases?: Record<string, string> }
      setState({ events: data.events ?? [], aliases: data.aliases ?? {}, loading: false, error: null })
    } catch {
      setState(s => ({ ...s, loading: false, error: 'Could not load activity' }))
    }
  }, [potId?.toString()])

  const triggerRefresh = useCallback(async () => {
    if (potId === undefined) return
    const now = Date.now()
    if (now - refreshThrottle.current < 5_000) return
    refreshThrottle.current = now
    try {
      await fetch(`/api/v1/pots/${TARGET_CHAIN_ID}/${potId}/refresh`, { method: 'POST' })
      await fetchActivity()
    } catch { /* ok */ }
  }, [potId?.toString(), fetchActivity])

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

  // Initial load: refresh then poll
  useEffect(() => {
    if (potId === undefined) return
    triggerRefresh()
    const id = setInterval(fetchActivity, POLL_MS)
    return () => clearInterval(id)
  }, [potId?.toString()])

  return { ...state, syncTx, triggerRefresh }
}

// Suppress unused import — contract is referenced in comments
void contract
