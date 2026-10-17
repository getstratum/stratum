'use client'

import { useCallback, useEffect, useState } from 'react'

const input = 'w-full bg-raised border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent'
const label = 'block text-xs font-semibold text-muted mb-1.5'
const primary = 'bg-ink hover:bg-ink-hover disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 px-4 text-sm'
const secondary = 'bg-card border border-border text-default hover:bg-raised disabled:opacity-40 font-semibold rounded-lg py-2.5 px-4 text-sm'

async function send(url, method, body) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, data }
}

function Message({ error, ok }) {
  if (error) return <p role="alert" className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>
  if (ok) return <p role="status" className="text-xs text-ok rounded-lg px-3 py-2">{ok}</p>
  return null
}

// ── Password ──────────────────────────────────────────────────────────────────
function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext]       = useState('')
  const [repeat, setRepeat]   = useState('')
  const [state, setState]     = useState({ saving: false, error: '', done: false })

  async function submit(e) {
    e.preventDefault()
    if (next !== repeat) return setState({ saving: false, error: 'Las contraseñas nuevas no coinciden.', done: false })
    setState({ saving: true, error: '', done: false })
    try {
      const r = await send('/api/session/password', 'POST', { currentPassword: current, newPassword: next })
      if (!r.ok) return setState({ saving: false, error: r.data.message ?? 'No se pudo cambiar la contraseña.', done: false })
      setCurrent(''); setNext(''); setRepeat('')
      setState({ saving: false, error: '', done: true })
    } catch {
      setState({ saving: false, error: 'No se pudo conectar con la consola.', done: false })
    }
  }

  return (
    <section className="bg-card border border-border rounded-xl p-6">
      <h2 className="text-sm font-semibold text-strong mb-1">Contraseña</h2>
      <p className="text-xs text-muted mb-4">Cambiarla cierra tus otras sesiones.</p>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="current" className={label}>Contraseña actual</label>
          <input id="current" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} className={input} />
        </div>
        <div>
          <label htmlFor="next" className={label}>Contraseña nueva (mínimo 12 caracteres)</label>
          <input id="next" type="password" autoComplete="new-password" required minLength={12} value={next} onChange={e => setNext(e.target.value)} className={input} />
        </div>
        <div>
          <label htmlFor="repeat" className={label}>Repetir la nueva</label>
          <input id="repeat" type="password" autoComplete="new-password" required minLength={12} value={repeat} onChange={e => setRepeat(e.target.value)} className={input} />
        </div>
        <Message error={state.error} ok={state.done && 'Contraseña cambiada.'} />
        <button type="submit" disabled={state.saving} className={`w-full ${primary}`}>
          {state.saving ? 'Guardando…' : 'Cambiar contraseña'}
        </button>
      </form>
    </section>
  )
}

// ── Recovery codes, shown once ───────────────────────────────────────────────
function RecoveryCodes({ codes, onDone }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'))
      setCopied(true)
    } catch { /* the codes stay on screen to copy by hand */ }
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-default">
        Guardá estos códigos de recuperación en un lugar seguro (un gestor de contraseñas). Cada uno sirve una vez
        para entrar si perdés el teléfono. <strong>No se vuelven a mostrar.</strong>
      </p>
      <ul data-testid="recovery-codes" className="grid grid-cols-2 gap-2 font-mono text-sm bg-raised border border-border rounded-lg p-4">
        {codes.map(c => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex gap-2">
        <button type="button" onClick={copy} className={secondary}>{copied ? 'Copiados' : 'Copiar'}</button>
        <button type="button" onClick={onDone} className={primary}>Ya los guardé</button>
      </div>
    </div>
  )
}

