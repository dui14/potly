import { useState } from 'react'
import { useSignMessage } from 'wagmi'
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import { useAliasAvailability, updateAlias } from '@/hooks/useAlias'
import { invalidateAliasCache } from '@/lib/supabase'

const ALIAS_RE = /^[a-z0-9_]{3,20}$/

interface Props {
  address: string
  currentAlias: string
  onClose: () => void
  onUpdated: (alias: string) => void
}

export function EditAliasModal({ address, currentAlias, onClose, onUpdated }: Props) {
  const { signMessageAsync } = useSignMessage()
  const [input, setInput]       = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [serverErr, setServerErr]   = useState('')
  const [done, setDone]             = useState(false)

  const newAlias = input.toLowerCase()
  const valid    = ALIAS_RE.test(newAlias) && newAlias !== currentAlias.toLowerCase()
  const { available, checking } = useAliasAvailability(valid ? newAlias : '')

  if (done) {
    return (
      <Overlay onClose={onClose}>
        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-center gap-2 text-[var(--success)] font-semibold">
            <CheckCircle size={16} /> Alias updated to @{newAlias}!
          </div>
          <button onClick={onClose} className="rounded-xl px-4 py-2 bg-[var(--accent)] text-white text-sm hover:opacity-90 transition">Done</button>
        </div>
      </Overlay>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid || !available || submitting) return
    setServerErr('')
    setSubmitting(true)
    const err = await updateAlias(currentAlias, newAlias, address, msg => signMessageAsync({ message: msg }))
    if (err) { setServerErr(err); setSubmitting(false) }
    else {
      invalidateAliasCache(address)
      setDone(true); setSubmitting(false); onUpdated(newAlias)
    }
  }

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
        <h2 className="text-base font-semibold text-[var(--ink)]">Edit alias</h2>
        <p className="text-xs text-[var(--muted)]">
          Current: <span className="font-mono text-[var(--ink-2)]">@{currentAlias}</span>.
          {' '}3–20 chars, a–z 0–9 _. At most one change per hour.
        </p>
        <p className="text-xs text-[var(--subtle)]">
          Existing pots are unaffected — recipients are stored on-chain as addresses.
        </p>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 bg-[var(--surface-muted)] border border-[var(--border)] rounded-xl px-3 py-2.5">
            <span className="text-[var(--muted)] text-sm">@</span>
            <input
              value={input}
              onChange={e => { setInput(e.target.value.replace(/[^a-z0-9_]/gi, '')); setServerErr('') }}
              placeholder="new_alias"
              maxLength={20}
              className="bg-transparent flex-1 text-sm outline-none text-[var(--ink)]"
              autoFocus
            />
            {valid && checking  && <Loader2  size={12} className="animate-spin text-[var(--muted)]" />}
            {valid && !checking && available === true  && <CheckCircle size={12} className="text-[var(--success)]" />}
            {valid && !checking && available === false && <AlertCircle size={12} className="text-[var(--danger)]" />}
          </div>
          {valid && !checking && available === false && <p className="text-xs text-[var(--danger)]">Alias taken</p>}
          {!valid && input.length > 0 && newAlias === currentAlias.toLowerCase() && (
            <p className="text-xs text-[var(--muted)]">Must differ from current alias</p>
          )}
        </div>

        {serverErr && (
          <p className="text-xs text-[var(--danger)] flex items-center gap-1">
            <AlertCircle size={11} /> {serverErr}
          </p>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={onClose}
            className="flex-1 rounded-xl px-4 py-2.5 text-sm bg-[var(--surface)] border border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-strong)] transition">
            Cancel
          </button>
          <button type="submit" disabled={!valid || !available || submitting}
            className="flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-2">
            {submitting && <Loader2 size={12} className="animate-spin" />}
            {submitting ? 'Signing…' : 'Update alias'}
          </button>
        </div>
      </form>
    </Overlay>
  )
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-sm mx-4 rounded-2xl bg-[var(--bg)] border border-[var(--border)] shadow-2xl">
        {children}
      </div>
    </div>
  )
}
