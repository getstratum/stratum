'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

// Grouped as in the console prototype. Each entry shows only when the role
// has its permission (GET /api/session); hiding is a convenience, the API
// refuses what the role cannot do anyway.
const NAV = [
  { group: 'General', items: [
    { href: '/',          label: 'Inicio',      permission: 'usage.read' },
  ] },
  { group: 'Conexiones', items: [
    { href: '/providers', label: 'Proveedores', permission: 'providers.read' },
    { href: '/models',    label: 'Modelos',     permission: 'models.read' },
    { href: '/gateways',  label: 'Gateways',    permission: 'gateways.read' },
    { href: '/apps',      label: 'Aplicaciones', permission: 'apps.read' },
  ] },
  { group: 'Acceso', items: [
    { href: '/users',     label: 'Usuarios',    permission: 'users.read' },
    { href: '/agents',    label: 'Agentes',     permission: 'users.read' },
    { href: '/teams',     label: 'Equipos',     permission: 'teams.read' },
    { href: '/policy',    label: 'Políticas',   permission: 'policies.read' },
  ] },
  { group: 'Uso', items: [
    { href: '/usage',     label: 'Consumo',     permission: 'usage.read' },
    { href: '/logs',      label: 'Requests',    permission: 'logs.read' },
    { href: '/alerts',    label: 'Alertas',     permission: 'alerts.read' },
  ] },
  { group: 'Seguridad', items: [
    { href: '/sso',       label: 'Ingreso con SSO', permission: 'sso.read' },
    { href: '/audit',     label: 'Auditoría',   permission: 'audit.read' },
  ] },
]

const ROLE_LABEL = {
  owner: 'Owner', admin: 'Admin', team_manager: 'Gestor/a de equipo', auditor: 'Auditor/a',
}

const isActive = (path, href) => (href === '/' ? path === '/' : path === href || path.startsWith(href + '/'))

export default function Sidebar() {
  const path = usePathname()
  const [me, setMe] = useState(null)
  const [open, setOpen] = useState(false) // the menu on narrow screens

  useEffect(() => {
    fetch('/api/session').then(r => (r.ok ? r.json() : null)).then(setMe).catch(() => {})
  }, [])
  useEffect(() => { setOpen(false) }, [path])

  const groups = me
    ? NAV.map(g => ({ ...g, items: g.items.filter(n => me.permissions[n.permission]) })).filter(g => g.items.length)
    : []

  return (
    <>
      {/* Narrow screens: a top bar with the menu button */}
      <div className="md:hidden flex items-center justify-between h-14 px-4 bg-nav border-b border-border">
        <span className="text-[17px] font-semibold text-strong tracking-tight">Stratum</span>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          aria-controls="console-nav"
          className="min-h-[44px] px-3 rounded-md border border-border-strong bg-card text-sm font-medium text-strong"
        >
          {open ? 'Cerrar menú' : 'Menú'}
        </button>
      </div>

      <aside
        id="console-nav"
        className={`${open ? 'flex' : 'hidden'} md:flex w-full md:w-60 flex-shrink-0 flex-col gap-4 bg-nav border-b md:border-b-0 md:border-r border-border px-3.5 py-5 md:overflow-y-auto`}
      >
        <div className="hidden md:block px-1.5 text-[17px] font-semibold text-strong tracking-tight">Stratum</div>
        {me && (
          <div className="px-1.5">
            <div className="rounded-md border border-border-strong bg-card px-2.5 py-2">
              <div className="text-sm font-semibold text-strong truncate">{me.org.name}</div>
              <div className="text-xs text-muted">{ROLE_LABEL[me.user.role] ?? me.user.role}</div>
            </div>
          </div>
        )}

        <nav aria-label="Consola" className="flex flex-col gap-0.5">
          {me && groups.length === 0 && (
            // An Owner or Admin without a second factor: only the account page works.
            <p className="px-2.5 pt-3.5 text-[13px] text-muted">
              Configurá la verificación en dos pasos en <Link href="/account" className="text-accent hover:text-accent-hover">Mi cuenta</Link> para usar la consola.
            </p>
          )}
          {groups.map(g => (
            <div key={g.group} className="flex flex-col gap-0.5">
              <div className="px-2.5 pt-3.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle">{g.group}</div>
              {g.items.map(({ href, label }) => {
                const on = isActive(path, href)
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={on ? 'page' : undefined}
                    className={`block px-2.5 py-2 rounded-md text-sm text-strong transition-colors ${
                      on ? 'bg-card font-semibold shadow-[0_0_0_1px_#d5d9e0]' : 'hover:bg-card/60'
                    }`}
                  >
                    {label}
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-2 px-1.5 pt-4">
          {me && (
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-strong truncate">{me.user.name ?? me.user.email}</span>
              <span className="text-xs text-muted truncate">
                {me.user.email}{me.mfa?.enabled ? ' · 2FA activo' : ''}
              </span>
            </div>
          )}
          <div className="flex gap-3.5 text-[13px]">
            <Link href="/account" className="text-accent hover:text-accent-hover">Mi cuenta</Link>
            <button
              type="button"
              onClick={async () => {
                await fetch('/api/session', { method: 'DELETE' })
                window.location.href = '/login'
              }}
              className="text-accent hover:text-accent-hover"
            >
              Cerrar sesión
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
