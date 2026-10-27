import { useEffect, useState } from 'react'
import {
  fetchAliasByWallet,
  fetchWalletByAlias,
  checkAliasAvailable,
  supabaseAvailable,
} from '@/lib/supabase'

/** Returns the alias for a connected wallet (or null). */
export function useMyAlias(address: string | undefined) {
  const [alias, setAlias]     = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!address || !supabaseAvailable) { setAlias(null); return }
    let cancelled = false
    setLoading(true)
    fetchAliasByWallet(address).then(a => {
      if (!cancelled) { setAlias(a); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [address])

  return { alias, loading, refetch: () => {
    if (!address) return
    fetchAliasByWallet(address).then(setAlias)
  }}
}

/** Resolve @alias → address or return the raw address if it starts with 0x. */
export function useResolveRecipient(raw: string) {
  const [resolved, setResolved]   = useState<string | null>(null)
  const [checking, setChecking]   = useState(false)
  const [isAlias, setIsAlias]     = useState(false)

  useEffect(() => {
    if (!raw) { setResolved(null); setIsAlias(false); return }
    if (raw.startsWith('0x')) { setResolved(raw); setIsAlias(false); return }
    if (!raw.startsWith('@')) { setResolved(null); setIsAlias(false); return }
    const alias = raw.slice(1).trim()
    if (!alias) { setResolved(null); return }
    setChecking(true)
    setIsAlias(true)
    fetchWalletByAlias(alias).then(addr => {
      setResolved(addr)
      setChecking(false)
    })
  }, [raw])

  return { resolved, checking, isAlias }
}

/** Live alias availability checker. */
export function useAliasAvailability(alias: string) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [checking, setChecking]   = useState(false)

  useEffect(() => {
    if (!alias || alias.length < 3) { setAvailable(null); return }
    setChecking(true)
    const t = setTimeout(() => {
      checkAliasAvailable(alias).then(ok => {
        setAvailable(ok)
        setChecking(false)
      })
    }, 400) // debounce
    return () => clearTimeout(t)
  }, [alias])

  return { available, checking }
}

/** PUT to /api/v1/profile/update. Returns error string or null on success. */
export async function updateAlias(
  oldAlias: string,
  newAlias: string,
  address: string,
  signMessage: (msg: string) => Promise<string>,
): Promise<string | null> {
  const issuedAt = new Date().toISOString()
  const message  = `Potly alias update\nOld: ${oldAlias.toLowerCase()}\nNew: ${newAlias.toLowerCase()}\nWallet: ${address}\nIssued: ${issuedAt}`
  let signature: string
  try { signature = await signMessage(message) } catch { return 'Signature cancelled.' }
  const res = await fetch('/api/v1/profile/update', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldAlias, newAlias, address, issuedAt, signature }),
  })
  if (res.ok) return null
  const body = await res.json().catch(() => ({})) as { error?: string }
  return body.error ?? `Server error ${res.status}`
}

/** POST to /api/v1/profile. Returns error string or null on success. */
export async function claimAlias(
  alias: string,
  address: string,
  signMessage: (msg: string) => Promise<string>,
): Promise<string | null> {
  const issuedAt = new Date().toISOString()
  const message  = `Potly alias claim\nAlias: ${alias}\nWallet: ${address}\nIssued: ${issuedAt}`
  let signature: string
  try {
    signature = await signMessage(message)
  } catch {
    return 'Signature cancelled.'
  }
  const res = await fetch('/api/v1/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias, address, issuedAt, signature }),
  })
  if (res.ok) return null
  const body = await res.json().catch(() => ({})) as { error?: string }
  return body.error ?? `Server error ${res.status}`
}

