interface Props {
  raised: bigint
  target: bigint
}

export function ProgressBar({ raised, target }: Props) {
  const pct = target > 0n ? Math.min(100, Number((raised * 10000n) / target) / 100) : 0
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-xs text-[var(--muted)]">
        <span>${fmt(raised)} raised</span>
        <span>${fmt(target)} target</span>
      </div>
      <div className="h-2 rounded-full bg-[var(--surface-muted)] overflow-hidden">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-[var(--subtle)] text-right">{pct.toFixed(1)}% funded</p>
    </div>
  )
}

function fmt(raw: bigint) {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
