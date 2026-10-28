// arc-studio-allow-onchain-literal
/**
 * Shared helpers for all API route handlers.
 * Pure functions — no side effects, no imports from @vercel/node.
 */
import { createPublicClient, http, fallback, decodeEventLog } from 'viem'
import { arcTestnet, arc } from 'viem/chains'

// ── Env ──────────────────────────────────────────────────────────────────────
export const POTLY_ADDRESS      = (process.env.POTLY_ADDRESS      ?? '').toLowerCase()
export const ARC_NETWORK        = process.env.ARC_NETWORK         ?? 'testnet'
export const ARC_RPC_URL        = process.env.ARC_RPC_URL
export const POTLY_DEPLOY_BLOCK = BigInt(process.env.POTLY_DEPLOY_BLOCK ?? '0')
export const SB_URL             = process.env.SUPABASE_URL
export const SB_KEY             = process.env.SUPABASE_SERVICE_ROLE_KEY
export const CHAIN              = ARC_NETWORK === 'mainnet' ? arc : arcTestnet
export const CHAIN_ID           = ARC_NETWORK === 'mainnet' ? arc.id : arcTestnet.id

const MAINNET_RPCS = [
  'https://rpc.mainnet.arc.io',
  'https://rpc.drpc.mainnet.arc.io',
  'https://arc-rpc.publicnode.com',
  'https://rpc.beamrpc.com',
]
const TESTNET_RPCS = ['https://rpc.testnet.arc.io']

export function makeClient() {
  const rpcs = ARC_NETWORK === 'mainnet' ? MAINNET_RPCS : TESTNET_RPCS
  const urls = ARC_RPC_URL ? [ARC_RPC_URL, ...rpcs] : rpcs
  return createPublicClient({ chain: CHAIN, transport: fallback(urls.map(u => http(u))) })
}

// ── Supabase helpers ─────────────────────────────────────────────────────────
export async function sbGet(path: string): Promise<unknown> {
  if (!SB_URL || !SB_KEY) throw new Error('Supabase not configured')
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' },
  })
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Supabase ${res.status}: ${t}`) }
  return res.json()
}

export async function sbPost(path: string, body: unknown): Promise<void> {
  if (!SB_URL || !SB_KEY) throw new Error('Supabase not configured')
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(body),
  })
  // PostgREST returns 201 on insert, 204 on empty result-set, and 200 on
  // conflict-ignored rows (resolution=ignore-duplicates with return=minimal).
  // Treat all three as success; anything else is a real error.
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    const t = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${t}`)
  }
}

export async function sbRpc(fn: string, params: Record<string, unknown>): Promise<unknown> {
  if (!SB_URL || !SB_KEY) throw new Error('Supabase not configured')
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Supabase rpc/${fn} ${res.status}: ${t}`) }
  return res.json()
}

export async function sbUpsert(table: string, path: string, body: unknown, onConflict: string): Promise<void> {
  if (!SB_URL || !SB_KEY) throw new Error('Supabase not configured')
  const res = await fetch(`${SB_URL}/rest/v1/${table}${path}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json',
      Prefer: `resolution=merge-duplicates,return=minimal`,
    },
    body: JSON.stringify(body),
  })
  void onConflict  // used by caller for documentation only; Prefer header handles it
  // PostgREST returns 200/201/204 on successful upserts depending on version and return mode.
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    const t = await res.text().catch(() => '')
    throw new Error(`Supabase upsert ${res.status}: ${t}`)
  }
}

// ── Event ABI ────────────────────────────────────────────────────────────────
export const EVENT_ABI = [
  { type: 'event', name: 'PotCreated',    inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'target', type: 'uint256' }, { name: 'slots', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'metadataHash', type: 'bytes32' }] },
  { type: 'event', name: 'Deposited',     inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'depositor', type: 'address', indexed: true }, { name: 'accepted', type: 'uint256' }, { name: 'raised', type: 'uint256' }] },
  { type: 'event', name: 'Withdrawn',     inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'depositor', type: 'address', indexed: true }, { name: 'amount', type: 'uint256' }, { name: 'raised', type: 'uint256' }] },
  { type: 'event', name: 'PotFilled',     inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'filledAt', type: 'uint256' }] },
  { type: 'event', name: 'PayoutClaimed', inputs: [{ name: 'potId', type: 'uint256', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'payout', type: 'uint256' }, { name: 'fee', type: 'uint256' }] },
  { type: 'event', name: 'PotCancelled',  inputs: [{ name: 'potId', type: 'uint256', indexed: true }] },
] as const

export type EventKind = 'created' | 'deposit' | 'withdraw' | 'filled' | 'payout' | 'cancelled'

function eventKind(name: string): EventKind | null {
  switch (name) {
    case 'PotCreated':    return 'created'
    case 'Deposited':     return 'deposit'
    case 'Withdrawn':     return 'withdraw'
    case 'PotFilled':     return 'filled'
    case 'PayoutClaimed': return 'payout'
    case 'PotCancelled':  return 'cancelled'
    default:              return null
  }
}

export interface DecodedEvent {
  kind:         EventKind
  wallet:       string   // lowercase
  actor:        string   // lowercase, tx.from
  amount:       string   // USDC base units as string
  raised_after: string
  extra:        Record<string, string>
  log_index:    number
  block_number: number
  block_time:   string   // ISO 8601 — Postgres timestamptz column
  tx_hash:      string   // lowercase
}

