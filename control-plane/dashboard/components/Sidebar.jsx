'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

// Each entry shows only when the role has its permission (GET /api/session).
// Hiding is a convenience: the API refuses what the role cannot do anyway.
const NAV = [
  { href: '/',          label: 'Overview',  permission: 'usage.read' },
  { href: '/teams',     label: 'Teams',     permission: 'teams.read' },
  { href: '/users',     label: 'Users',     permission: 'users.read' },
  { href: '/agents',    label: 'Agents',    permission: 'users.read' },
  { href: '/logs',      label: 'Requests',  permission: 'logs.read' },
  { href: '/policy',    label: 'Policies',  permission: 'policies.read' },
  { href: '/alerts',    label: 'Alerts',    permission: 'alerts.read' },
  { href: '/providers', label: 'Providers', permission: 'providers.read' },
]

const ROLE_LABEL = {
  owner: 'Owner', admin: 'Admin', team_manager: 'Gestor/a de equipo', auditor: 'Auditor/a',
}

export default function Sidebar() {
  const path = usePathname()
  const [me, setMe] = useState(null)

  useEffect(() => {
    fetch('/api/session').then(r => (r.ok ? r.json() : null)).then(setMe).catch(() => {})
  }, [])

  const nav = me ? NAV.filter(n => me.permissions[n.permission]) : []

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
        {nav.map(({ href, label }) => {
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

      {/* Logout + Status */}
      <div className="px-3 pb-3 border-t border-border pt-2 space-y-1">
        {me && (
          <div className="px-3 pb-1">
            <div className="text-sm font-medium text-default truncate">{me.user.name ?? me.user.email}</div>
            <div className="text-xs text-subtle truncate">{me.org.name} · {ROLE_LABEL[me.user.role] ?? me.user.role}</div>
            <Link href="/account" className="text-xs text-accent hover:text-accent-hover">Mi cuenta</Link>
          </div>
        )}
        <button
          onClick={async () => {
            await fetch('/api/session', { method: 'DELETE' })
            window.location.href = '/login'
          }}
          className="w-full flex items-center h-8 px-3 rounded-md text-sm text-muted hover:bg-raised hover:text-err transition-colors"
        >
          Cerrar sesión
        </button>
      </div>

    </aside>
  )
}
