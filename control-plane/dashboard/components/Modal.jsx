'use client'

import { Children, cloneElement, isValidElement, useEffect, useId } from 'react'

export default function Modal({ title, onClose, children, width = 'max-w-lg' }) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={title} className={`relative w-full ${width} bg-card border border-border rounded-xl shadow-dropdown`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-strong">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
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

const LABEL = 'block text-xs font-semibold text-muted uppercase tracking-wide'
const CONTROLS = new Set(['input', 'select', 'textarea'])

// A field whose content is one control (Input, Select or a native one) gets a
// real <label for>, and its hint is the control's description: screen readers
// announce both, and tests find the control by its label alone. Anything else
// (a group of checkboxes, a control plus a note) keeps a plain heading.
export function Field({ label, hint, children }) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const control = Children.count(children) === 1 && isValidElement(children) &&
    (children.type === Input || children.type === Select || CONTROLS.has(children.type))
  if (!control) {
    return (
      <div className="block space-y-1.5">
        <span className={LABEL}>{label}</span>
        {children}
        {hint && <span className="block text-xs text-subtle">{hint}</span>}
      </div>
    )
  }
  const controlId = children.props.id ?? id
  return (
    <div className="block space-y-1.5">
      <label htmlFor={controlId} className={LABEL}>{label}</label>
      {cloneElement(children, { id: controlId, 'aria-describedby': hintId })}
      {hint && <span id={hintId} className="block text-xs text-subtle">{hint}</span>}
    </div>
  )
}

export function Input({ ...props }) {
  return (
    <input
      {...props}
      className="w-full bg-card border border-border-strong rounded-md px-3 h-10 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
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
  const base = 'min-h-[40px] px-4 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-40'
  const v = {
    primary:   'bg-ink hover:bg-ink-hover text-white',
    secondary: 'bg-card border border-border text-default hover:bg-raised',
    danger:    'bg-err-light border border-err/20 text-err hover:bg-red-100',
  }
  return <button {...props} className={`${base} ${v[variant]} ${className}`} />
}
