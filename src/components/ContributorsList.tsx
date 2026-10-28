/**
 * ContributorsList v6
 *
 * History table spec (Issue 1):
 *   - Columns: Timestamp | Alias | Address | Type | Amount | View | Fee
 *   - deposit and withdraw events only (no approve, no system events)
 *   - Newest blockchain event first
 *   - Refresh button: lazily scans chain via POST .../rescan, then reloads from DB
 *   - Subsequent page loads read from Supabase without rescanning
 *
 * Summary section above the table still shows live contributionOf per wallet.
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
import { ExternalLink, RefreshCw } from 'lucide-react'

const PAGE = 20

type WalletData = { address: `0x${string}`; liveAmount: bigint; withdrawTotal: bigint }

function fmt(raw: bigint) {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 6,
  })
}

function fmtAmount(ev: PotEvent): string {
  if (!ev.amount || ev.amount === '0') return '—'
  const n = Number(BigInt(ev.amount)) / 1_000_000
  const s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
  return ev.kind === 'deposit' ? `+${s}` : `−${s}`
}

function fmtFee(ev: PotEvent): string {
  // Only payout events carry a protocol fee; deposits/withdrawals have none.
  const fee = (ev.extra as Record<string, unknown>)?.fee
  if (fee === undefined || fee === null || fee === '' || fee === '0') return '—'
  const n = Number(BigInt(String(fee))) / 1_000_000
  if (n === 0) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) + ' USDC'
}

interface Props {
  potId:         bigint
  pot:           PotData
  events:        PotEvent[]
  aliases:       Record<string, string>
  activityError: string | null
  syncing?:      boolean
  hasMore?:      boolean
  onRefresh?:    () => void   // used by summary retry button only
  onLoadMore?:   () => void
  lastFetch?:    number
}

export function ContributorsList({
  potId, pot, events, aliases: propAliases,
  activityError, syncing, hasMore, onRefresh, onLoadMore,
}: Props) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [wallets, setWallets]   = useState<WalletData[]>([])
  const [aliases, setAliases]   = useState<Record<string, string>>(propAliases)
  const [page, setPage]         = useState(1)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const cooldownRef             = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [cooldown, setCooldown] = useState(false)

  // Sync aliases
  useEffect(() => { setAliases(propAliases) }, [JSON.stringify(propAliases)])

  // Build wallet summary from events
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
    }).catch(() => { /* keep event-derived amounts */ })
    return () => { cancelled = true }
  }, [client, potId.toString(), wallets.length])

  useEffect(() => () => { cooldownRef.current && clearTimeout(cooldownRef.current) }, [])

  // Refresh: scan chain → upsert → reload from DB
  async function handleRescan() {
    if (cooldown || scanning) return
    setScanning(true)
    setScanError(null)
    setCooldown(true)
    cooldownRef.current = setTimeout(() => setCooldown(false), 10_000)

    try {
      const r = await fetch(
        `/api/v1/pots/${TARGET_CHAIN_ID}/${potId}/rescan`,
        { method: 'POST' },
      )
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { error?: string }
        setScanError(j.error ?? `HTTP ${r.status}`)
      } else {
        // Reload from DB via parent's onRefresh
        onRefresh?.()
        setPage(1)
      }
    } catch (e) {
      setScanError(String(e))
    } finally {
      setScanning(false)
    }
  }

  // History: deposit + withdraw only, newest first (API already returns newest-first)
  const historyEvents = events.filter(ev => ev.kind === 'deposit' || ev.kind === 'withdraw')

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
      {/* ── Contributor summary ───────────────────────────────────────────── */}
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
              <div key={w.address}
                className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 bg-[var(--surface-muted)] min-w-0"
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
              </div>
            )
          })}
        </div>

        {former.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            <p className="text-xs text-[var(--subtle)] px-1 mb-1">Former contributors</p>
            {former.map(w => {
              const al      = aliases[w.address]
              const display = al ? `@${al}` : formatAddress(w.address)
              return (
                <div key={w.address}
                  className="w-full flex items-center gap-2 rounded-xl px-3 py-2 min-w-0 opacity-60"
                >
                  <span className="flex-1 text-xs font-mono text-[var(--muted)] truncate min-w-0">{display}</span>
                  <span className="text-xs text-[var(--subtle)] shrink-0">withdrew {fmt(w.withdrawTotal)}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Transaction history ──────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3 min-w-0 gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--ink)]">Transaction history</h3>
            {(syncing || scanning) && (
              <span className="text-xs text-[var(--accent)] animate-pulse">
                {scanning ? 'Scanning chain…' : 'Syncing…'}
              </span>
            )}
          </div>
          <button
            onClick={handleRescan}
            disabled={cooldown || scanning}
            title={cooldown ? 'Wait 10 s between refreshes' : 'Scan chain and refresh history'}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border)] text-xs text-[var(--muted)] hover:text-[var(--ink)] transition ${cooldown || scanning ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <RefreshCw size={11} className={scanning ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {scanError && (
          <p className="text-xs text-[var(--danger)] mb-2 px-1">{scanError}</p>
        )}

        {historyEvents.length === 0 && (
          <p className="text-sm text-[var(--muted)] py-3 text-center">
            {syncing || scanning ? 'Scanning history…' : 'No deposit or withdrawal events yet.'}
          </p>
        )}

        {historyEvents.length > 0 && (
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
                  {historyEvents.slice(0, page * PAGE).map((ev, i) => {
                    const walletLc = ev.wallet.toLowerCase()
                    const al = aliases[walletLc]
                    return (
                      <tr
                        key={`${ev.tx_hash}-${ev.log_index}-${i}`}
                        className="border-b border-[var(--border)]/40 hover:bg-[var(--surface-muted)]/50 transition"
                      >
                        <td className="py-2.5 pr-3 text-xs text-[var(--muted)] whitespace-nowrap">
                          {ev.block_time ? formatDateTime(ev.block_time) : `#${ev.block_number}`}
                        </td>
                        <td className="py-2.5 pr-3 text-xs text-[var(--ink-2)] max-w-[100px] truncate">
                          {al ? `@${al}` : '—'}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-xs text-[var(--ink-2)] whitespace-nowrap">
                          {ev.wallet ? formatAddress(ev.wallet as `0x${string}`) : '—'}
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className={`text-[10px] border rounded px-1.5 py-0.5 font-medium whitespace-nowrap ${
                            ev.kind === 'deposit'
                              ? 'bg-emerald-900/30 text-emerald-300 border-emerald-700/30'
                              : 'bg-amber-900/30 text-amber-300 border-amber-700/30'
                          }`}>
                            {ev.kind === 'deposit' ? 'Deposit' : 'Withdraw'}
                          </span>
                        </td>
                        <td className={`py-2.5 pr-3 text-right tabular-nums text-xs font-medium whitespace-nowrap ${
                          ev.kind === 'deposit' ? 'text-[var(--success)]' : 'text-amber-300'
                        }`}>
                          {fmtAmount(ev)}
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
                          {fmtFee(ev)}
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
                const walletLc = ev.wallet.toLowerCase()
                const al = aliases[walletLc]
                const fee = fmtFee(ev)
                return (
                  <div
                    key={`${ev.tx_hash}-${ev.log_index}-${i}`}
                    className="rounded-xl bg-[var(--surface-muted)] p-3 flex flex-col gap-1.5 text-xs min-w-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`border rounded px-1.5 py-0.5 font-medium ${
                        ev.kind === 'deposit'
                          ? 'bg-emerald-900/30 text-emerald-300 border-emerald-700/30'
                          : 'bg-amber-900/30 text-amber-300 border-amber-700/30'
                      }`}>
                        {ev.kind === 'deposit' ? 'Deposit' : 'Withdraw'}
                      </span>
                      <span className="text-[var(--muted)]">
                        {ev.block_time ? formatDateTime(ev.block_time) : `#${ev.block_number}`}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      {al && <span className="text-[var(--ink-2)]">@{al}</span>}
                      <span className="font-mono text-[var(--subtle)] break-anywhere">{ev.wallet ? formatAddress(ev.wallet as `0x${string}`) : '—'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <span className={`font-medium tabular-nums ${ev.kind === 'deposit' ? 'text-[var(--success)]' : 'text-amber-300'}`}>
                        {fmtAmount(ev)}
                      </span>
                      <div className="flex items-center gap-3 shrink-0">
                        {fee !== '—' && <span className="text-[var(--subtle)]">Fee: {fee}</span>}
                        {ev.tx_hash && (
                          <a
                            href={buildTxUrl(ev.tx_hash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-0.5 text-[var(--muted)] hover:text-[var(--ink)] transition"
                          >
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
