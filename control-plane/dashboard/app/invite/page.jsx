'use client'

// The page an invitation's link opens (lib/invitations.js): /invite#<token>.
// The token is in the fragment, which the browser never sends to a server;
// this page reads it and posts it. Here the person chooses their password;
// an Owner or Admin then goes on to set up the second factor.

import { useEffect, useState } from 'react'
import PasswordInput from '../../components/PasswordInput'

const INPUT = 'w-full bg-raised border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all disabled:opacity-50'
const LABEL = 'block text-xs font-semibold text-muted uppercase tracking-wide mb-1.5'
const ROLE = { owner: 'Owner', admin: 'Admin', team_manager: 'gestor de equipo', auditor: 'Auditor', member: 'integrante' }
const MIN = 12

async function post(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { ok: res.ok, data: await res.json() }
  } catch {
    return { ok: false, data: { message: 'No se pudo conectar con la consola.' } }
  }
}

export default function InvitePage() {
  const [token, setToken] = useState(null)
  const [inv, setInv] = useState(null)        // what the invitation says
  const [state, setState] = useState('loading') // loading | form | invalid | done
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)

  useEffect(() => {
    const t = window.location.hash.slice(1)
    // Out of the address bar and the history: the link works once anyway.
    window.history.replaceState(null, '', '/invite')
    if (!t) { setState('invalid'); return }
    setToken(t)
    post('/api/invitations/lookup', { token: t }).then(r => {
      if (!r.ok) { setError(r.data.message ?? ''); setState('invalid'); return }
      setInv(r.data)
      setState('form')
    })
  }, [])

  async function accept(e) {
    e.preventDefault()
    if (busy) return
    if (!inv.sso) {
      if (password.length < MIN) return setError(`La contraseña necesita al menos ${MIN} caracteres.`)
      if (password !== again) return setError('Las dos contraseñas no coinciden.')
    }
    setBusy(true)
    setError('')
    const r = await post('/api/invitations/accept', { token, name, password: inv.sso ? undefined : password })
    setBusy(false)
    if (!r.ok) {
      setError(r.data.message ?? 'No se pudo aceptar la invitación.')
      if (r.data.error === 'invitation_invalid') setState('invalid')
      return
    }
    setPassword(''); setAgain('')
    if (r.data.next && !r.data.sso) {
      setTimeout(() => window.location.replace(r.data.next), 100)
      setState('done')
      setDone({ redirecting: true })
      return
    }
    setDone(r.data)
    setState('done')
  }

  return (
    <div className="min-h-screen bg-app flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-1.5 mb-7">
          <span className="text-[22px] font-semibold text-strong tracking-tight">Stratum</span>
          <span className="text-sm text-muted">Invitación</span>
        </div>

        <div className="bg-card border border-border rounded-[10px] p-8">
          {state === 'loading' && <p className="text-sm text-muted">Revisando la invitación…</p>}

          {state === 'invalid' && (
            <>
              <h1 className="text-base font-semibold text-strong mb-2">Este enlace no sirve</h1>
              <p className="text-sm text-muted">
                {error || 'Ya se usó, venció o la reemplazaron por otra. Pedile una nueva a quien te invitó.'}
              </p>
              <a href="/login" className="inline-block mt-5 text-sm text-accent hover:underline">Ir a ingresar</a>
            </>
          )}

          {state === 'form' && inv && (
            <>
              <h1 className="text-xl font-semibold text-strong mb-1">Te invitaron a {inv.org}</h1>
              <p className="text-sm text-muted mb-6">
                Como {ROLE[inv.role] ?? inv.role}, con <span className="text-strong">{inv.email}</span>.
                {inv.sso
                  ? ' Tu organización ingresa con su proveedor de identidad: no hace falta contraseña.'
                  : ' Elegí tu contraseña: nadie más la conoce.'}
              </p>
              <form onSubmit={accept} className="space-y-4">
                <input type="email" value={inv.email} autoComplete="username" readOnly hidden />
                <div>
                  <label htmlFor="name" className={LABEL}>Tu nombre</label>
                  <input id="name" value={name} onChange={e => setName(e.target.value)} autoComplete="name"
                    placeholder={inv.email.split('@')[0]} maxLength={255} className={INPUT} disabled={busy} />
                </div>
                {!inv.sso && (
                  <>
                    <div>
                      <label htmlFor="password" className={LABEL}>Contraseña</label>
                      <PasswordInput id="password" autoComplete="new-password" value={password} required minLength={MIN}
                        onChange={e => setPassword(e.target.value)} className={INPUT} disabled={busy} />
                      <p className="text-xs text-subtle mt-1">Al menos {MIN} caracteres.</p>
                    </div>
                    <div>
                      <label htmlFor="again" className={LABEL}>Repetila</label>
                      <PasswordInput id="again" autoComplete="new-password" value={again} required
                        onChange={e => setAgain(e.target.value)} className={INPUT} disabled={busy} />
                    </div>
                  </>
                )}
                {error && <p role="alert" className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
                <button type="submit" disabled={busy || (!inv.sso && (!password || !again))}
                  className="w-full bg-ink hover:bg-ink-hover disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors shadow-sm">
                  {busy ? 'Creando tu cuenta…' : 'Aceptar la invitación'}
                </button>
              </form>
              <p className="text-xs text-subtle mt-4">
                Vence el {new Date(inv.expires_at).toLocaleString('es-UY', { dateStyle: 'long', timeStyle: 'short' })}
              </p>
            </>
          )}

          {state === 'done' && done && (
            done.redirecting ? <p className="text-sm text-muted">Listo. Entrando…</p> : (
              <>
                <h1 className="text-base font-semibold text-strong mb-2">Tu cuenta está lista</h1>
                <p className="text-sm text-muted">
                  {done.sso
                    ? 'Ingresá con «Entrar con SSO», con la cuenta de tu organización.'
                    : 'Ya podés entrar a las aplicaciones de tu organización con tu email y esta contraseña.'}
                </p>
                {done.sso && <a href="/login" className="inline-block mt-5 text-sm text-accent hover:underline">Ir a ingresar</a>}
              </>
            )
          )}
        </div>
      </div>
    </div>
  )
}
