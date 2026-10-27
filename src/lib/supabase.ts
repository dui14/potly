/**
 * Browser-only Supabase client (anon key, read-only tables).
 * Server-side service-role key lives only in api/ — never imported here.
 *
 * If VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is absent the client is null
 * and every hook returns a graceful fallback so the app works without Supabase.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabaseAvailable = !!(url && key)

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
  try {
    const rows = await sbFetch(
      `/profiles?wallet_address=eq.${wallet.toLowerCase()}&select=alias&limit=1`,
    ) as { alias: string }[]
    return rows[0]?.alias ?? null
  } catch { return null }
}

/** Look up wallet address for a given alias. Returns null if not found. */
export async function fetchWalletByAlias(alias: string): Promise<string | null> {
  if (!supabaseAvailable) return null
  try {
    const rows = await sbFetch(
      `/profiles?alias=eq.${encodeURIComponent(alias.toLowerCase())}&select=wallet_address&limit=1`,
    ) as { wallet_address: string }[]
    return rows[0]?.wallet_address ?? null
  } catch { return null }
}

/** Check if an alias is available (true = available). */
export async function checkAliasAvailable(alias: string): Promise<boolean> {
  if (!supabaseAvailable) return false
  try {
    const rows = await sbFetch(
      `/profiles?alias=eq.${encodeURIComponent(alias.toLowerCase())}&select=alias&limit=1`,
    ) as { alias: string }[]
    return rows.length === 0
  } catch { return false }
}

/** Resolve multiple wallet addresses to aliases in one call. */
export async function fetchAliasesByWallets(wallets: string[]): Promise<Record<string, string>> {
  if (!supabaseAvailable || wallets.length === 0) return {}
  try {
    const lower = wallets.map(w => w.toLowerCase())
    const inClause = lower.map(w => `"${w}"`).join(',')
    const rows = await sbFetch(
      `/profiles?wallet_address=in.(${inClause})&select=wallet_address,alias`,
    ) as { wallet_address: string; alias: string }[]
    const map: Record<string, string> = {}
    for (const row of rows) map[row.wallet_address] = row.alias
    return map
  } catch { return {} }
}
