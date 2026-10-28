import { useState, useCallback, useRef } from 'react'
import { useAccount, useWriteContract, useSwitchChain } from 'wagmi'
import { useNavigate } from 'react-router-dom'
import { isAddress, decodeEventLog } from 'viem'
import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID, IS_TESTNET } from '@/config/wagmi'
import { computeMetadataHash, randomSalt, parseUsdc, formatUsdc, saveMeta, postMetadata } from '@/lib/metadata'
import { estimatedGasUsdc6 } from '@/lib/gas'
import { useGasPrice } from '@/hooks/useGasPrice'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { decodePotlyError } from '@/lib/errors'
import { useResolveRecipient } from '@/hooks/useAlias'
import { TxButton } from './TxButton'

const DURATION_PRESETS = [
  { label: '5 min',  value: 5 * 60 },
  { label: '15 min', value: 15 * 60 },
  { label: '1 hr',   value: 3_600 },
  { label: '1 day',  value: 86_400 },
  { label: '7 days', value: 7 * 86_400 },
  { label: 'Custom', value: -1 },
]

const MIN_DURATION = 60          // 1 minute
const MAX_DURATION = 30 * 86_400 // 30 days

export function CreatePotForm() {
  const { address, chainId } = useAccount()
  const { switchChain }      = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const navigate             = useNavigate()

  const [recipientRaw, setRecipientRaw] = useState('')
  const [confirmed, setConfirmed]       = useState(false)
  const [targetStr, setTargetStr]       = useState('10')
  const [slots, setSlots]               = useState(10)
  const [duration, setDuration]         = useState(86_400)
  const [customDuration, setCustomDuration] = useState('')
  const [showCustom, setShowCustom]     = useState(false)
  const [title, setTitle]               = useState('')
  const [note, setNote]                 = useState('')
  const [error, setError]               = useState('')
  const [metaStatus, setMetaStatus]     = useState<'idle' | 'pending' | 'done' | 'failed'>('idle')
  const pendingMetaRef                  = useRef<{ title: string; note: string; salt: `0x${string}` } | null>(null)

  const gasPrice  = useGasPrice()
  const { balance } = useUsdcBalance(address)
  const gasEst    = estimatedGasUsdc6('createPot', gasPrice)
  const canAfford = balance >= gasEst
  const wrongChain = chainId !== TARGET_CHAIN_ID

  const { resolved, checking, isAlias } = useResolveRecipient(recipientRaw)

  const targetRaw   = (() => { try { return parseUsdc(targetStr) } catch { return 0n } })()
  const targetValid = targetRaw >= 10_000n && targetRaw <= 500_000_000n
  const slotsValid  = slots >= 1 && slots <= 100

  // Recipient must be confirmed when it's an alias
  const recipientAddr = resolved && isAddress(resolved) ? resolved as `0x${string}` : null
  const recipientDirect = !recipientRaw.startsWith('@') && isAddress(recipientRaw) ? recipientRaw as `0x${string}` : null
  const finalRecipient = recipientAddr ?? recipientDirect

  // For alias: require explicit confirmation
  const recipientReady = isAlias ? (!!recipientAddr && confirmed) : !!finalRecipient

  const formValid = recipientReady && targetValid && slotsValid && title.trim().length > 0

  const handleSubmit = useCallback(async (): Promise<`0x${string}` | void> => {
    setError('')
    if (wrongChain) { switchChain({ chainId: TARGET_CHAIN_ID }); return }
    if (!formValid || !finalRecipient || !address) return

    const salt = randomSalt()
    const titleTrimmed = title.trim()
    const noteTrimmed  = note.trim()
    const hash = computeMetadataHash(titleTrimmed, noteTrimmed, salt)

    try {
      const txHash = await writeContractAsync({
        address: POTLY_ADDRESS,
        abi: POTLY_ABI,
        functionName: 'createPot',
        args: [finalRecipient, targetRaw, BigInt(slots), BigInt(duration), hash],
        chainId: TARGET_CHAIN_ID,
      })
      pendingMetaRef.current = { title: titleTrimmed, note: noteTrimmed, salt }
      return txHash
    } catch (e) {
      setError(decodePotlyError(e))
      throw e
    }
  }, [wrongChain, formValid, finalRecipient, address, title, note, targetRaw, slots, duration, switchChain, writeContractAsync])

  const suggestedShare = slots > 0 ? targetRaw / BigInt(slots) : 0n

  return (
    <div className="flex flex-col gap-5">
      {/* Recipient */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-[var(--ink-2)]">
          Recipient <span className="text-[var(--subtle)] font-normal">(address or @alias)</span>
        </label>
        <input
          value={recipientRaw}
          onChange={e => { setRecipientRaw(e.target.value); setConfirmed(false) }}
          placeholder="0x… or @alice"
          className="w-full bg-[var(--surface-muted)] border border-[var(--border)] focus:border-[var(--border-strong)] rounded-xl px-3 py-2.5 text-sm font-mono outline-none transition"
        />
        {/* Alias resolution */}
        {isAlias && checking && (
          <div className="flex items-center gap-1 text-xs text-[var(--muted)]">
            <Loader2 size={11} className="animate-spin" /> Resolving alias…
          </div>
        )}
        {isAlias && !checking && recipientAddr && !confirmed && (
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm">
            <div className="flex items-center gap-1.5 text-[var(--success)] text-xs font-medium">
              <CheckCircle size={11} /> Verified alias
            </div>
            <p className="text-[var(--ink-2)] font-mono text-xs">{recipientAddr}</p>
            <button
              onClick={() => setConfirmed(true)}
              className="self-start rounded-lg px-3 py-1.5 text-xs font-semibold bg-[var(--accent)] text-white hover:opacity-90 transition"
            >
              Confirm this recipient
            </button>
          </div>
        )}
        {isAlias && !checking && recipientAddr && confirmed && (
          <div className="flex items-center gap-1.5 text-xs text-[var(--success)]">
            <CheckCircle size={11} /> {formatAddress(recipientAddr)} confirmed
          </div>
        )}
        {isAlias && !checking && !recipientAddr && recipientRaw.length > 1 && (
          <p className="text-xs text-[var(--danger)] flex items-center gap-1">
            <AlertCircle size={11} /> Alias not found
          </p>
        )}
        {!isAlias && recipientRaw && !isAddress(recipientRaw) && (
          <p className="text-xs text-[var(--danger)]">Invalid address</p>
        )}
      </div>

      {/* Target */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-[var(--ink-2)]">Target total (USDC)</label>
        <input
          value={targetStr}
          onChange={e => setTargetStr(e.target.value)}
          type="number" min="0.01" max="500" step="0.01"
          className="bg-[var(--surface-muted)] border border-[var(--border)] focus:border-[var(--border-strong)] rounded-xl px-3 py-2.5 text-sm outline-none transition"
        />
        {targetStr && !targetValid && (
          <p className="text-xs text-[var(--danger)]">Target must be 0.01–500 USDC</p>
        )}
      </div>

      {/* Duration */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-[var(--ink-2)]">Duration</label>
        <div className="flex flex-wrap gap-2">
          {DURATION_PRESETS.map(p => {
            const isCustom = p.value === -1
            const isActive = isCustom ? showCustom : (!showCustom && duration === p.value)
            return (
              <button
                key={p.value}
                onClick={() => {
                  if (isCustom) { setShowCustom(true) }
                  else { setShowCustom(false); setDuration(p.value) }
                }}
                className={`px-3 py-2 rounded-xl text-sm font-medium border transition ${isActive ? 'bg-[var(--accent)] text-white border-transparent' : 'bg-[var(--surface)] border-[var(--border)] text-[var(--ink-2)] hover:border-[var(--border-strong)]'}`}
              >{p.label}</button>
            )
          })}
        </div>
        {showCustom && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={30 * 24 * 60}
                value={customDuration}
                onChange={e => {
                  setCustomDuration(e.target.value)
                  const mins = Number(e.target.value)
                  if (mins >= 1 && mins <= 30 * 24 * 60) setDuration(mins * 60)
                }}
                placeholder="minutes (1–43200)"
                className="flex-1 bg-[var(--surface-muted)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm outline-none"
              />
              <span className="text-xs text-[var(--muted)] whitespace-nowrap">min</span>
            </div>
            {customDuration && (Number(customDuration) * 60 < MIN_DURATION || Number(customDuration) * 60 > MAX_DURATION) && (
              <p className="text-xs text-[var(--danger)]">Between 1 minute and 30 days</p>
            )}
          </div>
        )}
      </div>

      {/* Slots hint */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-[var(--ink-2)]">
          Max contributors — {slots}
          {suggestedShare > 0n && <span className="text-[var(--subtle)] font-normal"> · suggested {formatUsdc(suggestedShare)} USDC each</span>}
        </label>
        <p className="text-xs text-[var(--subtle)]">New wallets need a free slot; wallets already in can add more.</p>
        <input
          type="range" min={1} max={100} value={slots}
          onChange={e => setSlots(Number(e.target.value))}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-[var(--subtle)]"><span>1</span><span>100</span></div>
      </div>

      {/* Title */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-[var(--ink-2)]">Title <span className="text-[var(--subtle)] font-normal">(max 80)</span></label>
        <input
          value={title}
          onChange={e => setTitle(e.target.value.slice(0, 80))}
          placeholder="Birthday gift for Alice"
          className="bg-[var(--surface-muted)] border border-[var(--border)] focus:border-[var(--border-strong)] rounded-xl px-3 py-2.5 text-sm outline-none transition"
        />
      </div>

      {/* Note */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-[var(--ink-2)]">Note <span className="text-[var(--subtle)] font-normal">(max 280)</span></label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value.slice(0, 280))}
          rows={2}
          placeholder="Optional message…"
          className="bg-[var(--surface-muted)] border border-[var(--border)] focus:border-[var(--border-strong)] rounded-xl px-3 py-2.5 text-sm outline-none transition resize-none"
        />
      </div>

      {/* Summary */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 flex flex-col gap-2 text-sm">
        <Row label="Target"           value={`${formatUsdc(targetRaw)} USDC`} strong />
        <Row label="Suggested share"  value={suggestedShare > 0n ? `${formatUsdc(suggestedShare)} USDC each` : '—'} />
        <Row label="Protocol fee"     value="0.05% only when paid out" />
        <Row label="Est. gas"         value={`~${(Number(gasEst) / 1_000_000).toFixed(4)} USDC`} />
        {!IS_TESTNET && <Row label="" value="Real USDC — mainnet" danger />}
      </div>

      {error && <p className="text-xs text-[var(--danger)] px-1">{error}</p>}
      {!canAfford && <p className="text-xs text-[var(--danger)] px-1">Insufficient USDC for gas</p>}

      {metaStatus === 'pending' && (
        <p className="text-xs text-[var(--muted)] flex items-center gap-1">
          <Loader2 size={11} className="animate-spin" /> Saving title…
        </p>
      )}
      {metaStatus === 'failed' && (
        <p className="text-xs text-[var(--subtle)]">Title pending — will show as "Pot #id" until synced.</p>
      )}

      <TxButton
        label={wrongChain ? 'Switch to Arc' : 'Create Pot'}
        disabled={!formValid || !canAfford}
        disabledReason={!formValid ? 'Fill in all fields' : 'Insufficient USDC for gas'}
        onSubmit={handleSubmit}
        onSuccess={() => { /* navigation handled in onReceipt with potId state */ }}
        onReceipt={async (receipt) => {
          const meta = pendingMetaRef.current
          if (!meta) return
          // Parse PotCreated log to get potId
          let potId: bigint | null = null
          for (const log of receipt.logs) {
            try {
              const decoded = decodeEventLog({ abi: POTLY_ABI, data: log.data, topics: log.topics })
              if (decoded.eventName === 'PotCreated') {
                potId = (decoded.args as { potId: bigint }).potId
                break
              }
            } catch { /* not this event */ }
          }
          if (potId === null) return
          saveMeta(TARGET_CHAIN_ID, potId, meta)
          // Navigate with the new potId so MyPotsPage can show it immediately
          // even before the API / indexer has caught up.
          navigate('/my', { state: { newPotId: potId.toString() } })
          setMetaStatus('pending')
          const ok = await postMetadata(TARGET_CHAIN_ID, potId, meta)
          setMetaStatus(ok ? 'done' : 'failed')
        }}
      />
    </div>
  )
}

function Row({ label, value, strong, danger }: { label: string; value: string; strong?: boolean; danger?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[var(--muted)]">{label}</span>
      <span className={`tabular-nums ${strong ? 'font-semibold text-[var(--ink)]' : danger ? 'text-[var(--danger)]' : 'text-[var(--ink-2)]'}`}>{value}</span>
    </div>
  )
}

function formatAddress(addr: string): string {
  return addr.slice(0, 6) + '…' + addr.slice(-4)
}
