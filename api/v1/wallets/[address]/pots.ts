/**
 * GET /api/v1/wallets/:address/pots
 *
 * Primary: calls the Supabase RPC my_pot_ids(p_chain, p_contract, p_wallet, p_limit).
 * Fallback: when Supabase is unconfigured or returns an empty list, multicalls the
 *   newest min(potCount, 100) pots from the chain and keeps those where the wallet
 *   is creator, recipient, or has a non-zero contribution.
 *
 * Cache-Control: public, s-maxage=10, stale-while-revalidate=30
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { POTLY_ADDRESS, CHAIN_ID, sbRpc, validateAddress, makeClient } from '../../../_shared'

const DEFAULT_LIMIT = 200
const FALLBACK_SCAN_LIMIT = 100  // never scan more than this many pots via RPC
const MAX_PAGE_SIZE = 50

// Minimal ABI slices needed for the fallback multicall
const POT_ABI = [
  { type: 'function', name: 'potCount',       inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getPot',         inputs: [{ name: 'potId', type: 'uint256' }], outputs: [{ name: '', type: 'tuple', components: [{ name: 'creator', type: 'address' }, { name: 'recipient', type: 'address' }, { name: 'target', type: 'uint256' }, { name: 'raised', type: 'uint256' }, { name: 'slots', type: 'uint256' }, { name: 'contributors', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'filledAt', type: 'uint256' }, { name: 'status', type: 'uint8' }, { name: 'metadataHash', type: 'bytes32' }] }], stateMutability: 'view' },
  { type: 'function', name: 'contributionOf', inputs: [{ name: 'potId', type: 'uint256' }, { name: 'wallet', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const

async function fallbackChainScan(wallet: string): Promise<string[]> {
  if (!POTLY_ADDRESS) return []
  const addr = POTLY_ADDRESS as `0x${string}`
  const client = makeClient()

  // 1. Read potCount
  const count = await client.readContract({ address: addr, abi: POT_ABI, functionName: 'potCount' }) as bigint
  if (count === 0n) return []

  // 2. Build list of pot ids to scan: newest FALLBACK_SCAN_LIMIT pots
  const scanCount = count < BigInt(FALLBACK_SCAN_LIMIT) ? Number(count) : FALLBACK_SCAN_LIMIT
  const potIds: bigint[] = []
  for (let i = 0; i < scanCount; i++) {
    potIds.push(count - BigInt(i))
  }

  // 3. Multicall getPot for all ids
  const potCalls = potIds.map(id => ({
    address: addr,
    abi:     POT_ABI,
    functionName: 'getPot' as const,
    args:    [id] as [bigint],
  }))

  const potResults = await client.multicall({ contracts: potCalls, allowFailure: true })

  // 4. Find pots where wallet is creator or recipient
  const walletL = wallet.toLowerCase()
  const directMatches = new Set<string>()
  const toCheckContrib: bigint[] = []

  for (let i = 0; i < potResults.length; i++) {
    const r = potResults[i]
    if (r.status !== 'success' || !r.result) continue
    const pot = r.result as { creator: string; recipient: string }
    if (pot.creator.toLowerCase() === walletL || pot.recipient.toLowerCase() === walletL) {
      directMatches.add(potIds[i].toString())
    } else {
      toCheckContrib.push(potIds[i])
    }
  }

  // 5. Multicall contributionOf for pots where wallet is neither creator nor recipient
  const contribCalls = toCheckContrib.map(id => ({
    address: addr,
    abi:     POT_ABI,
    functionName: 'contributionOf' as const,
    args:    [id, walletL as `0x${string}`] as [bigint, `0x${string}`],
  }))

  if (contribCalls.length > 0) {
    const contribResults = await client.multicall({ contracts: contribCalls, allowFailure: true })
    for (let i = 0; i < contribResults.length; i++) {
      const r = contribResults[i]
      if (r.status === 'success' && r.result && (r.result as bigint) > 0n) {
        directMatches.add(toCheckContrib[i].toString())
      }
    }
  }

  // Return in descending order (newest first)
  return [...directMatches].sort((a, b) => Number(BigInt(b) - BigInt(a)))
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' })

  try {
    const rawAddress = req.query.address as string
    const wallet = validateAddress(rawAddress)
    if (!wallet) return res.status(400).json({ ok: false, error: 'Invalid address' })
    if (!POTLY_ADDRESS) return res.status(503).json({ ok: false, error: 'Contract not configured' })

    // Pagination: offset (0-based) and limit (default 6, max 50)
    const rawOffset = Number(req.query.offset ?? 0)
    const rawLimit  = Number(req.query.limit  ?? 6)
    const offset    = isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0
    const limit     = Math.min(Math.max(1, isFinite(rawLimit) ? Math.floor(rawLimit) : 6), MAX_PAGE_SIZE)
    // Fetch one extra to detect hasMore
    const fetchN    = offset + limit + 1

    const SB_URL = process.env.SUPABASE_URL
    const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

    let allPotIds: string[] = []
    let source: 'index' | 'chain' = 'index'

    // ── Primary: Supabase index ──────────────────────────────────────────────
    if (SB_URL && SB_KEY) {
      try {
        const rows = await sbRpc('my_pot_ids', {
          p_chain:    CHAIN_ID,
          p_contract: POTLY_ADDRESS,
          p_wallet:   wallet,
          p_limit:    DEFAULT_LIMIT,
        }) as { pot_id: string; last_block: string }[]
        allPotIds = (rows ?? []).map(r => r.pot_id)
      } catch (sbErr) {
        // Supabase error — fall through to chain scan below
        void sbErr
      }
    }

    // ── Fallback: bounded chain scan ─────────────────────────────────────────
    if (allPotIds.length === 0) {
      try {
        allPotIds = await fallbackChainScan(wallet)
        source = 'chain'
      } catch {
        res.setHeader('Cache-Control', 'no-store')
        return res.status(200).json({ ok: true, potIds: [], hasMore: false, total: 0, source: 'error', note: 'Both index and chain scan failed' })
      }
    }

    // Apply pagination
    const total   = allPotIds.length
    const page    = allPotIds.slice(offset, fetchN)
    const hasMore = page.length > limit
    const potIds  = hasMore ? page.slice(0, limit) : page

    // no-store: wallet pot lists are per-user and must never be edge-cached.
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, potIds, hasMore, total, offset, limit, source })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
