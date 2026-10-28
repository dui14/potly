/**
 * GET /api/v1/wallets/:address/pots
 *
 * Calls the Supabase RPC my_pot_ids(p_chain, p_contract, p_wallet, p_limit)
 * and returns the pot ids as strings.
 * Cache-Control: public, s-maxage=10, stale-while-revalidate=30
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { POTLY_ADDRESS, CHAIN_ID, sbRpc, validateAddress } from '../../../_shared'

const DEFAULT_LIMIT = 200

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' })

  try {
    const rawAddress = req.query.address as string
    const wallet = validateAddress(rawAddress)
    if (!wallet) return res.status(400).json({ ok: false, error: 'Invalid address' })
    if (!POTLY_ADDRESS) return res.status(503).json({ ok: false, error: 'Contract not configured' })

    const rows = await sbRpc('my_pot_ids', {
      p_chain:    CHAIN_ID,
      p_contract: POTLY_ADDRESS,
      p_wallet:   wallet,
      p_limit:    DEFAULT_LIMIT,
    }) as { pot_id: string; last_block: string }[]

    res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30')
    return res.status(200).json({
      ok: true,
      potIds: (rows ?? []).map(r => r.pot_id),
    })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
