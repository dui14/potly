import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { parseAbiItem } from 'viem'
import { POTLY_ADDRESS, POTLY_DEPLOY_BLOCK, TARGET_CHAIN_ID } from '@/config/wagmi'
import { useReadContract } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'

const PayoutClaimedAbi = parseAbiItem(
  'event PayoutClaimed(uint256 indexed potId, address indexed recipient, uint256 payout, uint256 fee)',
)
const CHUNK = 2000n

export function useProofStats() {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [totalPaid, setTotalPaid]     = useState<bigint>(0n)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState<string | null>(null)

  const { data: potCount } = useReadContract({
    address: POTLY_ADDRESS,
    abi: POTLY_ABI,
    functionName: 'potCount',
    chainId: TARGET_CHAIN_ID,
    query: { refetchInterval: 15_000 },
  })

  useEffect(() => {
    if (!client) return
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const head = await client!.getBlockNumber()
        let sum = 0n
        for (let from = POTLY_DEPLOY_BLOCK; from <= head; from += CHUNK) {
          if (cancelled) return
          const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head
          const logs = await client!.getLogs({
            address: POTLY_ADDRESS,
            event: PayoutClaimedAbi,
            fromBlock: from, toBlock: to,
          })
          for (const log of logs) {
            sum += (log.args.payout as bigint) + (log.args.fee as bigint)
          }
        }
        if (!cancelled) { setTotalPaid(sum); setLoading(false) }
      } catch {
        if (!cancelled) { setError('Failed to load stats.'); setLoading(false) }
      }
    }
    load()
    return () => { cancelled = true }
  }, [client])

  return { potCount: potCount as bigint | undefined, totalPaid, loading, error }
}