/** Convert a chain block timestamp (unix seconds) to ISO 8601. */
export function toIso(unixSeconds: number | bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString()
}

/**
 * Map one decoded log to our event shape per spec §1.
 *   created:  wallet=creator, amount=target, extra={recipient,slots,deadline,metadataHash}
 *   deposit:  wallet=depositor, amount=accepted, raised_after
 *   withdraw: wallet=depositor, amount, raised_after
 *   filled:   wallet=the contributor who filled (from actor); amount=0
 *   payout:   wallet=recipient, actor=tx sender, amount=net payout, extra={fee}
 *   cancelled:wallet=creator (from actor)
 */
export function mapArgs(kind: EventKind, args: Record<string, unknown>, actor: string): {
  wallet: string; amount: string; raised_after: string; extra: Record<string, string>
} {
  const str = (v: unknown) => String(v ?? '0')
  switch (kind) {
    case 'created':
      return {
        wallet: str(args.creator).toLowerCase(),
        amount: str(args.target),
        raised_after: '0',
        extra: {
          recipient:    str(args.recipient).toLowerCase(),
          slots:        str(args.slots),
          deadline:     str(args.deadline),
          metadataHash: str(args.metadataHash),
        },
      }
    case 'deposit':
      return {
        wallet: str(args.depositor).toLowerCase(),
        amount: str(args.accepted),
        raised_after: str(args.raised),
        extra: {},
      }
    case 'withdraw':
      return {
        wallet: str(args.depositor).toLowerCase(),
        amount: str(args.amount),
        raised_after: str(args.raised),
        extra: {},
      }
    case 'filled':
      return { wallet: actor, amount: '0', raised_after: '0', extra: {} }
    case 'payout':
      return {
        wallet: str(args.recipient).toLowerCase(),
        amount: str(args.payout),    // net payout (spec: "net paid to recipient")
        raised_after: '0',
        extra: { fee: str(args.fee) },
      }
    case 'cancelled':
      return { wallet: actor, amount: '0', raised_after: '0', extra: {} }
  }
}

/**
 * Decode all logs from a receipt that belong to our contract and optionally
 * filter to a specific potId.  Returns DecodedEvent[].
 */
export async function decodeReceiptLogs(
  txHash: `0x${string}`,
  contractAddress: string,
  filterPotId?: bigint,
): Promise<DecodedEvent[]> {
  const client = makeClient()
  const [receipt, tx] = await Promise.all([
    client.getTransactionReceipt({ hash: txHash }),
    client.getTransaction({ hash: txHash }),
  ])
  const actor    = tx.from.toLowerCase()
  const block    = await client.getBlock({ blockNumber: receipt.blockNumber })
  const blockTime = toIso(block.timestamp)
  const blockNum  = Number(receipt.blockNumber)

  const out: DecodedEvent[] = []
  for (const log of receipt.logs) {
    if ((log.address as string).toLowerCase() !== contractAddress) continue
    try {
      const decoded = decodeEventLog({
        abi: EVENT_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      })
      const kind = eventKind(decoded.eventName as string)
      if (!kind) continue
      const args = decoded.args as Record<string, unknown>
      if (filterPotId !== undefined && args.potId !== undefined) {
        if (BigInt(String(args.potId)) !== filterPotId) continue
      }
      const { wallet, amount, raised_after, extra } = mapArgs(kind, args, actor)
      out.push({
        kind, wallet, actor, amount, raised_after, extra,
        log_index: log.logIndex ?? 0,
        block_number: blockNum,
        block_time:   blockTime,
        tx_hash:      txHash.toLowerCase(),
      })
    } catch { /* not one of our events */ }
  }
  return out
}

/**
 * Decode all logs obtained from getLogs (no tx/receipt context available —
 * actor must be fetched per tx if needed, or left as empty string).
 * Used in the indexer where we call getLogs in bulk.
 */
export async function decodeRawLog(
  log: { address: string; data: `0x${string}`; topics: readonly `0x${string}`[]; logIndex: number | null; blockNumber: bigint | null; transactionHash: `0x${string}` | null },
  contractAddress: string,
  blockTime: string,   // ISO 8601
  actor: string,
): Promise<DecodedEvent | null> {
  if ((log.address as string).toLowerCase() !== contractAddress) return null
  try {
    const decoded = decodeEventLog({
      abi: EVENT_ABI,
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    })
    const kind = eventKind(decoded.eventName as string)
    if (!kind) return null
    const args = decoded.args as Record<string, unknown>
    const { wallet, amount, raised_after, extra } = mapArgs(kind, args, actor)
    return {
      kind, wallet, actor, amount, raised_after, extra,
      log_index: log.logIndex ?? 0,
      block_number: Number(log.blockNumber ?? 0n),
      block_time: blockTime,
      tx_hash: (log.transactionHash ?? '').toLowerCase(),
    }
  } catch { return null }
}

export function isRangeErr(e: unknown) {
  const m = String((e as { message?: string })?.message ?? e).toLowerCase()
  return m.includes('block range') || m.includes('limit exceed') || m.includes('too many') || m.includes('range')
}

/** Validate and lowercase an Ethereum address string. Returns null if invalid. */
export function validateAddress(s: string | undefined | null): string | null {
  if (!s || !/^0x[0-9a-fA-F]{40}$/.test(s)) return null
  return s.toLowerCase()
}
