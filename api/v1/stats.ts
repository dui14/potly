/**
 * GET /api/v1/stats
 *
 * Calls the Supabase RPC proof_stats(p_chain, p_contract) and returns
 * aggregate statistics. Intended for the ProofStrip component.
 * Cache-Control: public, s-maxage=60, stale-while-revalidate=120
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { POTLY_ADDRESS, CHAIN_ID, sbRpc } from '../_shared'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' })
  try {
    if (!POTLY_ADDRESS) return res.status(503).json({ ok: false, error: 'Contract not configured' })

    const rows = await sbRpc('proof_stats', {
      p_chain:    CHAIN_ID,
      p_contract: POTLY_ADDRESS,
    }) as { pots: string; paid: string; settled: string; fees: string }[]

    const row = rows?.[0] ?? { pots: '0', paid: '0', settled: '0', fees: '0' }
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
    return res.status(200).json({
      ok:        true,
      pots:      row.pots,
      paid:      row.paid,
      settled:   row.settled,
      fees:      row.fees,
    })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
