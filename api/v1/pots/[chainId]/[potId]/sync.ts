// arc-studio-allow-onchain-literal
/**
 * POST /api/v1/pots/:chainId/:potId/sync  { txHash }
 *   Reads the receipt, decodes logs for the configured Potly contract
 *   (only logs for this potId), upserts pot_events idempotently.
 *   Idempotent: duplicate (chain_id, tx_hash, log_index) is ignored.
 *
 * GET  /api/v1/pots/:chainId/:potId/activity
 *   Returns up to 200 pot_events for this pot in block order,
 *   selecting only needed columns, plus one "in" alias map query.
 *   Cache-Control: public, s-maxage=10, stale-while-revalidate=30
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  POTLY_ADDRESS, CHAIN_ID,
  sbGet, sbPost,
  decodeReceiptLogs,
  type DecodedEvent,
} from '../../../../_shared'

const SB_URL = process.env.SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function getAliasMap(wallets: string[]): Promise<Record<string, string>> {
  if (!SB_URL || !SB_KEY || wallets.length === 0) return {}
  try {
    const lower = [...new Set(wallets.map(w => w.toLowerCase()))]
    const inClause = lower.map(w => `"${w}"`).join(',')
    const rows = await sbGet(
      `/profiles?wallet_address=in.(${inClause})&select=wallet_address,alias`,
    ) as { wallet_address: string; alias: string }[]
    const map: Record<string, string> = {}
    for (const r of rows) map[r.wallet_address] = r.alias
    return map
  } catch { return {} }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { chainId, potId } = req.query as { chainId: string; potId: string }
    const chainIdN = Number(chainId)
    const potIdN   = BigInt(potId)

    if (!POTLY_ADDRESS) return res.status(503).json({ ok: false, error: 'Contract not configured' })
    // Reject if this request is for a different chain
    if (chainIdN !== CHAIN_ID) return res.status(400).json({ ok: false, error: 'Wrong chain' })

    // ── GET activity ────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (!SB_URL || !SB_KEY) return res.status(503).json({ ok: false, error: 'Supabase not configured' })

      // Pagination params: limit (default 20, max 100), before=<blockNumber>:<logIndex>
      const rawLimit = Number(req.query.limit ?? 20)
      const limit    = Math.min(Math.max(1, isFinite(rawLimit) ? rawLimit : 20), 100)
      const fetch1   = limit + 1   // fetch one extra to detect hasMore

      let beforeFilter = ''
      const beforeParam = req.query.before as string | undefined
      if (beforeParam) {
        const [bn, li] = beforeParam.split(':').map(Number)
        if (isFinite(bn) && isFinite(li)) {
          // Events strictly before this (block_number, log_index) — newest-first
          beforeFilter = `&or=(block_number.lt.${bn},and(block_number.eq.${bn},log_index.lt.${li}))`
        }
      }

      const events = await sbGet(
        `/pot_events?chain_id=eq.${chainIdN}&contract_address=eq.${POTLY_ADDRESS}&pot_id=eq.${potIdN.toString()}` +
        `&select=kind,wallet,actor,amount,raised_after,extra,tx_hash,block_number,block_time,log_index` +
        `&order=block_number.desc,log_index.desc&limit=${fetch1}${beforeFilter}`,
      ) as { wallet: string }[]

      const hasMore  = events.length > limit
      const page     = hasMore ? events.slice(0, limit) : events
      const wallets  = [...new Set(page.map((e: { wallet: string }) => e.wallet).filter(Boolean))]
      const aliases  = await getAliasMap(wallets)

      res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30')
      return res.status(200).json({ ok: true, events: page, hasMore, aliases })
    }

    // ── POST sync ───────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      if (!SB_URL || !SB_KEY) return res.status(503).json({ ok: false, error: 'Supabase not configured' })
      const { txHash } = req.body as { txHash?: string }
      if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return res.status(400).json({ ok: false, error: 'Missing or invalid txHash' })
      }

      const decoded = await decodeReceiptLogs(txHash as `0x${string}`, POTLY_ADDRESS, potIdN)
      if (decoded.length > 0) {
        await sbPost('/pot_events', decoded.map((e: DecodedEvent) => ({
          chain_id:         chainIdN,
          contract_address: POTLY_ADDRESS,
          pot_id:           potIdN.toString(),
          ...e,
          extra:            JSON.stringify(e.extra),
        })))
      }
      return res.status(200).json({ ok: true, inserted: decoded.length })
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) })
  }
}
