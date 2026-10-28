import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sbGet, POTLY_ADDRESS, CHAIN_ID, makeClient, POTLY_DEPLOY_BLOCK } from './_shared'

const SB_URL = process.env.SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// GET /api/healthz
// Returns { ok, ts, env, indexer } — presence only, never values.
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    // Indexer lag (best-effort)
    let indexer: { scannedTo: number; lagBlocks: number } | null = null
    try {
      const [cursorRows, client] = await Promise.all([
        SB_URL && SB_KEY
          ? sbGet(`/pot_scan_state?chain_id=eq.${CHAIN_ID}&contract_address=eq.${POTLY_ADDRESS}&pot_id=eq.-1&select=scanned_to&limit=1`)
              .catch(() => null)
          : Promise.resolve(null),
        Promise.resolve(makeClient()),
      ])
      const head = await client.getBlockNumber().catch(() => null)
      const scannedTo = cursorRows
        ? BigInt((cursorRows as { scanned_to: string }[])[0]?.scanned_to ?? POTLY_DEPLOY_BLOCK)
        : POTLY_DEPLOY_BLOCK
      if (head !== null) {
        indexer = {
          scannedTo: Number(scannedTo),
          lagBlocks: Number(head > scannedTo ? head - scannedTo : 0n),
        }
      }
    } catch { /* indexer info optional */ }

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
      indexer,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}
