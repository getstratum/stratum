'use client'

// Sign-in to an application with the console account (lib/oidc.js). The
// application sent the browser to /api/oidc/authorize, which brought it
// here with ?i=<interaction>; at the end the browser goes back to the
// application with a code.

import { useEffect, useState } from 'react'
import { SSO_MESSAGES } from '../../../lib/sso-messages.js'

const INPUT = 'w-full bg-raised border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all disabled:opacity-50'
const LABEL = 'block text-xs font-semibold text-muted uppercase tracking-wide mb-1.5'
// What /api/oidc/authorize may send here; any other value shows the first.
const FATAL = {
  unknown_client: 'La aplicación no está registrada en la consola, o fue dada de baja.',
  bad_redirect_uri: 'La dirección de retorno no es una de las registradas para esta aplicación.',
}
const BUTTON = 'w-full bg-ink hover:bg-ink-hover disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors shadow-sm'

export default function AppSignIn() {
  const [interaction, setInteraction] = useState(null)
  const [info, setInfo]               = useState(null)   // { client, org }
  const [fatal, setFatal]             = useState('')
  const [step, setStep]               = useState('password') // password | code | setup | codes
  const [email, setEmail]             = useState('')
  const [password, setPassword]       = useState('')
  const [challenge, setChallenge]     = useState(null)
  const [setup, setSetup]             = useState(null)   // { secret, qr_svg }
  const [code, setCode]               = useState('')
  const [recovery, setRecovery]       = useState(null)
  const [redirect, setRedirect]       = useState(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState('')

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('error')) { setFatal(FATAL[q.get('error')] ?? FATAL.unknown_client); return }
    const i = q.get('i')
    if (!i) { setFatal('Falta el ingreso. Volvé a la aplicación y empezá de nuevo.'); return }
    setInteraction(i)
    if (q.get('sso')) setError(SSO_MESSAGES[q.get('sso')] ?? SSO_MESSAGES.provider)
    fetch(`/api/oidc/interaction?i=${encodeURIComponent(i)}`)
      .then(async r => { const d = await r.json(); r.ok ? setInfo(d) : setFatal(d.message) })
      .catch(() => setFatal('No se pudo conectar con la consola.'))
  }, [])

  async function post(url, body) {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: interaction, ...body }),
      })
      const data = await res.json()
      if (res.status === 404) { setFatal(data.message); return null }
      if (!res.ok) { setError(data.message ?? 'No se pudo ingresar.'); return null }
      return data
    } catch {
      setError('No se pudo conectar con la consola.')
      return null
    } finally {
      setLoading(false)
    }
  }

  // The organization's identity provider, chosen by the email's domain.
  async function submitSso() {
    if (!email || loading) return
    const d = await post('/api/sso/start', { email })
    if (d?.redirect) window.location.assign(d.redirect)
  }

  async function submitPassword(e) {
    e.preventDefault()
    if (!email || !password || loading) return
    const d = await post('/api/oidc/login', { email, password })
    if (!d) return
    setPassword('')
    if (d.redirect) return window.location.replace(d.redirect)
    setChallenge(d.challenge)
    if (d.mfa_enrollment_required) {
      setSetup({ secret: d.secret, qr_svg: d.qr_svg })
      setStep('setup')
    } else {
      setStep('code')
    }
  }

  async function submitCode(e) {
    e.preventDefault()
    if (!code.trim() || loading) return
    const d = await post('/api/oidc/login/mfa', { challenge, code: code.trim() })
    setCode('')
    if (!d) return
    if (d.recovery_codes) {
      setRecovery(d.recovery_codes)
      setRedirect(d.redirect)
      setStep('codes')
      return
    }
    window.location.replace(d.redirect)
  }

  return (
    <div className="min-h-screen bg-app flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-1.5 mb-7">
          <span className="text-[22px] font-semibold text-strong tracking-tight">Stratum</span>
          <span className="text-sm text-muted">{info ? `Cuenta de ${info.org}` : 'Ingreso a una aplicación'}</span>
        </div>

        <div className="bg-card border border-border rounded-[10px] p-8">
          {fatal ? (
            <>
              <h1 className="text-base font-semibold text-strong mb-2">No se puede ingresar</h1>
              <p role="alert" className="text-sm text-muted">{fatal}</p>
            </>
          ) : !info ? (
            <p className="text-sm text-muted">Cargando…</p>
          ) : step === 'password' ? (
            <>
              <h1 className="text-xl font-semibold text-strong mb-1">Ingresá a {info.client}</h1>
              <p className="text-sm text-muted mb-6">Con tu cuenta de Stratum en {info.org}.</p>
              <form onSubmit={submitPassword} className="space-y-4">
                <div>
                  <label htmlFor="email" className={LABEL}>Email</label>
                  <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                    autoComplete="username" autoFocus required className={INPUT} />
                </div>
                <div>
                  <label htmlFor="password" className={LABEL}>Contraseña</label>
                  <input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password" required className={INPUT} />
                </div>
                {error && <p role="alert" className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
                <button type="submit" disabled={loading || !email || !password} className={BUTTON}>
                  {loading ? 'Verificando…' : 'Continuar'}
                </button>
              </form>
              <div className="flex items-center gap-3 my-5 text-xs text-subtle" aria-hidden="true">
                <span className="flex-1 border-t border-border" />o<span className="flex-1 border-t border-border" />
              </div>
              <button type="button" onClick={submitSso} disabled={loading || !email}
                className="w-full border border-border-strong bg-card hover:bg-raised disabled:opacity-40 text-strong font-semibold rounded-lg py-2.5 text-sm transition-colors">
                Entrar con SSO
              </button>
              <p className="text-xs text-subtle mt-2">Con la cuenta de tu organización (Google Workspace, Microsoft…): escribí tu email y tocá el botón.</p>
            </>
          ) : step === 'code' ? (
            <>
              <h1 className="text-base font-semibold text-strong mb-1">Verificación en dos pasos</h1>
              <p className="text-sm text-muted mb-6">
                El código de 6 dígitos de tu aplicación de autenticación, o uno de tus códigos de recuperación.
              </p>
              <form onSubmit={submitCode} className="space-y-4">
                <div>
                  <label htmlFor="code" className={LABEL}>Código</label>
                  <input id="code" type="text" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)}
                    autoFocus required className={`${INPUT} font-mono tracking-widest`} />
                </div>
                {error && <p role="alert" className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
                <button type="submit" disabled={loading || !code.trim()} className={BUTTON}>
                  {loading ? 'Verificando…' : 'Ingresar'}
                </button>
              </form>
            </>
          ) : step === 'setup' ? (
            <>
              <h1 className="text-base font-semibold text-strong mb-1">Configurá la verificación en dos pasos</h1>
              <p className="text-sm text-muted mb-4">
                {info.client} la pide. Escaneá el código con tu aplicación de autenticación (Google Authenticator,
                1Password, Authy) e ingresá el primer código que muestre.
              </p>
              <div className="flex justify-center mb-3" aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: setup.qr_svg }} />
              <p className="text-xs text-muted mb-5 break-all">
                Si no podés escanearlo: <code className="font-mono text-default">{setup.secret}</code>
              </p>
              <form onSubmit={submitCode} className="space-y-4">
                <div>
                  <label htmlFor="first-code" className={LABEL}>Primer código</label>
                  <input id="first-code" type="text" inputMode="numeric" autoComplete="one-time-code" value={code}
                    onChange={e => setCode(e.target.value)} autoFocus required className={`${INPUT} font-mono tracking-widest`} />
                </div>
                {error && <p role="alert" className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
                <button type="submit" disabled={loading || !code.trim()} className={BUTTON}>
                  {loading ? 'Verificando…' : 'Activar e ingresar'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-base font-semibold text-strong mb-1">Tus códigos de recuperación</h1>
              <p className="text-sm text-muted mb-4">
                Sirven una vez cada uno si perdés el teléfono. Guardalos en un lugar seguro: no se vuelven a mostrar.
              </p>
              <ul className="grid grid-cols-2 gap-2 font-mono text-sm text-strong bg-raised border border-border rounded-lg p-3 mb-5">
                {recovery.map(c => <li key={c}>{c}</li>)}
              </ul>
              <button type="button" onClick={() => window.location.replace(redirect)} className={BUTTON}>
                Ya los guardé, continuar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
