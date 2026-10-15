'use client'

import { useState } from 'react'

const input = 'w-full bg-raised border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent'

export default function AccountPage() {
  const [current, setCurrent] = useState('')
  const [next, setNext]       = useState('')
  const [repeat, setRepeat]   = useState('')
  const [state, setState]     = useState({ saving: false, error: '', done: false })

  async function submit(e) {
    e.preventDefault()
    if (next !== repeat) return setState({ saving: false, error: 'Las contraseñas nuevas no coinciden.', done: false })
    setState({ saving: true, error: '', done: false })
    try {
      const res = await fetch('/api/session/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      const data = await res.json()
      if (!res.ok) return setState({ saving: false, error: data.message ?? 'No se pudo cambiar la contraseña.', done: false })
      setCurrent(''); setNext(''); setRepeat('')
      setState({ saving: false, error: '', done: true })
    } catch {
      setState({ saving: false, error: 'No se pudo conectar con la consola.', done: false })
    }
  }

  return (
    <div className="p-7 max-w-md">
      <h1 className="text-lg font-semibold text-strong mb-1">Mi cuenta</h1>
      <p className="text-sm text-muted mb-6">Cambiar tu contraseña cierra tus otras sesiones.</p>
      <form onSubmit={submit} className="space-y-4 bg-card border border-border rounded-xl p-6">
        <div>
          <label htmlFor="current" className="block text-xs font-semibold text-muted mb-1.5">Contraseña actual</label>
          <input id="current" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} className={input} />
        </div>
        <div>
          <label htmlFor="next" className="block text-xs font-semibold text-muted mb-1.5">Contraseña nueva (mínimo 12 caracteres)</label>
          <input id="next" type="password" autoComplete="new-password" required minLength={12} value={next} onChange={e => setNext(e.target.value)} className={input} />
        </div>
        <div>
          <label htmlFor="repeat" className="block text-xs font-semibold text-muted mb-1.5">Repetir la nueva</label>
          <input id="repeat" type="password" autoComplete="new-password" required minLength={12} value={repeat} onChange={e => setRepeat(e.target.value)} className={input} />
        </div>
        {state.error && <p className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{state.error}</p>}
        {state.done && <p className="text-xs text-ok rounded-lg px-3 py-2">Contraseña cambiada.</p>}
        <button type="submit" disabled={state.saving} className="w-full bg-accent hover:bg-accent-hover disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 text-sm">
          {state.saving ? 'Guardando…' : 'Cambiar contraseña'}
        </button>
      </form>
    </div>
  )
}
