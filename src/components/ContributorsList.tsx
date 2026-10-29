/**
 * ContributorsList v7
 *
 * History table spec:
 *   Columns: Timestamp | Alias | Address | Type | Amount | View | Fee
 *   Timestamp: en-US, 24-hour clock with seconds; full UTC in title tooltip.
 *   Type: Deposit, Withdraw (user rows) | Created, Filled, Paid out, Cancelled (system rows)
 *   Fee: from fee_wei (18-decimal native USDC), up to 6 decimals; "—" when null.
 *   Filter chips: All | Deposits | Withdrawals | System
 *   Newest blockchain event first. 20 rows with Load more.
 *   Refresh button calls POST sync mode="refresh", disabled 10 s, shows spinner.
 */
import { useState, useEffect, useRef } from 'react'
import { usePublicClient } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID, buildTxUrl } from '@/config/wagmi'
import { fetchAliasesByWallets } from '@/lib/supabase'
import { formatAddress } from '@/lib/utils'
import type { PotData } from '@/hooks/usePot'
import type { HistoryEvent } from '@/hooks/useHistory'
import { ExternalLink, RefreshCw } from 'lucide-react'

const PAGE = 20

type FilterChip = 'all' | 'deposits' | 'withdrawals' | 'system'
const SYSTEM_KINDS = new Set(['created', 'filled', 'payout', 'cancelled'])

function fmtUsdcRaw(raw: bigint): string {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 6,
  })
}

function fmtAmount(ev: HistoryEvent): string {
  if (!ev.amount || ev.amount === '0') return '—'
  const n = Number(BigInt(ev.amount)) / 1_000_000
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
  if (ev.kind === 'deposit')  return `+${s}`
  if (ev.kind === 'withdraw') return `−${s}`
  return s
}

function fmtFeeWei(feeWei: string | null): string {
  if (!feeWei || feeWei === '0') return '—'
  const n = Number(BigInt(feeWei)) / 1e18   // 18-decimal native USDC
  if (n === 0) return '—'
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
  return `${s} USDC`
}

// Timestamp: "Oct 28, 2026 19:23:41" (en-US, 24-hour, seconds)
const DT_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, timeZone: 'UTC',
})
function fmtTimestamp(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return DT_FMT.format(d)
}

function typeLabel(kind: string): string {
  switch (kind) {
    case 'deposit':   return 'Deposit'
    case 'withdraw':  return 'Withdraw'
    case 'created':   return 'Created'
    case 'filled':    return 'Filled'
    case 'payout':    return 'Paid out'
    case 'cancelled': return 'Cancelled'
    default:          return kind
  }
}

function typeBadgeClass(kind: string): string {
  switch (kind) {
    case 'deposit':   return 'bg-emerald-900/30 text-emerald-300 border-emerald-700/30'
    case 'withdraw':  return 'bg-amber-900/30 text-amber-300 border-amber-700/30'
    default:          return 'bg-[var(--surface-muted)] text-[var(--muted)] border-[var(--border)]'
  }
}

interface Props {
  potId:            bigint
  pot:              PotData
  events:           HistoryEvent[]
  aliases:          Record<string, string>
  activityError:    string | null
  syncing?:         boolean
  hasMore?:         boolean
  onRefresh?:       () => void
  onLoadMore?:      () => void
  refreshCooldown?: boolean
  lastRefreshed?:   number
}

