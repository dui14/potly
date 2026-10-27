import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { Link, useLocation } from 'react-router-dom'
import { IS_TESTNET } from '@/config/wagmi'
import { useMyAlias } from '@/hooks/useAlias'
import { supabaseAvailable } from '@/lib/supabase'
import { AliasModal } from './AliasModal'

export function Header() {
  const { pathname } = useLocation()
  const { address, isConnected } = useAccount()
  const { alias, loading, refetch } = useMyAlias(address)
  const [showModal, setShowModal] = useState(false)
  const [prevConnected, setPrevConnected] = useState(false)

  // Show alias modal once when user first connects and has no alias
  useEffect(() => {
    if (isConnected && !prevConnected) {
      setPrevConnected(true)
      // Wait a moment for the alias lookup to complete
      if (supabaseAvailable) {
        const t = setTimeout(() => {
          if (!alias && !loading) setShowModal(true)
        }, 1500)
        return () => clearTimeout(t)
      }
    }
    if (!isConnected) setPrevConnected(false)
  }, [isConnected, prevConnected, alias, loading])

  const nav = [
    { to: '/', label: 'Create' },
    { to: '/my', label: 'My Pots' },
  ]

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)]/80 backdrop-blur-md">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-4">
          <Link to="/" className="font-display text-lg font-bold text-[var(--ink)] tracking-tight">
            Potly
          </Link>

          {IS_TESTNET && (
            <span className="text-[10px] font-semibold bg-amber-900/40 text-amber-300 border border-amber-700/40 px-2 py-0.5 rounded-full uppercase tracking-wider">
              Testnet
            </span>
          )}
          {!IS_TESTNET && (
            <span className="text-[10px] font-semibold bg-emerald-900/40 text-emerald-300 border border-emerald-700/40 px-2 py-0.5 rounded-full uppercase tracking-wider">
              Real USDC
            </span>
          )}

          <nav className="flex items-center gap-1 ml-2">
            {nav.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={[
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition',
                  pathname === to
                    ? 'bg-[var(--surface-strong)] text-[var(--ink)]'
                    : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-muted)]',
                ].join(' ')}
              >
                {label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {isConnected && alias && (
              <button
                onClick={() => setShowModal(true)}
                className="text-xs text-[var(--muted)] hover:text-[var(--ink)] transition"
                title="Your alias"
              >
                @{alias}
              </button>
            )}
            {isConnected && !alias && supabaseAvailable && (
              <button
                onClick={() => setShowModal(true)}
                className="text-xs text-[var(--muted)] hover:text-[var(--ink)] transition underline"
              >
                Set alias
              </button>
            )}
            <ConnectKitButton />
          </div>
        </div>
      </header>

      {showModal && address && (
        <AliasModal
          address={address}
          onClose={() => setShowModal(false)}
          onClaimed={(_a) => { setShowModal(false); refetch() }}
        />
      )}
    </>
  )
}
