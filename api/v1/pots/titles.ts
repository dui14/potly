/**
 * GET /api/v1/pots/titles?chain=<chainId>&ids=1,2,3
 *
 * Returns { ok, titles: { [potId]: string } } from pot_metadata in one
 * "in" query. Validates every id; rejects the request if chain != CHAIN_ID.
 * Cache-Control: s-maxage=60 (titles rarely change).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CHAIN_ID, POTLY_ADDRESS, SB_URL, SB_KEY, sbGet } from '../../_shared'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' })

  const chainParam = Number(req.query.chain)
  if (chainParam !== CHAIN_ID) return res.status(400).json({ ok: false, error: 'Wrong chain' })

  const idsParam = req.query.ids as string | undefined
  if (!idsParam) return res.status(200).json({ ok: true, titles: {} })

  // Validate: only digits + commas
  if (!/^[0-9,]+$/.test(idsParam)) return res.status(400).json({ ok: false, error: 'Invalid ids' })

  const ids = [...new Set(
    idsParam.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => isFinite(n) && n > 0),
  )]
  if (ids.length === 0) return res.status(200).json({ ok: true, titles: {} })
  if (ids.length > 50)  return res.status(400).json({ ok: false, error: 'Too many ids (max 50)' })

  if (!SB_URL || !SB_KEY) return res.status(503).json({ ok: false, error: 'Supabase not configured' })
  if (!POTLY_ADDRESS)      return res.status(503).json({ ok: false, error: 'Contract not configured' })

  try {
    const rows = await sbGet(
      `/pot_metadata?chain_id=eq.${CHAIN_ID}&contract_address=eq.${POTLY_ADDRESS}` +
      `&pot_id=in.(${ids.join(',')})&select=pot_id,title`,
    ) as { pot_id: string | number; title: string }[]

    const titles: Record<string, string> = {}
    for (const r of rows) titles[String(r.pot_id)] = r.title ?? ''

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    return res.status(200).json({ ok: true, titles })
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Internal error' })
  }
}
