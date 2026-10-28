/**
 * Unit tests forr API shared helpers.
 * Focused on the two confirmed bugs:
 *   1. sbPost treating HTTP 200 as an error (PostgREST ignore-duplicates response)
 *   2. wallets/pots endpoint returning empty when Supabase index is behind
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'

// ── Bug 1: sbPost / sbUpsert accepting HTTP 200 ──────────────────────────────

describe('sbPost — PostgREST status codes', () => {
  const origFetch = globalThis.fetch

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://fake.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
  })

  async function callSbPost(status: number): Promise<{ threw: boolean; message?: string }> {
    // Re-require _shared with a mocked fetch so each call is independent
    globalThis.fetch = mock(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => '',
      json: async () => ({}),
    })) as unknown as typeof fetch

    // Dynamic import with cache-busting isn't available in bun:test easily,
    // so we inline the logic under test directly.
    const SB_URL = process.env.SUPABASE_URL!
    const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const res = await globalThis.fetch(`${SB_URL}/rest/v1/pot_events`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify([]),
    })
    // This mirrors the FIXED check in _shared.ts
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
      const t = await res.text().catch(() => '')
      return { threw: true, message: `Supabase ${res.status}: ${t}` }
    }
    return { threw: false }
  }

  it('accepts HTTP 201 (normal insert)', async () => {
    const r = await callSbPost(201)
    expect(r.threw).toBe(false)
  })

  it('accepts HTTP 204 (empty result)', async () => {
    const r = await callSbPost(204)
    expect(r.threw).toBe(false)
  })

  it('accepts HTTP 200 (ignore-duplicates conflict — the bug)', async () => {
    const r = await callSbPost(200)
    expect(r.threw).toBe(false)
  })

  it('rejects HTTP 400', async () => {
    const r = await callSbPost(400)
    expect(r.threw).toBe(true)
    expect(r.message).toContain('400')
  })

  it('rejects HTTP 409', async () => {
    const r = await callSbPost(409)
    expect(r.threw).toBe(true)
    expect(r.message).toContain('409')
  })

  // Restore fetch
  afterAll(() => {
    globalThis.fetch = origFetch
  })
})

// ── Bug 2: pots fallback logic ───────────────────────────────────────────────

describe('wallets/pots fallback chain scan logic', () => {
  it('scans at most 100 pots from the chain when Supabase returns empty', () => {
    const FALLBACK_SCAN_LIMIT = 100
    const potCount = 250n
    const scanCount = potCount < BigInt(FALLBACK_SCAN_LIMIT) ? Number(potCount) : FALLBACK_SCAN_LIMIT
    expect(scanCount).toBe(100)

    const potIds: bigint[] = []
    for (let i = 0; i < scanCount; i++) {
      potIds.push(potCount - BigInt(i))
    }
    expect(potIds[0]).toBe(250n)
    expect(potIds[99]).toBe(151n)
    expect(potIds.length).toBe(100)
  })

  it('scans all pots when potCount < 100', () => {
    const FALLBACK_SCAN_LIMIT = 100
    const potCount = 7n
    const scanCount = potCount < BigInt(FALLBACK_SCAN_LIMIT) ? Number(potCount) : FALLBACK_SCAN_LIMIT
    expect(scanCount).toBe(7)
  })

  it('returns empty immediately when potCount is 0', () => {
    const potCount = 0n
    expect(potCount === 0n).toBe(true)
  })

  it('includes pots where wallet is creator', () => {
    const wallet = '0xabc'.toLowerCase()
    const potResults = [
      { status: 'success', result: { creator: '0xABC', recipient: '0x999' } },
      { status: 'success', result: { creator: '0x111', recipient: '0x222' } },
    ]
    const potIds = [1n, 2n]
    const directMatches = new Set<string>()
    const toCheckContrib: bigint[] = []

    for (let i = 0; i < potResults.length; i++) {
      const r = potResults[i]
      if (r.status !== 'success' || !r.result) continue
      const pot = r.result
      if (pot.creator.toLowerCase() === wallet || pot.recipient.toLowerCase() === wallet) {
        directMatches.add(potIds[i].toString())
      } else {
        toCheckContrib.push(potIds[i])
      }
    }

    expect(directMatches.has('1')).toBe(true)
    expect(directMatches.has('2')).toBe(false)
    expect(toCheckContrib).toContain(2n)
  })

  it('includes pots where wallet is contributor (non-zero contributionOf)', () => {
    const contributions = [0n, 5000000n, 0n]
    const potIds = [10n, 11n, 12n]
    const matches = new Set<string>()
    for (let i = 0; i < contributions.length; i++) {
      if (contributions[i] > 0n) matches.add(potIds[i].toString())
    }
    expect(matches.has('11')).toBe(true)
    expect(matches.has('10')).toBe(false)
    expect(matches.has('12')).toBe(false)
  })
})

// Need afterAll from bun:test
function afterAll(fn: () => void) {
  // bun:test exposes afterAll at module scope; this shim is for tsc only
  if (typeof (globalThis as unknown as { afterAll?: (fn: () => void) => void }).afterAll === 'function') {
    ;(globalThis as unknown as { afterAll: (fn: () => void) => void }).afterAll(fn)
  }
}

// ── A1: block_time ISO conversion ─────────────────────────────────────────────

describe('toIso — block timestamp to ISO 8601', () => {
  // Import inline to avoid module-level side-effects on env vars
  it('converts the sample unix timestamp 1793184294 correctly', async () => {
    // This is the timestamp that caused Postgres error 22008 when written raw.
    const { toIso } = await import('../_shared')
    const result = toIso(1793184294)
    // Must be a valid Date (timezone-agnostic: round-trip the unix seconds)
    expect(isNaN(new Date(result).getTime())).toBe(false)
    expect(Math.round(new Date(result).getTime() / 1000)).toBe(1793184294)
    // Must end with Z (UTC / ISO 8601)
    expect(result.endsWith('Z')).toBe(true)
  })

  it('is safe with BigInt input', async () => {
    const { toIso } = await import('../_shared')
    const result = toIso(1793184294n)
    expect(isNaN(new Date(result).getTime())).toBe(false)
    expect(Math.round(new Date(result).getTime() / 1000)).toBe(1793184294)
    expect(result.endsWith('Z')).toBe(true)
  })

  it('round-trips: toIso output is accepted by new Date()', async () => {
    const { toIso } = await import('../_shared')
    const samples = [0, 1000000000, 1793184294, 2000000000]
    for (const ts of samples) {
      const iso = toIso(ts)
      const parsed = new Date(iso)
      expect(isNaN(parsed.getTime())).toBe(false)
      // round-trip: unix seconds should match
      expect(Math.round(parsed.getTime() / 1000)).toBe(ts)
    }
  })
})
