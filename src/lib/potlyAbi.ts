// Auto-generated from contracts/out/Potly.sol/Potly.json — v2
// Do not edit manually — re-copy from the artifact after a forge build.

export const POTLY_ABI = [
  // ── Constructor ────────────────────────────────────────────────────────────
  {
    type: 'constructor',
    inputs: [
      { name: '_usdc',        type: 'address' },
      { name: '_treasury',    type: 'address' },
      { name: '_feeBps',      type: 'uint16'  },
      { name: '_maxPotTotal', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  // ── Mutating functions ─────────────────────────────────────────────────────
  {
    type: 'function', name: 'createPot',
    inputs: [
      { name: 'recipient',       type: 'address' },
      { name: 'target',          type: 'uint256' },
      { name: 'slots',           type: 'uint256' },
      { name: 'durationSeconds', type: 'uint256' },
      { name: 'metadataHash',    type: 'bytes32' },
    ],
    outputs: [{ name: 'potId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'deposit',
    inputs: [{ name: 'potId', type: 'uint256' }, { name: 'amount', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'withdraw',
    inputs: [{ name: 'potId', type: 'uint256' }, { name: 'amount', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'cancel',
    inputs: [{ name: 'potId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'claimPayout',
    inputs: [{ name: 'potId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'sweepUnaccounted',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // ── View functions ─────────────────────────────────────────────────────────
  {
    type: 'function', name: 'getPot',
    inputs: [{ name: 'potId', type: 'uint256' }],
    outputs: [{
      name: '', type: 'tuple',
      components: [
        { name: 'creator',      type: 'address' },
        { name: 'recipient',    type: 'address' },
        { name: 'target',       type: 'uint256' },
        { name: 'raised',       type: 'uint256' },
        { name: 'slots',        type: 'uint256' },
        { name: 'contributors', type: 'uint256' },
        { name: 'deadline',     type: 'uint256' },
        { name: 'filledAt',     type: 'uint256' },
        { name: 'status',       type: 'uint8'   },
        { name: 'metadataHash', type: 'bytes32' },
      ],
    }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'contributionOf',
    inputs: [{ name: 'potId', type: 'uint256' }, { name: 'who', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'remaining',
    inputs: [{ name: 'potId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'claimDeadline',
    inputs: [{ name: 'potId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'isRefundable',
    inputs: [{ name: 'potId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'potCount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'totalLocked',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'usdc',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'treasury',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'feeBps',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'maxPotTotal',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  // ── Events ─────────────────────────────────────────────────────────────────
  {
    type: 'event', name: 'PotCreated',
    inputs: [
      { name: 'potId',        type: 'uint256', indexed: true  },
      { name: 'creator',      type: 'address', indexed: true  },
      { name: 'recipient',    type: 'address', indexed: true  },
      { name: 'target',       type: 'uint256', indexed: false },
      { name: 'slots',        type: 'uint256', indexed: false },
      { name: 'deadline',     type: 'uint256', indexed: false },
      { name: 'metadataHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Deposited',
    inputs: [
      { name: 'potId',     type: 'uint256', indexed: true  },
      { name: 'depositor', type: 'address', indexed: true  },
      { name: 'amount',    type: 'uint256', indexed: false },
      { name: 'raised',    type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'PotFilled',
    inputs: [
      { name: 'potId',    type: 'uint256', indexed: true  },
      { name: 'filledAt', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Withdrawn',
    inputs: [
      { name: 'potId',     type: 'uint256', indexed: true  },
      { name: 'depositor', type: 'address', indexed: true  },
      { name: 'amount',    type: 'uint256', indexed: false },
      { name: 'raised',    type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'PotCancelled',
    inputs: [{ name: 'potId', type: 'uint256', indexed: true }],
  },
  {
    type: 'event', name: 'PayoutClaimed',
    inputs: [
      { name: 'potId',     type: 'uint256', indexed: true  },
      { name: 'recipient', type: 'address', indexed: true  },
      { name: 'payout',    type: 'uint256', indexed: false },
      { name: 'fee',       type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event', name: 'Swept',
    inputs: [
      { name: 'by',     type: 'address', indexed: true  },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  // ── Custom errors ──────────────────────────────────────────────────────────
  { type: 'error', name: 'ZeroAddress',              inputs: [] },
  { type: 'error', name: 'NoCode',                   inputs: [{ name: 'target_', type: 'address' }] },
  { type: 'error', name: 'FeeTooHigh',               inputs: [{ name: 'bps', type: 'uint16' }] },
  { type: 'error', name: 'InvalidSlots',             inputs: [{ name: 'slots', type: 'uint256' }] },
  { type: 'error', name: 'InvalidDuration',          inputs: [{ name: 'duration', type: 'uint256' }] },
  { type: 'error', name: 'TargetTooSmall',           inputs: [{ name: 'target_', type: 'uint256' }] },
  { type: 'error', name: 'TargetExceedsMax',         inputs: [{ name: 'target_', type: 'uint256' }, { name: 'max', type: 'uint256' }] },
  { type: 'error', name: 'InvalidRecipient',         inputs: [] },
  { type: 'error', name: 'PotNotOpen',               inputs: [{ name: 'potId', type: 'uint256' }, { name: 'status', type: 'uint8' }] },
  { type: 'error', name: 'PotNotFilled',             inputs: [{ name: 'potId', type: 'uint256' }, { name: 'status', type: 'uint8' }] },
  { type: 'error', name: 'DeadlinePassed',           inputs: [{ name: 'potId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  { type: 'error', name: 'PotFull',                  inputs: [{ name: 'potId', type: 'uint256' }] },
  { type: 'error', name: 'AmountBelowMin',           inputs: [{ name: 'amount', type: 'uint256' }, { name: 'min', type: 'uint256' }] },
  { type: 'error', name: 'ZeroAmount',               inputs: [] },
  { type: 'error', name: 'AmountExceedsContribution',inputs: [{ name: 'amount', type: 'uint256' }, { name: 'contribution', type: 'uint256' }] },
  { type: 'error', name: 'NoContribution',           inputs: [{ name: 'potId', type: 'uint256' }, { name: 'caller', type: 'address' }] },
  { type: 'error', name: 'NotRefundable',            inputs: [{ name: 'potId', type: 'uint256' }] },
  { type: 'error', name: 'NotCreator',               inputs: [{ name: 'potId', type: 'uint256' }, { name: 'caller', type: 'address' }] },
  { type: 'error', name: 'ClaimWindowClosed',        inputs: [{ name: 'potId', type: 'uint256' }] },
  { type: 'error', name: 'NothingToSweep',           inputs: [] },
  { type: 'error', name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'ReentrancyGuardReentrantCall', inputs: [] },
] as const
