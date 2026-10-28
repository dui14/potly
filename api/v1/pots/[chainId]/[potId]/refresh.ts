/**
 * POST /api/v1/pots/:chainId/:potId/refresh
 *
 * Delegates to the global indexer tick so there is one scanning code path.
 * The per-pot refresh route is kept for backwards compatibility with any
 * existing client calls.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' })
  try {
    // Forward to the global tick — same host, internal fetch
    const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'
    const tickRes = await fetch(`${base}/api/v1/index/tick`, { method: 'POST' })
    const body = await tickRes.json()
    return res.status(tickRes.ok ? 200 : 500).json(body)
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
