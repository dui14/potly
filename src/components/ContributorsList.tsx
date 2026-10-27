/**
 * ContributorsList v3
 *
 * Chain source of truth: contributionOf per wallet via adaptive getLogs for
 * the depositor set, then reads live contribution amounts from the chain.
 *
 * Layout:
 *   "#n  @alias / short-addr  amount USDC  % of target  [Withdrew X badge]"
 *   Current contributors first, then "Former contributors" section.
 *   Header: "Contributor spots M/N" with helper text.
 *   If event-based amounts < raised: "Some contributions still syncing" + Refresh.
 *   Tapping a row opens a bottom sheet (mobile) / popover (desktop) with timeline.
 *   Falls back to count + "details unavailable" if logs fail entirely.
 */
import { useEffect, useState, useRef } from 'react'
import { usePublicClient } from 'wagmi'
import { parseAbiItem } from 'viem'
import { POTLY_ADDRESS, POTLY_DEPLOY_BLOCK, TARGET_CHAIN_ID, buildTxUrl } from '@/config/wagmi'
import { fetchAliasesByWallets } from '@/lib/supabase'
import { formatAddress } from '@/lib/utils'
import { useContributionOf } from '@/hooks/usePot'
import type { PotData } from '@/hooks/usePot'
import { ExternalLink, X, ChevronDown } from 'lucide-react'

const DepositedAbi = parseAbiItem('event Deposited(uint256 indexed potId, address indexed depositor, uint256 amount, uint256 raised)')
const WithdrawnAbi = parseAbiItem('event Withdrawn(uint256 indexed potId, address indexed depositor, uint256 amount, uint256 raised)')

const CHUNK_INIT = 50_000n
const CHUNK_MIN  =  1_000n

function isRangeError(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e).toLowerCase()
  return msg.includes('block range') || msg.includes('limit exceeded') || msg.includes('too many') || msg.includes('range')
}

interface HistoryEntry { type: 'deposit' | 'withdraw'; amount: bigint; blockNumber: bigint; txHash: string }
interface WalletData {
  address: `0x${string}`
  eventAmount: bigint  // from events (may lag)
  withdrawTotal: bigint
  history: HistoryEntry[]
}

interface Props {
  potId: bigint
  pot: PotData
  onRefresh?: () => void
}

