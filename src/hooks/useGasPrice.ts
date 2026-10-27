import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { TARGET_CHAIN_ID } from '@/config/wagmi'

/** Returns the current gas price in wei (bigint), refreshed every 15s. */
export function useGasPrice(): bigint {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [gasPrice, setGasPrice] = useState(1_000_000_000n) // 1 gwei fallback

  useEffect(() => {
    let cancelled = false
    async function fetch() {
      try {
        const fees = await client?.estimateFeesPerGas()
        if (fees && !cancelled) {
          setGasPrice(fees.maxFeePerGas ?? fees.gasPrice ?? 1_000_000_000n)
        }
      } catch { /* keep last value */ }
    }
    fetch()
    const id = setInterval(fetch, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [client])

  return gasPrice
}
