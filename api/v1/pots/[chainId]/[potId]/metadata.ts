/**
 * GET  /api/v1/pots/:chainId/:potId/metadata  → { title, note }
 * POST /api/v1/pots/:chainId/:potId/metadata  → stores title/note/salt after verifying hash
 *
 * The contract is read server-side from POTLY_ADDRESS + ARC_RPC_URL.
 * SUPABASE_SERVICE_ROLE_KEY is used for writes and is never in src/.
 * The metadata hash is keccak256(abi.encode(string title, string note, bytes32 salt)).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createPublicClient, http, keccak256, encodeAbiParameters } from 'viem'
import { arcTestnet, arc } from 'viem/chains'

const POTLY_ADDRESS      = process.env.POTLY_ADDRESS as `0x${string}` | undefined
const ARC_NETWORK        = process.env.ARC_NETWORK ?? 'testnet'
const ARC_RPC_URL        = process.env.ARC_RPC_URL
const SUPABASE_URL       = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY

const CHAIN = ARC_NETWORK === 'mainnet' ? arc : arcTestnet

const GET_POT_ABI = [{
  type: 'function', name: 'getPot',
  inputs: [{ name: 'potId', type: 'uint256' }],
  outputs: [{
    name: '', type: 'tuple',
    components: [
      { name: 'creator',      type: 'address' },
      { name: 'recipient',    type: 'address' },
      { name: 'target',       type: 'uint256' },
      { name: 'raised',       type: 'uint256' },
      { name: 'slots',        type: 'uint256' },
      { name: 'contributors', type: 'uint256' },
      { name: 'deadline',     type: 'uint256' },
      { name: 'filledAt',     type: 'uint256' },
      { name: 'status',       type: 'uint8'   },
      { name: 'metadataHash', type: 'bytes32' },
    ],
  }],
  stateMutability: 'view',
}] as const

async function sbFetch(path: string, method: string, body?: unknown) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('Supabase not configured')
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (method === 'GET') return res.json()
  return { status: res.status }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { chainId, potId } = req.query as { chainId: string; potId: string }
  const chainIdN = Number(chainId)
  const potIdN   = Number(potId)
  if (!Number.isFinite(chainIdN) || !Number.isFinite(potIdN) || potIdN < 1)
    return res.status(400).json({ error: 'Invalid chainId or potId' })

  // GET
  if (req.method === 'GET') {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Metadata API not configured' })
    }
    const rows = await sbFetch(
      `/pot_metadata?chain_id=eq.${chainIdN}&contract_address=eq.${POTLY_ADDRESS?.toLowerCase()}&pot_id=eq.${potIdN}&select=title,note&limit=1`,
      'GET',
    ).catch(() => []) as { title: string; note: string }[]
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json({ title: rows[0].title, note: rows[0].note })
  }

  // POST
  if (req.method === 'POST') {
    const { title, note, salt } = req.body as { title?: string; note?: string; salt?: string }
    if (!title || typeof note !== 'string' || !salt)
      return res.status(400).json({ error: 'Missing title, note, or salt' })
    if (!POTLY_ADDRESS) return res.status(503).json({ error: 'Contract address not configured' })
    if (!ARC_RPC_URL)   return res.status(503).json({ error: 'RPC not configured' })

    // Read on-chain metadataHash
    const client = createPublicClient({ chain: CHAIN, transport: http(ARC_RPC_URL) })
    const pot = await client.readContract({
      address: POTLY_ADDRESS,
      abi: GET_POT_ABI,
      functionName: 'getPot',
      args: [BigInt(potIdN)],
    }).catch(() => null) as { metadataHash: `0x${string}` } | null

    if (!pot) return res.status(404).json({ error: 'Pot not found on chain' })

    // Recompute hash
    const computed = keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
        [title, note, salt as `0x${string}`],
      ),
    )
    if (computed.toLowerCase() !== pot.metadataHash.toLowerCase())
      return res.status(400).json({ error: 'Hash mismatch' })

    // Insert (ignore conflict — metadata is immutable once stored)
    await sbFetch('/pot_metadata', 'POST', {
      chain_id: chainIdN,
      contract_address: POTLY_ADDRESS.toLowerCase(),
      pot_id: potIdN,
      title,
      note,
      salt,
    }).catch(() => null)

    return res.status(201).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
