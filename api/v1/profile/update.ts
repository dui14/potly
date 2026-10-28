/**
 * PUT /api/v1/profile/update
 * Body: { oldAlias, newAlias, address, issuedAt, signature }
 *
 * Rules:
 * - Signed message verified with viem verifyMessage.
 * - issuedAt within 5 minutes.
 * - newAlias not in alias_history for a different wallet within 30 days.
 * - newAlias not already taken.
 * - At most one alias change per wallet per hour.
 * - On success: write oldAlias to alias_history, set updated_at.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyMessage, isAddress } from 'viem'

const ALIAS_RE       = /^[a-z0-9_]{3,20}$/
const RESERVED       = new Set(['admin', 'support', 'potly', 'treasury', 'arc', 'circle', 'usdc', 'official'])
const SB_URL         = process.env.SUPABASE_URL
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY

async function sbFetch(path: string, method: string, body?: unknown) {
  if (!SB_URL || !SERVICE_KEY) throw new Error('Supabase not configured')
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=minimal' : method === 'PATCH' ? 'return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (method === 'GET') return res.json()
  return res
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PUT') return res.status(405).json({ ok: false, error: 'Method not allowed' })
  try {
    const { oldAlias, newAlias, address, issuedAt, signature } = req.body as {
      oldAlias?: string; newAlias?: string; address?: string; issuedAt?: string; signature?: string
    }

    if (!oldAlias || !newAlias || !address || !issuedAt || !signature)
      return res.status(400).json({ ok: false, error: 'Missing fields' })
    if (!isAddress(address))
      return res.status(400).json({ ok: false, error: 'Invalid address' })
    const newLcN = newAlias.trim().toLowerCase()
    if (!ALIAS_RE.test(newLcN))
      return res.status(400).json({ ok: false, error: 'Alias must be 3-20 characters: a-z, 0-9 or underscore' })
    if (RESERVED.has(newLcN))
      return res.status(400).json({ ok: false, error: 'That alias is reserved' })
    if (oldAlias.toLowerCase() === newLcN)
      return res.status(400).json({ ok: false, error: 'New alias must differ from old alias' })

    // issuedAt within 5 minutes
    const issued = new Date(issuedAt).getTime()
    if (isNaN(issued) || Date.now() - issued > 5 * 60_000)
      return res.status(400).json({ ok: false, error: 'issuedAt is too old (max 5 minutes)' })

    // Verify signature
    const message = `Potly alias update\nOld: ${oldAlias.toLowerCase()}\nNew: ${newLcN}\nWallet: ${address}\nIssued: ${issuedAt}`
    const valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` }).catch(() => false)
    if (!valid) return res.status(400).json({ ok: false, error: 'Invalid signature' })

    const lc = address.toLowerCase()

    // Check current profile owns oldAlias
    const profiles = await sbFetch(`/profiles?wallet_address=eq.${lc}&select=alias,updated_at&limit=1`, 'GET') as { alias: string; updated_at: string | null }[]
    if (!profiles.length || profiles[0].alias.toLowerCase() !== oldAlias.toLowerCase())
      return res.status(400).json({ ok: false, error: 'Old alias does not match current alias' })

    // Rate limit: 1 change per hour
    if (profiles[0].updated_at) {
      const last = new Date(profiles[0].updated_at).getTime()
      if (Date.now() - last < 3_600_000)
        return res.status(429).json({ ok: false, error: 'At most one alias change per hour' })
    }

    // New alias not taken
    const existing = await sbFetch(`/profiles?alias=eq.${encodeURIComponent(newLcN)}&select=wallet_address&limit=1`, 'GET') as { wallet_address: string }[]
    if (existing.length > 0 && existing[0].wallet_address !== lc)
      return res.status(409).json({ ok: false, error: 'Alias is already taken' })

    // New alias not in alias_history for a different wallet within 30 days
    const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const hist = await sbFetch(`/alias_history?alias=eq.${encodeURIComponent(newLcN)}&released_at=gte.${since30}&select=wallet_address&limit=1`, 'GET') as { wallet_address: string }[]
    if (hist.length > 0 && hist[0].wallet_address !== lc)
      return res.status(409).json({ ok: false, error: 'Alias recently used by another wallet' })

    // Write old alias to alias_history
    await sbFetch('/alias_history', 'POST', { wallet_address: lc, alias: oldAlias.toLowerCase(), released_at: new Date().toISOString() })

    // Update profile
    await sbFetch(`/profiles?wallet_address=eq.${lc}`, 'PATCH', {
      alias: newLcN,
      updated_at: new Date().toISOString(),
    })

    return res.status(200).json({ ok: true, alias: newLcN })
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}
