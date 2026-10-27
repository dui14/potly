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

/**
 * POST metadata to the API with up to 3 retries and exponential backoff.
 * Silently succeeds if the API is not configured (503) — localStorage is the fallback.
 * Returns true on success, false on permanent failure.
 */
export async function postMetadata(
  chainId: number,
  potId: bigint,
  meta: PotMeta,
): Promise<boolean> {
  const url = `/api/v1/pots/${chainId}/${potId}/metadata`
  const body = JSON.stringify({ title: meta.title, note: meta.note, salt: meta.salt })
  const MAX_TRIES = 3
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      if (res.ok) return true
      // 503 = API not configured; 409 = already stored — both are acceptable
      if (res.status === 503 || res.status === 409) return true
      // 400 hash mismatch — no point retrying
      if (res.status === 400) return false
    } catch { /* network error — retry */ }
    if (attempt < MAX_TRIES - 1) {
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt))
    }
  }
  return false
}
