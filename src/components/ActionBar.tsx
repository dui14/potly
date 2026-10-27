import { useAccount, useWriteContract, useSwitchChain } from 'wagmi'
import { AlertCircle } from 'lucide-react'
import { POTLY_ABI } from '@/lib/potlyAbi'
import { POTLY_ADDRESS, TARGET_CHAIN_ID } from '@/config/wagmi'
import { estimatedGasUsdc6 } from '@/lib/gas'
import { useGasPrice } from '@/hooks/useGasPrice'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { useContributionOf, useIsRefundable, STATUS } from '@/hooks/usePot'
import { TxButton } from './TxButton'
import { ContributePanel } from './ContributePanel'
import { WithdrawPanel } from './WithdrawPanel'
import { formatAddress } from '@/lib/utils'
import type { PotData } from '@/hooks/usePot'

interface Props {
  potId: bigint
  pot: PotData
  chainTime: bigint
  onAction: () => void
}

export function ActionBar({ potId, pot, chainTime, onAction }: Props) {
  const { address, chainId } = useAccount()
  const { switchChain }      = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const gasPrice             = useGasPrice()
  const { balance }          = useUsdcBalance(address)
  const { contribution }     = useContributionOf(potId, address)
  const isRefundable         = useIsRefundable(potId)
  const wrongChain           = chainId !== TARGET_CHAIN_ID

  if (!address) {
    return <p className="text-sm text-[var(--muted)]">Connect your wallet to interact.</p>
  }

  const { status, creator, recipient, target, raised, slots, contributors, deadline } = pot
  const isCreator  = address.toLowerCase() === creator.toLowerCase()
  const isExpired  = status === STATUS.OPEN && chainTime >= deadline

  const claimGas   = estimatedGasUsdc6('claimPayout', gasPrice)
  const canClaim   = balance >= claimGas

  // EXPIRED + OPEN = refunds open
  if (isExpired && status === STATUS.OPEN) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 bg-amber-900/20 border border-amber-700/40 text-amber-400 text-sm">
          <AlertCircle size={14} />
          Expired: refunds open
        </div>
        {contribution > 0n && isRefundable && (
          <WithdrawPanel potId={potId} contribution={contribution} onSuccess={onAction} />
        )}
      </div>
    )
  }

  // OPEN — show Contribute (if slot available) and Withdraw (if has contribution + refundable)
  if (status === STATUS.OPEN) {
    const slotsFull = contributors >= slots
    return (
      <div className="flex flex-col gap-4">
        {!slotsFull && raised < target ? (
          <ContributePanel potId={potId} pot={pot} onSuccess={onAction} />
        ) : raised >= target ? (
          <p className="text-sm text-[var(--success)]">Target reached — awaiting payout claim.</p>
        ) : (
          <p className="text-sm text-[var(--muted)]">All contributor slots are taken.</p>
        )}

        {contribution > 0n && isRefundable && (
          <div className="border-t border-[var(--border)] pt-4">
            <WithdrawPanel potId={potId} contribution={contribution} onSuccess={onAction} />
          </div>
        )}

        {isCreator && (
          <div className="border-t border-[var(--border)] pt-4">
            <TxButton
              label="Cancel Pot"
              variant="danger"
              onSubmit={async () => {
                if (wrongChain) { switchChain({ chainId: TARGET_CHAIN_ID }); return }
                return writeContractAsync({
                  address: POTLY_ADDRESS,
                  abi: POTLY_ABI,
                  functionName: 'cancel',
                  args: [potId],
                  chainId: TARGET_CHAIN_ID,
                })
              }}
              onSuccess={onAction}
            />
          </div>
        )}
      </div>
    )
  }

  // FILLED — anyone can trigger payout; contributors can withdraw after claim window
  if (status === STATUS.FILLED) {
    return (
      <div className="flex flex-col gap-4">
        <div className="text-sm text-[var(--ink-2)]">
          Recipient: <span className="font-mono">{formatAddress(recipient)}</span>
        </div>
        <TxButton
          label="Pay out to recipient"
          disabled={!canClaim}
          disabledReason="Not enough USDC for gas"
          onSubmit={async () => {
            if (wrongChain) { switchChain({ chainId: TARGET_CHAIN_ID }); return }
            return writeContractAsync({
              address: POTLY_ADDRESS,
              abi: POTLY_ABI,
              functionName: 'claimPayout',
              args: [potId],
              chainId: TARGET_CHAIN_ID,
            })
          }}
          onSuccess={onAction}
        />
        {contribution > 0n && isRefundable && (
          <div className="border-t border-[var(--border)] pt-4">
            <WithdrawPanel potId={potId} contribution={contribution} onSuccess={onAction} />
          </div>
        )}
      </div>
    )
  }

  // CANCELLED
  if (status === STATUS.CANCELLED) {
    if (contribution > 0n) {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--muted)]">Pot cancelled — you can withdraw your contribution.</p>
          <WithdrawPanel potId={potId} contribution={contribution} onSuccess={onAction} />
        </div>
      )
    }
    return <p className="text-sm text-[var(--muted)]">This pot was cancelled.</p>
  }

  // PAID
  return <p className="text-sm text-[var(--success)]">This pot has been paid out.</p>
}
