/**
 * useActivity — data flow without polling for history.
 *
 * - Loads activity once when the pot page opens.
 * - If history is empty OR inconsistent with chain (raised > 0 but no deposits,
 *   or net-deposit sum differs from raised), calls tick once and refetches.
 *   At most 2 attempts, 4 s apart.  Shows "Syncing history…" during retries.
 * - syncTx(hash): POST .../sync then refetches once (called after user tx).
 * - No setInterval for history.
 * - Pot state from chain may refresh every 20 s only while tab is visible
 *   (handled by PotPage via usePot refetch, not here).
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { TARGET_CHAIN_ID, POTLY_ADDRESS } from '@/config/wagmi'

export interface PotEvent {
  kind: 'created' | 'deposit' | 'withdraw' | 'filled' | 'payout' | 'cancelled'
  wallet:       string
  actor:        string
  amount:       string
  raised_after: string
  extra:        Record<string, unknown>
  tx_hash:      string
  block_number: number
  block_time:   string   // ISO 8601 from the API
  log_index:    number
}

interface ActivityState {
  events:    PotEvent[]
  aliases:   Record<string, string>
  hasMore:   boolean
  loading:   boolean
  syncing:   boolean     // "Syncing history…" indicator
  error:     string | null
  lastFetch: number      // ms timestamp of last successful fetch
}

const BASE_URL = (potId: bigint) =>
  `/api/v1/pots/${TARGET_CHAIN_ID}/${potId}`

void POTLY_ADDRESS  // keep import alive

export function useActivity(potId: bigint | undefined, raisedAmount?: bigint) {
  const [state, setState] = useState<ActivityState>({
    events: [], aliases: {}, hasMore: false,
    loading: false, syncing: false, error: null, lastFetch: 0,
  })
  const retryCount    = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncingRef    = useRef(false)

  // ── Core fetch ─────────────────────────────────────────────────────────────
  const fetchActivity = useCallback(async (limit = 100) => {
    if (potId === undefined) return
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const r = await fetch(`${BASE_URL(potId)}/activity?limit=${limit}`)
      if (!r.ok) { setState(s => ({ ...s, loading: false, error: `HTTP ${r.status}` })); return }
      const data = await r.json() as {
        events?: PotEvent[]; aliases?: Record<string, string>; hasMore?: boolean
      }
      setState(s => ({
        ...s,
        events:    data.events  ?? [],
        aliases:   data.aliases ?? {},
        hasMore:   data.hasMore ?? false,
        loading:   false,
        error:     null,
        lastFetch: Date.now(),
      }))
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: String(e) }))
    }
  }, [potId])

  // ── Load-more (append) ─────────────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (potId === undefined || !state.hasMore) return
    setState(s => ({ ...s, loading: true }))
    const last = state.events[state.events.length - 1]
    const before = last ? `${last.block_number}:${last.log_index}` : ''
    try {
      const r = await fetch(`${BASE_URL(potId)}/activity?limit=20${before ? `&before=${before}` : ''}`)
      if (!r.ok) { setState(s => ({ ...s, loading: false })); return }
      const data = await r.json() as { events?: PotEvent[]; aliases?: Record<string,string>; hasMore?: boolean }
      setState(s => ({
        ...s,
        events:  [...s.events, ...(data.events || [])],
        aliases: { ...s.aliases, ...(data.aliases || {}) },
        hasMore: data.hasMore ?? false,
        loading: false,
      }))
    } catch { setState(s => ({ ...s, loading: false })) }
  }, [potId, state.events, state.hasMore])

  // ── Inconsistency detection ────────────────────────────────────────────────
  useEffect(() => {
    if (potId === undefined || syncingRef.current) return
    if (state.loading || state.syncing) return
    if (state.lastFetch === 0) return  // initial load not done yet

    const raised = raisedAmount ?? 0n
    const deposits = state.events.filter(e => e.kind === 'deposit')
    const netDeposit = deposits.reduce((s, e) => s + BigInt(e.amount), 0n)
    const withdrawals = state.events.filter(e => e.kind === 'withdraw')
    const netWithdraw = withdrawals.reduce((s, e) => s + BigInt(e.amount), 0n)
    const netFromEvents = netDeposit - netWithdraw

    const inconsistent =
      (raised > 0n && deposits.length === 0) ||
      (raised > 0n && netFromEvents !== raised && deposits.length > 0)

    if (!inconsistent || retryCount.current >= 2) return

    // Inconsistency detected — re-fetch from DB only (no automatic RPC scan).
    // The user can click Refresh to explicitly trigger a chain scan if needed.
    syncingRef.current = true
    retryCount.current += 1
    const attempt = async () => {
      await fetchActivity()
      syncingRef.current = false
    }
    retryTimerRef.current = setTimeout(attempt, retryCount.current === 1 ? 2000 : 4000)
  }, [state.lastFetch, state.events.length, raisedAmount?.toString(), potId?.toString()])

  // ── Initial load ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (potId === undefined) return
    retryCount.current = 0
    retryTimerRef.current && clearTimeout(retryTimerRef.current)
    void fetchActivity(100)
  }, [potId])

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    retryTimerRef.current && clearTimeout(retryTimerRef.current)
  }, [])

  // ── syncTx: POST .../sync then refetch once ────────────────────────────────
  const syncTx = useCallback(async (txHash: string) => {
    if (potId === undefined) return
    try {
      await fetch(`${BASE_URL(potId)}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash }),
      })
    } catch { /* best-effort */ }
    await fetchActivity(100)
  }, [potId, fetchActivity])

  // ── Manual refresh — re-reads from DB after caller has already scanned chain ─
  // (ContributorsList calls POST .../rescan first, then calls this.)
  const refresh = useCallback(async () => {
    if (potId === undefined) return
    await fetchActivity(100)
  }, [potId, fetchActivity])

  return {
    ...state,
    syncTx,
    refresh,
    loadMore,
    fetchActivity,
  }
}
