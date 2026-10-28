import { useParams } from 'react-router-dom'
import { usePot, STATUS } from '@/hooks/usePot'
import { useChainTime } from '@/hooks/useChainTime'
import { useActivity } from '@/hooks/useActivity'
import { StatusBadge } from '@/components/StatusBadge'
import { Countdown } from '@/components/Countdown'
import { ActionBar } from '@/components/ActionBar'
import { ShareStrip } from '@/components/ShareStrip'
import { ProgressBar } from '@/components/ProgressBar'
import { ContributorsList } from '@/components/ContributorsList'
import { StatusTimeline } from '@/components/StatusTimeline'
import { TARGET_CHAIN_ID } from '@/config/wagmi'
import { formatAddress } from '@/lib/utils'
import { fetchAliasByWallet } from '@/lib/supabase'
import { usePotMeta } from '@/hooks/usePotMeta'
import { useEffect, useState } from 'react'

export function PotPage() {
  const { chainId: chainIdStr, potId: potIdStr } = useParams<{ chainId: string; potId: string }>()
  const potId   = potIdStr !== undefined ? BigInt(potIdStr) : undefined
  const chainId = chainIdStr ? Number(chainIdStr) : 0

  const { pot, isLoading, refetch } = usePot(potId)
  const chainTime = useChainTime()
  const meta = usePotMeta(TARGET_CHAIN_ID, potId)
  const title = meta.title
  const { events, aliases: actAliases, syncTx, triggerRefresh, error } = useActivity(potId)

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
      <main className="max-w-lg mx-auto px-4 py-16 flex flex-col gap-4">
        <div className="skeleton h-7 w-48" />
        <div className="skeleton h-4 w-64" />
        <div className="stat-grid">
          <div className="skeleton h-16" />
          <div className="skeleton h-16" />
          <div className="skeleton h-16" />
        </div>
        <div className="skeleton h-3 w-full" />
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
  const recipientDisplay = recipientAlias
    ? `@${recipientAlias} (${formatAddress(pot.recipient)})`
    : formatAddress(pot.recipient)

  const handleAction = () => { refetch(); triggerRefresh() }

  return (
    <main className="max-w-[1120px] mx-auto px-4 py-8">
      {/* Mobile: single column. Desktop: two-column via .pot-layout */}
      <div className="pot-layout">

        {/* ── Left column ──────────────────────────────────────────────── */}
        <div className="flex flex-col gap-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h1 className="font-display text-2xl font-bold text-[var(--ink)] tracking-tight">{title}</h1>
              {meta.note && <p className="text-sm text-[var(--muted)]">{meta.note}</p>}
            </div>
            <StatusBadge status={pot.status} />
          </div>

          {/* Recipient */}
          <div className="text-sm text-[var(--muted)] flex gap-2 items-start min-w-0">
            <span className="shrink-0">Recipient:</span>
            <span className="font-mono text-[var(--ink-2)] break-anywhere min-w-0">{recipientDisplay}</span>
          </div>

          {/* Countdown */}
          {!isExpired && (
            <Countdown deadline={pot.deadline} filledAt={pot.filledAt} status={pot.status} />
          )}
          {isExpired && pot.status === STATUS.OPEN && (
            <div className="text-xs text-amber-400 px-1">Deadline passed.</div>
          )}

          {/* Stats + progress */}
          <div className="flex flex-col gap-3">
            <div className="stat-grid">
              <StatCard label="Target"   value={fmtUsdc(pot.target)} />
              <StatCard label="Raised"   value={fmtUsdc(pot.raised)} />
              <StatCard
                label="Contributor spots"
                value={`${pot.contributors}/${pot.slots}`}
                sub="Max contributors"
              />
            </div>
            <ProgressBar raised={pot.raised} target={pot.target} />
          </div>

          {/* Contributors */}
          {potId !== undefined && (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
              <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Contributors</h3>
              <ContributorsList
            potId={potId}
            pot={pot}
            events={events}
            aliases={actAliases}
            activityError={error}
            onRefresh={triggerRefresh}
          />
            </section>
          )}

          {/* Status timeline */}
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Timeline</h3>
            <StatusTimeline
              pot={pot}
              potId={potId ?? 0n}
              events={events}
              aliases={actAliases}
              chainTime={chainTime}
            />
          </section>

          {/* Share */}
          {potId !== undefined && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Share</h3>
              <ShareStrip potId={potId} />
            </div>
          )}
        </div>

        {/* ── Right column (desktop sticky action card) ─────────────────── */}
        {potId !== undefined && (
          <aside className="pot-sidebar">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <ActionBar potId={potId} pot={pot} chainTime={chainTime} onAction={handleAction} syncTx={syncTx} />
            </div>
          </aside>
        )}
      </div>

      {/* Mobile sticky bottom bar — primary action only */}
      {potId !== undefined && (
        <div className="mobile-action-bar">
          <ActionBar potId={potId} pot={pot} chainTime={chainTime} onAction={handleAction} syncTx={syncTx} mobileCompact />
        </div>
      )}
    </main>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 flex flex-col gap-1 justify-between">
      <span className="text-xs text-[var(--subtle)]">{label}</span>
      <span className="text-base font-semibold tabular-nums text-[var(--ink)]">{value}</span>
      {sub && <span className="text-[10px] text-[var(--subtle)]">{sub}</span>}
    </div>
  )
}

function fmtUsdc(raw: bigint): string {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDC'
}