// ── Second factor ────────────────────────────────────────────────────────────
function SecondFactor({ me, reload }) {
  const [step, setStep]         = useState('idle') // idle | password | scan | codes | regen | disable
  const [password, setPassword] = useState('')
  const [code, setCode]         = useState('')
  const [setup, setSetup]       = useState(null)
  const [codes, setCodes]       = useState(null)
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState('')
  const mfa = me.mfa

  const reset = () => { setStep('idle'); setPassword(''); setCode(''); setSetup(null); setError('') }

  async function run(fn) {
    setBusy(true); setError('')
    try { await fn() } catch { setError('No se pudo conectar con la consola.') } finally { setBusy(false) }
  }

  const begin = (e) => { e.preventDefault(); run(async () => {
    const r = await send('/api/session/mfa/setup', 'POST', { password })
    if (!r.ok) return setError(r.data.message ?? 'No se pudo empezar.')
    setSetup(r.data); setPassword(''); setStep('scan')
  }) }

  const confirm = (e) => { e.preventDefault(); run(async () => {
    const r = await send('/api/session/mfa/setup', 'PUT', { code: code.trim() })
    if (!r.ok) return setError(r.data.message ?? 'El código no coincide.')
    setCodes(r.data.recovery_codes); setCode(''); setSetup(null); setStep('codes')
  }) }

  const regenerate = (e) => { e.preventDefault(); run(async () => {
    const r = await send('/api/session/mfa/recovery-codes', 'POST', { code: code.trim() })
    if (!r.ok) return setError(r.data.message ?? 'Código incorrecto.')
    setCodes(r.data.recovery_codes); setCode(''); setStep('codes')
  }) }

  const turnOff = (e) => { e.preventDefault(); run(async () => {
    const r = await send('/api/session/mfa', 'DELETE', { password, code: code.trim() })
    if (!r.ok) return setError(r.data.message ?? 'No se pudo desactivar.')
    reset(); reload()
  }) }

  function codesSaved() {
    setCodes(null)
    reset()
    // An Owner or Admin who had to set it up can now use the whole console.
    if (mfa.enrollmentRequired) window.location.replace('/')
    else reload()
  }

  return (
    <section className="bg-card border border-border rounded-xl p-6 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-strong mb-1">Verificación en dos pasos</h2>
        <p className="text-xs text-muted">
          Además de la contraseña, un código de una aplicación de autenticación (Google Authenticator, Microsoft
          Authenticator, 1Password, Bitwarden…). {mfa.required ? 'Es obligatoria para tu rol.' : 'Es opcional para tu rol.'}
        </p>
      </div>

      {step === 'codes' && codes ? (
        <RecoveryCodes codes={codes} onDone={codesSaved} />
      ) : !mfa.enabled ? (
        step === 'idle' ? (
          <button type="button" onClick={() => setStep('password')} className={primary}>Configurar</button>
        ) : step === 'password' ? (
          <form onSubmit={begin} className="space-y-3">
            <div>
              <label htmlFor="mfa-password" className={label}>Tu contraseña, para confirmar</label>
              <input id="mfa-password" type="password" autoComplete="current-password" required value={password}
                onChange={e => setPassword(e.target.value)} className={input} autoFocus />
            </div>
            <Message error={error} />
            <div className="flex gap-2">
              <button type="submit" disabled={busy || !password} className={primary}>Continuar</button>
              <button type="button" onClick={reset} className={secondary}>Cancelar</button>
            </div>
          </form>
        ) : step === 'scan' && setup ? (
          <form onSubmit={confirm} className="space-y-4">
            <p className="text-sm text-default">1. Escaneá el código con la aplicación, o cargá la clave a mano.</p>
            <div className="flex flex-wrap items-start gap-4">
              {/* The SVG is generated by our own server (lib/qr.js) from the otpauth URI. */}
              <div className="bg-white p-2 rounded-lg w-44 h-44 shrink-0"
                dangerouslySetInnerHTML={{ __html: setup.qr_svg }} />
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted">Clave</p>
                <code data-testid="mfa-secret" className="block font-mono text-sm break-all text-strong">
                  {setup.secret.match(/.{1,4}/g).join(' ')}
                </code>
                <p className="text-xs text-muted">Tipo: basada en tiempo, 6 dígitos, 30 segundos.</p>
              </div>
            </div>
            <div>
              <label htmlFor="mfa-code" className={label}>2. Ingresá el código que muestra</label>
              <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" required value={code}
                onChange={e => setCode(e.target.value)} placeholder="123456" className={`${input} font-mono tracking-widest`} />
            </div>
            <Message error={error} />
            <div className="flex gap-2">
              <button type="submit" disabled={busy || !code.trim()} className={primary}>Activar</button>
              <button type="button" onClick={reset} className={secondary}>Cancelar</button>
            </div>
          </form>
        ) : null
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ok font-semibold">● Activada</p>
          {step === 'idle' && (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setStep('regen')} className={secondary}>Códigos de recuperación nuevos</button>
              {!mfa.required && <button type="button" onClick={() => setStep('disable')} className={secondary}>Desactivar</button>}
            </div>
          )}
          {step === 'regen' && (
            <form onSubmit={regenerate} className="space-y-3">
              <p className="text-xs text-muted">Los códigos anteriores dejan de servir.</p>
              <div>
                <label htmlFor="regen-code" className={label}>Código de la aplicación</label>
                <input id="regen-code" inputMode="numeric" autoComplete="one-time-code" required value={code}
                  onChange={e => setCode(e.target.value)} className={`${input} font-mono tracking-widest`} autoFocus />
              </div>
              <Message error={error} />
              <div className="flex gap-2">
                <button type="submit" disabled={busy || !code.trim()} className={primary}>Generar</button>
                <button type="button" onClick={reset} className={secondary}>Cancelar</button>
              </div>
            </form>
          )}
          {step === 'disable' && (
            <form onSubmit={turnOff} className="space-y-3">
              <div>
                <label htmlFor="off-password" className={label}>Contraseña</label>
                <input id="off-password" type="password" autoComplete="current-password" required value={password}
                  onChange={e => setPassword(e.target.value)} className={input} autoFocus />
              </div>
              <div>
                <label htmlFor="off-code" className={label}>Código de la aplicación</label>
                <input id="off-code" inputMode="numeric" autoComplete="one-time-code" required value={code}
                  onChange={e => setCode(e.target.value)} className={`${input} font-mono tracking-widest`} />
              </div>
              <Message error={error} />
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className={primary}>Desactivar</button>
                <button type="button" onClick={reset} className={secondary}>Cancelar</button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  )
}

export default function AccountPage() {
  const [me, setMe] = useState(null)
  const [notice, setNotice] = useState('')

  const load = useCallback(() => {
    fetch('/api/session').then(r => (r.ok ? r.json() : null)).then(setMe).catch(() => {})
  }, [])
  useEffect(() => {
    load()
    const left = new URLSearchParams(window.location.search).get('recovery_left')
    if (left !== null) {
      setNotice(`Entraste con un código de recuperación; te quedan ${left}. Si perdiste el teléfono, generá códigos nuevos o pedile a un Owner que reinicie tu verificación.`)
    }
  }, [load])

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-xl space-y-6">
      <div>
        <h1 className="text-[26px] font-semibold text-strong tracking-tight mb-1">Mi cuenta</h1>
        {me && <p className="text-sm text-muted">{me.user.email}</p>}
      </div>
      {me?.mfa?.enrollmentRequired && (
        <p role="alert" className="text-sm bg-warn-light text-warn border border-warn/20 rounded-lg px-4 py-3">
          Tu rol requiere la verificación en dos pasos. Configurala para usar la consola.
        </p>
      )}
      {notice && <p role="status" className="text-sm bg-raised border border-border rounded-lg px-4 py-3">{notice}</p>}
      {me && <SecondFactor me={me} reload={load} />}
      {me && !me.mfa?.enrollmentRequired && <PasswordForm />}
    </div>
  )
}
