/**
 * ContributorsList v4
 *
 * Data source: activity events from useActivity (via PotPage prop) —
 * no getLogs in the browser.
 * Live amounts: contributionOf for each known wallet via one multicall.
 *
 * Rows: #n  @alias/short-addr  current USDC  % of target  [Withdrew X]
 * Current contributors first, then "Former contributors".
 * Row tap → bottom sheet (mobile) / popover (desktop) with timeline.
 * If API fails: contributor count from chain + Retry button.
 * "Some contributions still syncing" + Refresh when sum < raised.
 */
import { useState, useEffect } from 'react'
import { usePublicClient } from 'wagmi'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID, buildTxUrl } from '@/config/wagmi'
import { fetchAliasesByWallets } from '@/lib/supabase'
import { formatAddress } from '@/lib/utils'
import type { PotData } from '@/hooks/usePot'
import type { PotEvent } from '@/hooks/useActivity'
import { ExternalLink, X, ChevronDown } from 'lucide-react'

interface HistoryEntry {
  type: 'deposit' | 'withdraw'
  amount: bigint
  blockNumber: number
  blockTime: number
  txHash: string
}

interface WalletData {
  address:     `0x${string}`
  liveAmount:  bigint   // from chain multicall
  withdrawTotal: bigint // total withdrawn (from events)
  history:     HistoryEntry[]
}

interface Props {
  potId:        bigint
  pot:          PotData
  events:       PotEvent[]          // from useActivity
  aliases:      Record<string,string> // from useActivity
  activityError: string | null
  onRefresh?:   () => void
}

