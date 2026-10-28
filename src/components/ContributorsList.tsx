/**
 * ContributorsList v5  (B1/B2)
 *
 * Two sections:
 *  1. Summary — current contributors with live contributionOf (multicall).
 *  2. History table — all events, newest-first, paginated (20 per page),
 *     with filter chips and per-row "View" links.
 *
 * Clicking a contributor in the summary filters history to that wallet.
 * Refresh button (10 s cooldown) calls tick then refetches.
 */
import { useState, useEffect, useRef } from 'react'
import { usePublicClient } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID, buildTxUrl } from '@/config/wagmi'
import { fetchAliasesByWallets } from '@/lib/supabase'
import { formatAddress } from '@/lib/utils'
import { formatDateTime } from '@/lib/fmt'
import type { PotData } from '@/hooks/usePot'
import type { PotEvent } from '@/hooks/useActivity'
import { ExternalLink, RefreshCw, X } from 'lucide-react'

const PAGE = 20

type Filter = 'all' | 'deposits' | 'withdrawals' | 'system'
type WalletData = { address: `0x${string}`; liveAmount: bigint; withdrawTotal: bigint }

function fmt(raw: bigint) {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}

function ActionBadge({ kind }: { kind: PotEvent['kind'] }) {
  const map: Record<PotEvent['kind'], { label: string; cls: string }> = {
    created:   { label: 'Created',      cls: 'bg-blue-900/30 text-blue-300 border-blue-700/30' },
    deposit:   { label: 'Deposit',      cls: 'bg-emerald-900/30 text-emerald-300 border-emerald-700/30' },
    withdraw:  { label: 'Withdrawal',   cls: 'bg-amber-900/30 text-amber-300 border-amber-700/30' },
    filled:    { label: 'Fully funded', cls: 'bg-purple-900/30 text-purple-300 border-purple-700/30' },
    payout:    { label: 'Paid out',     cls: 'bg-sky-900/30 text-sky-300 border-sky-700/30' },
    cancelled: { label: 'Cancelled',    cls: 'bg-rose-900/30 text-rose-300 border-rose-700/30' },
  }
  const { label, cls } = map[kind] ?? { label: kind, cls: '' }
  return <span className={`text-[10px] border rounded px-1.5 py-0.5 font-medium whitespace-nowrap ${cls}`}>{label}</span>
}

