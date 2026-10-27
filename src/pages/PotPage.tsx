import { useParams } from 'react-router-dom'
import { usePot, STATUS } from '@/hooks/usePot'
import { useChainTime } from '@/hooks/useChainTime'
import { StatusBadge } from '@/components/StatusBadge'
import { Countdown } from '@/components/Countdown'
import { ActionBar } from '@/components/ActionBar'
import { ShareStrip } from '@/components/ShareStrip'
import { ProgressBar } from '@/components/ProgressBar'
import { ContributorsList } from '@/components/ContributorsList'
import { loadMeta } from '@/lib/metadata'
import { TARGET_CHAIN_ID } from '@/config/wagmi'
import { formatAddress } from '@/lib/utils'
import { fetchAliasByWallet } from '@/lib/supabase'
import { useEffect, useState } from 'react'

export function PotPage() {
  const { chainId: chainIdStr, potId: potIdStr } = useParams<{ chainId: string; potId: string }>()
  const potId  = potIdStr !== undefined ? BigInt(potIdStr) : undefined
  const chainId = chainIdStr ? Number(chainIdStr) : 0

  const { pot, isLoading, refetch } = usePot(potId)
  const chainTime = useChainTime()

  const meta  = potId !== undefined ? loadMeta(TARGET_CHAIN_ID, potId) : null
  const title = meta?.title || (potId !== undefined ? `Pot #${potId}` : '')

  const [recipientAlias, setRecipientAlias] = useState<string | null>(null)
  useEffect(() => {
    if (!pot) return
    fetchAliasByWallet(pot.recipient).then(setRecipientAlias)
  }, [pot?.recipient])

  if (chainId !== TARGET_CHAIN_ID) {
    return (
      <main className="max-w-lg mx-auto px-4 py-16 text-center text-[var(--muted)]">
        Wrong chain. This pot is on chain {chainIdStr}.
      </main>
    )
  }

  if (isLoading) {
    return (
      <main className="max-w-lg mx-auto px-4 py-16 text-center text-[var(--muted)]">
        Loading pot…
      </main>
    )
  }

  if (!pot || (pot.slots === 0n && pot.deadline === 0n)) {
    return (
      <main className="max-w-lg mx-auto px-4 py-16 text-center text-[var(--muted)]">
        Pot #{potIdStr} not found.
      </main>
    )
  }

  const isExpired = pot.status === STATUS.OPEN && chainTime >= pot.deadline

  return (
    <main className="max-w-lg mx-auto px-4 py-8 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-xl font-bold text-[var(--ink)] tracking-tight">{title}</h1>
          {meta?.note && <p className="text-sm text-[var(--muted)]">{meta.note}</p>}
        </div>
        <StatusBadge status={pot.status} />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Target"          value={`$${fmt(pot.target)}`} />
        <StatCard label="Raised"          value={`$${fmt(pot.raised)}`} />
        <StatCard label={`${pot.contributors}/${pot.slots}`} value="contributors" />
      </div>

      {/* Progress bar */}
      <ProgressBar raised={pot.raised} target={pot.target} />

      {/* Countdown */}
      {!isExpired && (
        <Countdown deadline={pot.deadline} filledAt={pot.filledAt} status={pot.status} />
      )}
      {isExpired && pot.status === STATUS.OPEN && (
        <div className="text-xs text-amber-400 px-1">Deadline passed.</div>
      )}

      {/* Recipient */}
      <div className="text-sm text-[var(--muted)] flex gap-2">
        <span>Recipient:</span>
        <span className="font-mono text-[var(--ink-2)]">
          {recipientAlias ? `@${recipientAlias} (${formatAddress(pot.recipient)})` : formatAddress(pot.recipient)}
        </span>
      </div>

      {/* Contributors */}
      {potId !== undefined && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Contributors</h3>
          <ContributorsList potId={potId} pot={pot} />
        </div>
      )}

      {/* Actions */}
      {potId !== undefined && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <ActionBar potId={potId} pot={pot} chainTime={chainTime} onAction={refetch} />
        </div>
      )}

      {/* Share */}
      {potId !== undefined && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Share this pot</h3>
          <ShareStrip potId={potId} />
        </div>
      )}
    </main>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 flex flex-col gap-1">
      <span className="text-xs text-[var(--subtle)]">{label}</span>
      <span className="text-base font-semibold tabular-nums text-[var(--ink)]">{value}</span>
    </div>
  )
}

function fmt(raw: bigint): string {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
