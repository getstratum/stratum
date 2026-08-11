'use client'

import { useEffect } from 'react'

export default function Modal({ title, onClose, children, width = 'max-w-lg' }) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={`relative w-full ${width} bg-card border border-border rounded-2xl shadow-dropdown`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-strong">{title}</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-default transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  )
}

export function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-muted uppercase tracking-wide">{label}</label>
      {children}
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  )
}

export function Input({ ...props }) {
  return (
    <input
      {...props}
      className="w-full bg-card border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
    />
  )
}

export function Select({ children, ...props }) {
  return (
    <select
      {...props}
      className="w-full bg-card border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
    >
      {children}
    </select>
  )
}

export function Btn({ variant = 'primary', className = '', ...props }) {
  const base = 'px-4 py-2.5 rounded-lg text-sm font-semibold transition-all disabled:opacity-40'
  const v = {
    primary:   'bg-accent hover:bg-accent-hover text-white shadow-sm',
    secondary: 'bg-card border border-border text-default hover:bg-raised',
    danger:    'bg-err-light border border-err/20 text-err hover:bg-red-100',
  }
  return <button {...props} className={`${base} ${v[variant]} ${className}`} />
}
