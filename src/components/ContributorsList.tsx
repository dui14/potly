import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { parseAbiItem } from 'viem'
import { POTLY_ADDRESS, POTLY_DEPLOY_BLOCK, TARGET_CHAIN_ID } from '@/config/wagmi'
import { fetchAliasesByWallets } from '@/lib/supabase'
import { formatAddress } from '@/lib/utils'
import type { PotData } from '@/hooks/usePot'

const DepositedAbi = parseAbiItem(
  'event Deposited(uint256 indexed potId, address indexed depositor, uint256 amount, uint256 raised)',
)
const WithdrawnAbi = parseAbiItem(
  'event Withdrawn(uint256 indexed potId, address indexed depositor, uint256 amount, uint256 raised)',
)

interface ContributorEntry {
  address: `0x${string}`
  amount: bigint
}

interface Props {
  potId: bigint
  pot: PotData
}

export function ContributorsList({ potId, pot }: Props) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [contributors, setContributors] = useState<ContributorEntry[]>([])
  const [aliases, setAliases]           = useState<Record<string, string>>({})

  // suggested share = target / slots
  const suggestedShare = pot.slots > 0n ? pot.target / pot.slots : 0n

  useEffect(() => {
    if (!client || !potId) return
    let cancelled = false
    async function load() {
      try {
        const head = await client!.getBlockNumber()
        const [depLogs, withLogs] = await Promise.all([
          client!.getLogs({
            address: POTLY_ADDRESS,
            event: DepositedAbi,
            args: { potId },
            fromBlock: POTLY_DEPLOY_BLOCK,
            toBlock: head,
          }),
          client!.getLogs({
            address: POTLY_ADDRESS,
            event: WithdrawnAbi,
            args: { potId },
            fromBlock: POTLY_DEPLOY_BLOCK,
            toBlock: head,
          }),
        ])
        if (cancelled) return

        // Build net contributions from events
        const net = new Map<string, bigint>()
        for (const log of depLogs) {
          const addr = (log.args.depositor as string).toLowerCase()
          net.set(addr, (net.get(addr) ?? 0n) + (log.args.amount as bigint))
        }
        for (const log of withLogs) {
          const addr = (log.args.depositor as string).toLowerCase()
          net.set(addr, (net.get(addr) ?? 0n) - (log.args.amount as bigint))
        }

        const entries: ContributorEntry[] = Array.from(net.entries())
          .filter(([, amt]) => amt > 0n)
          .map(([addr, amount]) => ({ address: addr as `0x${string}`, amount }))
          .sort((a, b) => (a.amount < b.amount ? 1 : -1))

        if (!cancelled) {
          setContributors(entries)
          const addrs = entries.map(e => e.address)
          fetchAliasesByWallets(addrs).then(m => { if (!cancelled) setAliases(m) })
        }
      } catch { /* ignore */ }
    }
    load()
    return () => { cancelled = true }
  }, [client, potId, pot.raised]) // re-run when raised changes (new deposit/withdraw)

  if (contributors.length === 0) {
    return <p className="text-sm text-[var(--muted)] text-center py-4">No contributions yet.</p>
  }

  return (
    <div className="flex flex-col gap-1">
      {contributors.map(c => {
        const alias = aliases[c.address.toLowerCase()]
        const displayName = alias ? `@${alias}` : formatAddress(c.address)
        const pct = suggestedShare > 0n
          ? Number((c.amount * 10000n) / suggestedShare) / 100
          : 0
        return (
          <div
            key={c.address}
            className="flex items-center justify-between rounded-lg px-3 py-2 bg-[var(--surface-muted)] text-sm"
          >
            <span className="font-mono text-[var(--ink-2)]">{displayName}</span>
            <div className="flex items-center gap-2 text-right">
              <span className="tabular-nums text-[var(--ink)]">${fmt(c.amount)}</span>
              <span className="text-xs text-[var(--subtle)]">{pct.toFixed(0)}% of share</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function fmt(raw: bigint) {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
