import { ExternalLink } from 'lucide-react'
import { useProofStats } from '@/hooks/useProofStats'
import { POTLY_ADDRESS, TREASURY_ADDRESS, buildAddrUrl, IS_TESTNET } from '@/config/wagmi'

export function ProofStrip() {
  const { stats, loading } = useProofStats()
  const dash = loading ? '…' : undefined

  return (
    <div className="border border-[var(--border)] rounded-2xl bg-[var(--surface)] p-5 flex flex-col gap-4">
      <h2 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">On-chain proof</h2>
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Pots created"  value={dash ?? stats?.potCount.toString() ?? '0'} />
        <Stat label="Pots paid out" value={dash ?? String(stats?.paidCount ?? 0)} />
        <Stat
          label={`USDC settled${IS_TESTNET ? '' : ' (real)'}`}
          value={dash ?? `$${fmt(stats?.usdcSettled ?? 0n)}`}
        />
        <Stat label="Fees accrued" value={dash ?? `$${fmt(stats?.feesAccrued ?? 0n)}`} />
      </div>
      <div className="flex flex-col gap-2 text-xs">
        <AddressLink label="Contract" addr={POTLY_ADDRESS} />
        <AddressLink label="Treasury" addr={TREASURY_ADDRESS} />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <span className="text-xl font-display font-bold tabular-nums text-[var(--ink)]">{value}</span>
    </div>
  )
}

function AddressLink({ label, addr }: { label: string; addr: string }) {
  return (
    <a href={buildAddrUrl(addr)} target="_blank" rel="noopener noreferrer"
      className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--ink)] transition">
      <span className="text-[var(--subtle)] w-16">{label}:</span>
      <span className="font-mono">{addr.slice(0, 10)}…{addr.slice(-6)}</span>
      <ExternalLink size={11} />
    </a>
  )
}

function fmt(raw: bigint): string {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
