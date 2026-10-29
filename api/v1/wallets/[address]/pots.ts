/**
 * GET /api/v1/wallets/:address/pots?limit=6&before=<block>:<potId>
 *
 * Calls my_pot_ids RPC (keyset pagination via p_before_block + p_before_pot).
 * Returns { ok, potIds, hasMore, nextCursor, source }.
 * Cache-Control: no-store (per-user, freshness-critical).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { POTLY_ADDRESS, CHAIN_ID, SB_URL, SB_KEY, sbRpc, validateAddress } from '../../../_shared'

const DEFAULT_LIMIT = 6
const MAX_LIMIT     = 50

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' })

  try {
    const rawAddr = req.query.address as string
    const wallet  = validateAddress(rawAddr)
    if (!wallet)        return res.status(400).json({ ok: false, error: 'Invalid address' })
    if (!POTLY_ADDRESS) return res.status(503).json({ ok: false, error: 'Contract not configured' })
    if (!SB_URL || !SB_KEY) return res.status(503).json({ ok: false, error: 'Supabase not configured' })

    const rawLimit = Number(req.query.limit ?? DEFAULT_LIMIT)
    const limit    = Math.min(Math.max(1, isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT), MAX_LIMIT)

    // Keyset cursor: before=<last_block>:<last_pot_id>
    let beforeBlock: number | null = null
    let beforePot:   number | null = null
    const beforeParam = req.query.before as string | undefined
    if (beforeParam) {
      const [bl, pt] = beforeParam.split(':').map(Number)
      if (isFinite(bl) && isFinite(pt)) { beforeBlock = bl; beforePot = pt }
    }

    const rows = await sbRpc('my_pot_ids', {
      p_chain:        CHAIN_ID,
      p_contract:     POTLY_ADDRESS,
      p_wallet:       wallet,
      p_limit:        limit + 1,   // fetch one extra to detect hasMore
      p_before_block: beforeBlock,
      p_before_pot:   beforePot,
    }) as { pot_id: string; last_block: string }[]

    const hasMore    = rows.length > limit
    const page       = hasMore ? rows.slice(0, limit) : rows
    const potIds     = page.map(r => r.pot_id)
    const last       = page[page.length - 1]
    const nextCursor = last ? `${last.last_block}:${last.pot_id}` : null

    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, potIds, hasMore, nextCursor, source: 'index' })
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
