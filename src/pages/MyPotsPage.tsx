import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Link, useLocation } from 'react-router-dom'
import { ConnectKitButton } from 'connectkit'
import { Loader2 } from 'lucide-react'
import { useMyPots } from '@/hooks/useMyPots'
import { usePot, STATUS } from '@/hooks/usePot'
import { StatusBadge } from '@/components/StatusBadge'
import { ProgressBar } from '@/components/ProgressBar'
import { TARGET_CHAIN_ID } from '@/config/wagmi'
import { usePotMeta } from '@/hooks/usePotMeta'
import { useChainTime } from '@/hooks/useChainTime'

type Tab = 'all' | 'open' | 'paid' | 'closed'

const TAB_LABELS: { id: Tab; label: string }[] = [
  { id: 'all',    label: 'All' },
  { id: 'open',   label: 'Open' },
  { id: 'paid',   label: 'Paid' },
  { id: 'closed', label: 'Closed' },
]

export function MyPotsPage() {
  const { address } = useAccount()
  const location    = useLocation()
  // potId passed via navigation state so the new pot shows immediately
  // before the API / indexer catches up.
  const newPotId: bigint | undefined = (() => {
    const s = (location.state as { newPotId?: string } | null)?.newPotId
    try { return s ? BigInt(s) : undefined } catch { return undefined }
  })()

  const { pots, loading, loadingMore, hasMore, error, progress, retry, loadMore } = useMyPots(address, newPotId)
  const [tab, setTab] = useState<Tab>('all')

  if (!address) {
    return (
      <main className="max-w-lg mx-auto px-4 py-16 flex flex-col items-center gap-4 text-center">
        <p className="text-[var(--muted)]">Connect your wallet to see your pots.</p>
        <ConnectKitButton />
      </main>
    )
  }

  return (
    <main className="max-w-[1120px] mx-auto px-4 py-8 flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-[var(--ink)] tracking-tight">My pots</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Pots you created or deposited into.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-[var(--surface-muted)] rounded-xl p-1 w-fit">
        {TAB_LABELS.map(t => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id) }}
            className={[
              'px-4 py-1.5 rounded-lg text-sm font-medium transition',
              tab === t.id
                ? 'bg-[var(--surface-strong)] text-[var(--ink)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)]',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex flex-col items-center gap-3 py-12 text-[var(--muted)]">
          <Loader2 size={24} className="animate-spin" />
          {progress && (
            <p className="text-xs tabular-nums">
              Loading {progress.done}/{progress.total} pots…
            </p>
          )}
          {/* Skeleton cards */}
          <div className="pots-grid w-full">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
                <div className="skeleton h-5 w-40" />
                <div className="skeleton h-3 w-24" />
                <div className="skeleton h-3 w-full" />
                <div className="skeleton h-3 w-32" />
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)] flex items-center justify-between gap-3">
          <span className="min-w-0 break-anywhere">{error}</span>
          <button onClick={() => retry()} className="underline text-[var(--danger)] font-medium whitespace-nowrap shrink-0">Retry</button>
        </div>
      )}

      {!loading && !error && pots.length === 0 && (
        <div className="py-12 text-center text-[var(--muted)]">
          No pots found.{' '}
          <Link to="/" className="underline text-[var(--ink-2)]">Create one</Link>
        </div>
      )}

      {!loading && pots.length > 0 && (
        <>
          <div className="pots-grid">
            {pots.map(({ potId, role }) => (
              <PotCard key={potId.toString()} potId={potId} role={role} tab={tab} />
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center pt-2">
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="px-6 py-2 rounded-xl border border-[var(--border)] text-sm text-[var(--ink-2)] hover:border-[var(--border-strong)] transition disabled:opacity-40"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  )
}

interface CardProps { potId: bigint; role: string; tab: Tab }

function PotCard({ potId, role, tab }: CardProps) {
  const { pot } = usePot(potId)
  const { title } = usePotMeta(TARGET_CHAIN_ID, potId)
  const chainTime = useChainTime()

  // Tab filtering
  if (pot) {
    const isExpired = pot.status === STATUS.OPEN && chainTime >= pot.deadline
    const isClosed  = pot.status === STATUS.CANCELLED || isExpired
    const isPaid    = pot.status === STATUS.PAID
    const isOpen    = pot.status === STATUS.OPEN && !isExpired

    if (tab === 'open'   && !isOpen)   return null
    if (tab === 'paid'   && !isPaid)   return null
    if (tab === 'closed' && !isClosed) return null
  }

  const deadlineLabel = pot
    ? pot.status === STATUS.PAID       ? 'Paid'
    : pot.status === STATUS.CANCELLED  ? 'Cancelled'
    : chainTime >= pot.deadline        ? 'Expired'
    : `Deadline ${new Date(Number(pot.deadline) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}`
    : null

  const roleColor: Record<string, string> = {
    creator:     'bg-[var(--accent)]/15 text-[var(--accent)]',
    contributor: 'bg-[var(--success)]/15 text-[var(--success)]',
    recipient:   'bg-purple-500/15 text-purple-400',
  }

  return (
    <Link
      to={`/p/${TARGET_CHAIN_ID}/${potId}`}
      className="block rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 hover:border-[var(--border-strong)] transition group flex-1 flex flex-col gap-3 min-w-0"
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 min-w-0">
        <span className="font-medium text-[var(--ink)] group-hover:underline line-clamp-2 min-w-0 break-anywhere">
          {title}
        </span>
        <div className="shrink-0 flex items-center gap-1.5">
          {pot && <StatusBadge status={pot.status} />}
        </div>
      </div>

      {/* Role chip */}
      <span className={`self-start text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${roleColor[role] ?? 'bg-[var(--surface-muted)] text-[var(--muted)]'}`}>
        {role}
      </span>

      {/* Progress */}
      {pot ? (
        <>
          <ProgressBar raised={pot.raised} target={pot.target} />
          <div className="flex justify-between text-xs text-[var(--muted)] tabular-nums min-w-0 gap-2">
            <span className="truncate">Spots {pot.contributors.toString()}/{pot.slots.toString()}</span>
            {deadlineLabel && <span className="shrink-0 text-[var(--subtle)]">{deadlineLabel}</span>}
          </div>
        </>
      ) : (
        <>
          <div className="skeleton h-3 w-full" />
          <div className="skeleton h-3 w-32" />
        </>
      )}
    </Link>
  )
}
