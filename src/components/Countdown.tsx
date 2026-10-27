import { useChainTime } from '@/hooks/useChainTime'
import { STATUS } from '@/hooks/usePot'

function fmt(secs: bigint): string {
  if (secs <= 0n) return 'Expired'
  const s = Number(secs)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${ss}s`
  return `${m}m ${ss}s`
}

export function Countdown({
  deadline, filledAt, status,
}: {
  deadline: bigint
  filledAt: bigint
  status: number
}) {
  const now = useChainTime()

  if (status === STATUS.PAID) return <span className="text-[var(--success)] text-sm font-medium">Paid out</span>
  if (status === STATUS.CANCELLED) return <span className="text-[var(--danger)] text-sm font-medium">Cancelled</span>

  if (status === STATUS.FILLED) {
    const claimEnd = filledAt + 7n * 86400n
    const rem = claimEnd - now
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-[var(--muted)] uppercase tracking-wider">Claim window</span>
        <span className={`text-base font-semibold tabular-nums ${rem <= 0n ? 'text-[var(--danger)]' : 'text-blue-300'}`}>
          {rem <= 0n ? 'Expired' : fmt(rem)}
        </span>
      </div>
    )
  }

  // OPEN
  const rem = deadline - now
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-[var(--muted)] uppercase tracking-wider">Deadline</span>
      <span className={`text-base font-semibold tabular-nums ${rem <= 0n ? 'text-[var(--danger)]' : 'text-[var(--ink)]'}`}>
        {fmt(rem)}
      </span>
    </div>
  )
}
