/**
 * useMyPots — paginated pot list for a wallet.
 *
 * API contract (GET /api/v1/wallets/:address/pots?offset=N&limit=6):
 *   Returns { potIds, hasMore, total, source } — newest first.
 *
 * Strategy:
 *   1. Fetch page of 6 pot IDs from API (Supabase index → chain fallback).
 *   2. Multicall getPot + contributionOf for that page to resolve role.
 *   3. loadMore() fetches the next page and appends.
 *
 * @param newPotId — optimistic pot id from navigation state after creation;
 *                   prepended immediately so the new pot shows before the API.
 */
import { useState, useEffect, useCallback } from 'react'
import { usePublicClient } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID } from '@/config/wagmi'

export interface MyPotEntry { potId: bigint; role: 'creator' | 'recipient' | 'contributor' }

const PAGE_SIZE   = 6
const BATCH_SIZE  = 50

export function useMyPots(address: `0x${string}` | undefined, newPotId?: bigint) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })

  // Optimistic entry for the just-created pot
  const optimistic: MyPotEntry | null = newPotId !== undefined
    ? { potId: newPotId, role: 'creator' }
    : null

  const [pots, setPots]         = useState<MyPotEntry[]>(optimistic ? [optimistic] : [])
  const [loading, setLoading]   = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [hasMore, setHasMore]   = useState(false)
  const [offset, setOffset]     = useState(0)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  // Resolve role for a batch of pot IDs
  async function resolveRoles(ids: bigint[]): Promise<MyPotEntry[]> {
    if (!client || !address) return []
    const seen: MyPotEntry[] = []
    for (let b = 0; b < ids.length; b += BATCH_SIZE) {
      const batch = ids.slice(b, b + BATCH_SIZE)
      setProgress({ done: b, total: ids.length })
      const calls = batch.flatMap(potId => [
        { address: POTLY_ADDRESS, abi: POTLY_ABI, functionName: 'getPot' as const, args: [potId] as const },
        { address: POTLY_ADDRESS, abi: POTLY_ABI, functionName: 'contributionOf' as const, args: [potId, address] as const },
      ])
      const results = await client.multicall({ contracts: calls, allowFailure: true })
      for (let i = 0; i < batch.length; i++) {
        const potRes  = results[i * 2]
        const contRes = results[i * 2 + 1]
        if (potRes.status !== 'success') continue
        const pot  = potRes.result as { creator: `0x${string}`; recipient: `0x${string}` }
        const cont = contRes.status === 'success' ? (contRes.result as bigint) : 0n
        const addrL = address.toLowerCase()
        if (pot.creator.toLowerCase() === addrL) seen.push({ potId: batch[i], role: 'creator' })
        else if (pot.recipient.toLowerCase() === addrL) seen.push({ potId: batch[i], role: 'recipient' })
        else if (cont > 0n) seen.push({ potId: batch[i], role: 'contributor' })
      }
    }
    setProgress(null)
    return seen
  }

  // Fetch a page of pot IDs from the API
  async function fetchPage(pageOffset: number): Promise<{ ids: bigint[]; hasMore: boolean } | null> {
    if (!address) return null
    try {
      const r = await fetch(
        `/api/v1/wallets/${address.toLowerCase()}/pots?offset=${pageOffset}&limit=${PAGE_SIZE}`,
      )
      if (!r.ok) return null
      const body = await r.json() as { ok: boolean; potIds?: string[]; hasMore?: boolean }
      if (!body.ok || !Array.isArray(body.potIds)) return null
      return { ids: body.potIds.map(id => BigInt(id)), hasMore: body.hasMore ?? false }
    } catch { return null }
  }

  // Merge helper: prepend optimistic entry if not already present
  function withOptimistic(list: MyPotEntry[]): MyPotEntry[] {
    if (!optimistic) return list
    const already = list.some(p => p.potId === optimistic.potId)
    if (already) return list
    return [optimistic, ...list]
  }

  // ── Initial load ─────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!address || !client) return
    setLoading(true)
    setError(null)

    try {
      const apiResult = await fetchPage(0)
      if (apiResult !== null) {
        const entries = await resolveRoles(apiResult.ids)
        setPots(withOptimistic(entries))
        setHasMore(apiResult.hasMore)
        setOffset(PAGE_SIZE)
        return
      }

      // API unavailable — full chain fallback (scan newest 200)
      const potCountRaw = await client.readContract({
        address: POTLY_ADDRESS, abi: POTLY_ABI, functionName: 'potCount',
      }) as bigint
      const total = Number(potCountRaw)
      const ids: bigint[] = []
      for (let i = total; i >= Math.max(1, total - 200 + 1); i--) ids.push(BigInt(i))
      const entries = await resolveRoles(ids)
      setPots(withOptimistic(entries))
      setHasMore(false)
      setOffset(ids.length)
    } catch {
      setError('Failed to load pots.')
    } finally {
      setLoading(false)
    }
  }, [address, client])

  // ── Load more ─────────────────────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (!address || !client || loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const apiResult = await fetchPage(offset)
      if (apiResult !== null) {
        const entries = await resolveRoles(apiResult.ids)
        setPots(prev => {
          // Deduplicate: don't add pots already in the list
          const existing = new Set(prev.map(p => p.potId.toString()))
          const fresh = entries.filter(e => !existing.has(e.potId.toString()))
          return [...prev, ...fresh]
        })
        setHasMore(apiResult.hasMore)
        setOffset(o => o + PAGE_SIZE)
      } else {
        setHasMore(false)
      }
    } catch { /* silently ignore load-more errors */ }
    finally { setLoadingMore(false) }
  }, [address, client, offset, hasMore, loadingMore])

  useEffect(() => { void load() }, [load])

  return { pots, loading, loadingMore, hasMore, error, progress, retry: load, loadMore }
}
