import { useState } from 'react'
import { useSignMessage } from 'wagmi'
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import { useAliasAvailability, claimAlias } from '@/hooks/useAlias'
import { supabaseAvailable } from '@/lib/supabase'

const ALIAS_RE = /^[a-z0-9_]{3,20}$/
const RESERVED = new Set(['admin', 'support', 'potly', 'treasury', 'arc', 'circle', 'usdc', 'official'])

interface Props {
  address: string
  onClose: () => void
  onClaimed: (alias: string) => void
}

export function AliasModal({ address, onClose, onClaimed }: Props) {
  const { signMessageAsync } = useSignMessage()
  const [input, setInput]   = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [serverErr, setServerErr]   = useState('')
  const [done, setDone]             = useState(false)

  const alias    = input.toLowerCase().trim()
  const valid    = ALIAS_RE.test(alias)
  const reserved = RESERVED.has(alias)
  const { available, checking } = useAliasAvailability(valid && !reserved ? alias : '')

  if (!supabaseAvailable) {
    return (
      <Overlay onClose={onClose}>
        <div className="flex flex-col gap-4 p-6 text-sm text-[var(--muted)]">
          <p>Aliases are not available — Supabase is not configured.</p>
          <button onClick={onClose} className="rounded-xl px-4 py-2 bg-[var(--surface)] border border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-strong)] text-sm transition">
            Close
          </button>
        </div>
      </Overlay>
    )
  }

  if (done) {
    return (
      <Overlay onClose={onClose}>
        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-center gap-2 text-[var(--success)] font-semibold">
            <CheckCircle size={16} /> @{alias} claimed!
          </div>
          <button onClick={onClose} className="rounded-xl px-4 py-2 bg-[var(--accent)] text-white text-sm hover:opacity-90 transition">
            Done
          </button>
        </div>
      </Overlay>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid || reserved || !available || submitting) return
    if (reserved) { setServerErr('That alias is reserved'); return }
    setServerErr('')
    setSubmitting(true)
    const err = await claimAlias(alias, address, (msg) => signMessageAsync({ message: msg }))
    if (err) { setServerErr(err); setSubmitting(false) }
    else { setDone(true); setSubmitting(false); onClaimed(alias) }
  }

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
        <h2 className="text-base font-semibold text-[var(--ink)]">Choose your alias</h2>
        <p className="text-xs text-[var(--muted)]">
          3–20 characters: a–z, 0–9 or underscore. Reserved words (admin, potly, arc, …) are not allowed.
          Signing a message proves ownership of your wallet — no on-chain transaction needed.
        </p>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 bg-[var(--surface-muted)] border border-[var(--border)] rounded-xl px-3 py-2.5">
            <span className="text-[var(--muted)] text-sm">@</span>
            <input
              value={input}
              onChange={e => {
                // Lowercase + strip non-allowed chars + strip spaces as you type
                setInput(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))
                setServerErr('')
              }}
              placeholder="yourname"
              maxLength={20}
              autoCapitalize="none"
              className="bg-transparent flex-1 text-sm outline-none text-[var(--ink)]"
            />
            {valid && !reserved && checking && <Loader2 size={12} className="animate-spin text-[var(--muted)]" />}
            {valid && !reserved && !checking && available === true  && <CheckCircle size={12} className="text-[var(--success)]" />}
            {((!valid && input.length > 0) || reserved || (!checking && available === false)) && <AlertCircle size={12} className="text-[var(--danger)]" />}
          </div>
          {reserved && <p className="text-xs text-[var(--danger)]">That alias is reserved</p>}
          {!reserved && valid && !checking && available === false && (
            <p className="text-xs text-[var(--danger)]">Alias is already taken</p>
          )}
          {!valid && !reserved && input.length > 0 && (
            <p className="text-xs text-[var(--muted)]">Alias must be 3-20 characters: a-z, 0-9 or underscore</p>
          )}
        </div>
        {serverErr && (
          <p className="text-xs text-[var(--danger)] flex items-center gap-1">
            <AlertCircle size={11} /> {serverErr}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl px-4 py-2.5 text-sm bg-[var(--surface)] border border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-strong)] transition"
          >
            Skip
          </button>
          <button
            type="submit"
            disabled={!valid || reserved || !available || submitting}
            className="flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            {submitting ? 'Signing…' : 'Claim alias'}
          </button>
        </div>
      </form>
    </Overlay>
  )
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm mx-4 rounded-2xl bg-[var(--bg)] border border-[var(--border)] shadow-2xl">
        {children}
      </div>
    </div>
  )
}