function amountDisplay(ev: PotEvent): string {
  const n = Number(BigInt(ev.amount)) / 1_000_000
  if (!ev.amount || ev.amount === '0') return ''
  if (ev.kind === 'deposit') return `+${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`
  if (ev.kind === 'withdraw') return `−${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`
  if (ev.kind === 'payout') return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`
  return ''
}

interface Props {
  potId:        bigint
  pot:          PotData
  events:       PotEvent[]
  aliases:      Record<string, string>
  activityError: string | null
  syncing?:     boolean
  hasMore?:     boolean
  onRefresh?:   () => void
  onLoadMore?:  () => void
  lastFetch?:   number
}

export function ContributorsList({
  potId, pot, events, aliases: propAliases,
  activityError, syncing, hasMore, onRefresh, onLoadMore, lastFetch,
}: Props) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [wallets, setWallets]     = useState<WalletData[]>([])
  const [aliases, setAliases]     = useState<Record<string, string>>(propAliases)
  const [filter, setFilter]       = useState<Filter>('all')
  const [walletFilter, setWalletFilter] = useState<string | null>(null)
  const [page, setPage]           = useState(1)
  const [cooldown, setCooldown]   = useState(false)
  const cooldownRef               = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync propAliases
  useEffect(() => { setAliases(propAliases) }, [JSON.stringify(propAliases)])

  // Build wallet summary from events
  useEffect(() => {
    if (events.length === 0) { setWallets([]); return }
    const depMap  = new Map<string, bigint>()
    const wdMap   = new Map<string, bigint>()
    for (const ev of events) {
      if (ev.kind !== 'deposit' && ev.kind !== 'withdraw') continue
      const a = ev.wallet.toLowerCase()
      const amt = BigInt(ev.amount)
      if (ev.kind === 'deposit') depMap.set(a, (depMap.get(a) ?? 0n) + amt)
      else wdMap.set(a, (wdMap.get(a) ?? 0n) + amt)
    }
    const addrs = [...new Set(depMap.keys())]
    setWallets(addrs.map(a => ({
      address:      a as `0x${string}`,
      liveAmount:   0n,
      withdrawTotal: wdMap.get(a) ?? 0n,
    })))
    const missing = addrs.filter(a => !propAliases[a])
    if (missing.length > 0) {
      fetchAliasesByWallets(missing).then(m => setAliases(prev => ({ ...prev, ...m })))
    }
  }, [JSON.stringify(events.map(e => `${e.kind}${e.wallet}${e.amount}`))])

  // Multicall contributionOf
  useEffect(() => {
    if (!client || wallets.length === 0) return
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
    }).catch(() => {/* keep */})
    return () => { cancelled = true }
  }, [client, potId.toString(), wallets.length])

  // Refresh cooldown
  function handleRefresh() {
    if (cooldown || !onRefresh) return
    onRefresh()
    setCooldown(true)
    cooldownRef.current = setTimeout(() => setCooldown(false), 10_000)
  }
  useEffect(() => () => { cooldownRef.current && clearTimeout(cooldownRef.current) }, [])

  // Filtered events for history table
  const historyEvents = events.filter(ev => {
    if (walletFilter && ev.wallet.toLowerCase() !== walletFilter) return false
    if (filter === 'deposits') return ev.kind === 'deposit'
    if (filter === 'withdrawals') return ev.kind === 'withdraw'
    if (filter === 'system') return ['created', 'filled', 'payout', 'cancelled'].includes(ev.kind)
    return true
  })

  // API error fallback
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

  return (
    <div className="flex flex-col gap-5">
      {/* ── Summary ──────────────────────────────────────────────────────── */}
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
          {current
            .sort((a, b) => a.liveAmount < b.liveAmount ? 1 : -1)
            .map((w, i) => {
              const al = aliases[w.address]
              const display = al ? `@${al}` : formatAddress(w.address)
              const pct = pot.target > 0n ? Number((w.liveAmount * 10000n) / pot.target) / 100 : 0
              const isSelected = walletFilter === w.address
              return (
                <button
                  key={w.address}
                  onClick={() => { setWalletFilter(isSelected ? null : w.address); setPage(1) }}
                  className={`w-full flex items-center gap-2 rounded-xl px-3 py-2.5 transition text-left min-w-0 ${isSelected ? 'bg-[var(--accent)]/10 border border-[var(--accent)]/30' : 'bg-[var(--surface-muted)] hover:bg-[var(--surface-strong)]'}`}
                >
                  <span className="text-xs text-[var(--subtle)] w-5 shrink-0">#{i + 1}</span>
                  <span className="flex-1 text-sm font-mono text-[var(--ink-2)] truncate min-w-0">{display}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {w.withdrawTotal > 0n && (
                      <span className="hidden sm:inline text-[10px] bg-amber-900/30 text-amber-300 border border-amber-700/30 rounded px-1.5 py-0.5">
                        withdrew {fmt(w.withdrawTotal)}
                      </span>
                    )}
                    <span className="tabular-nums text-sm text-[var(--ink)]">{fmt(w.liveAmount)} USDC</span>
                    <span className="text-xs text-[var(--subtle)]">{pct.toFixed(1)}%</span>
                  </div>
                </button>
              )
            })}
        </div>

        {former.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            <p className="text-xs text-[var(--subtle)] px-1 mb-1">Former contributors</p>
            {former.map(w => {
              const al = aliases[w.address]
              const display = al ? `@${al}` : formatAddress(w.address)
              const isSelected = walletFilter === w.address
              return (
                <button
                  key={w.address}
                  onClick={() => { setWalletFilter(isSelected ? null : w.address); setPage(1) }}
                  className={`w-full flex items-center gap-2 rounded-xl px-3 py-2 text-left min-w-0 opacity-60 hover:opacity-100 transition ${isSelected ? 'bg-[var(--accent)]/10 border border-[var(--accent)]/30' : 'bg-[var(--surface-muted)]/50'}`}
                >
                  <span className="flex-1 text-xs font-mono text-[var(--muted)] truncate min-w-0">{display}</span>
                  <span className="text-xs text-[var(--subtle)] shrink-0">withdrew {fmt(w.withdrawTotal)}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* ── History ──────────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-2 min-w-0 gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-sm font-semibold text-[var(--ink)]">History</h3>
            {syncing && <span className="text-xs text-[var(--accent)] animate-pulse">Syncing…</span>}
            {!syncing && lastFetch ? (
              <span className="text-xs text-[var(--subtle)]">
                Updated {formatDateTime(lastFetch)}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {walletFilter && (
              <button
                onClick={() => setWalletFilter(null)}
                className="flex items-center gap-1 text-xs text-[var(--accent)] hover:underline"
              >
                {aliases[walletFilter] ? `@${aliases[walletFilter]}` : formatAddress(walletFilter as `0x${string}`)}
                <X size={10} />
              </button>
            )}
            <button
              onClick={handleRefresh}
              disabled={cooldown}
              title="Refresh history"
              className={`p-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-[var(--ink)] transition ${cooldown ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Filter chips */}
        <div className="flex gap-1.5 mb-3 flex-wrap">
          {(['all', 'deposits', 'withdrawals', 'system'] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(1) }}
              className={`text-xs rounded-full px-3 py-1 border transition capitalize ${filter === f ? 'bg-[var(--accent)] text-white border-[var(--accent)]' : 'bg-[var(--surface-muted)] text-[var(--muted)] border-[var(--border)] hover:border-[var(--ink-2)]'}`}
            >
              {f === 'all' ? 'All' : f === 'system' ? 'System' : f === 'deposits' ? 'Deposits' : 'Withdrawals'}
            </button>
          ))}
        </div>

        {historyEvents.length === 0 && (
          <p className="text-sm text-[var(--muted)] py-3 text-center">
            {syncing ? 'Syncing history…' : 'No events yet.'}
          </p>
        )}

        {/* Desktop table */}
        {historyEvents.length > 0 && (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-xs text-[var(--subtle)] border-b border-[var(--border)]">
                    <th className="text-left py-2 pr-3 font-medium whitespace-nowrap">Time</th>
                    <th className="text-left py-2 pr-3 font-medium">Action</th>
                    <th className="text-left py-2 pr-3 font-medium">Wallet</th>
                    <th className="text-right py-2 pr-3 font-medium whitespace-nowrap">Amount</th>
                    <th className="text-right py-2 font-medium">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {historyEvents.slice(0, page * PAGE).map((ev, i) => {
                    const al = aliases[ev.wallet.toLowerCase()]
                    const walletDisplay = al
                      ? `@${al} (${formatAddress(ev.wallet as `0x${string}`)})`
                      : formatAddress(ev.wallet as `0x${string}`)
                    const amt = amountDisplay(ev)
                    return (
                      <tr key={`${ev.tx_hash}-${ev.log_index}-${i}`} className="border-b border-[var(--border)]/40 hover:bg-[var(--surface-muted)]/50 transition">
                        <td className="py-2.5 pr-3 text-xs text-[var(--muted)] whitespace-nowrap">
                          {ev.block_time ? formatDateTime(ev.block_time) : `#${ev.block_number}`}
                        </td>
                        <td className="py-2.5 pr-3"><ActionBadge kind={ev.kind} /></td>
                        <td className="py-2.5 pr-3 font-mono text-xs text-[var(--ink-2)] min-w-0 max-w-[160px] truncate">
                          {ev.wallet ? walletDisplay : '—'}
                        </td>
                        <td className={`py-2.5 pr-3 text-right tabular-nums text-xs font-medium whitespace-nowrap ${ev.kind === 'deposit' ? 'text-[var(--success)]' : ev.kind === 'withdraw' ? 'text-amber-300' : 'text-[var(--ink)]'}`}>
                          {amt || '—'}
                        </td>
                        <td className="py-2.5 text-right">
                          {ev.tx_hash ? (
                            <a href={buildTxUrl(ev.tx_hash)} target="_blank" rel="noopener noreferrer" className="flex items-center justify-end gap-0.5 text-xs text-[var(--muted)] hover:text-[var(--ink)] transition">
                              View <ExternalLink size={10} />
                            </a>
                          ) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile stacked cards */}
            <div className="flex flex-col gap-2 md:hidden">
              {historyEvents.slice(0, page * PAGE).map((ev, i) => {
                const al = aliases[ev.wallet.toLowerCase()]
                const walletDisplay = al ? `@${al}` : formatAddress(ev.wallet as `0x${string}`)
                const amt = amountDisplay(ev)
                return (
                  <div key={`${ev.tx_hash}-${ev.log_index}-${i}`} className="rounded-xl bg-[var(--surface-muted)] p-3 flex flex-col gap-1.5 text-xs min-w-0">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <ActionBadge kind={ev.kind} />
                      <span className="text-[var(--muted)] text-right shrink-0">
                        {ev.block_time ? formatDateTime(ev.block_time) : `#${ev.block_number}`}
                      </span>
                    </div>
                    {ev.wallet && (
                      <span className="font-mono text-[var(--ink-2)] break-anywhere min-w-0">{walletDisplay}</span>
                    )}
                    <div className="flex items-center justify-between min-w-0 gap-2">
                      {amt && (
                        <span className={`font-medium tabular-nums ${ev.kind === 'deposit' ? 'text-[var(--success)]' : ev.kind === 'withdraw' ? 'text-amber-300' : 'text-[var(--ink)]'}`}>
                          {amt}
                        </span>
                      )}
                      {ev.tx_hash && (
                        <a href={buildTxUrl(ev.tx_hash)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-[var(--muted)] hover:text-[var(--ink)] transition ml-auto shrink-0">
                          View <ExternalLink size={10} />
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Load more */}
            {(page * PAGE < historyEvents.length || hasMore) && (
              <button
                onClick={() => {
                  if (page * PAGE < historyEvents.length) setPage(p => p + 1)
                  else onLoadMore?.()
                }}
                className="mt-3 w-full rounded-xl py-2 border border-[var(--border)] text-xs text-[var(--muted)] hover:text-[var(--ink)] hover:border-[var(--ink-2)] transition"
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
