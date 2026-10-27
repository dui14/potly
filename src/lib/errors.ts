import { decodeErrorResult, type Hex } from 'viem'
import { POTLY_ABI } from './potlyAbi'

const STATUS_NAMES = ['OPEN', 'FILLED', 'PAID', 'CANCELLED']

export function decodePotlyError(error: unknown): string {
  try {
    const msg = (error as { message?: string })?.message ?? ''

    if (
      msg.toLowerCase().includes('user rejected') ||
      (error as { code?: number })?.code === 4001
    ) return 'Transaction cancelled.'

    if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('timeout'))
      return 'Network error — check your connection and try again.'

    const hexMatch = msg.match(/(0x[0-9a-fA-F]{8,})/)
    if (hexMatch) {
      try {
        const decoded = decodeErrorResult({ abi: POTLY_ABI as never, data: hexMatch[1] as Hex })
        return formatPotlyError(decoded.errorName, decoded.args as unknown[])
      } catch { /* fall through */ }
    }

    const reasonMatch = msg.match(/reverted with reason string '([^']+)'/)
    if (reasonMatch) return reasonMatch[1]

    if (msg.toLowerCase().includes('reverted')) return 'Transaction failed — please try again.'
    if (msg.toLowerCase().includes('insufficient funds') || msg.toLowerCase().includes('exceeds balance'))
      return 'Insufficient USDC balance.'

    return 'Something went wrong — please try again.'
  } catch {
    return 'Something went wrong — please try again.'
  }
}

export function formatPotlyError(name: string, args: unknown[]): string {
  switch (name) {
    case 'ZeroAddress':              return 'Zero address not allowed.'
    case 'NoCode':                   return 'USDC address has no contract code.'
    case 'FeeTooHigh':               return `Fee too high: ${args[0]} bps (max 100).`
    case 'InvalidSlots':             return `Invalid slots: ${args[0]}. Must be 1–100.`
    case 'InvalidDuration':          return `Invalid duration: ${args[0]}s. Must be 60s–30 days.`
    case 'TargetTooSmall':           return 'Target too small (min 0.01 USDC).'
    case 'TargetExceedsMax':         return `Target exceeds maximum pot size of 500 USDC.`
    case 'InvalidRecipient':         return 'Invalid recipient address.'
    case 'PotNotOpen':               return `Pot is ${STATUS_NAMES[Number(args[1])] ?? 'unknown'}, not OPEN.`
    case 'PotNotFilled':             return `Pot is ${STATUS_NAMES[Number(args[1])] ?? 'unknown'}, not FILLED.`
    case 'DeadlinePassed':           return 'The pot deadline has passed.'
    case 'PotFull':                  return 'All contributor slots are taken.'
    case 'AmountBelowMin':           return `Amount too small (min 0.01 USDC unless filling remainder).`
    case 'ZeroAmount':               return 'Amount must be greater than zero.'
    case 'AmountExceedsContribution':return `Withdraw amount exceeds your contribution of $${fmt6(args[1] as bigint)}.`
    case 'NoContribution':           return 'You have no contribution in this pot.'
    case 'NotRefundable':            return 'This pot is not refundable yet.'
    case 'NotCreator':               return 'Only the pot creator can cancel.'
    case 'ClaimWindowClosed':        return 'The 7-day claim window has expired.'
    case 'NothingToSweep':           return 'No unaccounted USDC to sweep.'
    default:                         return `Contract error: ${name}`
  }
}

function fmt6(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(2)
}
