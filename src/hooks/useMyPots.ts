/**
 * useMyPots — paginated pot list for a wallet.
 *
 * Network requests per page load (first 6):
 *   1. GET /api/v1/wallets/:address/pots?limit=6            — pot IDs (no-store)
 *   2. GET /api/v1/pots/titles?chain=…&ids=…               — titles (s-maxage=60)
 *   3. multicall getPot + contributionOf for those 6 IDs   — chain read
 *
 * Load more: repeats requests 1–3 with &before=<cursor>, appends.
 * No getLogs. No chain scan. Chain scan only inside the API route.
 * If the API fails, exposes a retry state.
 * Newly created pot from navigation state is prepended optimistically from
 * localStorage until the real API result arrives.
 */
import { useState, useEffect, useCallback } from 'react'
import { usePublicClient } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID } from '@/config/wagmi'

export interface MyPotEntry {
  potId:  bigint
  role:   'creator' | 'recipient' | 'contributor'
  title?: string
}

const PAGE      = 6
const BATCH     = 50

export function useMyPots(address: `0x${string}` | undefined, newPotId?: bigint) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })

  const optimistic: MyPotEntry | null = newPotId !== undefined
    ? { potId: newPotId, role: 'creator' }
    : null

  const [pots,        setPots]        = useState<MyPotEntry[]>(optimistic ? [optimistic] : [])
  const [loading,     setLoading]     = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [hasMore,     setHasMore]     = useState(false)
  const [cursor,      setCursor]      = useState<string | null>(null)

  // Resolve roles via multicall getPot + contributionOf
  async function resolveRoles(ids: bigint[]): Promise<MyPotEntry[]> {
    if (!client || !address || ids.length === 0) return []
    const entries: MyPotEntry[] = []
    for (let b = 0; b < ids.length; b += BATCH) {
      const batch = ids.slice(b, b + BATCH)
      const calls = batch.flatMap(id => [
        { address: POTLY_ADDRESS, abi: POTLY_ABI, functionName: 'getPot' as const, args: [id] as const },
        { address: POTLY_ADDRESS, abi: POTLY_ABI, functionName: 'contributionOf' as const, args: [id, address] as const },
      ])
      const results = await client.multicall({ contracts: calls, allowFailure: true })
      for (let i = 0; i < batch.length; i++) {
        const potRes  = results[i * 2]
        const cntRes  = results[i * 2 + 1]
        if (potRes.status !== 'success') continue
        const pot  = potRes.result as { creator: `0x${string}`; recipient: `0x${string}` }
        const cont = cntRes.status === 'success' ? (cntRes.result as bigint) : 0n
        const al   = address.toLowerCase()
        if (pot.creator.toLowerCase() === al)   entries.push({ potId: batch[i], role: 'creator' })
        else if (pot.recipient.toLowerCase() === al) entries.push({ potId: batch[i], role: 'recipient' })
        else if (cont > 0n) entries.push({ potId: batch[i], role: 'contributor' })
      }
    }
    return entries
  }

  // Fetch titles from the API in one query
  async function fetchTitles(ids: bigint[]): Promise<Record<string, string>> {
    if (ids.length === 0) return {}
    try {
      const r = await fetch(`/api/v1/pots/titles?chain=${TARGET_CHAIN_ID}&ids=${ids.join(',')}`)
      if (!r.ok) return {}
      const d = await r.json() as { ok: boolean; titles?: Record<string, string> }
      return d.ok && d.titles ? d.titles : {}
    } catch { return {} }
  }

  // Fetch a page of pot IDs
  async function fetchIds(beforeCursor?: string): Promise<{ ids: bigint[]; hasMore: boolean; next: string | null } | null> {
    if (!address) return null
    try {
      const url = `/api/v1/wallets/${address.toLowerCase()}/pots?limit=${PAGE}${beforeCursor ? `&before=${beforeCursor}` : ''}`
      const r = await fetch(url)
      if (!r.ok) return null
      const d = await r.json() as { ok: boolean; potIds?: string[]; hasMore?: boolean; nextCursor?: string | null }
      if (!d.ok || !Array.isArray(d.potIds)) return null
      return { ids: d.potIds.map(s => BigInt(s)), hasMore: d.hasMore ?? false, next: d.nextCursor ?? null }
    } catch { return null }
  }

  function withOptimistic(list: MyPotEntry[]): MyPotEntry[] {
    if (!optimistic) return list
    if (list.some(p => p.potId === optimistic.potId)) return list
    return [optimistic, ...list]
  }

  // ── Initial load ─────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!address || !client) return
    setLoading(true)
    setError(null)

    try {
      const apiResult = await fetchIds()
      if (!apiResult) { setError('Failed to load pots.'); return }

      const [entries, titles] = await Promise.all([
        resolveRoles(apiResult.ids),
        fetchTitles(apiResult.ids),
      ])
      const merged = entries.map(e => ({ ...e, title: titles[e.potId.toString()] }))

      setPots(withOptimistic(merged))
      setHasMore(apiResult.hasMore)
      setCursor(apiResult.next)
    } catch { setError('Failed to load pots.') }
    finally  { setLoading(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, client])

  // ── Load more ─────────────────────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (!address || !client || loadingMore || !hasMore || !cursor) return
    setLoadingMore(true)
    try {
      const apiResult = await fetchIds(cursor)
      if (!apiResult) { setLoadingMore(false); return }

      const [entries, titles] = await Promise.all([
        resolveRoles(apiResult.ids),
        fetchTitles(apiResult.ids),
      ])
      const merged = entries.map(e => ({ ...e, title: titles[e.potId.toString()] }))

      setPots(prev => {
        const existing = new Set(prev.map(p => p.potId.toString()))
        return [...prev, ...merged.filter(e => !existing.has(e.potId.toString()))]
      })
      setHasMore(apiResult.hasMore)
      setCursor(apiResult.next)
    } catch { /* silent — user can try Load more again */ }
    finally  { setLoadingMore(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, client, cursor, hasMore, loadingMore])

  useEffect(() => { void load() }, [load])

  return { pots, loading, loadingMore, hasMore, error, retry: load, loadMore }
}