// ── Timeline sheet ────────────────────────────────────────────────────────────
function WalletSheet({ wallet, alias, history, onClose }: {
  wallet: string; alias?: string; history: HistoryEntry[]; onClose: () => void
}) {
  const display = alias
    ? `@${alias} (${formatAddress(wallet as `0x${string}`)})`
    : formatAddress(wallet as `0x${string}`)
  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm mx-0 md:mx-4 rounded-t-2xl md:rounded-2xl bg-[var(--bg)] border border-[var(--border)] shadow-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] min-w-0">
          <span className="font-semibold text-sm text-[var(--ink)] font-mono break-anywhere min-w-0 mr-2">{display}</span>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--ink)] shrink-0"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4 flex flex-col gap-3">
          {history.length === 0 && <p className="text-sm text-[var(--muted)]">No history.</p>}
          {history.map((h, i) => (
            <div key={i} className="flex items-start justify-between gap-3 text-sm min-w-0">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className={`font-medium ${h.type === 'deposit' ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                  {h.type === 'deposit' ? '+' : '−'}{fmt(h.amount)} USDC
                </span>
                <span className="text-xs text-[var(--muted)]">
                  {h.blockTime ? new Date(h.blockTime * 1000).toLocaleString() : `Block ${h.blockNumber}`}
                </span>
              </div>
              <a
                href={buildTxUrl(h.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--ink)] transition shrink-0"
              >
                View tx <ExternalLink size={11} />
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export function ContributorsList({ potId, pot, events, aliases: propAliases, activityError, onRefresh }: Props) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [wallets, setWallets]     = useState<WalletData[]>([])
  const [aliases, setAliases]     = useState<Record<string,string>>(propAliases)
  const [selected, setSelected]   = useState<string | null>(null)
  const [multicallDone, setMulticallDone] = useState(false)

  // Sync propAliases into local state
  useEffect(() => { setAliases(propAliases) }, [JSON.stringify(propAliases)])

  // Build wallet data from events
  useEffect(() => {
    if (events.length === 0) { setWallets([]); setMulticallDone(false); return }

    const depositMap  = new Map<string, bigint>()
    const withdrawMap = new Map<string, bigint>()
    const historyMap  = new Map<string, HistoryEntry[]>()

    for (const ev of events) {
      if (ev.kind !== 'deposit' && ev.kind !== 'withdraw') continue
      const addr = ev.wallet.toLowerCase() as `0x${string}`
      const amt  = BigInt(ev.amount)
      if (ev.kind === 'deposit') {
        depositMap.set(addr, (depositMap.get(addr) ?? 0n) + amt)
      } else {
        withdrawMap.set(addr, (withdrawMap.get(addr) ?? 0n) + amt)
      }
      const h = historyMap.get(addr) ?? []
      h.push({ type: ev.kind, amount: amt, blockNumber: ev.block_number, blockTime: ev.block_time, txHash: ev.tx_hash })
      historyMap.set(addr, h)
    }

    const allAddrs = [...new Set(depositMap.keys())]
    const draft: WalletData[] = allAddrs.map(addr => ({
      address:      addr as `0x${string}`,
      liveAmount:   0n,  // filled by multicall below
      withdrawTotal: withdrawMap.get(addr) ?? 0n,
      history:      (historyMap.get(addr) ?? []).sort((a, b) => a.blockNumber - b.blockNumber),
    }))
    setWallets(draft)
    setMulticallDone(false)

    // Fetch missing aliases
    const missing = allAddrs.filter(a => !propAliases[a])
    if (missing.length > 0) {
      fetchAliasesByWallets(missing).then(m => setAliases(prev => ({ ...prev, ...m })))
    }
  }, [JSON.stringify(events.map(e => `${e.kind}${e.wallet}${e.amount}${e.tx_hash}`))])

  // Multicall contributionOf for all wallets
  useEffect(() => {
    if (!client || wallets.length === 0) return
    let cancelled = false
    async function fetchLive() {
      const calls = wallets.map(w => ({
        address:      POTLY_ADDRESS,
        abi:          POTLY_ABI,
        functionName: 'contributionOf' as const,
        args:         [potId, w.address] as const,
      }))
      try {
        const results = await client!.multicall({ contracts: calls, allowFailure: true })
        if (cancelled) return
        setWallets(prev => prev.map((w, i) => ({
          ...w,
          liveAmount: results[i].status === 'success' ? (results[i].result as bigint) : w.liveAmount,
        })))
        setMulticallDone(true)
      } catch { /* keep event-derived amounts */ }
    }
    void fetchLive()
    return () => { cancelled = true }
  }, [client, potId.toString(), wallets.length])

  // ── API failed fallback ────────────────────────────────────────────────────
  if (activityError && events.length === 0) {
    return (
      <div className="flex items-center justify-between text-sm text-[var(--muted)] py-3">
        <span>{pot.contributors.toString()} contributor{pot.contributors !== 1n ? 's' : ''}</span>
        <button onClick={onRefresh} className="underline text-[var(--ink-2)] text-xs ml-2">Retry</button>
      </div>
    )
  }

  const former  = wallets.filter(w => w.liveAmount === 0n && w.withdrawTotal > 0n && multicallDone)

  // Sync-lag check: sum of live amounts vs raised
  const liveSum = wallets.reduce((s, w) => s + w.liveAmount, 0n)
  const lagging = multicallDone && liveSum < pot.raised && events.length > 0

  const selectedWallet = selected ? wallets.find(w => w.address === selected) : null

  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-1 min-w-0">
        <span className="text-xs text-[var(--muted)] min-w-0">
          Contributor spots {pot.contributors.toString()}/{pot.slots.toString()}
          {' · '}
          <span className="text-[var(--subtle)]">New wallets need a free spot; existing contributors can add more.</span>
        </span>
      </div>

      {wallets.length === 0 && events.length === 0 && (
        <p className="text-sm text-[var(--muted)] text-center py-3">No contributions yet.</p>
      )}

      {/* Current contributors */}
      <div className="flex flex-col gap-1">
        {wallets
          .filter(w => w.liveAmount > 0n || (!multicallDone && w.history.some(h => h.type === 'deposit')))
          .sort((a, b) => a.liveAmount < b.liveAmount ? 1 : -1)
          .map((w, i) => {
            const alias = aliases[w.address]
            const display = alias ? `@${alias}` : formatAddress(w.address)
            const pct = pot.target > 0n ? Number((w.liveAmount * 10000n) / pot.target) / 100 : 0
            return (
              <button
                key={w.address}
                onClick={() => setSelected(w.address)}
                className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 bg-[var(--surface-muted)] hover:bg-[var(--surface-strong)] transition text-left group min-w-0"
              >
                <span className="text-xs text-[var(--subtle)] w-5 shrink-0">#{i + 1}</span>
                <span className="flex-1 text-sm font-mono text-[var(--ink-2)] truncate min-w-0">{display}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {w.withdrawTotal > 0n && (
                    <span className="hidden sm:inline text-[10px] bg-amber-900/30 text-amber-300 border border-amber-700/30 rounded px-1.5 py-0.5">
                      withdrew {fmtShort(w.withdrawTotal)}
                    </span>
                  )}
                  <span className="tabular-nums text-sm text-[var(--ink)]">{fmt(w.liveAmount)} USDC</span>
                  <span className="text-xs text-[var(--subtle)]">{pct.toFixed(1)}%</span>
                  <ChevronDown size={12} className="text-[var(--subtle)] group-hover:text-[var(--ink)] transition" />
                </div>
              </button>
            )
          })}
      </div>

      {/* Sync lag */}
      {lagging && (
        <div className="flex items-center justify-between text-xs text-[var(--muted)] px-1 mt-1">
          <span>Some contributions are still syncing.</span>
          <button onClick={onRefresh} className="underline text-[var(--ink-2)] ml-2">Refresh</button>
        </div>
      )}

      {/* Former contributors */}
      {former.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          <p className="text-xs text-[var(--subtle)] px-1 mb-1">Former contributors</p>
          {former.map(w => {
            const alias = aliases[w.address]
            const display = alias ? `@${alias}` : formatAddress(w.address)
            return (
              <button
                key={w.address}
                onClick={() => setSelected(w.address)}
                className="w-full flex items-center gap-2 rounded-xl px-3 py-2 bg-[var(--surface-muted)]/50 text-left opacity-60 hover:opacity-100 transition min-w-0"
              >
                <span className="flex-1 text-xs font-mono text-[var(--muted)] truncate min-w-0">{display}</span>
                <span className="text-xs text-[var(--subtle)] shrink-0">withdrew {fmtShort(w.withdrawTotal)}</span>
                <ChevronDown size={11} className="text-[var(--subtle)] shrink-0" />
              </button>
            )
          })}
        </div>
      )}

      {/* Timeline sheet */}
      {selectedWallet && (
        <WalletSheet
          wallet={selectedWallet.address}
          alias={aliases[selectedWallet.address]}
          history={selectedWallet.history}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}

function fmt(raw: bigint) {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}
function fmtShort(raw: bigint) {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
