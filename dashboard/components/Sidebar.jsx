'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'

const NAV = [
  { href: '/',          label: 'Overview'   },
  { href: '/teams',     label: 'Teams'      },
  { href: '/users',     label: 'Users'      },
  { href: '/agents',    label: 'Agents'     },
  { href: '/logs',      label: 'Requests'   },
  { href: '/policy',    label: 'Policies'   },
  { href: '/alerts',    label: 'Alerts'     },
  { href: '/providers', label: 'Providers'  },
]

export default function Sidebar() {
  const path = usePathname()

  return (
    <aside className="w-56 flex-shrink-0 flex flex-col bg-card border-r border-border shadow-sm">

      {/* Logo */}
      <div className="px-5 h-14 flex items-center border-b border-border gap-2.5">
        <div className="w-6 h-6 rounded-md bg-accent flex items-center justify-center">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1L11 6L6 11L1 6L6 1Z" fill="white"/>
          </svg>
        </div>
        <span className="font-semibold text-strong text-sm tracking-tight">Stratum</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-3 space-y-0.5">
        {NAV.map(({ href, label }) => {
          const active = path === href
          return (
            <Link
              key={href}
              href={href}
              className={`
                flex items-center h-9 px-3 rounded-md text-sm font-medium transition-colors
                ${active
                  ? 'bg-accent-light text-accent-text'
                  : 'text-muted hover:bg-raised hover:text-default'}
              `}
            >
              {active && (
                <span className="w-1.5 h-1.5 rounded-full bg-accent mr-2.5 flex-shrink-0" />
              )}
              {!active && <span className="w-1.5 h-1.5 mr-2.5 flex-shrink-0" />}
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Playground */}
      <div className="px-3 pb-2 border-t border-border pt-2">
        <Link
          href="/prompt"
          className={`
            flex items-center justify-between h-9 px-3 rounded-md text-sm font-medium transition-colors
            ${path === '/prompt'
              ? 'bg-accent-light text-accent-text'
              : 'text-muted hover:bg-raised hover:text-default'}
          `}
        >
          <span>Playground</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-40">
            <path d="M2 2h8v8M2 10L10 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </Link>
      </div>

      {/* Logout + Status */}
      <div className="px-3 pb-3 border-t border-border pt-2 space-y-1">
        <button
          onClick={async () => {
            await fetch('/api/session', { method: 'DELETE' })
            window.location.href = '/login'
          }}
          className="w-full flex items-center h-8 px-3 rounded-md text-sm text-muted hover:bg-raised hover:text-err transition-colors"
        >
          Sign out
        </button>
        <div className="flex items-center gap-2 text-xs text-subtle px-3">
          <span className="w-1.5 h-1.5 rounded-full bg-ok flex-shrink-0" />
          Gateway · :8080
        </div>
      </div>

    </aside>
  )
}
