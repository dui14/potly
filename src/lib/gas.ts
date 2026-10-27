// Per-action gas constants from v2 forge gas report (rounded up slightly).
// Multiply by live fee data × 1.3 to get USDC estimate.
// Arc gas is USDC (18-decimal native); convert to 6-decimal for display.

export const GAS_LIMITS = {
  approve:     50_000n,
  createPot:  175_000n,
  deposit:    205_000n,
  withdraw:    76_000n,
  claimPayout: 93_000n,
} as const

export type GasAction = keyof typeof GAS_LIMITS

// Convert 18-decimal native USDC gas to 6-decimal display USDC.
// gasCost18 = gasUnits * gasPriceWei  (in 18-decimal native USDC)
// USDC6     = gasCost18 / 1e12
export function gasToUsdc6(gasUnits: bigint, gasPriceWei: bigint): bigint {
  return (gasUnits * gasPriceWei) / 1_000_000_000_000n
}

export function estimatedGasUsdc6(action: GasAction, gasPriceWei: bigint): bigint {
  return (gasToUsdc6(GAS_LIMITS[action], gasPriceWei) * 13n) / 10n
}
