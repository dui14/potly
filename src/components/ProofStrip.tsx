import { ExternalLink } from 'lucide-react'
import { useProofStats } from '@/hooks/useProofStats'
import { POTLY_ADDRESS, TREASURY_ADDRESS, buildAddrUrl, IS_TESTNET } from '@/config/wagmi'

export function ProofStrip() {
  const { potCount, totalPaid, loading } = useProofStats()

  return (
    <div className="border border-[var(--border)] rounded-2xl bg-[var(--surface)] p-5 flex flex-col gap-4">
      <h2 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">On-chain proof</h2>
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Pots created" value={loading ? '…' : (potCount?.toString() ?? '0')} />
        <Stat
          label={`USDC paid out${IS_TESTNET ? '' : ' (real)'}`}
          value={loading ? '…' : `$${formatUsdc(totalPaid)}`}
        />
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
      <span className="text-2xl font-display font-bold tabular-nums text-[var(--ink)]">{value}</span>
    </div>
  )
}

function AddressLink({ label, addr }: { label: string; addr: string }) {
  return (
    <a
      href={buildAddrUrl(addr)}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--ink)] transition"
    >
      <span className="text-[var(--subtle)] w-16">{label}:</span>
      <span className="font-mono">{formatAddress(addr)}</span>
      <ExternalLink size={11} />
    </a>
  )
}

function formatAddress(addr: string) {
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`
}

function formatUsdc(raw: bigint): string {
  const n = Number(raw) / 1_000_000
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
