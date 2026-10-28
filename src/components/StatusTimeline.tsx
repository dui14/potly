/**
 * StatusTimeline — shows Created / Filled / Paid|Cancelled|Expired with times.
 * For PAID shows a receipt card.
 * For CANCELLED shows the cancel note.
 * For an expired unfilled OPEN pot shows "Expired: refunds open".
 */
import { ExternalLink } from 'lucide-react'
import { buildTxUrl } from '@/config/wagmi'
import { formatAddress } from '@/lib/utils'
import { formatDateTime } from '@/lib/fmt'
import type { PotData } from '@/hooks/usePot'
import type { PotEvent } from '@/hooks/useActivity'

interface Props {
  pot: PotData
  potId: bigint
  events: PotEvent[]
  aliases: Record<string, string>
  chainTime: bigint
  onRefresh?: () => void
}

/**
 * Format a block_time value which may be an ISO string (from the API)
 * or a unix-seconds number (from chain data e.g. pot.filledAt).
 */
function fmtTs(isoOrUnix: string | number | bigint): string {
  if (!isoOrUnix) return '—'
  if (typeof isoOrUnix === 'string') return formatDateTime(isoOrUnix)
  return formatDateTime(new Date(Number(isoOrUnix) * 1000))
}
function fmtUsdc(raw: string | bigint): string {
  const n = Number(BigInt(String(raw))) / 1_000_000
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
}
function alias(addr: string, aliases: Record<string, string>): string {
  const a = aliases[addr.toLowerCase()]
  return a ? `@${a} (${formatAddress(addr as `0x${string}`)})` : formatAddress(addr as `0x${string}`)
}

const DOT = 'w-2 h-2 rounded-full bg-[var(--accent)] mt-1 shrink-0'
const DONE_DOT = 'w-2 h-2 rounded-full bg-[var(--success)] mt-1 shrink-0'
const FADE_DOT = 'w-2 h-2 rounded-full bg-[var(--subtle)] mt-1 shrink-0'

export function StatusTimeline({ pot, events, aliases, chainTime, onRefresh }: Props) {
  const createdEvt  = events.find(e => e.kind === 'created')
  const filledEvt   = events.find(e => e.kind === 'filled')
  const payoutEvt   = events.find(e => e.kind === 'payout')
  const cancelEvt   = events.find(e => e.kind === 'cancelled')

  const isOpen      = pot.status === 0
  const isFilled    = pot.status === 1
  const isPaid      = pot.status === 2
  const isCancelled = pot.status === 3
  const isExpired   = isOpen && chainTime >= pot.deadline

  const steps: React.ReactNode[] = []

  // Created: use event when available; if missing but pot exists, show "Syncing..."
  steps.push(
    <Step key="created" dot={<span className={DONE_DOT} />}
      label="Created"
      time={createdEvt ? fmtTs(createdEvt.block_time) : 'Syncing…'}
      sub={
        createdEvt
          ? <a href={buildTxUrl(createdEvt.tx_hash)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--ink)] text-xs">tx <ExternalLink size={10} /></a>
          : onRefresh
            ? <button onClick={onRefresh} className="text-xs text-[var(--accent)] hover:underline">Refresh</button>
            : null
      }
    />,
  )

  // Filled (or pending)
  if (isFilled || isPaid) {
    steps.push(
      <Step key="filled" dot={<span className={DONE_DOT} />}
        label="Fully funded"
        time={filledEvt ? fmtTs(filledEvt.block_time) : (pot.filledAt > 0n ? fmtTs(Number(pot.filledAt)) : '—')}
      />,
    )
  } else if (!isCancelled && !isExpired) {
    steps.push(
      <Step key="filled" dot={<span className={DOT} />}
        label="Fully funded"
        time="Pending"
      />,
    )
  }

  // Paid out
  if (isPaid && payoutEvt) {
    const recipient = String(payoutEvt.extra?.recipient ?? pot.recipient)
    const payout    = String(payoutEvt.extra?.payout ?? payoutEvt.amount)
    const fee       = String(payoutEvt.extra?.fee ?? '0')
    steps.push(
      <Step key="paid" dot={<span className={DONE_DOT} />}
        label="Paid out"
        time={fmtTs(payoutEvt.block_time)}
        sub={
          <div className="mt-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-1.5 text-xs text-[var(--muted)]">
            <Row label="Recipient" value={alias(recipient, aliases)} />
            <Row label="Amount" value={`${fmtUsdc(payout)} USDC`} />
            <Row label="Fee" value={`${fmtUsdc(fee)} USDC`} />
            <Row label="Triggered by" value={alias(payoutEvt.actor, aliases)} />
            <a href={buildTxUrl(payoutEvt.tx_hash)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[var(--accent)] hover:underline mt-0.5">
              View transaction <ExternalLink size={10} />
            </a>
          </div>
        }
      />,
    )
  }

  // Cancelled
  if (isCancelled) {
    steps.push(
      <Step key="cancelled" dot={<span className="w-2 h-2 rounded-full bg-[var(--danger)] mt-1 shrink-0" />}
        label="Cancelled"
        time={cancelEvt ? fmtTs(cancelEvt.block_time) : '—'}
        sub={cancelEvt
          ? <a href={buildTxUrl(cancelEvt.tx_hash)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--ink)]">tx <ExternalLink size={10} /></a>
          : null
        }
      />,
    )
  }

  // Expired
  if (isExpired) {
    steps.push(
      <Step key="expired" dot={<span className="w-2 h-2 rounded-full bg-amber-400 mt-1 shrink-0" />}
        label="Expired — refunds open"
        time={fmtTs(Number(pot.deadline))}
      />,
    )
  }

  // Future terminal state placeholder when open+not expired
  if (isOpen && !isExpired && !isCancelled) {
    steps.push(
      <Step key="future" dot={<span className={FADE_DOT} />}
        label="Paid out (pending)"
        time=""
      />,
    )
  }

  return (
    <div className="flex flex-col gap-0">
      {steps}
    </div>
  )
}

function Step({ dot, label, time, sub }: { dot: React.ReactNode; label: string; time: string; sub?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        {dot}
        <div className="w-px flex-1 bg-[var(--border)] my-1" />
      </div>
      <div className="pb-4">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-[var(--ink)]">{label}</span>
          {time && <span className="text-xs text-[var(--muted)]">{time}</span>}
        </div>
        {sub}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-[var(--subtle)]">{label}</span>
      <span className="text-[var(--ink-2)] text-right truncate max-w-[60%]">{value}</span>
    </div>
  )
}
