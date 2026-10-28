import { useState, useEffect, useCallback } from 'react'
import {
  useAccount, useWriteContract, useSwitchChain,
  useSimulateContract, useWaitForTransactionReceipt,
} from 'wagmi'
import { erc20Abi, parseAbiItem, decodeEventLog } from 'viem'
import { Loader2, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, USDC_ADDRESS, TARGET_CHAIN_ID, IS_TESTNET, buildTxUrl } from '@/config/wagmi'
import { estimatedGasUsdc6 } from '@/lib/gas'
import { useGasPrice } from '@/hooks/useGasPrice'
import { useUsdcBalance, useUsdcAllowance } from '@/hooks/useUsdcBalance'
import { useRemaining } from '@/hooks/usePot'
import { decodePotlyError } from '@/lib/errors'
import { fmtUsdc, fmtGasNative, usdc6ToWei } from '@/lib/fmt'
import type { PotData } from '@/hooks/usePot'

type Step = 'idle' | 'approving' | 'signing' | 'confirming' | 'success' | 'error'

interface Props {
  potId: bigint
  pot: PotData
  onSuccess: () => void
}

const DepositedAbi = parseAbiItem(
  'event Deposited(uint256 indexed potId, address indexed depositor, uint256 accepted, uint256 raised)',
)

