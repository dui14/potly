import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { parseAbiItem } from 'viem'
import { POTLY_ADDRESS, POTLY_DEPLOY_BLOCK, TARGET_CHAIN_ID } from '@/config/wagmi'

export interface MyPotEntry { potId: bigint; role: 'creator' | 'depositor' }

const CHUNK = 2000n

const PotCreatedAbi = parseAbiItem(
  'event PotCreated(uint256 indexed potId, address indexed creator, address indexed recipient, uint256 target, uint256 slots, uint256 deadline, bytes32 metadataHash)',
)
const DepositedAbi = parseAbiItem(
  'event Deposited(uint256 indexed potId, address indexed depositor, uint256 amount, uint256 raised)',
)

export function useMyPots(address: `0x${string}` | undefined) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [pots, setPots]         = useState<MyPotEntry[]>([])
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [progress, setProgress] = useState<{ current: bigint; head: bigint } | null>(null)

  useEffect(() => {
    if (!address || !client) return
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const head  = await client!.getBlockNumber()
        const start = POTLY_DEPLOY_BLOCK
        const seen  = new Map<bigint, MyPotEntry>()

        for (let from = start; from <= head; from += CHUNK) {
          if (cancelled) return
          const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head
          setProgress({ current: to, head })

          const [created, deposited] = await Promise.all([
            client!.getLogs({
              address: POTLY_ADDRESS,
              event: PotCreatedAbi,
              args: { creator: address },
              fromBlock: from, toBlock: to,
            }),
            client!.getLogs({
              address: POTLY_ADDRESS,
              event: DepositedAbi,
              args: { depositor: address },
              fromBlock: from, toBlock: to,
            }),
          ])

          for (const log of created) {
            const id = log.args.potId as bigint
            if (!seen.has(id)) seen.set(id, { potId: id, role: 'creator' })
          }
          for (const log of deposited) {
            const id = log.args.potId as bigint
            if (!seen.has(id)) seen.set(id, { potId: id, role: 'depositor' })
          }
        }

        if (!cancelled) {
          setPots(Array.from(seen.values()).sort((a, b) => (a.potId < b.potId ? 1 : -1)))
          setLoading(false)
          setProgress(null)
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load pots. Please try again.')
          setLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [address, client])

  return { pots, loading, error, progress }
}
