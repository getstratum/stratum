'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'

const ROLES = ['user', 'admin', 'org_admin']

// ─── One-time API key reveal ──────────────────────────────────────────────────
function ApiKeyReveal({ apiKey, onClose }) {
  const [copied, setCopied] = useState(false)
  return (
    <Modal title="🔑 API Key generada" onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <div className="bg-yellow-950/40 border border-yellow-800/40 rounded-lg p-3 text-xs text-yellow-400">
          ⚠️ Esta es la única vez que se muestra esta key. Copiala ahora.
        </div>
        <div className="flex gap-2 items-center">
          <code className="flex-1 bg-surface border border-border rounded-lg px-3 py-2.5 text-xs text-emerald-300 font-mono break-all">
            {apiKey}
          </code>
          <button
            onClick={() => { navigator.clipboard.writeText(apiKey); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
            className="flex-shrink-0 bg-accent hover:bg-accent-dim text-white rounded-lg px-3 py-2.5 text-xs font-semibold"
          >
            {copied ? '✓' : 'Copiar'}
          </button>
        </div>
        <Btn variant="secondary" onClick={onClose} className="w-full">Ya la guardé, cerrar</Btn>
      </div>
    </Modal>
  )
}

// ─── Create / Edit modal ──────────────────────────────────────────────────────
function UserModal({ user, teams, onSave, onClose }) {
  const isEdit = !!user
  const [form, setForm] = useState({
    email:      user?.email   ?? '',
    name:       user?.name    ?? '',
    teamId:     user?.team_id ?? '',
    role:       user?.role    ?? 'user',
    password:   '',
    giveApiKey: user?.has_api_key ?? false,
    hasPassword: user?.has_password ?? false,
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function submit() {
    setSaving(true); setError('')
    try {
      const url    = isEdit ? `/api/users/${user.id}` : '/api/users'
      const method = isEdit ? 'PATCH' : 'POST'

      const payload = isEdit
        ? {
            name:        form.name,
            teamId:      form.teamId,
            role:        form.role,
            ...(form.password ? { newPassword: form.password } : {}),
            ...(form.removePassword ? { removePassword: true } : {}),
          }
        : {
            email:     form.email,
            name:      form.name,
            teamId:    form.teamId,
            role:      form.role,
            password:  form.password || null,
            giveApiKey: form.giveApiKey,
          }

      const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Error al guardar'); return }
      onSave(data)
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? 'Editar usuario' : 'Nuevo usuario'} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        {!isEdit && (
          <Field label="Email *">
            <Input type="email" placeholder="usuario@empresa.com" value={form.email}
              onChange={e => set('email', e.target.value)} autoFocus />
          </Field>
        )}
        <Field label="Nombre">
          <Input placeholder="Nombre completo" value={form.name} onChange={e => set('name', e.target.value)} />
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
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>
        </div>

        {/* Access type selection */}
        <div className="border border-border rounded-xl p-4 space-y-3">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Tipo de acceso</div>

          {/* Password access */}
          <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
            ${form.hasPassword || form.password ? 'border-blue-700/50 bg-blue-950/20' : 'border-border hover:border-slate-600'}`}>
            <input type="checkbox" className="mt-0.5 accent-blue-500"
              checked={isEdit ? form.hasPassword : !!form.password}
              onChange={e => {
                if (isEdit) set('hasPassword', e.target.checked)
                else if (!e.target.checked) set('password', '')
              }}
            />
            <div className="flex-1">
              <div className="text-sm font-semibold text-slate-200">💬 Acceso Playground</div>
              <div className="text-xs text-slate-500 mt-0.5">El usuario entra con email + contraseña al chat</div>
              {(!isEdit || (isEdit && form.hasPassword)) && (
                <Input
                  type="password"
                  placeholder={isEdit ? "Nueva contraseña (dejar vacío para no cambiar)" : "Contraseña *"}
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                  className="mt-2"
                />
              )}
              {isEdit && form.has_password && (
                <button
                  onClick={() => set('removePassword', true)}
                  className="text-xs text-red-400 hover:text-red-300 mt-1"
                >
                  Quitar acceso Playground
                </button>
              )}
            </div>
          </label>

          {/* API key access */}
          <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
            ${form.giveApiKey || user?.has_api_key ? 'border-emerald-700/50 bg-emerald-950/20' : 'border-border hover:border-slate-600'}`}>
            <input type="checkbox" className="mt-0.5 accent-emerald-500"
              checked={form.giveApiKey}
              onChange={e => set('giveApiKey', e.target.checked)}
            />
            <div>
              <div className="text-sm font-semibold text-slate-200">🔑 Acceso API</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {isEdit && user?.has_api_key
                  ? 'Ya tiene API key. Usar "Rotar key" para regenerar.'
                  : 'Genera una API key para llamadas directas (desarrolladores)'}
              </div>
            </div>
          </label>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
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

function AccessBadges({ user }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {user.has_password && (
        <span className="text-xs bg-blue-950/50 text-blue-300 border border-blue-800/50 rounded-full px-2 py-0.5">
          💬 Playground
        </span>
      )}
      {user.has_api_key && (
        <span className="text-xs bg-emerald-950/50 text-emerald-300 border border-emerald-800/50 rounded-full px-2 py-0.5">
          🔑 API
        </span>
      )}
      {!user.has_password && !user.has_api_key && (
        <span className="text-xs text-slate-600">Sin acceso</span>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function UsersPage() {
  const [users,     setUsers]     = useState([])
  const [teams,     setTeams]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(null)
  const [revealKey, setRevealKey] = useState(null)
  const [rotating,  setRotating]  = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [u, t] = await Promise.all([
      fetch('/api/users').then(r => r.json()),
      fetch('/api/teams').then(r => r.json()),
    ])
    setUsers(u); setTeams(t); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleActive(user) {
    await fetch(`/api/users/${user.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !user.is_active }),
    })
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
    if (data.apiKey) setRevealKey(data.apiKey)
  }

  function handleSave(data) {
    setModal(null)
    if (data.apiKey) setRevealKey(data.apiKey)
    load()
  }

  return (
    <div className="p-7 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Usuarios</h1>
          <p className="text-sm text-slate-500 mt-0.5">{users.length} usuarios · {teams.length} equipos</p>
        </div>
        <Btn onClick={() => setModal('create')}>+ Nuevo usuario</Btn>
      </div>

      <div className="bg-surface-card border border-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-slate-500 text-sm">Cargando…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wide border-b border-border">
                <th className="px-5 py-3 text-left font-semibold">Usuario</th>
                <th className="px-5 py-3 text-left font-semibold">Equipo</th>
                <th className="px-5 py-3 text-left font-semibold">Rol</th>
                <th className="px-5 py-3 text-left font-semibold">Acceso</th>
                <th className="px-5 py-3 text-left font-semibold">Estado</th>
                <th className="px-5 py-3 text-right font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map(user => (
                <tr key={user.id} className={`hover:bg-surface-hover transition-colors ${!user.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-white">{user.name}</div>
                    <div className="text-xs text-slate-500">{user.email}</div>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400 text-xs">{user.team_name ?? '—'}</td>
                  <td className="px-5 py-3.5">
                    <span className="text-xs bg-slate-800 text-slate-400 border border-slate-700 rounded-full px-2 py-0.5">
                      {user.role}
                    </span>
                  </td>
                  <td className="px-5 py-3.5"><AccessBadges user={user} /></td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs font-semibold ${user.is_active ? 'text-emerald-400' : 'text-slate-600'}`}>
                      {user.is_active ? '● Activo' : '○ Inactivo'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setModal({ user })}
                        className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1 rounded hover:bg-surface transition-colors">
                        Editar
                      </button>
                      {user.has_api_key && (
                        <button onClick={() => rotateKey(user)} disabled={rotating === user.id || !user.is_active}
                          className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-surface transition-colors disabled:opacity-30">
                          {rotating === user.id ? '…' : 'Rotar key'}
                        </button>
                      )}
                      <button onClick={() => toggleActive(user)}
                        className={`text-xs px-2 py-1 rounded hover:bg-surface transition-colors
                          ${user.is_active ? 'text-red-400 hover:text-red-300' : 'text-emerald-400 hover:text-emerald-300'}`}>
                        {user.is_active ? 'Desactivar' : 'Activar'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal === 'create' && <UserModal teams={teams} onSave={handleSave} onClose={() => setModal(null)} />}
      {modal?.user && <UserModal user={modal.user} teams={teams} onSave={handleSave} onClose={() => setModal(null)} />}
      {revealKey && <ApiKeyReveal apiKey={revealKey} onClose={() => setRevealKey(null)} />}
    </div>
  )
}
