/**
 * useProofStats
 *
 * Reads aggregate statistics:
 *   - potCount from the chain (live, useReadContract)
 *   - paid, settled, fees from GET /api/v1/stats (cached 60 s server-side)
 *
 * Falls back to the old multicall approach when the API is unavailable.
 */
import { useState, useEffect, useRef } from 'react'
import { useReadContract, usePublicClient } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID } from '@/config/wagmi'

const CACHE_TTL  = 60_000   // ms — mirrors server s-maxage
const BATCH_SIZE = 50
const FALLBACK_MAX = 200
const STATUS_PAID  = 2

export interface ProofStats {
  potCount:    bigint
  paidCount:   number
  usdcSettled: bigint
  feesAccrued: bigint
}

export function useProofStats() {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [stats, setStats]     = useState<ProofStats | null>(null)
  const [loading, setLoading] = useState(false)
  const cacheUntil            = useRef(0)

  // potCount live from chain
  const { data: potCountData } = useReadContract({
    address: POTLY_ADDRESS,
    abi: POTLY_ABI,
    functionName: 'potCount',
    chainId: TARGET_CHAIN_ID,
    query: { refetchInterval: 30_000 },
  })
  const potCount = (potCountData as bigint | undefined) ?? 0n

  const { data: feeBpsData } = useReadContract({
    address: POTLY_ADDRESS, abi: POTLY_ABI, functionName: 'feeBps', chainId: TARGET_CHAIN_ID,
  })
  const feeBps = (feeBpsData as number | undefined) ?? 0

  useEffect(() => {
    if (Date.now() < cacheUntil.current) return  // still fresh
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        // ── 1. API ────────────────────────────────────────────────────────
        const r = await fetch('/api/v1/stats').catch(() => null)
        if (r && r.ok) {
          const body = await r.json() as { ok: boolean; paid?: string; settled?: string; fees?: string }
          if (body.ok && !cancelled) {
            setStats((_s) => ({
              potCount,
              paidCount:   Number(body.paid ?? 0),
              usdcSettled: BigInt(body.settled ?? 0),
              feesAccrued: BigInt(body.fees   ?? 0),
            }) satisfies ProofStats)
            cacheUntil.current = Date.now() + CACHE_TTL
            setLoading(false)
            return
          }
        }
      } catch { /* fall through */ }

      // ── 2. Fallback multicall ─────────────────────────────────────────
      if (!client) { setLoading(false); return }
      try {
        const total     = Number(potCount)
        const scanStart = Math.max(1, total - FALLBACK_MAX + 1)
        const ids: bigint[] = []
        for (let i = total; i >= scanStart; i--) ids.push(BigInt(i))

        let paidCount = 0; let usdcSettled = 0n; let feesAccrued = 0n
        for (let b = 0; b < ids.length; b += BATCH_SIZE) {
          if (cancelled) return
          const batch   = ids.slice(b, b + BATCH_SIZE)
          const calls   = batch.map(id => ({ address: POTLY_ADDRESS, abi: POTLY_ABI, functionName: 'getPot' as const, args: [id] as const }))
          const results = await client.multicall({ contracts: calls, allowFailure: true })
          for (const r of results) {
            if (r.status !== 'success') continue
            const pot = r.result as { status: number; target: bigint }
            if (pot.status === STATUS_PAID) {
              paidCount++
              usdcSettled += pot.target
              feesAccrued += (pot.target * BigInt(feeBps)) / 10000n
            }
          }
        }
        if (!cancelled) {
          setStats({ potCount, paidCount, usdcSettled, feesAccrued })
          cacheUntil.current = Date.now() + CACHE_TTL
        }
      } catch { /* leave previous stats visible */ }
      finally { if (!cancelled) setLoading(false) }
    }

    void load()
    return () => { cancelled = true }
  }, [client, feeBps, potCount.toString()])

  // Keep potCount in sync even when the rest is cached
  useEffect(() => {
    setStats(s => s ? { ...s, potCount } : null)
  }, [potCount.toString()])

  return { stats, loading }
}