export function ContributePanel({ potId, pot, onSuccess }: Props) {
  const { address, chainId } = useAccount()
  const { switchChain }      = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const gasPrice             = useGasPrice()
  const { balance, refetch: refetchBal } = useUsdcBalance(address)
  const { allowance, refetch: refetchAllow } = useUsdcAllowance(address, POTLY_ADDRESS)
  const rem = useRemaining(potId)

  const sugg = pot.slots > 0n ? pot.target / pot.slots : 0n
  const [rawInput, setRawInput] = useState('')
  const [step, setStep]         = useState<Step>('idle')
  const [errMsg, setErrMsg]     = useState('')
  const [txHash, setTxHash]     = useState<`0x${string}` | undefined>()
  const [actualCharged, setActualCharged] = useState<bigint | null>(null)
  const [actualGas, setActualGas]         = useState<string | null>(null)

  const wrongChain = chainId !== TARGET_CHAIN_ID

  // Parse input — 6 decimal places max
  const parsedInput: bigint = (() => {
    if (!rawInput) return 0n
    const n = parseFloat(rawInput.replace(/,/g, ''))
    if (isNaN(n) || n <= 0) return 0n
    return BigInt(Math.round(n * 1_000_000))
  })()

  // The amount we will actually submit: if input exceeds remaining, cap at remaining
  // and SHOW the user what they'll be charged (so approval = charged amount).
  const chargeAmount = parsedInput > rem ? rem : parsedInput
  const isOverRem    = parsedInput > rem && rem > 0n

  // Gas estimates
  const approveGas = estimatedGasUsdc6('approve', gasPrice)
  const depositGas = estimatedGasUsdc6('deposit', gasPrice)

  // After every confirmed tx refetch allowance so needsApprove is fresh
  const needsApprove = allowance < chargeAmount

  // Simulate deposit ONLY after allowance is confirmed sufficient
  // (simulating before approval always reverts because the contract checks transferFrom)
  const { error: simError } = useSimulateContract({
    address: POTLY_ADDRESS,
    abi: POTLY_ABI,
    functionName: 'deposit',
    args: chargeAmount > 0n && address ? [potId, chargeAmount] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: chargeAmount > 0n && !!address && !needsApprove },
  })

  const simBlocked = !!simError && !needsApprove && chargeAmount > 0n
  const simErrMsg  = simBlocked ? decodePotlyError(simError) : null

  // Wait for tx receipt
  const { isSuccess, data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash && step === 'confirming' },
  })

  useEffect(() => {
    if (!isSuccess || !receipt || step !== 'confirming') return
    if (receipt.status === 'success') {
      // Read actual accepted amount from the Deposited event
      let accepted = chargeAmount
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: [DepositedAbi], data: log.data, topics: log.topics })
          if (decoded.eventName === 'Deposited') {
            accepted = (decoded.args as { accepted: bigint }).accepted
            break
          }
        } catch { /* not this event */ }
      }
      const gasWei = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n)
      setActualGas(fmtGasNative(gasWei))
      setActualCharged(accepted)
      setStep('success')
      // Invalidate everything — stale allowance is the root cause of re-deposit failures
      void refetchBal()
      void refetchAllow()
      onSuccess()
    } else {
      setStep('error')
      setErrMsg('Transaction reverted on-chain.')
    }
  }, [isSuccess, receipt])   // eslint-disable-line react-hooks/exhaustive-deps

  // Reset form when remaining changes (pot updated by another contributor)
  // but NOT when we're mid-transaction
  const resetForm = useCallback(() => {
    if (step === 'success' || step === 'signing' || step === 'approving' || step === 'confirming') return
    setRawInput('')
    setErrMsg('')
    setStep('idle')
  }, [step])

  useEffect(() => { resetForm() }, [rem.toString()])   // eslint-disable-line react-hooks/exhaustive-deps

  const quickBtns = [
    { label: '25%', value: sugg / 4n },
    { label: '50%', value: sugg / 2n },
    { label: '100%', value: sugg },
    { label: 'Fill',  value: rem },
  ]

  async function handleSubmit() {
    if (step !== 'idle' && step !== 'error') return
    if (wrongChain) { switchChain({ chainId: TARGET_CHAIN_ID }); return }
    if (chargeAmount === 0n) return
    setErrMsg('')
    setActualCharged(null)
    setActualGas(null)

    try {
      // Approval uses exact chargeAmount — consumed by the deposit; next deposit
      // needs a fresh approval, which is why we refetchAllow after success.
      if (needsApprove) {
        setStep('approving')
        await writeContractAsync({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'approve',
          args: [POTLY_ADDRESS, chargeAmount],
          chainId: TARGET_CHAIN_ID,
        })
        await refetchAllow()
      }

      setStep('signing')
      const hash = await writeContractAsync({
        address: POTLY_ADDRESS,
        abi: POTLY_ABI,
        functionName: 'deposit',
        args: [potId, chargeAmount],
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

  // Disabled reason text (A3c)
  function disabledReason(): string | null {
    if (wrongChain) return null  // button label already says "Switch to Arc"
    if (chargeAmount === 0n) return 'Enter a contribution amount'
    if (balance < chargeAmount + approveGas + depositGas)
      return `Insufficient USDC (need ~${fmtUsdc(chargeAmount + approveGas + depositGas)} USDC)`
    if (simBlocked && simErrMsg) return simErrMsg
    return null
  }

  const totalGas = approveGas + depositGas
  const totalCost = chargeAmount + totalGas
  const canSubmit =
    chargeAmount > 0n &&
    balance >= totalCost &&
    !simBlocked &&
    (step === 'idle' || step === 'error')

  // After success, show receipt
  if (step === 'success' && actualCharged !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-xl bg-[var(--success)]/10 border border-[var(--success)]/30 p-4">
        <div className="flex items-center gap-2 text-[var(--success)] font-semibold text-sm">
          <CheckCircle size={14} /> Contribution confirmed
        </div>
        <p className="text-sm text-[var(--ink-2)]">
          Charged: <span className="font-mono tabular-nums">{fmtUsdc(actualCharged)} USDC</span>
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

  const reason = disabledReason()

  return (
    <div className="flex flex-col gap-4">
      {/* Amount input */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[var(--ink-2)]">
          Contribute (USDC)
          {sugg > 0n && <span className="text-[var(--muted)] font-normal"> · suggested {fmtUsdc(sugg)}</span>}
        </label>
        <div className="flex gap-2 flex-wrap">
          {quickBtns.map(b => b.value > 0n && (
            <button
              key={b.label}
              onClick={() => setRawInput((Number(b.value) / 1_000_000).toFixed(6))}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] bg-[var(--surface)] text-[var(--ink-2)] hover:border-[var(--border-strong)] transition"
            >
              {b.label}{b.label === 'Fill' ? ` (${fmtUsdc(rem)} USDC)` : ''}
            </button>
          ))}
        </div>
        <input
          type="number" min="0.000001" step="0.000001"
          value={rawInput}
          onChange={e => { setRawInput(e.target.value); setErrMsg('') }}
          placeholder="0.00"
          className="bg-[var(--surface-muted)] border border-[var(--border)] focus:border-[var(--border-strong)] rounded-xl px-3 py-2.5 text-sm outline-none transition w-full"
        />
        {/* Overcap notice: tell the user exactly what they'll be charged */}
        {isOverRem && (
          <p className="text-xs text-amber-400 flex items-start gap-1">
            <AlertCircle size={11} className="mt-0.5 shrink-0" />
            Only {fmtUsdc(rem)} USDC is still needed — you will be charged {fmtUsdc(rem)} USDC.
          </p>
        )}
        {simBlocked && simErrMsg && (
          <p className="text-xs text-[var(--danger)] flex items-center gap-1">
            <AlertCircle size={11} /> {simErrMsg}
          </p>
        )}
      </div>

      {/* Summary card */}
      {chargeAmount > 0n && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 flex flex-col gap-1.5 text-xs">
          <Row label="Pot receives"       value={`${fmtUsdc(chargeAmount)} USDC`} />
          {needsApprove && <Row label="Step 1: Approve" value="Required (exact amount)" />}
          <Row label="Est. gas"           value={`~${fmtGasNative(usdc6ToWei(totalGas))} USDC`} />
          <Row label="Total deducted ~"   value={`${fmtUsdc(totalCost)} USDC`} strong />
          <Row label="Balance after ~"    value={`${fmtUsdc(balance > totalCost ? balance - totalCost : 0n)} USDC`} />
          {!IS_TESTNET && <Row label="" value="Real USDC — mainnet" danger />}
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        className={[
          'w-full rounded-xl px-4 py-3 text-sm font-semibold transition-all flex items-center justify-center gap-2',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          'bg-[var(--accent)] text-white hover:opacity-90',
        ].join(' ')}
      >
        {(step === 'approving' || step === 'signing' || step === 'confirming') && (
          <Loader2 size={14} className="animate-spin" />
        )}
        {step === 'approving'  ? 'Approving…' :
         step === 'signing'    ? 'Confirm in wallet…' :
         step === 'confirming' ? 'Confirming…' :
         wrongChain            ? 'Switch to Arc' :
         needsApprove          ? 'Approve & Contribute' : 'Contribute'}
      </button>

      {/* Disabled reason (A3c) */}
      {!canSubmit && reason && step === 'idle' && (
        <p className="text-xs text-[var(--subtle)] px-1 flex items-start gap-1">
          <AlertCircle size={11} className="mt-0.5 shrink-0" /> {reason}
        </p>
      )}

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

function Row({ label, value, strong, danger }: { label: string; value: string; strong?: boolean; danger?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[var(--muted)]">{label}</span>
      <span className={strong ? 'font-semibold text-[var(--ink)]' : danger ? 'text-[var(--danger)]' : 'text-[var(--ink-2)]'}>{value}</span>
    </div>
  )
}
