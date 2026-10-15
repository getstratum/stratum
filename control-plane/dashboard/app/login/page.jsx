'use client'

import { useState } from 'react'

export default function LoginPage() {
  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [loading,     setLoading]     = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const [error,       setError]       = useState(() => {
    // Show message if redirected due to session expiry
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      if (params.get('reason') === 'session_expired') return 'Tu sesión terminó. Volvé a ingresar.'
    }
    return ''
  })

  async function handleLogin(e) {
    e.preventDefault()
    if (!email || !password || loading) return
    setLoading(true)
    setError('')

    try {
      const res  = await fetch('/api/session', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.message ?? 'No se pudo iniciar sesión.')
        return
      }

      setRedirecting(true)
      // Small delay ensures the cookie is committed before navigating.
      setTimeout(() => { window.location.replace('/') }, 100)

    } catch {
      setError('No se pudo conectar con la consola.')
    } finally {
      if (!redirecting) setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-app flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-9 h-9 rounded-xl bg-accent flex items-center justify-center shadow-sm">
            <svg width="16" height="16" viewBox="0 0 12 12" fill="none">
              <path d="M6 1L11 6L6 11L1 6L6 1Z" fill="white"/>
            </svg>
          </div>
          <span className="text-xl font-bold text-strong tracking-tight">Stratum</span>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-2xl shadow-card p-8">
          <h1 className="text-base font-semibold text-strong mb-1">Ingresar</h1>
          <p className="text-sm text-muted mb-6">Consola de administración</p>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="username"
                autoFocus
                required
                disabled={redirecting}
                className="w-full bg-raised border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all disabled:opacity-50"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-1.5">
                Contraseña
              </label>
              <input
                type="password" autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                disabled={redirecting}
                className="w-full bg-raised border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all disabled:opacity-50"
              />
            </div>

            {error && (
              <p className="text-xs text-err bg-err-light rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || redirecting || !email || !password}
              className="w-full bg-accent hover:bg-accent-hover disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors shadow-sm mt-2"
            >
              {redirecting ? 'Entrando…' : loading ? 'Verificando…' : 'Continuar'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-subtle mt-4">
          La sesión vence tras 30 minutos sin actividad.
        </p>

      </div>
    </div>
  )
}
