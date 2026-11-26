'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'
import { usePermissions } from '../../components/usePermissions'
import { useNarrow } from '../../components/useNarrow'

const ROLES = ['member', 'team_manager', 'auditor', 'admin', 'owner']
const ROLE_LABEL = {
  owner: 'Owner', admin: 'Admin', team_manager: 'Gestor/a de equipo', auditor: 'Auditor/a', member: 'Miembro',
}

// ── API key one-time reveal ───────────────────────────────────────────────────
function ApiKeyReveal({ apiKey, onClose }) {
  const [copied, setCopied] = useState(false)
  return (
    <Modal title="API key generada" onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          ⚠ Esta es la única vez que se muestra esta key. Copiala ahora.
        </p>
        <div className="flex gap-2 items-center">
          <code data-testid="revealed-key" className="flex-1 bg-raised border border-border rounded-lg px-3 py-2.5 text-xs text-accent font-mono break-all">
            {apiKey}
          </code>
          <button
            onClick={() => { navigator.clipboard.writeText(apiKey); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
            className="flex-shrink-0 bg-ink hover:bg-ink-hover text-white rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
          >
            {copied ? '✓' : 'Copiar'}
          </button>
        </div>
        <Btn variant="secondary" onClick={onClose} className="w-full">Ya la guardé, cerrar</Btn>
      </div>
    </Modal>
  )
}

// ── Reset password modal ──────────────────────────────────────────────────────
function ResetPasswordModal({ user, onClose }) {
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [done,     setDone]     = useState(false)

  async function submit() {
    if (!password) return setError('Ingresá una contraseña')
    if (password !== confirm) return setError('Las contraseñas no coinciden')
    if (password.length < 12) return setError('Mínimo 12 caracteres')
    setSaving(true); setError('')
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: password }),
      })
      if (!res.ok) { const d = await res.json(); setError(d.message ?? d.error ?? 'Error'); return }
      setDone(true)
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={`Nueva contraseña — ${user.name}`} onClose={onClose} width="max-w-sm">
      {done ? (
        <div className="space-y-4">
          <p className="text-sm text-ok font-medium">✓ Contraseña actualizada correctamente</p>
          <Btn onClick={onClose} className="w-full">Cerrar</Btn>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Nueva contraseña">
            <Input type="password" placeholder="Mínimo 12 caracteres" value={password}
              onChange={e => setPassword(e.target.value)} autoFocus />
          </Field>
          <Field label="Confirmar contraseña">
            <Input type="password" placeholder="Repetir contraseña" value={confirm}
              onChange={e => setConfirm(e.target.value)} onKey={e => e.key === 'Enter' && submit()} />
          </Field>
          {error && <p className="text-xs text-err">{error}</p>}
          <div className="flex gap-3">
            <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
            <Btn onClick={submit} disabled={saving} className="flex-1">
              {saving ? 'Guardando…' : 'Guardar contraseña'}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Create / Edit modal ───────────────────────────────────────────────────────
function UserModal({ user, teams, onSave, onClose }) {
  const isEdit = !!user
  const [form, setForm] = useState({
    email:      user?.email   ?? '',
    name:       user?.name    ?? '',
    teamId:     user?.team_id ?? '',
    role:       user?.role    ?? 'member',
    password:   '',
    giveApiKey: false,
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function submit() {
    if (!isEdit && !form.email) return setError('Email requerido')
    if (!isEdit && !form.password && !form.giveApiKey)
      return setError('El usuario necesita contraseña o API key')

    setSaving(true); setError('')
    try {
      const url    = isEdit ? `/api/users/${user.id}` : '/api/users'
      const method = isEdit ? 'PATCH' : 'POST'
      const payload = isEdit
        ? { name: form.name, teamId: form.teamId, role: form.role }
        : { email: form.email, name: form.name, teamId: form.teamId,
            role: form.role, password: form.password || null, giveApiKey: form.giveApiKey }

      const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json()
      if (!res.ok) { setError(data.message ?? data.error ?? 'Error al guardar'); return }
      onSave(data)
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? `Editar — ${user.name}` : 'Nuevo usuario'} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        {!isEdit && (
          <Field label="Email *">
            <Input type="email" placeholder="usuario@empresa.com" value={form.email}
              onChange={e => set('email', e.target.value)} autoFocus />
          </Field>
        )}

        <Field label="Nombre">
          <Input placeholder="Nombre completo" value={form.name}
            onChange={e => set('name', e.target.value)} autoFocus={isEdit} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Equipo">
            <Select value={form.teamId} onChange={e => set('teamId', e.target.value)}>
              <option value="">Sin equipo</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Rol">
            <Select value={form.role} onChange={e => set('role', e.target.value)}>
              {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </Select>
          </Field>
        </div>

        {!isEdit && (
          <div className="border border-border rounded-xl p-4 space-y-3">
            <p className="text-xs font-semibold text-muted uppercase tracking-wide">Tipo de acceso</p>

            <div className="space-y-1">
              <label className="text-xs font-medium text-default block mb-1">
                Contraseña (acceso a la consola)
              </label>
              <Input type="password" placeholder="Dejar vacío si solo usa API key"
                value={form.password} onChange={e => set('password', e.target.value)} />
            </div>

            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" className="accent-accent"
                checked={form.giveApiKey} onChange={e => set('giveApiKey', e.target.checked)} />
              <div>
                <div className="text-sm font-medium text-default">Generar API key</div>
                <div className="text-xs text-muted">Para desarrolladores y llamadas directas</div>
              </div>
            </label>
          </div>
        )}

        {error && <p className="text-xs text-err">{error}</p>}

        <div className="flex gap-3 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Crear usuario'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Invite modal ──────────────────────────────────────────────────────────────
// A link that works once, for 72 hours, where the person chooses their own
// password (POST /api/invitations). Sent by email when the console has SMTP;
// the link is shown either way, to pass on another way.
function InviteModal({ teams, onDone, onClose }) {
  const [form, setForm]   = useState({ email: '', teamId: '', role: 'member' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [copied, setCopied] = useState(false)
  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function submit() {
    if (!form.email) return setError('Email requerido')
    setSaving(true); setError('')
    try {
      const res = await fetch('/api/invitations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, role: form.role, teamId: form.teamId || null }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.message ?? 'No se pudo invitar.'); return }
      setResult(data)
      onDone()
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  if (result) {
    return (
      <Modal title="Invitación creada" onClose={onClose} width="max-w-md">
        <div className="space-y-4">
          <p className="text-sm text-default">
            {result.sent
              ? <>Le enviamos el enlace a <b>{result.invitation.email}</b>. Si no le llega, pasale este:</>
              : <>La consola no tiene email configurado: pasale este enlace a <b>{result.invitation.email}</b> por otro medio.</>}
          </p>
          <div className="flex gap-2 items-center">
            <code data-testid="invite-link" className="flex-1 bg-raised border border-border rounded-lg px-3 py-2.5 text-xs text-accent font-mono break-all">
              {result.link}
            </code>
            <button onClick={() => { navigator.clipboard.writeText(result.link); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
              className="flex-shrink-0 bg-ink hover:bg-ink-hover text-white rounded-lg px-3 py-2 text-xs font-semibold transition-colors">
              {copied ? '✓' : 'Copiar'}
            </button>
          </div>
          <p className="text-xs text-muted">Sirve una sola vez, durante 72 horas. Quien lo abre elige su contraseña.</p>
          <Btn variant="secondary" onClick={onClose} className="w-full">Listo</Btn>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Invitar por email" onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <Field label="Email *">
          <Input type="email" placeholder="persona@empresa.com" value={form.email}
            onChange={e => set('email', e.target.value)} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Equipo">
            <Select value={form.teamId} onChange={e => set('teamId', e.target.value)}>
              <option value="">Sin equipo</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Rol">
            <Select value={form.role} onChange={e => set('role', e.target.value)}>
              {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </Select>
          </Field>
        </div>
        <p className="text-xs text-muted">
          Recibe un enlace que sirve una vez, durante 72 horas, para elegir su contraseña. Nadie más la conoce.
        </p>
        {error && <p className="text-xs text-err">{error}</p>}
        <div className="flex gap-3 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">{saving ? 'Invitando…' : 'Invitar'}</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Access badges ─────────────────────────────────────────────────────────────
function AccessBadges({ user }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {user.has_password && (
        <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5">
          Consola{user.has_mfa ? ' · 2 pasos' : ''}
        </span>
      )}
      {user.has_api_key && (
        <span className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2 py-0.5">
          API key
        </span>
      )}
      {user.app_access === false && (
        <span className="text-xs text-subtle border border-border rounded-full px-2 py-0.5"
          title="Ninguna aplicación (como un portal de chat) puede actuar en su nombre">
          Sin aplicaciones
        </span>
      )}
      {!user.has_password && !user.has_api_key && (
        <span className="text-xs text-subtle">Sin acceso</span>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function UsersPage() {
  const [users,     setUsers]     = useState([])
  const [invites,   setInvites]   = useState([])
  const [teams,     setTeams]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(null)   // 'create' | { user } | { reset: user }
  const [revealKey, setRevealKey] = useState(null)
  const [rotating,  setRotating]  = useState(null)
  const [search,    setSearch]    = useState('')
  const [filter,    setFilter]    = useState('all')  // all | active | inactive
  const { can, fixed } = usePermissions()
  const canManage = can('users.manage')
  const full      = fixed('people')
  const canKeys   = can('keys.manage')

  const load = useCallback(async () => {
    setLoading(true)
    const [u, t, i] = await Promise.all([
      fetch('/api/users').then(r => r.json()),
      fetch('/api/teams').then(r => r.json()),
      fetch('/api/invitations').then(r => r.json()).catch(() => []),
    ])
    setUsers(Array.isArray(u) ? u : [])
    setInvites(Array.isArray(i) ? i : [])
    setTeams(Array.isArray(t) ? t : [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = users.filter(u => {
    const matchSearch = !search ||
      u.name?.toLowerCase().includes(search.toLowerCase()) ||
      u.email?.toLowerCase().includes(search.toLowerCase()) ||
      u.team_name?.toLowerCase().includes(search.toLowerCase())
    const matchFilter = filter === 'all' ||
      (filter === 'active' && u.is_active) ||
      (filter === 'inactive' && !u.is_active)
    return matchSearch && matchFilter
  })

  async function toggleActive(user) {
    const res = await fetch(`/api/users/${user.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !user.is_active }),
    })
    if (!res.ok) window.alert((await res.json()).message ?? 'No se pudo cambiar el estado.')
    load()
  }

  async function toggleApps(user) {
    const res = await fetch(`/api/users/${user.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appAccess: user.app_access === false }),
    })
    if (!res.ok) window.alert((await res.json()).message ?? 'No se pudo cambiar el acceso a aplicaciones.')
    load()
  }

  async function resetMfa(user) {
    if (!window.confirm(`¿Reiniciar la verificación en dos pasos de ${user.email}? Sus sesiones terminan; al volver a entrar la configura de nuevo.`)) return
    const res = await fetch(`/api/users/${user.id}/mfa`, { method: 'DELETE' })
    if (!res.ok) window.alert((await res.json()).message ?? 'No se pudo reiniciar.')
    load()
  }

  async function revokeKey(user) {
    if (!window.confirm(`¿Revocar la API key de ${user.email}? Deja de funcionar en todos los gateways en 30 s como máximo.`)) return
    const res = await fetch(`/api/users/${user.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove-key' }),
    })
    if (!res.ok) window.alert((await res.json()).message ?? 'No se pudo revocar la key.')
    load()
  }

  async function rotateKey(user) {
    setRotating(user.id)
    const res  = await fetch(`/api/users/${user.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rotate-key' }),
    })
    const data = await res.json()
    setRotating(null)
    if (!res.ok) window.alert(data.message ?? 'No se pudo rotar la key.')
    if (data.apiKey) setRevealKey(data.apiKey)
  }

  async function revokeInvite(inv) {
    if (!window.confirm(`¿Anular la invitación de ${inv.email}? El enlace deja de funcionar.`)) return
    const res = await fetch(`/api/invitations/${inv.id}`, { method: 'DELETE' })
    if (!res.ok) window.alert((await res.json()).message ?? 'No se pudo anular.')
    load()
  }

  function handleSave(data) {
    setModal(null)
    if (data.apiKey) setRevealKey(data.apiKey)
    load()
  }

  const narrow = useNarrow()
  // A person's actions: in the table's last column, or under the card on a phone.
  const actions = (user) => (
    <>
      {canManage && (
        <button onClick={() => setModal({ user })}
          className="text-xs text-muted hover:text-default px-2 py-1 rounded hover:bg-raised transition-colors whitespace-nowrap">
          Editar
        </button>
      )}
      {canManage && user.has_password && (
        <button onClick={() => setModal({ reset: user })}
          className="text-xs text-muted hover:text-default px-2 py-1 rounded hover:bg-raised transition-colors whitespace-nowrap">
          Nueva contraseña
        </button>
      )}
      {canManage && user.has_mfa && (
        <button onClick={() => resetMfa(user)}
          className="text-xs text-muted hover:text-default px-2 py-1 rounded hover:bg-raised transition-colors whitespace-nowrap">
          Reiniciar 2 pasos
        </button>
      )}
      {canKeys && user.has_api_key && (
        <button onClick={() => rotateKey(user)}
          disabled={rotating === user.id || !user.is_active}
          className="text-xs text-accent hover:text-accent-hover px-2 py-1 rounded hover:bg-raised transition-colors whitespace-nowrap disabled:opacity-30">
          {rotating === user.id ? '…' : 'Rotar key'}
        </button>
      )}
      {canKeys && user.has_api_key && (
        <button onClick={() => revokeKey(user)}
          className="text-xs text-err hover:text-err px-2 py-1 rounded hover:bg-raised transition-colors whitespace-nowrap">
          Revocar key
        </button>
      )}
      {canManage && user.is_active && (
        <button onClick={() => toggleApps(user)}
          title="Aplicaciones que actúan en nombre de personas, como un portal de chat"
          className="text-xs text-muted hover:text-default px-2 py-1 rounded hover:bg-raised transition-colors whitespace-nowrap">
          {user.app_access === false ? 'Permitir aplicaciones' : 'Quitar aplicaciones'}
        </button>
      )}
      {canManage && (
        <button onClick={() => toggleActive(user)}
          className={`text-xs px-2 py-1 rounded hover:bg-raised transition-colors whitespace-nowrap
            ${user.is_active ? 'text-err hover:text-err' : 'text-ok hover:text-ok'}`}>
          {user.is_active ? 'Desactivar' : 'Activar'}
        </button>
      )}
    </>
  )

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Usuarios</h1>
          <p className="text-sm text-muted mt-0.5">
            {users.length} usuarios · {teams.length} equipos
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Btn variant="secondary" onClick={() => setModal('invite')} disabled={!!full} title={full ?? undefined}>Invitar por email</Btn>
            <Btn onClick={() => setModal('create')} disabled={!!full} title={full ?? undefined}>+ Nuevo usuario</Btn>
          </div>
        )}
        {canManage && full && <p data-testid="plan-fixed" className="basis-full text-right text-xs text-muted">{canManage && full}</p>}
      </div>

      {/* Open invitations */}
      {invites.length > 0 && (
        <div className="bg-card border border-border rounded-[10px] mb-4" data-testid="invitations">
          <p className="px-5 pt-4 pb-2 text-xs font-semibold text-muted uppercase tracking-wide">Invitaciones pendientes</p>
          <ul className="divide-y divide-border">
            {invites.map(inv => (
              <li key={inv.id} className="px-5 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="font-semibold text-strong">{inv.email}</span>
                <span className="text-xs text-muted">{ROLE_LABEL[inv.role] ?? inv.role}{inv.team_name ? ` · ${inv.team_name}` : ''}</span>
                <span className={`text-xs ${inv.expired ? 'text-err' : 'text-subtle'}`}>
                  {inv.expired ? 'Venció: invitá de nuevo' : `Vence ${new Date(inv.expires_at).toLocaleString('es-UY', { dateStyle: 'short', timeStyle: 'short' })}`}
                </span>
                <span className="text-xs text-subtle">por {inv.invited_by}</span>
                {canManage && (
                  <button onClick={() => revokeInvite(inv)}
                    className="ml-auto text-xs text-err hover:text-err px-2 py-1 rounded hover:bg-raised transition-colors">
                    Anular
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="search"
          aria-label="Buscar personas"
          placeholder="Buscar por nombre, email o equipo…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] bg-raised border border-border rounded-lg px-3.5 py-2 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
        />
        <select
          aria-label="Mostrar"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="bg-raised border border-border rounded-lg px-3 py-2 text-sm text-default focus:outline-none focus:ring-2 focus:ring-accent/30"
        >
          <option value="all">Todos</option>
          <option value="active">Activos</option>
          <option value="inactive">Inactivos</option>
        </select>
      </div>

      {/* Table; on a phone, one card per person */}
      <div className="relative bg-card border border-border rounded-[10px] overflow-x-auto" tabIndex={0} role="region" aria-label="Usuarios">
        {loading ? (
          <div className="p-10 text-center text-muted text-sm">Cargando…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-subtle text-sm">
            {search ? 'No hay usuarios que coincidan con la búsqueda' : 'No hay usuarios todavía'}
          </div>
        ) : narrow ? (
          <ul className="divide-y divide-border">
            {filtered.map(user => (
              <li key={user.id} className={`px-4 py-3.5 flex flex-col gap-2 ${!user.is_active ? 'bg-raised' : ''}`}>
                <div className="min-w-0">
                  <div className="font-semibold text-strong truncate">{user.name}</div>
                  <div className="text-xs text-muted truncate">{user.email}</div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                  <span className="text-muted">{user.team_name ?? 'Sin equipo'}</span>
                  <span className="bg-raised text-muted border border-border rounded-full px-2 py-0.5">{ROLE_LABEL[user.role] ?? user.role}</span>
                  <span className={`font-semibold ${user.is_active ? 'text-ok' : 'text-subtle'}`}>{user.is_active ? '● Activo' : '○ Inactivo'}</span>
                </div>
                <AccessBadges user={user} />
                <div className="flex flex-wrap gap-1 -ml-2">{actions(user)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-xs text-muted uppercase tracking-wide border-b border-border bg-raised">
                <th className="px-5 py-3 text-left font-semibold">Usuario</th>
                <th className="px-5 py-3 text-left font-semibold">Equipo</th>
                <th className="px-5 py-3 text-left font-semibold">Rol</th>
                <th className="px-5 py-3 text-left font-semibold">Acceso</th>
                <th className="px-5 py-3 text-left font-semibold">Estado</th>
                <th className="px-5 py-3 text-right font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(user => (
                <tr key={user.id}
                  className={`hover:bg-raised transition-colors ${!user.is_active ? 'bg-raised' : ''}`}>
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-strong">{user.name}</div>
                    <div className="text-xs text-muted">{user.email}</div>
                  </td>
                  <td className="px-5 py-3.5 text-muted text-xs">
                    {user.team_name ?? <span className="text-subtle">—</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-xs bg-raised text-muted border border-border rounded-full px-2 py-0.5">
                      {ROLE_LABEL[user.role] ?? user.role}
                    </span>
                  </td>
                  <td className="px-5 py-3.5"><AccessBadges user={user} /></td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs font-semibold ${user.is_active ? 'text-ok' : 'text-subtle'}`}>
                      {user.is_active ? '● Activo' : '○ Inactivo'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex justify-end gap-1">
                      {actions(user)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Modals */}
      {modal === 'create'  && <UserModal teams={teams} onSave={handleSave} onClose={() => setModal(null)} />}
      {modal === 'invite'  && <InviteModal teams={teams} onDone={load} onClose={() => setModal(null)} />}
      {modal?.user         && <UserModal user={modal.user} teams={teams} onSave={handleSave} onClose={() => setModal(null)} />}
      {modal?.reset        && <ResetPasswordModal user={modal.reset} onClose={() => { setModal(null); load() }} />}
      {revealKey           && <ApiKeyReveal apiKey={revealKey} onClose={() => setRevealKey(null)} />}
    </div>
  )
}