// ── Timeline bottom sheet / popover ──────────────────────────────────────────
function WalletSheet({ wallet, alias, history, onClose }: {
  wallet: string; alias: string | undefined; history: HistoryEntry[]; onClose: () => void
}) {
  const displayName = alias ? `@${alias} (${formatAddress(wallet as `0x${string}`)})` : formatAddress(wallet as `0x${string}`)
  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm mx-0 md:mx-4 rounded-t-2xl md:rounded-2xl bg-[var(--bg)] border border-[var(--border)] shadow-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <span className="font-semibold text-sm text-[var(--ink)] font-mono">{displayName}</span>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--ink)]"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4 flex flex-col gap-3">
          {history.length === 0 && <p className="text-sm text-[var(--muted)]">No history.</p>}
          {history.map((h, i) => (
            <div key={i} className="flex items-start justify-between gap-3 text-sm">
              <div className="flex flex-col gap-0.5">
                <span className={`font-medium ${h.type === 'deposit' ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                  {h.type === 'deposit' ? '+' : '−'}{fmt(h.amount)} USDC
                </span>
                <span className="text-xs text-[var(--muted)]">Block {h.blockNumber.toString()}</span>
              </div>
              <a
                href={buildTxUrl(h.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--ink)] transition"
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

// ── ContributionRow ───────────────────────────────────────────────────────────
function ContributionRow({ n, addr, potId, pot, alias, withdrawTotal, history: _history, onOpen }: {
  n: number; addr: `0x${string}`; potId: bigint; pot: PotData
  alias: string | undefined; withdrawTotal: bigint
  history: HistoryEntry[]; onOpen: () => void
}) {
  // Live amount from chain
  const { contribution } = useContributionOf(potId, addr)
  const pct = pot.target > 0n ? Number((contribution * 10000n) / pot.target) / 100 : 0
  const displayName = alias ? `@${alias}` : formatAddress(addr)

  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 bg-[var(--surface-muted)] hover:bg-[var(--surface-strong)] transition text-left group"
    >
      <span className="text-xs text-[var(--subtle)] w-5 shrink-0">#{n}</span>
      <span className="flex-1 text-sm font-mono text-[var(--ink-2)] truncate">{displayName}</span>
      <div className="flex items-center gap-2 shrink-0">
        {withdrawTotal > 0n && (
          <span className="text-[10px] bg-amber-900/30 text-amber-300 border border-amber-700/30 rounded px-1.5 py-0.5">
            withdrew {fmtShort(withdrawTotal)}
          </span>
        )}
        <span className="tabular-nums text-sm text-[var(--ink)]">{fmt(contribution)} USDC</span>
        <span className="text-xs text-[var(--subtle)]">{pct.toFixed(1)}%</span>
        <ChevronDown size={12} className="text-[var(--subtle)] group-hover:text-[var(--ink)] transition" />
      </div>
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export function ContributorsList({ potId, pot, onRefresh }: Props) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const [wallets, setWallets]       = useState<WalletData[]>([])
  const [aliases, setAliases]       = useState<Record<string, string>>({})
  const [logsAvail, setLogsAvail]   = useState(true)
  const [selected, setSelected]     = useState<`0x${string}` | null>(null)
  const [syncing, setSyncing]       = useState(false)
  const cancelled                   = useRef(false)

  const suggestedShare = pot.slots > 0n ? pot.target / pot.slots : 0n
  void suggestedShare

  useEffect(() => {
    if (!client || !potId) return
    cancelled.current = false

    async function load() {
      setSyncing(true)
      try {
        const head  = await client!.getBlockNumber()
        const deposits  = new Map<string, { amount: bigint; history: HistoryEntry[] }>()
        const withdraws = new Map<string, { amount: bigint }>()
        let chunk = CHUNK_INIT

        for (let from = POTLY_DEPLOY_BLOCK; from <= head && !cancelled.current;) {
          const to = from + chunk - 1n < head ? from + chunk - 1n : head
          try {
            const [depLogs, withLogs] = await Promise.all([
              client!.getLogs({ address: POTLY_ADDRESS, event: DepositedAbi, args: { potId }, fromBlock: from, toBlock: to }),
              client!.getLogs({ address: POTLY_ADDRESS, event: WithdrawnAbi, args: { potId }, fromBlock: from, toBlock: to }),
            ])
            for (const log of depLogs) {
              const addr = (log.args.depositor as string).toLowerCase()
              const e = deposits.get(addr) ?? { amount: 0n, history: [] }
              e.amount += log.args.amount as bigint
              e.history.push({ type: 'deposit', amount: log.args.amount as bigint, blockNumber: log.blockNumber ?? 0n, txHash: log.transactionHash ?? '' })
              deposits.set(addr, e)
            }
            for (const log of withLogs) {
              const addr = (log.args.depositor as string).toLowerCase()
              const e = deposits.get(addr)
              if (e) { e.amount -= log.args.amount as bigint; e.history.push({ type: 'withdraw', amount: log.args.amount as bigint, blockNumber: log.blockNumber ?? 0n, txHash: log.transactionHash ?? '' }) }
              const w = withdraws.get(addr) ?? { amount: 0n }
              w.amount += log.args.amount as bigint
              withdraws.set(addr, w)
            }
            from += chunk; chunk = CHUNK_INIT
          } catch (e) {
            if (isRangeError(e) && chunk > CHUNK_MIN) { chunk = chunk / 2n }
            else { throw e }
          }
        }

        if (cancelled.current) return

        // Collect all wallets that ever deposited
        const all: WalletData[] = Array.from(deposits.entries()).map(([addr, d]) => ({
          address: addr as `0x${string}`,
          eventAmount: d.amount < 0n ? 0n : d.amount,
          withdrawTotal: withdraws.get(addr)?.amount ?? 0n,
          history: d.history,
        }))

        // Sort: current contributors (eventAmount > 0) first, then former
        all.sort((a, b) => {
          if (a.eventAmount > 0n && b.eventAmount === 0n) return -1
          if (a.eventAmount === 0n && b.eventAmount > 0n) return 1
          return a.eventAmount < b.eventAmount ? 1 : -1
        })

        setWallets(all)
        setLogsAvail(true)
        setSyncing(false)
        const addrs = all.map(w => w.address)
        fetchAliasesByWallets(addrs).then(m => { if (!cancelled.current) setAliases(m) })
      } catch {
        if (!cancelled.current) { setLogsAvail(false); setSyncing(false) }
      }
    }

    load()
    return () => { cancelled.current = true }
  }, [client, potId.toString(), pot.raised.toString()])

  // ── Fallback ─────────────────────────────────────────────────────────────
  if (!logsAvail) {
    return (
      <div className="text-sm text-[var(--muted)] text-center py-4">
        {pot.contributors.toString()} contributor{pot.contributors !== 1n ? 's' : ''} · details unavailable
      </div>
    )
  }

  const current = wallets.filter(w => w.eventAmount > 0n)
  const former  = wallets.filter(w => w.eventAmount === 0n && w.withdrawTotal > 0n)

  // Check if event amounts sum < raised (sync lag)
  const eventSum = current.reduce((s, w) => s + w.eventAmount, 0n)
  const lagging  = eventSum < pot.raised && !syncing

  const selectedWallet = selected ? wallets.find(w => w.address === selected) : null

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-[var(--muted)]">
          Contributor spots {pot.contributors.toString()}/{pot.slots.toString()}
          {' · '}
          <span className="text-[var(--subtle)]">New wallets need a free spot; existing contributors can add more.</span>
        </span>
      </div>

      {current.length === 0 && !syncing && (
        <p className="text-sm text-[var(--muted)] text-center py-3">No contributions yet.</p>
      )}

      {/* Current contributors */}
      <div className="flex flex-col gap-1">
        {current.map((w, i) => (
          <ContributionRow
            key={w.address}
            n={i + 1}
            addr={w.address}
            potId={potId}
            pot={pot}
            alias={aliases[w.address]}
            withdrawTotal={w.withdrawTotal}
            history={w.history}
            onOpen={() => setSelected(w.address)}
          />
        ))}
      </div>

      {/* Sync lag warning */}
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
            const displayName = alias ? `@${alias}` : formatAddress(w.address)
            return (
              <button
                key={w.address}
                onClick={() => setSelected(w.address)}
                className="w-full flex items-center gap-2 rounded-xl px-3 py-2 bg-[var(--surface-muted)]/50 text-left opacity-60 hover:opacity-100 transition"
              >
                <span className="flex-1 text-xs font-mono text-[var(--muted)] truncate">{displayName}</span>
                <span className="text-xs text-[var(--subtle)]">withdrew {fmtShort(w.withdrawTotal)}</span>
                <ChevronDown size={11} className="text-[var(--subtle)]" />
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
  const n = Number(raw) / 1_000_000
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
