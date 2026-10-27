import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useSwitchChain, useSimulateContract, useWaitForTransactionReceipt } from 'wagmi'
import { erc20Abi } from 'viem'
import { Loader2, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, USDC_ADDRESS, TARGET_CHAIN_ID, IS_TESTNET, buildTxUrl } from '@/config/wagmi'
import { estimatedGasUsdc6 } from '@/lib/gas'
import { useGasPrice } from '@/hooks/useGasPrice'
import { useUsdcBalance, useUsdcAllowance } from '@/hooks/useUsdcBalance'
import { useRemaining } from '@/hooks/usePot'
import { decodePotlyError } from '@/lib/errors'
import type { PotData } from '@/hooks/usePot'

type Step = 'idle' | 'approving' | 'signing' | 'confirming' | 'success' | 'error'

interface Props {
  potId: bigint
  pot: PotData
  onSuccess: () => void
}

function fmt(raw: bigint) {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function ContributePanel({ potId, pot, onSuccess }: Props) {
  const { address, chainId } = useAccount()
  const { switchChain }      = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const gasPrice             = useGasPrice()
  const { balance, refetch: refetchBal } = useUsdcBalance(address)
  const { allowance, refetch: refetchAllow } = useUsdcAllowance(address, POTLY_ADDRESS)
  const rem                  = useRemaining(potId)

  // suggested share = target / slots
  const sugg = pot.slots > 0n ? pot.target / pot.slots : 0n
  const [rawInput, setRawInput] = useState('')
  const [step, setStep]         = useState<Step>('idle')
  const [errMsg, setErrMsg]     = useState('')
  const [txHash, setTxHash]     = useState<`0x${string}` | undefined>()
  const [actualCharged, setActualCharged] = useState<bigint | null>(null)
  const [actualGas, setActualGas]         = useState<string | null>(null)

  const wrongChain = chainId !== TARGET_CHAIN_ID

  // Parse input
  const parsedInput = (() => {
    const n = parseFloat(rawInput.replace(/,/g, ''))
    if (isNaN(n) || n <= 0) return 0n
    return BigInt(Math.round(n * 1_000_000))
  })()

  // Cap at remaining
  const capped = parsedInput > rem ? rem : parsedInput
  const isOvercapped = parsedInput > rem && rem > 0n

  // Gas estimates
  const approveGas  = estimatedGasUsdc6('approve', gasPrice)
  const depositGas  = estimatedGasUsdc6('deposit', gasPrice)
  const totalCost   = capped + approveGas + depositGas

  // Simulate deposit to catch errors before submit
  const needsApprove = allowance < capped
  const { error: simError } = useSimulateContract({
    address: POTLY_ADDRESS,
    abi: POTLY_ABI,
    functionName: 'deposit',
    args: capped > 0n && address ? [potId, capped] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: capped > 0n && !!address && !needsApprove },
  })

  const simBlocked = !!simError && !needsApprove && capped > 0n
  const simErrMsg  = simBlocked ? decodePotlyError(simError) : null

  // Wait for tx receipt
  const { isSuccess, data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash && step === 'confirming' },
  })

  useEffect(() => {
    if (!isSuccess || !receipt || step !== 'confirming') return
    if (receipt.status === 'success') {
      // actual gas from receipt
      const gasUsed    = receipt.gasUsed ?? 0n
      const gasPrice_  = receipt.effectiveGasPrice ?? 0n
      const gasCost18  = gasUsed * gasPrice_
      const gasCost6   = gasCost18 / 1_000_000_000_000n
      setActualGas(`$${fmt(gasCost6)}`)
      // actual charged = capped (contract never over-pulls)
      setActualCharged(capped)
      setStep('success')
      refetchBal()
      onSuccess()
    } else {
      setStep('error')
      setErrMsg('Transaction reverted on-chain.')
    }
  }, [isSuccess, receipt, step, capped, refetchBal, onSuccess])

  const quickBtns = [
    { label: '25%', value: sugg / 4n },
    { label: '50%', value: sugg / 2n },
    { label: '100%', value: sugg },
    { label: 'Fill',  value: rem },
  ]

  async function handleSubmit() {
    if (step !== 'idle' && step !== 'error') return
    if (wrongChain) { switchChain({ chainId: TARGET_CHAIN_ID }); return }
    setErrMsg('')
    setActualCharged(null)
    setActualGas(null)

    try {
      if (needsApprove) {
        setStep('approving')
        await writeContractAsync({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'approve',
          args: [POTLY_ADDRESS, capped],
          chainId: TARGET_CHAIN_ID,
        })
        await refetchAllow()
        // approval done — user sees "approving" resolved, now deposit
      }

      setStep('signing')
      const hash = await writeContractAsync({
        address: POTLY_ADDRESS,
        abi: POTLY_ABI,
        functionName: 'deposit',
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

  const canSubmit = capped > 0n && balance >= totalCost && !simBlocked && step === 'idle'

  // After success, show receipt
  if (step === 'success' && actualCharged !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-xl bg-[var(--success)]/10 border border-[var(--success)]/30 p-4">
        <div className="flex items-center gap-2 text-[var(--success)] font-semibold text-sm">
          <CheckCircle size={14} /> Contribution confirmed
        </div>
        <p className="text-sm text-[var(--ink-2)]">
          Charged: <span className="font-mono">${fmt(actualCharged)} USDC</span>
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
      {/* Amount input */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-[var(--ink-2)]">
          Contribute (USDC)
          {sugg > 0n && <span className="text-[var(--muted)] font-normal"> · suggested ${fmt(sugg)}</span>}
        </label>
        <div className="flex gap-2 flex-wrap">
          {quickBtns.map(b => b.value > 0n && (
            <button
              key={b.label}
              onClick={() => setRawInput((Number(b.value) / 1_000_000).toString())}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] bg-[var(--surface)] text-[var(--ink-2)] hover:border-[var(--border-strong)] transition"
            >
              {b.label} {b.label === 'Fill' ? `($${fmt(rem)})` : ''}
            </button>
          ))}
        </div>
        <input
          type="number" min="0.01" step="0.01"
          value={rawInput}
          onChange={e => setRawInput(e.target.value)}
          placeholder="0.00"
          className="bg-[var(--surface-muted)] border border-[var(--border)] focus:border-[var(--border-strong)] rounded-xl px-3 py-2.5 text-sm outline-none transition w-full"
        />
        {isOvercapped && (
          <p className="text-xs text-amber-400">
            Only ${fmt(rem)} is still needed — you will be charged at most ${fmt(rem)}.
          </p>
        )}
        {simBlocked && simErrMsg && (
          <p className="text-xs text-[var(--danger)] flex items-center gap-1">
            <AlertCircle size={11} /> {simErrMsg}
          </p>
        )}
      </div>

      {/* Summary card */}
      {capped > 0n && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 flex flex-col gap-1.5 text-xs">
          <Row label="Pot receives"         value={`$${fmt(capped)} USDC`} />
          <Row label="Est. network fee"     value={`~$${fmt(approveGas + depositGas)} USDC`} />
          <Row label="Total deducted ~"     value={`$${fmt(totalCost)} USDC`} strong />
          <Row label="Balance after ~"      value={`$${fmt(balance > totalCost ? balance - totalCost : 0n)} USDC`} />
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

function Row({ label, value, strong, danger }: { label: string; value: string; strong?: boolean; danger?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[var(--muted)]">{label}</span>
      <span className={strong ? 'font-semibold text-[var(--ink)]' : danger ? 'text-[var(--danger)]' : 'text-[var(--ink-2)]'}>{value}</span>
    </div>
  )
}
