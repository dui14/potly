/**
 * Browser-only Supabase / API helpers (anon key, read-only tables).
 * Service-role key lives only in api/ — never imported here.
 * If VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is absent, every function
 * returns a graceful fallback — the app works without Supabase.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabaseAvailable = !!(url && key)

// ── 60-second alias cache ────────────────────────────────────────────────────
const aliasCache = new Map<string, { value: string | null; ts: number }>()
const ALIAS_TTL = 60_000

function getCached(k: string): string | null | undefined {
  const e = aliasCache.get(k)
  if (!e) return undefined
  if (Date.now() - e.ts > ALIAS_TTL) { aliasCache.delete(k); return undefined }
  return e.value
}
function setCache(k: string, v: string | null) {
  aliasCache.set(k, { value: v, ts: Date.now() })
}

/** Minimal REST wrapper — avoids the supabase-js bundle for a read-only browser client. */
async function sbFetch(path: string, init?: RequestInit): Promise<unknown> {
  if (!url || !key) throw new Error('Supabase not configured')
  const res = await fetch(`${url}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) throw new Error(`Supabase ${res.status}`)
  return res.json()
}

/** Look up alias for a wallet address. Returns null if not found or Supabase absent. */
export async function fetchAliasByWallet(wallet: string): Promise<string | null> {
  if (!supabaseAvailable) return null
  const lc = wallet.toLowerCase()
  const cached = getCached(lc)
  if (cached !== undefined) return cached
  try {
    const rows = await sbFetch(
      `/profiles?wallet_address=eq.${lc}&select=alias&limit=1`,
    ) as { alias: string }[]
    const v = rows[0]?.alias ?? null
    setCache(lc, v)
    return v
  } catch { return null }
}

/** Look up wallet address for a given alias. Returns null if not found. */
export async function fetchWalletByAlias(alias: string): Promise<string | null> {
  if (!supabaseAvailable) return null
  const lc = alias.toLowerCase()
  const cacheKey = `@${lc}`
  const cached = getCached(cacheKey)
  if (cached !== undefined) return cached
  try {
    const rows = await sbFetch(
      `/profiles?alias=eq.${encodeURIComponent(lc)}&select=wallet_address&limit=1`,
    ) as { wallet_address: string }[]
    const v = rows[0]?.wallet_address ?? null
    setCache(cacheKey, v)
    return v
  } catch { return null }
}

/** Check if an alias is available (true = available). Never throws. */
export async function checkAliasAvailable(alias: string): Promise<boolean> {
  if (!supabaseAvailable) return false
  try {
    const rows = await sbFetch(
      `/profiles?alias=eq.${encodeURIComponent(alias.toLowerCase())}&select=alias&limit=1`,
    ) as { alias: string }[]
    return rows.length === 0
  } catch { return false }
}

/** Resolve multiple wallet addresses to aliases in one query. Never throws. */
export async function fetchAliasesByWallets(wallets: string[]): Promise<Record<string, string>> {
  if (!supabaseAvailable || wallets.length === 0) return {}
  const lower = wallets.map(w => w.toLowerCase())
  // Check cache first
  const result: Record<string, string> = {}
  const missing: string[] = []
  for (const w of lower) {
    const c = getCached(w)
    if (c !== undefined) { if (c) result[w] = c }
    else missing.push(w)
  }
  if (missing.length === 0) return result
  try {
    const inClause = missing.map(w => `"${w}"`).join(',')
    const rows = await sbFetch(
      `/profiles?wallet_address=in.(${inClause})&select=wallet_address,alias`,
    ) as { wallet_address: string; alias: string }[]
    for (const row of rows) {
      result[row.wallet_address] = row.alias
      setCache(row.wallet_address, row.alias)
    }
    // Cache misses too
    for (const w of missing) {
      if (!(w in result)) setCache(w, null)
    }
  } catch { /* return partial result */ }
  return result
}

/** Invalidate alias cache for a wallet (call after alias claim/update). */
export function invalidateAliasCache(wallet: string) {
  aliasCache.delete(wallet.toLowerCase())
}

// ── Metadata via the API (not Supabase directly) ─────────────────────────────

export interface ApiMeta { title: string; note: string }

/** GET /api/v1/pots/:chainId/:potId/metadata — returns null when not found or API absent. */
export async function fetchMetadataFromApi(
  chainId: number,
  potId: bigint,
): Promise<ApiMeta | null> {
  try {
    const res = await fetch(`/api/v1/pots/${chainId}/${potId}/metadata`)
    if (res.status === 404) return null
    if (!res.ok) return null
    const data = await res.json() as { title?: string; note?: string }
    if (!data.title) return null
    return { title: data.title, note: data.note ?? '' }
  } catch { return null }
}
