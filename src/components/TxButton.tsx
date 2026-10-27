import { useState } from 'react'
import { useWaitForTransactionReceipt, type UseWaitForTransactionReceiptReturnType } from 'wagmi'
type Receipt = NonNullable<UseWaitForTransactionReceiptReturnType['data']>
import { Loader2, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react'
import { buildTxUrl } from '@/config/wagmi'
import { decodePotlyError } from '@/lib/errors'

export type TxState = 'idle' | 'signing' | 'confirming' | 'success' | 'error'

interface TxButtonProps {
  label: string
  disabled?: boolean
  disabledReason?: string
  variant?: 'primary' | 'ghost' | 'danger'
  onSubmit: () => Promise<`0x${string}` | void>
  onSuccess?: () => void
  onReceipt?: (receipt: Receipt) => void
  className?: string
}

export function TxButton({
  label, disabled, disabledReason, variant = 'primary',
  onSubmit, onSuccess, onReceipt, className = '',
}: TxButtonProps) {
  const [state, setState]   = useState<TxState>('idle')
  const [hash, setHash]     = useState<`0x${string}` | undefined>()
  const [errMsg, setErrMsg] = useState<string>('')

  const { isSuccess, data: receipt } = useWaitForTransactionReceipt({
    hash,
    query: { enabled: !!hash && state === 'confirming' },
  })

  // Transition to success once confirmed with status 1
  if (isSuccess && receipt?.status === 'success' && state === 'confirming') {
    setState('success')
    onSuccess?.()
    if (onReceipt && receipt) onReceipt(receipt)
  }
  // Handle reverted tx
  if (isSuccess && receipt?.status === 'reverted' && state === 'confirming') {
    setState('error')
    setErrMsg('Transaction reverted on-chain.')
  }

  async function handleClick() {
    if (state !== 'idle' && state !== 'error') return
    setState('signing')
    setErrMsg('')
    try {
      const txHash = await onSubmit()
      if (txHash) {
        setHash(txHash)
        setState('confirming')
      } else {
        setState('idle')
      }
    } catch (e) {
      const msg = decodePotlyError(e)
      if (msg === 'Transaction cancelled.') {
        setState('idle')
      } else {
        setErrMsg(msg)
        setState('error')
      }
    }
  }

  const variantCls = {
    primary: 'bg-[var(--accent)] text-white hover:opacity-90',
    ghost:   'bg-[var(--surface)] border border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-strong)]',
    danger:  'bg-[var(--danger)]/10 border border-[var(--danger)]/40 text-[var(--danger)] hover:bg-[var(--danger)]/20',
  }[variant]

  const isDisabled = disabled || state === 'signing' || state === 'confirming'

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <button
        onClick={handleClick}
        disabled={isDisabled}
        title={disabledReason}
        className={[
          'relative w-full rounded-xl px-4 py-3 text-sm font-semibold transition-all',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          'flex items-center justify-center gap-2',
          variantCls,
        ].join(' ')}
      >
        {state === 'signing' && <Loader2 size={14} className="animate-spin" />}
        {state === 'confirming' && <Loader2 size={14} className="animate-spin" />}
        {state === 'success' && <CheckCircle size={14} className="text-[var(--success)]" />}
        {state === 'error' && <AlertCircle size={14} />}
        {state === 'signing' ? 'Confirm in wallet…' :
         state === 'confirming' ? 'Confirming…' :
         state === 'success' ? 'Done!' : label}
      </button>

      {state === 'confirming' && hash && (
        <a
          href={buildTxUrl(hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--ink)] px-1"
        >
          <ExternalLink size={11} /> View transaction
        </a>
      )}
      {state === 'success' && hash && (
        <a
          href={buildTxUrl(hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-[var(--success)] px-1"
        >
          <ExternalLink size={11} /> Transaction confirmed
        </a>
      )}
      {state === 'error' && (
        <div className="flex items-start gap-1 text-xs text-[var(--danger)] px-1">
          <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
          <span>{errMsg}</span>
        </div>
      )}
      {disabled && disabledReason && state === 'idle' && (
        <p className="text-xs text-[var(--subtle)] px-1">{disabledReason}</p>
      )}
    </div>
  )
}
