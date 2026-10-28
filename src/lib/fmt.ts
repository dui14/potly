/**
 * Shared formatting helpers.
 * All amounts are displayed as USDC, never with a "$" prefix.
 * All date/time output is forced to en-US to avoid locale-dependent labels
 * (e.g. Vietnamese "thg 10" from system locale).
 */

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit',
})

/** Full date + time in en-US, e.g. "Oct 28, 2026, 6:24 AM" */
export function formatDateTime(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(typeof date === 'number' ? date * 1000 : date)
  if (isNaN(d.getTime())) return '—'
  return DATE_FMT.format(d)
}

/**
 * Relative time ("5 min ago", "just now") up to 48 h,
 * then falls back to formatDateTime.
 * Adds a title tooltip with the full date.
 */
export function fmtRelative(date: Date | string | number, nowMs = Date.now()): { text: string; title: string } {
  const d = date instanceof Date ? date : new Date(typeof date === 'number' ? date * 1000 : date)
  if (isNaN(d.getTime())) return { text: '—', title: '' }
  const diffSec = Math.floor((nowMs - d.getTime()) / 1000)
  const full = DATE_FMT.format(d)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const title = `${full} (${tz})`
  if (diffSec < 60) return { text: 'just now', title }
  if (diffSec < 3600) return { text: `${Math.floor(diffSec / 60)} min ago`, title }
  if (diffSec < 86400) return { text: `${Math.floor(diffSec / 3600)} hr ago`, title }
  if (diffSec < 172800) return { text: `${Math.floor(diffSec / 86400)} day ago`, title }
  return { text: full, title }
}

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
