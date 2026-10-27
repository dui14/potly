/**
 * usePotMeta — resolves pot title/note for any viewer.
 *
 * Priority order:
 *   1. API GET /api/v1/pots/:chainId/:potId/metadata
 *   2. Creator's localStorage (only when the API returned nothing)
 *
 * Side-effect: if the creator's browser holds a salt and the API has no
 * entry, we retry the POST once (fire-and-forget) so the title propagates.
 */
import { useEffect, useState } from 'react'
import { fetchMetadataFromApi, type ApiMeta } from '@/lib/supabase'
import { loadMeta, postMetadata } from '@/lib/metadata'

interface PotMeta { title: string; note: string }

export function usePotMeta(chainId: number, potId: bigint | undefined): PotMeta {
  const fallback = potId !== undefined ? `Pot #${potId}` : ''
  const [meta, setMeta] = useState<PotMeta>({ title: fallback, note: '' })

  useEffect(() => {
    if (potId === undefined) return
    let cancelled = false

    async function load() {
      // 1. Try the API
      let apiMeta: ApiMeta | null = null
      try { apiMeta = await fetchMetadataFromApi(chainId, potId!) } catch { /* ok */ }

      if (cancelled) return

      if (apiMeta) {
        setMeta({ title: apiMeta.title || fallback, note: apiMeta.note })
        return
      }

      // 2. Fall back to localStorage
      const local = loadMeta(chainId, potId!)
      if (local?.title) {
        setMeta({ title: local.title, note: local.note ?? '' })
        // If we have a salt, retry the POST once so the API catches up
        postMetadata(chainId, potId!, local).catch(() => null)
      }
      // else leave the "Pot #id" fallback
    }

    load()
    return () => { cancelled = true }
  }, [chainId, potId?.toString()])   // stringify bigint for dep comparison

  return meta
}
