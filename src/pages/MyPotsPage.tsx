import { useAccount } from 'wagmi'
import { Link } from 'react-router-dom'
import { ConnectKitButton } from 'connectkit'
import { ExternalLink, Loader2 } from 'lucide-react'
import { useMyPots } from '@/hooks/useMyPots'
import { usePot } from '@/hooks/usePot'
import { StatusBadge } from '@/components/StatusBadge'
import { loadMeta } from '@/lib/metadata'
import { TARGET_CHAIN_ID } from '@/config/wagmi'

export function MyPotsPage() {
  const { address } = useAccount()
  const { pots, loading, error, progress } = useMyPots(address)

  if (!address) {
    return (
      <main className="max-w-lg mx-auto px-4 py-16 flex flex-col items-center gap-4 text-center">
        <p className="text-[var(--muted)]">Connect your wallet to see your pots.</p>
        <ConnectKitButton />
      </main>
    )
  }

  return (
    <main className="max-w-lg mx-auto px-4 py-8 flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-[var(--ink)] tracking-tight">My pots</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Pots you created or deposited into.</p>
      </div>

      {loading && (
        <div className="flex flex-col items-center gap-3 py-12 text-[var(--muted)]">
          <Loader2 size={24} className="animate-spin" />
          {progress && (
            <p className="text-xs tabular-nums">
              Scanning block {progress.current.toString()} / {progress.head.toString()}
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      {!loading && !error && pots.length === 0 && (
        <div className="py-12 text-center text-[var(--muted)]">
          No pots found.{' '}
          <Link to="/" className="underline text-[var(--ink-2)]">Create one</Link>
        </div>
      )}

      {pots.map(({ potId, role }) => (
        <PotCard key={potId.toString()} potId={potId} role={role} />
      ))}
    </main>
  )
}

function PotCard({ potId, role }: { potId: bigint; role: string }) {
  const { pot } = usePot(potId)
  const meta = loadMeta(TARGET_CHAIN_ID, potId)
  const title = meta?.title || `Pot #${potId}`

  return (
    <Link
      to={`/p/${TARGET_CHAIN_ID}/${potId}`}
      className="block rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 hover:border-[var(--border-strong)] transition group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-medium text-[var(--ink)] group-hover:underline">{title}</span>
          <span className="text-xs text-[var(--muted)] capitalize">{role}</span>
        </div>
        <div className="flex items-center gap-2">
          {pot && <StatusBadge status={pot.status} />}
          <ExternalLink size={13} className="text-[var(--subtle)] flex-shrink-0" />
        </div>
      </div>
      {pot && (
        <div className="mt-3 flex gap-4 text-xs text-[var(--muted)] tabular-nums">
          <span>Target ${fmt(pot.target)} · {pot.slots.toString()} slots</span>
          <span>{pot.contributors.toString()} contributor{pot.contributors !== 1n ? 's' : ''}</span>
        </div>
      )}
    </Link>
  )
}

function fmt(raw: bigint): string {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
