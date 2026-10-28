/**
 * POST /api/v1/profile
 * Body: { alias, address, issuedAt, signature }
 *
 * Verifies the wallet signature over the fixed message template, checks
 * issuedAt is within 5 minutes, then inserts into public.profiles using
 * the service-role key (only accessible server-side via SUPABASE_SERVICE_ROLE_KEY).
 *
 * IMPORTANT: SUPABASE_SERVICE_ROLE_KEY is NEVER referenced in src/ — only here.
 * Never print or log it.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyMessage, isAddress } from 'viem'

const ALIAS_RE = /^[a-z0-9_]{3,20}$/
const RESERVED = new Set(['admin', 'support', 'potly', 'treasury', 'arc', 'circle', 'usdc', 'official'])

const SUPABASE_URL       = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY

async function sbAdminFetch(path: string, body: unknown): Promise<{ error?: { code?: string; message?: string } }> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('Supabase not configured server-side')
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (res.status === 201 || res.status === 204) return {}
  const json = await res.json().catch(() => ({})) as { code?: string; message?: string }
  return { error: json }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  const { alias, address, issuedAt, signature } = req.body as {
    alias?: string; address?: string; issuedAt?: string; signature?: string
  }

  // Validate inputs — normalize first
  const aliasLc = (alias ?? '').trim().toLowerCase()
  if (!aliasLc || !ALIAS_RE.test(aliasLc))
    return res.status(400).json({ error: 'Alias must be 3-20 characters: a-z, 0-9 or underscore' })
  if (RESERVED.has(aliasLc))
    return res.status(400).json({ error: 'That alias is reserved' })
  if (!address || !isAddress(address))
    return res.status(400).json({ error: 'Invalid address' })
  if (!issuedAt || !signature)
    return res.status(400).json({ error: 'Missing issuedAt or signature' })

  // Check issuedAt within 5 minutes
  const issued = new Date(issuedAt).getTime()
  if (isNaN(issued) || Date.now() - issued > 5 * 60 * 1000)
    return res.status(400).json({ error: 'issuedAt is too old (max 5 minutes)' })

  // Verify signature
  const message = `Potly alias claim\nAlias: ${aliasLc}\nWallet: ${address}\nIssued: ${issuedAt}`
  const valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` })
    .catch(() => false)
  if (!valid) return res.status(400).json({ error: 'Invalid signature' })

  // Insert
  const { error } = await sbAdminFetch('/profiles', {
    wallet_address: address.toLowerCase(),
    alias: aliasLc,
  })

  if (error) {
    const code = error.code ?? ''
    console.error(`[profile POST] pg=${code}`)
    if (code === '23505') {
      const msg = (error.message ?? '').toLowerCase()
      if (msg.includes('alias')) return res.status(409).json({ error: 'Alias is already taken' })
      if (msg.includes('wallet')) return res.status(409).json({ error: 'This wallet already has an alias' })
      return res.status(409).json({ error: 'Alias is already taken' })
    }
    if (code === '23514') return res.status(400).json({ error: 'That alias is not allowed' })
    return res.status(500).json({ error: `Request failed (code: ${code || 'unknown'})` })
  }

  return res.status(201).json({ ok: true, alias: aliasLc })
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}
