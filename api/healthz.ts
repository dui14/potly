import type { VercelRequest, VercelResponse } from '@vercel/node'

// GET /api/healthz
// Returns { ok, ts } plus a boolean for each env var the API reads.
// Reports presence only — never prints values.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    res.status(200).json({
      ok: true,
      ts: Date.now(),
      env: {
        SUPABASE_URL:              !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        POTLY_ADDRESS:             !!process.env.POTLY_ADDRESS,
        ARC_NETWORK:               !!process.env.ARC_NETWORK,
        ARC_RPC_URL:               !!process.env.ARC_RPC_URL,
      },
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}
