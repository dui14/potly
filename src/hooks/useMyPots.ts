/**
 * useMyPots — reads potCount, then fetches the newest ≤200 pots via
 * multicall in batches of 50 (getPot + contributionOf for the wallet).
 * My pots = creator, recipient, or contribution > 0.
 * No getLogs dependency.
 */
import { useState, useEffect, useCallback } from 'react'
import { usePublicClient } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID } from '@/config/wagmi'

export interface MyPotEntry { potId: bigint; role: 'creator' | 'recipient' | 'contributor' }

const MAX_POTS   = 200
const BATCH_SIZE = 50

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

    try {
      // 1. Read potCount
      const potCountRaw = await client.readContract({
        address: POTLY_ADDRESS,
        abi: POTLY_ABI,
        functionName: 'potCount',
      }) as bigint

      const total   = Number(potCountRaw)
      const scanEnd = total               // id of the newest pot (1-indexed)
      const scanStart = Math.max(1, total - MAX_POTS + 1)
      const ids: bigint[] = []
      for (let i = scanEnd; i >= scanStart; i--) ids.push(BigInt(i))

      const seen: MyPotEntry[] = []

      // 2. Multicall in batches of BATCH_SIZE
      for (let b = 0; b < ids.length; b += BATCH_SIZE) {
        const batch = ids.slice(b, b + BATCH_SIZE)
        setProgress({ done: b, total: ids.length })

        // Build multicall contracts array: getPot + contributionOf per id
        const calls = batch.flatMap(potId => [
          {
            address: POTLY_ADDRESS,
            abi: POTLY_ABI,
            functionName: 'getPot' as const,
            args: [potId] as const,
          },
          {
            address: POTLY_ADDRESS,
            abi: POTLY_ABI,
            functionName: 'contributionOf' as const,
            args: [potId, address] as const,
          },
        ])

        const results = await client.multicall({ contracts: calls, allowFailure: true })

        for (let i = 0; i < batch.length; i++) {
          const potRes  = results[i * 2]
          const contRes = results[i * 2 + 1]
          if (potRes.status !== 'success') continue
          const pot  = potRes.result as { creator: `0x${string}`; recipient: `0x${string}` }
          const cont = contRes.status === 'success' ? (contRes.result as bigint) : 0n
          const addr = address.toLowerCase()
          if (pot.creator.toLowerCase() === addr) {
            seen.push({ potId: batch[i], role: 'creator' })
          } else if (pot.recipient.toLowerCase() === addr) {
            seen.push({ potId: batch[i], role: 'recipient' })
          } else if (cont > 0n) {
            seen.push({ potId: batch[i], role: 'contributor' })
          }
        }
      }

      setPots(seen) // already newest-first (ids were reversed)
      setProgress(null)
    } catch {
      setError('Failed to load pots.')
    } finally {
      setLoading(false)
    }
  }, [address, client])

  useEffect(() => { load() }, [load])

  return { pots, loading, error, progress, retry: load }
}
