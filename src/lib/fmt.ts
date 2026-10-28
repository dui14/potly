/**
 * Shared formatting helpers.
 * All amounts are displayed as USDC, never with a "$" prefix.
 */

/** Format a 6-decimal USDC bigint as "1,234.56" (no $ sign, no USDC suffix). */
export function fmtUsdc(raw: bigint): string {
  return (Number(raw) / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })
}

/**
 * Format a gas cost expressed in 18-decimal native wei.
 * Shows up to 4 decimals; if the value rounds to less than 0.0001, shows "<0.0001".
 * Never uses a "$" sign.
 */
export function fmtGasNative(wei: bigint): string {
  const usdc = Number(wei) / 1e18
  if (usdc === 0) return '0'
  if (usdc < 0.0001) return '<0.0001'
  return usdc.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
}

/**
 * Convert a 6-decimal USDC bigint gas estimate (from estimatedGasUsdc6)
 * back to an 18-decimal wei bigint for fmtGasNative.
 * estimatedGasUsdc6 returns units in 6-decimal USDC; multiply by 1e12 to get wei.
 */
export function usdc6ToWei(usdc6: bigint): bigint {
  return usdc6 * 1_000_000_000_000n
}
