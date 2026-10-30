'use client'

import { useEffect, useState } from 'react'
import { SSO_MESSAGES } from '../../lib/sso-messages.js'

const INPUT = 'w-full bg-raised border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all disabled:opacity-50'
const LABEL = 'block text-xs font-semibold text-muted uppercase tracking-wide mb-1.5'

export default function LoginPage() {
  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  // Second step: the challenge from a correct password, and the code.
  const [challenge,   setChallenge]   = useState(null)
  const [code,        setCode]        = useState('')
  const [loading,     setLoading]     = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const [error,       setError]       = useState('')
  // After hydration: the server renders the page without the query string,
  // and a first render that differs from it is a hydration error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('reason') === 'session_expired') setError('Tu sesión terminó. Volvé a ingresar.')
    const sso = params.get('sso')
    if (sso) setError(SSO_MESSAGES[sso] ?? SSO_MESSAGES.provider)
  }, [])

  function go(path) {
    setRedirecting(true)
    // Small delay ensures the cookie is committed before navigating.
    setTimeout(() => { window.location.replace(path) }, 100)
  }

  async function post(url, body) {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      return { ok: res.ok, data: await res.json() }
    } catch {
      setError('No se pudo conectar con la consola.')
      return null
    } finally {
      setLoading(false)
    }
  }

  async function handlePassword(e) {
    e.preventDefault()
    if (!email || !password || loading) return
    const r = await post('/api/session', { email, password })
    if (!r) return
    if (!r.ok) return setError(r.data.message ?? 'No se pudo iniciar sesión.')
    if (r.data.mfa_required) {
      setChallenge(r.data.challenge)
      setPassword('')
      return
    }
    go(r.data.mfa_enrollment_required ? '/account?mfa=required' : '/')
  }

  async function handleCode(e) {
    e.preventDefault()
    if (!code.trim() || loading) return
    const r = await post('/api/session/mfa', { challenge, code: code.trim() })
    if (!r) return
    if (!r.ok) {
      setCode('')
      return setError(r.data.message ?? 'Código incorrecto.')
    }
    go(r.data.recovery_codes_left !== undefined ? `/account?recovery_left=${r.data.recovery_codes_left}` : '/')
  }

  // The organization's identity provider, chosen by the email's domain.
  async function handleSso() {
    if (!email || loading) return
    const r = await post('/api/sso/start', { email })
    if (!r) return
    if (!r.ok) return setError(r.data.message ?? 'No se pudo ingresar con SSO.')
    setRedirecting(true)
    window.location.assign(r.data.redirect)
  }

  function restart() {
    setChallenge(null)
    setCode('')
    setError('')
  }

  return (
    <div className="min-h-screen bg-app flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        <div className="flex flex-col items-center gap-1.5 mb-7">
          <span className="text-[22px] font-semibold text-strong tracking-tight">Stratum</span>
          <span className="text-sm text-muted">Consola de administración</span>
        </div>

        <div className="bg-card border border-border rounded-[10px] p-8">
          {!challenge ? (
            <>
              <h1 className="text-xl font-semibold text-strong mb-6">Ingresá a tu organización</h1>

              <form onSubmit={handlePassword} className="space-y-4">
                <div>
                  <label htmlFor="email" className={LABEL}>Email</label>
                  <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="you@company.com" autoComplete="username" autoFocus required
                    disabled={redirecting} className={INPUT} />
                </div>
                <div>
                  <label htmlFor="password" className={LABEL}>Contraseña</label>
                  <input id="password" type="password" autoComplete="current-password" value={password}
                    onChange={e => setPassword(e.target.value)} required disabled={redirecting} className={INPUT} />
                </div>
                {error && <p role="alert" className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
                <button type="submit" disabled={loading || redirecting || !email || !password}
                  className="w-full bg-ink hover:bg-ink-hover disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors shadow-sm mt-2">
                  {redirecting ? 'Entrando…' : loading ? 'Verificando…' : 'Continuar'}
                </button>
              </form>
              <div className="flex items-center gap-3 my-5 text-xs text-subtle" aria-hidden="true">
                <span className="flex-1 border-t border-border" />o<span className="flex-1 border-t border-border" />
              </div>
              <button type="button" onClick={handleSso} disabled={loading || redirecting || !email}
                className="w-full border border-border-strong bg-card hover:bg-raised disabled:opacity-40 text-strong font-semibold rounded-lg py-2.5 text-sm transition-colors">
                Entrar con SSO
              </button>
              <p className="text-xs text-subtle mt-2">Con la cuenta de tu organización (Google Workspace, Microsoft…): escribí tu email y tocá el botón.</p>
            </>
          ) : (
            <>
              <h1 className="text-base font-semibold text-strong mb-1">Verificación en dos pasos</h1>
              <p className="text-sm text-muted mb-6">
                Ingresá el código de 6 dígitos de tu aplicación de autenticación, o uno de tus códigos de recuperación.
              </p>

              <form onSubmit={handleCode} className="space-y-4">
                <div>
                  <label htmlFor="code" className={LABEL}>Código</label>
                  <input id="code" type="text" autoComplete="one-time-code" value={code}
                    onChange={e => setCode(e.target.value)} placeholder="123456" autoFocus required
                    disabled={redirecting} className={`${INPUT} font-mono tracking-widest`} />
                </div>
                {error && <p role="alert" className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
                <button type="submit" disabled={loading || redirecting || !code.trim()}
                  className="w-full bg-ink hover:bg-ink-hover disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors shadow-sm">
                  {redirecting ? 'Entrando…' : loading ? 'Verificando…' : 'Ingresar'}
                </button>
                <button type="button" onClick={restart} className="w-full text-xs text-muted hover:text-default">
                  Volver a empezar
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-xs text-subtle mt-4">
          La sesión vence tras 30 minutos sin actividad.
        </p>

      </div>
    </div>
  )
}
