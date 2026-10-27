import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useSwitchChain, useWaitForTransactionReceipt } from 'wagmi'
import { Loader2, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID, IS_TESTNET, buildTxUrl } from '@/config/wagmi'
import { estimatedGasUsdc6 } from '@/lib/gas'
import { useGasPrice } from '@/hooks/useGasPrice'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { decodePotlyError } from '@/lib/errors'

type Step = 'idle' | 'signing' | 'confirming' | 'success' | 'error'

interface Props {
  potId: bigint
  contribution: bigint
  onSuccess: () => void
}

function fmt(raw: bigint) {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function WithdrawPanel({ potId, contribution, onSuccess }: Props) {
  const { address, chainId } = useAccount()
  const { switchChain }      = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const gasPrice             = useGasPrice()
  const { balance, refetch: refetchBal } = useUsdcBalance(address)

  const [rawInput, setRawInput] = useState('')
  const [step, setStep]         = useState<Step>('idle')
  const [errMsg, setErrMsg]     = useState('')
  const [txHash, setTxHash]     = useState<`0x${string}` | undefined>()
  const [actualWithdrawn, setActualWithdrawn] = useState<bigint | null>(null)
  const [actualGas, setActualGas]             = useState<string | null>(null)

  const wrongChain  = chainId !== TARGET_CHAIN_ID
  const withdrawGas = estimatedGasUsdc6('withdraw', gasPrice)

  const parsedInput = (() => {
    const n = parseFloat(rawInput.replace(/,/g, ''))
    if (isNaN(n) || n <= 0) return 0n
    return BigInt(Math.round(n * 1_000_000))
  })()

  const capped      = parsedInput > contribution ? contribution : parsedInput
  const isOverCapped = parsedInput > contribution && contribution > 0n

  const { isSuccess, data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash && step === 'confirming' },
  })

  useEffect(() => {
    if (!isSuccess || !receipt || step !== 'confirming') return
    if (receipt.status === 'success') {
      const gasUsed   = receipt.gasUsed ?? 0n
      const gp        = receipt.effectiveGasPrice ?? 0n
      const gasCost6  = (gasUsed * gp) / 1_000_000_000_000n
      setActualGas(`$${fmt(gasCost6)}`)
      setActualWithdrawn(capped)
      setStep('success')
      refetchBal()
      onSuccess()
    } else {
      setStep('error')
      setErrMsg('Transaction reverted on-chain.')
    }
  }, [isSuccess, receipt, step, capped, refetchBal, onSuccess])

  async function handleSubmit() {
    if (step !== 'idle' && step !== 'error') return
    if (wrongChain) { switchChain({ chainId: TARGET_CHAIN_ID }); return }
    if (capped === 0n) return
    setErrMsg('')
    setActualWithdrawn(null)
    setActualGas(null)
    setStep('signing')
    try {
      const hash = await writeContractAsync({
        address: POTLY_ADDRESS,
        abi: POTLY_ABI,
        functionName: 'withdraw',
        args: [potId, capped],
        chainId: TARGET_CHAIN_ID,
      })
      setTxHash(hash)
      setStep('confirming')
    } catch (e) {
      const msg = decodePotlyError(e)
      if (msg === 'Transaction cancelled.') setStep('idle')
      else { setErrMsg(msg); setStep('error') }
    }
  }

  const canSubmit = capped > 0n && balance >= withdrawGas

  if (step === 'success' && actualWithdrawn !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-xl bg-[var(--success)]/10 border border-[var(--success)]/30 p-4">
        <div className="flex items-center gap-2 text-[var(--success)] font-semibold text-sm">
          <CheckCircle size={14} /> Withdrawal confirmed
        </div>
        <p className="text-sm text-[var(--ink-2)]">
          Received: <span className="font-mono">${fmt(actualWithdrawn)} USDC</span>
          {actualGas && <> · Gas: <span className="font-mono">{actualGas} USDC</span></>}
        </p>
        {txHash && (
          <a href={buildTxUrl(txHash)} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-[var(--success)]">
            <ExternalLink size={11} /> View transaction
          </a>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-[var(--ink-2)]">Withdraw (USDC)</label>
          <button
            onClick={() => setRawInput((Number(contribution) / 1_000_000).toString())}
            className="text-xs text-[var(--accent)] hover:underline"
          >
            Max (${fmt(contribution)})
          </button>
        </div>
        <input
          type="number" min="0.01" step="0.01"
          value={rawInput}
          onChange={e => setRawInput(e.target.value)}
          placeholder="0.00"
          className="bg-[var(--surface-muted)] border border-[var(--border)] focus:border-[var(--border-strong)] rounded-xl px-3 py-2.5 text-sm outline-none transition w-full"
        />
        {isOverCapped && (
          <p className="text-xs text-amber-400">Your contribution is ${fmt(contribution)}; capped to that amount.</p>
        )}
      </div>

      {capped > 0n && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 flex flex-col gap-1.5 text-xs">
          <Row label="You receive"       value={`$${fmt(capped)} USDC`} />
          <Row label="Est. network fee"  value={`~$${fmt(withdrawGas)} USDC`} />
          {!IS_TESTNET && <Row label="" value="Real USDC — mainnet" danger />}
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit || step === 'signing' || step === 'confirming'}
        className={[
          'w-full rounded-xl px-4 py-3 text-sm font-semibold transition-all flex items-center justify-center gap-2',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          'bg-[var(--surface)] border border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-strong)]',
        ].join(' ')}
      >
        {(step === 'signing' || step === 'confirming') && <Loader2 size={14} className="animate-spin" />}
        {step === 'signing'    ? 'Confirm in wallet…' :
         step === 'confirming' ? 'Confirming…' :
         wrongChain            ? 'Switch to Arc' : 'Withdraw'}
      </button>

      {step === 'confirming' && txHash && (
        <a href={buildTxUrl(txHash)} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-[var(--muted)] px-1">
          <ExternalLink size={11} /> View transaction
        </a>
      )}
      {step === 'error' && errMsg && (
        <div className="flex items-start gap-1 text-xs text-[var(--danger)]">
          <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
          <span>{errMsg}</span>
        </div>
      )}
    </div>
  )
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[var(--muted)]">{label}</span>
      <span className={danger ? 'text-[var(--danger)]' : 'text-[var(--ink-2)]'}>{value}</span>
    </div>
  )
}
