import { STATUS } from '@/hooks/usePot'

const LABELS: Record<number, string> = {
  [STATUS.OPEN]:      'Open',
  [STATUS.FILLED]:    'Filled',
  [STATUS.PAID]:      'Paid',
  [STATUS.CANCELLED]: 'Cancelled',
}
const COLORS: Record<number, string> = {
  [STATUS.OPEN]:      'bg-[var(--surface-muted)] text-[var(--ink-2)] border border-[var(--border)]',
  [STATUS.FILLED]:    'bg-blue-900/40 text-blue-300 border border-blue-700/40',
  [STATUS.PAID]:      'bg-emerald-900/40 text-emerald-300 border border-emerald-700/40',
  [STATUS.CANCELLED]: 'bg-red-900/30 text-red-300 border border-red-800/40',
}

export function StatusBadge({ status }: { status: number }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium tracking-wide uppercase ${COLORS[status] ?? COLORS[0]}`}>
      {LABELS[status] ?? 'Unknown'}
    </span>
  )
}
