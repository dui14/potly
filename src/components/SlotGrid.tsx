import { formatAddress } from '@/lib/utils'

export function SlotGrid({
  slots, filled, depositors,
}: {
  slots: bigint
  filled: bigint
  depositors: (`0x${string}` | null)[]
}) {
  const total = Number(slots)
  const filledCount = Number(filled)
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(total, 5)}, minmax(0,1fr))` }}>
      {Array.from({ length: total }).map((_, i) => {
        const addr = depositors[i]
        const isFilled = i < filledCount
        return (
          <div
            key={i}
            title={addr ?? undefined}
            className={[
              'rounded-xl border p-2.5 flex flex-col items-center justify-center gap-1 min-h-[64px]',
              isFilled
                ? 'bg-[var(--surface-strong)] border-[var(--border-strong)]'
                : 'bg-[var(--surface-muted)] border-[var(--border)] opacity-50',
            ].join(' ')}
          >
            <span className="text-xs text-[var(--muted)] tabular-nums">#{i + 1}</span>
            {isFilled && addr && (
              <span className="text-[10px] font-mono text-[var(--ink-2)] truncate w-full text-center">
                {formatAddress(addr)}
              </span>
            )}
            {!isFilled && <span className="text-xs text-[var(--subtle)]">Empty</span>}
          </div>
        )
      })}
    </div>
  )
}