export function ContributorsList({
  potId, pot, events, aliases: propAliases,
  activityError, syncing, hasMore, onRefresh, onLoadMore,
  refreshCooldown, lastRefreshed,
}: Props) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [wallets,  setWallets]  = useState<{ address: `0x${string}`; liveAmount: bigint; withdrawTotal: bigint }[]>([])
  const [aliases,  setAliases]  = useState<Record<string, string>>(propAliases)
  const [page,     setPage]     = useState(1)
  const [filter,   setFilter]   = useState<FilterChip>('all')

  // Sync aliases
  useEffect(() => { setAliases(propAliases) }, [JSON.stringify(propAliases)])

  // Build wallet summary from deposit/withdraw events
  useEffect(() => {
    if (events.length === 0) { setWallets([]); return }
    const depMap = new Map<string, bigint>()
    const wdMap  = new Map<string, bigint>()
    for (const ev of events) {
      if (ev.kind !== 'deposit' && ev.kind !== 'withdraw') continue
      const a = ev.wallet.toLowerCase()
      const amt = BigInt(ev.amount)
      if (ev.kind === 'deposit') depMap.set(a, (depMap.get(a) ?? 0n) + amt)
      else wdMap.set(a, (wdMap.get(a) ?? 0n) + amt)
    }
    const addrs = [...new Set(depMap.keys())]
    setWallets(addrs.map(a => ({
      address:       a as `0x${string}`,
      liveAmount:    0n,
      withdrawTotal: wdMap.get(a) ?? 0n,
    })))
    const missing = addrs.filter(a => !propAliases[a])
    if (missing.length > 0) {
      fetchAliasesByWallets(missing).then(m => setAliases(prev => ({ ...prev, ...m })))
    }
  }, [JSON.stringify(events.map(e => `${e.kind}${e.wallet}${e.amount}`))])

  // Multicall contributionOf — fires once per stable wallet-address set
  const walletAddrKey = wallets.map(w => w.address).sort().join(',')
  const multicallFiredRef = useRef('')
  useEffect(() => {
    if (!client || wallets.length === 0) return
    if (multicallFiredRef.current === walletAddrKey) return  // dedup
    multicallFiredRef.current = walletAddrKey
    let cancelled = false
    const calls = wallets.map(w => ({
      address: POTLY_ADDRESS, abi: POTLY_ABI,
      functionName: 'contributionOf' as const,
      args: [potId, w.address] as const,
    }))
    client.multicall({ contracts: calls, allowFailure: true }).then(results => {
      if (cancelled) return
      setWallets(prev => prev.map((w, i) => ({
        ...w,
        liveAmount: results[i].status === 'success' ? (results[i].result as bigint) : w.liveAmount,
      })))
    }).catch(() => {})
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, potId.toString(), walletAddrKey])

  // Filter events for history table
  const filtered = events.filter(ev => {
    if (filter === 'deposits')    return ev.kind === 'deposit'
    if (filter === 'withdrawals') return ev.kind === 'withdraw'
    if (filter === 'system')      return SYSTEM_KINDS.has(ev.kind)
    return true
  })

  const lastRefreshedText = lastRefreshed
    ? new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(lastRefreshed))
    : null

  if (activityError && events.length === 0) {
    return (
      <div className="flex items-center justify-between text-sm text-[var(--muted)] py-3">
        <span>{pot.contributors.toString()} contributor{pot.contributors !== 1n ? 's' : ''}</span>
        <button onClick={onRefresh} className="underline text-[var(--ink-2)] text-xs ml-2">Retry</button>
      </div>
    )
  }

  const current = wallets.filter(w => w.liveAmount > 0n)
  const former  = wallets.filter(w => w.liveAmount === 0n && w.withdrawTotal > 0n)

  const CHIPS: { id: FilterChip; label: string }[] = [
    { id: 'all',         label: 'All' },
    { id: 'deposits',    label: 'Deposits' },
    { id: 'withdrawals', label: 'Withdrawals' },
    { id: 'system',      label: 'System' },
  ]

  return (
    <div className="flex flex-col gap-5">
      {/* ── Contributor summary ────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-2 min-w-0">
          <span className="text-xs text-[var(--muted)]">
            Contributor spots {pot.contributors.toString()}/{pot.slots.toString()}
            {' · '}
            <span className="text-[var(--subtle)]">New wallets need a free spot; existing contributors can add more.</span>
          </span>
        </div>
        {current.length === 0 && (
          <p className="text-sm text-[var(--muted)] py-2">No contributions yet.</p>
        )}
        <div className="flex flex-col gap-1">
          {current.sort((a, b) => a.liveAmount < b.liveAmount ? 1 : -1).map((w, i) => {
            const al      = aliases[w.address]
            const display = al ? `@${al}` : formatAddress(w.address)
            const pct     = pot.target > 0n ? Number((w.liveAmount * 10000n) / pot.target) / 100 : 0
            return (
              <div key={w.address} className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 bg-[var(--surface-muted)] min-w-0">
                <span className="text-xs text-[var(--subtle)] w-5 shrink-0">#{i + 1}</span>
                <span className="flex-1 text-sm font-mono text-[var(--ink-2)] truncate min-w-0">{display}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {w.withdrawTotal > 0n && (
                    <span className="hidden sm:inline text-[10px] bg-amber-900/30 text-amber-300 border border-amber-700/30 rounded px-1.5 py-0.5">
                      withdrew {fmtUsdcRaw(w.withdrawTotal)}
                    </span>
                  )}
                  <span className="tabular-nums text-sm text-[var(--ink)]">{fmtUsdcRaw(w.liveAmount)} USDC</span>
                  <span className="text-xs text-[var(--subtle)]">{pct.toFixed(1)}%</span>
                </div>
              </div>
            )
          })}
        </div>
        {former.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            <p className="text-xs text-[var(--subtle)] px-1 mb-1">Former contributors</p>
            {former.map(w => (
              <div key={w.address} className="w-full flex items-center gap-2 rounded-xl px-3 py-2 min-w-0 opacity-60">
                <span className="flex-1 text-xs font-mono text-[var(--muted)] truncate min-w-0">
                  {aliases[w.address] ? `@${aliases[w.address]}` : formatAddress(w.address)}
                </span>
                <span className="text-xs text-[var(--subtle)] shrink-0">withdrew {fmtUsdcRaw(w.withdrawTotal)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Transaction history ────────────────────────────────────────── */}
      <section>
        {/* Header row */}
        <div className="flex items-center justify-between mb-3 min-w-0 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--ink)]">Transaction history</h3>
            {syncing && (
              <span className="text-xs text-[var(--accent)] animate-pulse">Scanning chain…</span>
            )}
            {lastRefreshedText && !syncing && (
              <span className="text-xs text-[var(--subtle)]">Updated {lastRefreshedText}</span>
            )}
          </div>
          <button
            onClick={onRefresh}
            disabled={refreshCooldown || syncing}
            title={refreshCooldown ? 'Wait 10 s between refreshes' : 'Scan chain and refresh history'}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border)] text-xs text-[var(--muted)] hover:text-[var(--ink)] transition ${refreshCooldown || syncing ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <RefreshCw size={11} className={syncing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {/* Filter chips */}
        <div className="flex gap-1.5 mb-3 flex-wrap">
          {CHIPS.map(c => (
            <button
              key={c.id}
              onClick={() => { setFilter(c.id); setPage(1) }}
              className={`px-2.5 py-0.5 rounded-full text-xs border transition ${
                filter === c.id
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/30'
                  : 'bg-transparent text-[var(--muted)] border-[var(--border)] hover:text-[var(--ink)]'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {filtered.length === 0 && (
          <p className="text-sm text-[var(--muted)] py-3 text-center">
            {syncing ? 'Scanning history…' : 'No events yet.'}
          </p>
        )}

        {filtered.length > 0 && (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-xs text-[var(--subtle)] border-b border-[var(--border)]">
                    <th className="text-left py-2 pr-3 font-medium whitespace-nowrap">Timestamp</th>
                    <th className="text-left py-2 pr-3 font-medium">Alias</th>
                    <th className="text-left py-2 pr-3 font-medium">Address</th>
                    <th className="text-left py-2 pr-3 font-medium">Type</th>
                    <th className="text-right py-2 pr-3 font-medium whitespace-nowrap">Amount</th>
                    <th className="text-center py-2 pr-3 font-medium">View</th>
                    <th className="text-right py-2 font-medium">Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, page * PAGE).map((ev, i) => {
                    const walletLc = ev.wallet.toLowerCase()
                    const al = aliases[walletLc]
                    const isUserRow = ev.kind === 'deposit' || ev.kind === 'withdraw'
                    return (
                      <tr
                        key={`${ev.tx_hash}-${ev.log_index}-${i}`}
                        className="border-b border-[var(--border)]/40 hover:bg-[var(--surface-muted)]/50 transition"
                      >
                        <td className="py-2.5 pr-3 text-xs text-[var(--muted)] whitespace-nowrap">
                          <span title={ev.block_time ? `UTC: ${ev.block_time}` : undefined}>
                            {ev.block_time ? fmtTimestamp(ev.block_time) : `#${ev.block_number}`}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-xs text-[var(--ink-2)] max-w-[100px] truncate">
                          {al ? `@${al}` : '—'}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-xs text-[var(--ink-2)] whitespace-nowrap">
                          {ev.wallet ? formatAddress(ev.wallet as `0x${string}`) : '—'}
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className={`text-[10px] border rounded px-1.5 py-0.5 font-medium whitespace-nowrap ${typeBadgeClass(ev.kind)}`}>
                            {typeLabel(ev.kind)}
                          </span>
                        </td>
                        <td className={`py-2.5 pr-3 text-right tabular-nums text-xs font-medium whitespace-nowrap ${
                          ev.kind === 'deposit' ? 'text-[var(--success)]' : isUserRow ? 'text-amber-300' : 'text-[var(--muted)]'
                        }`}>
                          {isUserRow ? fmtAmount(ev) : '—'}
                        </td>
                        <td className="py-2.5 pr-3 text-center">
                          {ev.tx_hash ? (
                            <a
                              href={buildTxUrl(ev.tx_hash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-0.5 text-xs text-[var(--muted)] hover:text-[var(--ink)] transition"
                            >
                              View <ExternalLink size={10} />
                            </a>
                          ) : '—'}
                        </td>
                        <td className="py-2.5 text-right text-xs text-[var(--muted)] tabular-nums whitespace-nowrap">
                          {fmtFeeWei(ev.fee_wei)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="flex flex-col gap-2 md:hidden">
              {filtered.slice(0, page * PAGE).map((ev, i) => {
                const al  = aliases[ev.wallet?.toLowerCase() ?? '']
                const fee = fmtFeeWei(ev.fee_wei)
                const isUserRow = ev.kind === 'deposit' || ev.kind === 'withdraw'
                return (
                  <div
                    key={`${ev.tx_hash}-${ev.log_index}-${i}`}
                    className="rounded-xl bg-[var(--surface-muted)] p-3 flex flex-col gap-1.5 text-xs min-w-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`border rounded px-1.5 py-0.5 font-medium ${typeBadgeClass(ev.kind)}`}>
                        {typeLabel(ev.kind)}
                      </span>
                      <span className="text-[var(--muted)]" title={ev.block_time ?? undefined}>
                        {ev.block_time ? fmtTimestamp(ev.block_time) : `#${ev.block_number}`}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      {al && <span className="text-[var(--ink-2)]">@{al}</span>}
                      <span className="font-mono text-[var(--subtle)] break-anywhere">
                        {ev.wallet ? formatAddress(ev.wallet as `0x${string}`) : '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <span className={`font-medium tabular-nums ${ev.kind === 'deposit' ? 'text-[var(--success)]' : isUserRow ? 'text-amber-300' : 'text-[var(--muted)]'}`}>
                        {isUserRow ? fmtAmount(ev) : '—'}
                      </span>
                      <div className="flex items-center gap-3 shrink-0">
                        {fee !== '—' && <span className="text-[var(--subtle)]">Fee: {fee}</span>}
                        {ev.tx_hash && (
                          <a href={buildTxUrl(ev.tx_hash)} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-0.5 text-[var(--muted)] hover:text-[var(--ink)] transition">
                            View <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Load more */}
            {(page * PAGE < filtered.length || hasMore) && (
              <button
                onClick={() => {
                  if (page * PAGE < filtered.length) setPage(p => p + 1)
                  else onLoadMore?.()
                }}
                className="mt-3 w-full rounded-xl py-2 border border-[var(--border)] text-xs text-[var(--muted)] hover:text-[var(--ink)] hover:border-[var(--border-strong)] transition"
              >
                Load more
              </button>
            )}
          </>
        )}
      </section>
    </div>
  )
}
