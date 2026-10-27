// arc-studio-allow-onchain-literal
/**
 * GET  /api/v1/pots/:chainId/:potId/metadata  -> { ok, title, note }
 * POST /api/v1/pots/:chainId/:potId/metadata  -> stores title/note/salt after verifying hash
 *
 * SUPABASE_SERVICE_ROLE_KEY is server-side only, never in src/.
 * Hash: keccak256(encodeAbiParameters([string, string, bytes32], [title, note, salt]))
 * which equals abi.encode(string, string, bytes32) on-chain.
 *
 * NOTE: API, Supabase and mainnet RPCs are not verifiable from the sandbox.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createPublicClient, http, fallback, keccak256, encodeAbiParameters } from 'viem'
import { arcTestnet, arc } from 'viem/chains'

const POTLY_ADDRESS    = process.env.POTLY_ADDRESS as `0x${string}` | undefined
const ARC_NETWORK      = process.env.ARC_NETWORK ?? 'testnet'
const ARC_RPC_URL      = process.env.ARC_RPC_URL  // primary RPC from env (optional)
const SUPABASE_URL     = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const CHAIN = ARC_NETWORK === 'mainnet' ? arc : arcTestnet

// Public RPC fallback lists (mainnet readiness spec item 5).
// ARC_RPC_URL from env is always tried first.
const MAINNET_RPCS = [
  'https://rpc.mainnet.arc.io',
  'https://rpc.drpc.mainnet.arc.io',
  'https://arc-rpc.publicnode.com',
  'https://rpc.beamrpc.com',
]
const TESTNET_RPCS = ['https://rpc.testnet.arc.io']

function makeTransport() {
  const publicList = ARC_NETWORK === 'mainnet' ? MAINNET_RPCS : TESTNET_RPCS
  const all = ARC_RPC_URL ? [ARC_RPC_URL, ...publicList] : publicList
  return all.length > 1 ? fallback(all.map(r => http(r))) : http(all[0])
}

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
      Prefer: method === 'POST' ? 'return=minimal,resolution=ignore-duplicates' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (method === 'GET') return res.json()
  return { status: res.status }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { chainId, potId } = req.query as { chainId: string; potId: string }
    const chainIdN = Number(chainId)
    const potIdN   = Number(potId)
    if (!Number.isFinite(chainIdN) || !Number.isFinite(potIdN) || potIdN < 1)
      return res.status(400).json({ ok: false, error: 'Invalid chainId or potId' })

    // ── GET ──────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (!SUPABASE_URL || !SERVICE_ROLE_KEY)
        return res.status(503).json({ ok: false, error: 'Metadata API not configured' })
      const rows = await sbFetch(
        `/pot_metadata?chain_id=eq.${chainIdN}&contract_address=eq.${POTLY_ADDRESS?.toLowerCase()}&pot_id=eq.${potIdN}&select=title,note&limit=1`,
        'GET',
      ).catch(() => []) as { title: string; note: string }[]
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' })
      return res.status(200).json({ ok: true, title: rows[0].title, note: rows[0].note })
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { title, note, salt } = req.body as { title?: string; note?: string; salt?: string }
      if (!title || typeof note !== 'string' || !salt)
        return res.status(400).json({ ok: false, error: 'Missing title, note, or salt' })
      if (!POTLY_ADDRESS)
        return res.status(503).json({ ok: false, error: 'Contract address not configured' })

      // Read on-chain metadataHash
      const client = createPublicClient({ chain: CHAIN, transport: makeTransport() })
      const pot = await client.readContract({
        address: POTLY_ADDRESS,
        abi: GET_POT_ABI,
        functionName: 'getPot',
        args: [BigInt(potIdN)],
      }).catch(() => null) as { metadataHash: `0x${string}` } | null

      if (!pot) return res.status(404).json({ ok: false, error: 'Pot not found on chain' })

      // Recompute hash — must match client-side computeMetadataHash
      // keccak256(encodeAbiParameters([string,string,bytes32],[title,note,salt]))
      const computed = keccak256(
        encodeAbiParameters(
          [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
          [title, note, salt as `0x${string}`],
        ),
      )
      if (computed.toLowerCase() !== pot.metadataHash.toLowerCase())
        return res.status(400).json({ ok: false, error: 'Hash mismatch' })

      if (!SUPABASE_URL || !SERVICE_ROLE_KEY)
        return res.status(503).json({ ok: false, error: 'Metadata storage not configured' })

      // Insert once; ignore conflict (Prefer: resolution=ignore-duplicates)
      await sbFetch('/pot_metadata', 'POST', {
        chain_id:         chainIdN,
        contract_address: POTLY_ADDRESS.toLowerCase(),
        pot_id:           potIdN,
        title,
        note,
        salt,
      }).catch(() => null)

      return res.status(201).json({ ok: true })
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  } catch (_err) {
    return res.status(500).json({ ok: false, error: 'Internal server error' })
  }
}
