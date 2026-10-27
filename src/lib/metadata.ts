import { encodeAbiParameters, keccak256 } from 'viem'

// Per-pot metadata stored only in localStorage (no API in M1/M2).
// key: `potly:meta:${chainId}:${potId}`
export interface PotMeta { title: string; note: string; salt: `0x${string}` }

const key = (chainId: number, potId: bigint) =>
  `potly:meta:${chainId}:${potId.toString()}`

export function saveMeta(chainId: number, potId: bigint, meta: PotMeta) {
  try { localStorage.setItem(key(chainId, potId), JSON.stringify(meta)) } catch { /* ok */ }
}

export function loadMeta(chainId: number, potId: bigint): PotMeta | null {
  try {
    const raw = localStorage.getItem(key(chainId, potId))
    return raw ? (JSON.parse(raw) as PotMeta) : null
  } catch { return null }
}

/** keccak256(abi.encode(string title, string note, bytes32 salt)) */
export function computeMetadataHash(title: string, note: string, salt: `0x${string}`): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
      [title, note, salt],
    ),
  )
}

export function randomSalt(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return ('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
}

export function formatUsdc(raw: bigint, decimals = 6): string {
  const n = Number(raw) / 10 ** decimals
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function parseUsdc(s: string): bigint {
  const n = parseFloat(s.replace(/,/g, ''))
  if (isNaN(n) || n < 0) throw new Error('Invalid amount')
  return BigInt(Math.round(n * 1_000_000))
}
