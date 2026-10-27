import { useEffect, useRef, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { TARGET_CHAIN_ID } from '@/config/wagmi'

/**
 * Returns the current chain time in seconds (bigint).
 * Fetches the latest block timestamp on mount and keeps a live offset
 * so countdowns update every second without hammering the RPC.
 */
export function useChainTime(): bigint {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [chainTime, setChainTime] = useState<bigint>(BigInt(Math.floor(Date.now() / 1000)))
  const offsetRef = useRef(0) // chainTimestamp - Date.now()/1000

  useEffect(() => {
    let cancelled = false
    async function fetchLatestBlock() {
      try {
        const block = await client?.getBlock({ blockTag: 'latest' })
        if (!block || cancelled) return
        const blockTs = Number(block.timestamp)
        offsetRef.current = blockTs - Math.floor(Date.now() / 1000)
        setChainTime(BigInt(blockTs))
      } catch { /* ignore */ }
    }
    fetchLatestBlock()
    const rpcInterval = setInterval(fetchLatestBlock, 15_000)
    const tickInterval = setInterval(() => {
      if (cancelled) return
      const now = Math.floor(Date.now() / 1000) + offsetRef.current
      setChainTime(BigInt(now))
    }, 1_000)
    return () => {
      cancelled = true
      clearInterval(rpcInterval)
      clearInterval(tickInterval)
    }
  }, [client])

  return chainTime
}
