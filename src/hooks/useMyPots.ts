/**
 * useMyPots
 *
 * 1. Calls GET /api/v1/wallets/:address/pots (my_pot_ids Supabase RPC).
 *    Returns those pot ids; then reads only those pots from the chain via one multicall.
 * 2. Falls back to scanning potCount → multicall(getPot+contributionOf) when the API
 *    is unavailable (no Supabase, 503, network error).
 */
import { useState, useEffect, useCallback } from 'react'
import { usePublicClient } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID } from '@/config/wagmi'

export interface MyPotEntry { potId: bigint; role: 'creator' | 'recipient' | 'contributor' }

const BATCH_SIZE      = 50
const FALLBACK_MAX    = 200

export function useMyPots(address: `0x${string}` | undefined) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [pots, setPots]         = useState<MyPotEntry[]>([])
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const load = useCallback(async () => {
    if (!address || !client) return
    setLoading(true)
    setError(null)
    setPots([])

    try {
      // ── 1. Try API ──────────────────────────────────────────────────────
      let apiIds: bigint[] | null = null
      try {
        const r = await fetch(`/api/v1/wallets/${address.toLowerCase()}/pots`)
        if (r.ok) {
          const body = await r.json() as { ok: boolean; potIds?: string[] }
          if (body.ok && Array.isArray(body.potIds)) {
            apiIds = body.potIds.map(id => BigInt(id))
          }
        }
      } catch { /* fall through to chain scan */ }

      if (apiIds !== null) {
        // Read only those specific pots from chain in one multicall
        const seen: MyPotEntry[] = []
        for (let b = 0; b < apiIds.length; b += BATCH_SIZE) {
          const batch = apiIds.slice(b, b + BATCH_SIZE)
          setProgress({ done: b, total: apiIds.length })
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
            const addr = address.toLowerCase()
            if (pot.creator.toLowerCase() === addr) seen.push({ potId: batch[i], role: 'creator' })
            else if (pot.recipient.toLowerCase() === addr) seen.push({ potId: batch[i], role: 'recipient' })
            else if (cont > 0n) seen.push({ potId: batch[i], role: 'contributor' })
          }
        }
        setPots(seen)
        setProgress(null)
        setLoading(false)
        return
      }

      // ── 2. Fallback: scan newest N pots ─────────────────────────────────
      const potCountRaw = await client.readContract({
        address: POTLY_ADDRESS,
        abi: POTLY_ABI,
        functionName: 'potCount',
      }) as bigint

      const total     = Number(potCountRaw)
      const scanStart = Math.max(1, total - FALLBACK_MAX + 1)
      const ids: bigint[] = []
      for (let i = total; i >= scanStart; i--) ids.push(BigInt(i))

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
          const addr = address.toLowerCase()
          if (pot.creator.toLowerCase() === addr) seen.push({ potId: batch[i], role: 'creator' })
          else if (pot.recipient.toLowerCase() === addr) seen.push({ potId: batch[i], role: 'recipient' })
          else if (cont > 0n) seen.push({ potId: batch[i], role: 'contributor' })
        }
      }
      setPots(seen)
      setProgress(null)
    } catch {
      setError('Failed to load pots.')
    } finally {
      setLoading(false)
    }
  }, [address, client])

  useEffect(() => { void load() }, [load])

  return { pots, loading, error, progress, retry: load }
}
