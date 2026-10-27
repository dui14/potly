/**
 * useProofStats — reads potCount, then fetches the newest ≤200 pots via
 * multicall (getPot batches of 50) to compute proof strip stats.
 * Caches the result for 30 seconds.  No getLogs dependency.
 */
import { useState, useEffect, useRef } from 'react'
import { usePublicClient, useReadContract } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID } from '@/config/wagmi'

const MAX_POTS   = 200
const BATCH_SIZE = 50
const CACHE_TTL  = 30_000   // ms

interface Stats {
  potCount:     bigint
  paidCount:    number
  usdcSettled:  bigint  // sum of target for PAID pots
  feesAccrued:  bigint  // sum of floor(target * feeBps / 10000)
}

const STATUS_PAID = 2

export function useProofStats() {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [stats, setStats]   = useState<Stats | null>(null)
  const [loading, setLoading] = useState(false)
  const cacheUntil = useRef(0)

  // feeBps — read once
  const { data: feeBpsData } = useReadContract({
    address: POTLY_ADDRESS,
    abi: POTLY_ABI,
    functionName: 'feeBps',
    chainId: TARGET_CHAIN_ID,
  })
  const feeBps = (feeBpsData as number | undefined) ?? 0

  useEffect(() => {
    if (!client) return
    if (Date.now() < cacheUntil.current) return  // still fresh

    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const potCountRaw = await client!.readContract({
          address: POTLY_ADDRESS,
          abi: POTLY_ABI,
          functionName: 'potCount',
        }) as bigint

        const total    = Number(potCountRaw)
        const scanEnd  = total
        const scanStart = Math.max(1, total - MAX_POTS + 1)
        const ids: bigint[] = []
        for (let i = scanEnd; i >= scanStart; i--) ids.push(BigInt(i))

        let paidCount   = 0
        let usdcSettled = 0n
        let feesAccrued = 0n

        for (let b = 0; b < ids.length; b += BATCH_SIZE) {
          if (cancelled) return
          const batch = ids.slice(b, b + BATCH_SIZE)
          const calls = batch.map(potId => ({
            address: POTLY_ADDRESS,
            abi: POTLY_ABI,
            functionName: 'getPot' as const,
            args: [potId] as const,
          }))
          const results = await client!.multicall({ contracts: calls, allowFailure: true })
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
          setStats({ potCount: potCountRaw, paidCount, usdcSettled, feesAccrued })
          cacheUntil.current = Date.now() + CACHE_TTL
        }
      } catch { /* ignore — last stats stay visible */ }
      finally { if (!cancelled) setLoading(false) }
    }

    load()
    return () => { cancelled = true }
  }, [client, feeBps])

  return { stats, loading }
}
