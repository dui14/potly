/**
 * ContributorsList — builds net contributions from Deposited/Withdrawn events.
 * Uses adaptive chunk sizes starting at 50,000 blocks, halving on range/limit
 * errors and trying the next transport.  Falls back to contributor count +
 * "details unavailable" if logs fail entirely.
 */
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

const CHUNK_INIT = 50_000n
const CHUNK_MIN  =  1_000n

interface ContributorEntry { address: `0x${string}`; amount: bigint }
interface Props { potId: bigint; pot: PotData }

function isRangeError(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e).toLowerCase()
  return msg.includes('block range') || msg.includes('limit exceeded') ||
         msg.includes('too many') || msg.includes('range')
}

export function ContributorsList({ potId, pot }: Props) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [contributors, setContributors] = useState<ContributorEntry[]>([])
  const [aliases, setAliases]           = useState<Record<string, string>>({})
  const [logsAvail, setLogsAvail]       = useState(true)

  const suggestedShare = pot.slots > 0n ? pot.target / pot.slots : 0n

  useEffect(() => {
    if (!client || !potId) return
    let cancelled = false

    async function load() {
      try {
        const head = await client!.getBlockNumber()
        const net  = new Map<string, bigint>()
        let chunk  = CHUNK_INIT

        for (let from = POTLY_DEPLOY_BLOCK; from <= head;) {
          if (cancelled) return
          const to = from + chunk - 1n < head ? from + chunk - 1n : head

          try {
            const [depLogs, withLogs] = await Promise.all([
              client!.getLogs({ address: POTLY_ADDRESS, event: DepositedAbi, args: { potId }, fromBlock: from, toBlock: to }),
              client!.getLogs({ address: POTLY_ADDRESS, event: WithdrawnAbi, args: { potId }, fromBlock: from, toBlock: to }),
            ])

            for (const log of depLogs) {
              const addr = (log.args.depositor as string).toLowerCase()
              net.set(addr, (net.get(addr) ?? 0n) + (log.args.amount as bigint))
            }
            for (const log of withLogs) {
              const addr = (log.args.depositor as string).toLowerCase()
              const cur  = net.get(addr) ?? 0n
              net.set(addr, cur > (log.args.amount as bigint) ? cur - (log.args.amount as bigint) : 0n)
            }

            from += chunk          // advance
            chunk = CHUNK_INIT     // reset chunk after a successful call
          } catch (e) {
            if (isRangeError(e) && chunk > CHUNK_MIN) {
              chunk = chunk / 2n   // halve and retry same range
            } else {
              throw e              // non-range error or already at min — bubble up
            }
          }
        }

        if (cancelled) return

        const entries: ContributorEntry[] = Array.from(net.entries())
          .filter(([, amt]) => amt > 0n)
          .map(([addr, amount]) => ({ address: addr as `0x${string}`, amount }))
          .sort((a, b) => (a.amount < b.amount ? 1 : -1))

        setContributors(entries)
        setLogsAvail(true)
        const addrs = entries.map(e => e.address)
        fetchAliasesByWallets(addrs).then(m => { if (!cancelled) setAliases(m) })
      } catch {
        if (!cancelled) setLogsAvail(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [client, potId, pot.raised])

  // ── Fallback: show count only when logs failed ───────────────────────────
  if (!logsAvail) {
    return (
      <div className="text-sm text-[var(--muted)] text-center py-4">
        {pot.contributors.toString()} contributor{pot.contributors !== 1n ? 's' : ''} · details unavailable
      </div>
    )
  }

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
          <div key={c.address}
            className="flex items-center justify-between rounded-lg px-3 py-2 bg-[var(--surface-muted)] text-sm">
            <span className="font-mono text-[var(--ink-2)]">{displayName}</span>
            <div className="flex items-center gap-2 text-right">
              <span className="tabular-nums text-[var(--ink)]">${fmt(c.amount)}</span>
              {IS_TESTNET === false && <span className="text-xs text-amber-400">real</span>}
              <span className="text-xs text-[var(--subtle)]">{pct.toFixed(0)}% of share</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

import { IS_TESTNET } from '@/config/wagmi'

function fmt(raw: bigint) {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
