import { useReadContract } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID } from '@/config/wagmi'

export const STATUS = { OPEN: 0, FILLED: 1, PAID: 2, CANCELLED: 3 } as const
export type PotStatus = (typeof STATUS)[keyof typeof STATUS]

export interface PotData {
  creator:      `0x${string}`
  recipient:    `0x${string}`
  target:       bigint
  raised:       bigint
  slots:        bigint
  contributors: bigint
  deadline:     bigint
  filledAt:     bigint
  status:       number
  metadataHash: `0x${string}`
}

export function usePot(potId: bigint | undefined) {
  const { data: pot, isLoading, refetch } = useReadContract({
    address: POTLY_ADDRESS,
    abi: POTLY_ABI,
    functionName: 'getPot',
    args: potId !== undefined ? [potId] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: potId !== undefined, refetchInterval: 8_000 },
  })
  return { pot: pot as PotData | undefined, isLoading, refetch }
}

export function useContributionOf(potId: bigint | undefined, address: `0x${string}` | undefined) {
  const { data, refetch } = useReadContract({
    address: POTLY_ADDRESS,
    abi: POTLY_ABI,
    functionName: 'contributionOf',
    args: potId !== undefined && address ? [potId, address] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: potId !== undefined && !!address, refetchInterval: 8_000 },
  })
  return { contribution: (data as bigint | undefined) ?? 0n, refetch }
}

export function useRemaining(potId: bigint | undefined) {
  const { data } = useReadContract({
    address: POTLY_ADDRESS,
    abi: POTLY_ABI,
    functionName: 'remaining',
    args: potId !== undefined ? [potId] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: potId !== undefined, refetchInterval: 8_000 },
  })
  return (data as bigint | undefined) ?? 0n
}

export function useIsRefundable(potId: bigint | undefined) {
  const { data } = useReadContract({
    address: POTLY_ADDRESS,
    abi: POTLY_ABI,
    functionName: 'isRefundable',
    args: potId !== undefined ? [potId] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: potId !== undefined, refetchInterval: 8_000 },
  })
  return data ?? false
}

export function usePotCount() {
  const { data } = useReadContract({
    address: POTLY_ADDRESS,
    abi: POTLY_ABI,
    functionName: 'potCount',
    chainId: TARGET_CHAIN_ID,
    query: { refetchInterval: 12_000 },
  })
  return data as bigint | undefined
}
