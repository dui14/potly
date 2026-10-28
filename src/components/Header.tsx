import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { Link, useLocation } from 'react-router-dom'
import { IS_TESTNET } from '@/config/wagmi'
import { useMyAlias } from '@/hooks/useAlias'
import { supabaseAvailable } from '@/lib/supabase'
import { AliasModal } from './AliasModal'
import { EditAliasModal } from './EditAliasModal'

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
      <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)]/90 backdrop-blur-md">
        <div className="max-w-[1120px] mx-auto px-3 sm:px-4 h-14 flex items-center gap-2 sm:gap-4 min-w-0">
          {/* Logo */}
          <Link to="/" className="font-display text-lg font-bold text-[var(--ink)] tracking-tight shrink-0">
            Potly
          </Link>

          {/* Network badge */}
          {IS_TESTNET && (
            <span className="text-[10px] font-semibold bg-amber-900/40 text-amber-300 border border-amber-700/40 px-2 py-0.5 rounded-full uppercase tracking-wider shrink-0">
              Testnet
            </span>
          )}
          {!IS_TESTNET && (
            <span className="text-[10px] font-semibold bg-emerald-900/40 text-emerald-300 border border-emerald-700/40 px-2 py-0.5 rounded-full uppercase tracking-wider shrink-0">
              Real USDC
            </span>
          )}

          {/* Desktop nav */}
          <nav className="hidden sm:flex items-center gap-1 ml-1 shrink-0">
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

          {/* Right side */}
          <div className="ml-auto flex items-center gap-2 min-w-0">
            {isConnected && alias && (
              <button
                onClick={() => setShowModal(true)}
                className="hidden sm:block text-xs text-[var(--muted)] hover:text-[var(--ink)] transition shrink-0"
                title="Edit alias"
              >
                @{alias}
              </button>
            )}
            {isConnected && !alias && supabaseAvailable && (
              <button
                onClick={() => setShowModal(true)}
                className="hidden sm:block text-xs text-[var(--muted)] hover:text-[var(--ink)] transition underline shrink-0"
              >
                Set alias
              </button>
            )}
            <ConnectKitButton />
          </div>
        </div>

        {/* Mobile bottom nav */}
        <nav className="sm:hidden flex border-t border-[var(--border)] bg-[var(--surface)]/95">
          {nav.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={[
                'flex-1 py-2 text-center text-sm font-medium transition',
                pathname === to
                  ? 'text-[var(--ink)] border-b-2 border-[var(--accent)]'
                  : 'text-[var(--muted)]',
              ].join(' ')}
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>

      {showModal && address && !alias && (
        <AliasModal
          address={address}
          onClose={() => setShowModal(false)}
          onClaimed={(_a) => { setShowModal(false); refetch() }}
        />
      )}
      {showModal && address && alias && (
        <EditAliasModal
          address={address}
          currentAlias={alias}
          onClose={() => setShowModal(false)}
          onUpdated={(_a) => { setShowModal(false); refetch() }}
        />
      )}
    </>
  )
}
