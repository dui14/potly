/**
 * useHistory — DB-first history for a pot page.
 *
 * On mount: one GET /history (Supabase only, s-maxage=5).
 * If needsSync: one POST sync mode="cold", guarded by a ref so it fires at
 *   most once per (chainId:potId) regardless of re-renders. On "busy" retries
 *   at most twice after retryAfterMs, then surfaces the Refresh button.
 * After user tx: syncTx(hash) calls mode="tx" once.
 * Refresh button: calls mode="refresh" once; disabled 10 s with a spinner.
 * No setInterval. No effect that re-issues sync after the data returns.
 *
 * DEV: logs one line per network request to console.debug with a [history] tag.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { TARGET_CHAIN_ID } from '@/config/wagmi'

export interface HistoryEvent {
  kind:         string
  wallet:       string
  actor:        string
  amount:       string
  raised_after: string
  extra:        Record<string, unknown>
  fee_wei:      string | null
  tx_hash:      string
  block_number: number
  block_time:   string   // ISO 8601
  log_index:    number
}

export interface HistoryPayload {
  created:    { time: string; txHash: string } | null
  events:     HistoryEvent[]
  aliases:    Record<string, string>
  hasMore:    boolean
  nextCursor: string | null
  syncedTo:   number | null
  needsSync:  boolean
}

interface State extends HistoryPayload {
  loading:        boolean
  loadingMore:    boolean
  syncing:        boolean   // cold/refresh scan in progress
  refreshCooldown:boolean   // 10 s lockout after refresh
  lastRefreshed:  number    // ms timestamp of last successful refresh
  error:          string | null
}

const EMPTY: HistoryPayload = {
  created: null, events: [], aliases: {}, hasMore: false,
  nextCursor: null, syncedTo: null, needsSync: false,
}

const BASE = (potId: bigint) => `/api/v1/pots/${TARGET_CHAIN_ID}/${potId}`

// Per-session dedup guard: set of "chainId:potId:mode" currently in-flight
const inFlight = new Set<string>()

function devLog(msg: string) {
  if (import.meta.env.DEV) console.debug('[history]', msg)
}

export function useHistory(potId: bigint | undefined) {
  const [state, setState] = useState<State>({
    ...EMPTY, loading: false, loadingMore: false,
    syncing: false, refreshCooldown: false, lastRefreshed: 0, error: null,
  })
  const coldFiredRef  = useRef(false)   // cold sync fired for this potId
  const retryCount    = useRef(0)
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── GET history ────────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async (cursor?: string): Promise<HistoryPayload | null> => {
    if (potId === undefined) return null
    const url = `${BASE(potId)}/history?limit=20${cursor ? `&before=${cursor}` : ''}`
    devLog(`GET ${url}`)
    try {
      const r = await fetch(url)
      if (!r.ok) return null
      const d = await r.json() as { ok: boolean } & HistoryPayload
      if (!d.ok) return null
      return { created: d.created, events: d.events, aliases: d.aliases ?? {},
               hasMore: d.hasMore ?? false, nextCursor: d.nextCursor ?? null,
               syncedTo: d.syncedTo ?? null, needsSync: d.needsSync ?? false }
    } catch { return null }
  }, [potId])

  // ── POST sync ──────────────────────────────────────────────────────────────
  const postSync = useCallback(async (
    mode: 'cold' | 'refresh' | 'tx', txHash?: string,
  ): Promise<HistoryPayload | null> => {
    if (potId === undefined) return null
    const key = `${TARGET_CHAIN_ID}:${potId}:${mode}`
    if (inFlight.has(key)) { devLog(`POST sync ${mode} — deduplicated (already in-flight)`); return null }
    inFlight.add(key)
    devLog(`POST sync mode=${mode}${txHash ? ` tx=${txHash.slice(0, 10)}…` : ''}`)
    try {
      const r = await fetch(`${BASE(potId)}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, ...(txHash ? { txHash } : {}) }),
      })
      if (!r.ok) return null
      const d = await r.json() as { ok: boolean; status?: string; retryAfterMs?: number } & HistoryPayload
      if (!d.ok) return null
      if (d.status === 'busy') {
        return { ...EMPTY, needsSync: true }  // signal caller to retry
      }
      return { created: d.created, events: d.events, aliases: d.aliases ?? {},
               hasMore: d.hasMore ?? false, nextCursor: d.nextCursor ?? null,
               syncedTo: d.syncedTo ?? null, needsSync: d.needsSync ?? false }
    } catch { return null }
    finally { inFlight.delete(key) }
  }, [potId])

  // ── Initial load ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (potId === undefined) return
    coldFiredRef.current = false
    retryCount.current   = 0
    setState(s => ({ ...s, loading: true, error: null, ...EMPTY }))

    void (async () => {
      const payload = await fetchHistory()
      if (!payload) {
        setState(s => ({ ...s, loading: false, error: 'Failed to load history.' }))
        return
      }
      setState(s => ({ ...s, loading: false, ...payload }))

      // Cold sync: fire exactly once if created event is missing
      if (payload.needsSync && !coldFiredRef.current) {
        coldFiredRef.current = true
        await runColdSync()
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [potId?.toString()])

  // ── Cold sync with retry ───────────────────────────────────────────────────
  async function runColdSync(attempt = 0): Promise<void> {
    if (potId === undefined) return
    setState(s => ({ ...s, syncing: true }))
    const result = await postSync('cold')
    if (!result) { setState(s => ({ ...s, syncing: false })); return }

    if (result.needsSync && attempt < 2) {
      // "busy" — retry after a delay, at most twice
      retryCount.current = attempt + 1
      setTimeout(() => void runColdSync(attempt + 1), 11_000)
      return
    }
    setState(s => ({ ...s, syncing: false, ...result }))
  }

  // ── Load more ──────────────────────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (potId === undefined || !state.hasMore || !state.nextCursor) return
    setState(s => ({ ...s, loadingMore: true }))
    const payload = await fetchHistory(state.nextCursor)
    setState(s => ({
      ...s,
      loadingMore: false,
      events:     payload ? [...s.events, ...payload.events] : s.events,
      aliases:    payload ? { ...s.aliases, ...payload.aliases } : s.aliases,
      hasMore:    payload ? payload.hasMore : false,
      nextCursor: payload ? payload.nextCursor : null,
    }))
  }, [potId, state.hasMore, state.nextCursor, fetchHistory])

  // ── syncTx: called after user's confirmed tx ───────────────────────────────
  const syncTx = useCallback(async (txHash: string) => {
    const result = await postSync('tx', txHash)
    if (result) setState(s => ({
      ...s, ...result,
      events:  result.events.length ? result.events : s.events,
      aliases: { ...s.aliases, ...result.aliases },
    }))
  }, [postSync])

  // ── Refresh button ─────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (potId === undefined || state.refreshCooldown) return
    setState(s => ({ ...s, syncing: true, refreshCooldown: true }))
    cooldownTimer.current && clearTimeout(cooldownTimer.current)
    cooldownTimer.current = setTimeout(() => setState(s => ({ ...s, refreshCooldown: false })), 10_000)
    const result = await postSync('refresh')
    setState(s => ({
      ...s, syncing: false,
      lastRefreshed: Date.now(),
      ...(result && !result.needsSync ? result : {}),
    }))
  }, [potId, state.refreshCooldown, postSync])

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => () => { cooldownTimer.current && clearTimeout(cooldownTimer.current) }, [])

  return {
    ...state,
    loadMore,
    syncTx,
    refresh,
  }
}
