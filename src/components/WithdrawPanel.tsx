import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useSwitchChain, useWaitForTransactionReceipt } from 'wagmi'
import { parseAbiItem, decodeEventLog } from 'viem'
import { Loader2, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID, IS_TESTNET, buildTxUrl } from '@/config/wagmi'
import { estimatedGasUsdc6 } from '@/lib/gas'
import { useGasPrice } from '@/hooks/useGasPrice'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { useContributionOf } from '@/hooks/usePot'
import { decodePotlyError } from '@/lib/errors'
import { fmtGasNative, fmtUsdc } from '@/lib/fmt'

type Step = 'idle' | 'signing' | 'confirming' | 'success' | 'error'

interface Props {
  potId: bigint
  /** Pass the outer contribution as a hint, but the panel reads live from chain. */
  contribution: bigint
  onSuccess: () => void
}

const WithdrawnAbi = parseAbiItem(
  'event Withdrawn(uint256 indexed potId, address indexed depositor, uint256 amount, uint256 raised)',
)

export function WithdrawPanel({ potId, contribution: _hint, onSuccess }: Props) {
  const { address, chainId } = useAccount()
  // Always read live contributionOf — never trust the prop after the first render
  const { contribution, refetch: refetchContrib } = useContributionOf(potId, address)
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

  // Parse input exactly — 6 decimal places max, never clamped
  const parsedInput: bigint = (() => {
    if (!rawInput) return 0n
    const n = parseFloat(rawInput.replace(/,/g, ''))
    if (isNaN(n) || n <= 0) return 0n
    // Round at 6 decimal places
    return BigInt(Math.round(n * 1_000_000))
  })()

  // Inline validation
  const isEmpty   = !rawInput || rawInput.trim() === ''
  const isZero    = !isEmpty && parsedInput === 0n
  const isOverMax = !isEmpty && !isZero && parsedInput > contribution
  const inputErr  = isOverMax
    ? `You can withdraw at most ${fmtUsdc(contribution)} USDC`
    : isZero ? 'Enter an amount greater than 0' : ''

  const { isSuccess, data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash && step === 'confirming' },
  })

  useEffect(() => {
    if (!isSuccess || !receipt || step !== 'confirming') return
    if (receipt.status === 'success') {
      // Decode Withdrawn event to get the exact amount returned
      let withdrawn = parsedInput
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: [WithdrawnAbi], data: log.data, topics: log.topics })
          if (decoded.eventName === 'Withdrawn') {
            withdrawn = (decoded.args as { amount: bigint }).amount
            break
          }
        } catch { /* not this event */ }
      }
      // Gas: gasUsed * effectiveGasPrice in native 18-decimal wei
      const gasWei = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n)
      setActualGas(fmtGasNative(gasWei))
      setActualWithdrawn(withdrawn)
      setStep('success')
      // Invalidate all relevant reads
      void refetchBal()
      void refetchContrib()
      onSuccess()
    } else {
      setStep('error')
      setErrMsg('Transaction reverted on-chain.')
    }
  }, [isSuccess, receipt])   // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to idle when contribution changes (e.g. after a successful tx and re-mount)
  useEffect(() => {
    if (step === 'success') return
    setRawInput('')
    setStep('idle')
    setErrMsg('')
  }, [contribution.toString()])   // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit() {
    if (step !== 'idle' && step !== 'error') return
    if (wrongChain) { switchChain({ chainId: TARGET_CHAIN_ID }); return }
    if (parsedInput === 0n || parsedInput > contribution) return
    setErrMsg('')
    setActualWithdrawn(null)
    setActualGas(null)
    setStep('signing')
    try {
      // Send exactly parsedInput — no silent clamping
      const hash = await writeContractAsync({
        address: POTLY_ADDRESS,
        abi: POTLY_ABI,
        functionName: 'withdraw',
        args: [potId, parsedInput],
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

  const canSubmit = !isEmpty && !isZero && !isOverMax && balance >= withdrawGas

  if (step === 'success' && actualWithdrawn !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-xl bg-[var(--success)]/10 border border-[var(--success)]/30 p-4">
        <div className="flex items-center gap-2 text-[var(--success)] font-semibold text-sm">
          <CheckCircle size={14} /> Withdrawal confirmed
        </div>
        <p className="text-sm text-[var(--ink-2)]">
          Received: <span className="font-mono tabular-nums">{fmtUsdc(actualWithdrawn)} USDC</span>
          {actualGas && <> · Gas: <span className="font-mono tabular-nums">{actualGas} USDC</span></>}
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
        <div className="flex items-center justify-between gap-2">
          <label className="text-sm font-medium text-[var(--ink-2)]">Withdraw (USDC)</label>
          <button
            onClick={() => setRawInput((Number(contribution) / 1_000_000).toFixed(6))}
            className="text-xs text-[var(--accent)] hover:underline shrink-0"
          >
            Max ({fmtUsdc(contribution)} USDC)
          </button>
        </div>
        <input
          type="number" min="0.000001" step="0.000001"
          value={rawInput}
          onChange={e => { setRawInput(e.target.value); setErrMsg('') }}
          placeholder="0.00"
          className="bg-[var(--surface-muted)] border border-[var(--border)] focus:border-[var(--border-strong)] rounded-xl px-3 py-2.5 text-sm outline-none transition w-full"
        />
        {inputErr && (
          <p className="text-xs text-[var(--danger)] flex items-center gap-1">
            <AlertCircle size={11} /> {inputErr}
          </p>
        )}
        {balance < withdrawGas && (
          <p className="text-xs text-[var(--danger)]">Insufficient USDC for gas (~{fmtGasNative(withdrawGas * 1_000_000_000_000n)} USDC)</p>
        )}
      </div>

      {parsedInput > 0n && !isOverMax && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 flex flex-col gap-1.5 text-xs">
          <Row label="You receive"       value={`${fmtUsdc(parsedInput)} USDC`} />
          <Row label="Est. network fee"  value={`~${fmtGasNative(withdrawGas * 1_000_000_000_000n)} USDC`} />
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
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
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
