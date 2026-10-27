import { useReadContract } from 'wagmi'
import { erc20Abi } from 'viem'
import { USDC_ADDRESS, TARGET_CHAIN_ID } from '@/config/wagmi'

export function useUsdcBalance(address: `0x${string}` | undefined) {
  const { data, refetch } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 10_000 },
  })
  return { balance: (data as bigint | undefined) ?? 0n, refetch }
}

export function useUsdcAllowance(owner: `0x${string}` | undefined, spender: `0x${string}`) {
  const { data, refetch } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: owner ? [owner, spender] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!owner, refetchInterval: 8_000 },
  })
  return { allowance: (data as bigint | undefined) ?? 0n, refetch }
}
