'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'
import { usePermissions } from '../../components/usePermissions'

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
  const [teams,     setTeams]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(null)   // 'create' | { user } | { reset: user }
  const [revealKey, setRevealKey] = useState(null)
  const [rotating,  setRotating]  = useState(null)
  const [search,    setSearch]    = useState('')
  const [filter,    setFilter]    = useState('all')  // all | active | inactive
  const { can } = usePermissions()
  const canManage = can('users.manage')
  const canKeys   = can('keys.manage')

  const load = useCallback(async () => {
    setLoading(true)
    const [u, t] = await Promise.all([
      fetch('/api/users').then(r => r.json()),
      fetch('/api/teams').then(r => r.json()),
    ])
    setUsers(Array.isArray(u) ? u : [])
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

  function handleSave(data) {
    setModal(null)
    if (data.apiKey) setRevealKey(data.apiKey)
    load()
  }

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
        {canManage && <Btn onClick={() => setModal('create')}>+ Nuevo usuario</Btn>}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="search"
          placeholder="Buscar por nombre, email o equipo…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] bg-raised border border-border rounded-lg px-3.5 py-2 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
        />
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="bg-raised border border-border rounded-lg px-3 py-2 text-sm text-default focus:outline-none focus:ring-2 focus:ring-accent/30"
        >
          <option value="all">Todos</option>
          <option value="active">Activos</option>
          <option value="inactive">Inactivos</option>
        </select>
      </div>

      {/* Table */}
      <div className="relative bg-card border border-border rounded-[10px] overflow-x-auto">
        {loading ? (
          <div className="p-10 text-center text-muted text-sm">Cargando…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-subtle text-sm">
            {search ? 'No hay usuarios que coincidan con la búsqueda' : 'No hay usuarios todavía'}
          </div>
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
                  className={`hover:bg-raised transition-colors ${!user.is_active ? 'opacity-50' : ''}`}>
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
      {modal?.user         && <UserModal user={modal.user} teams={teams} onSave={handleSave} onClose={() => setModal(null)} />}
      {modal?.reset        && <ResetPasswordModal user={modal.reset} onClose={() => { setModal(null); load() }} />}
      {revealKey           && <ApiKeyReveal apiKey={revealKey} onClose={() => setRevealKey(null)} />}
    </div>
  )
}
