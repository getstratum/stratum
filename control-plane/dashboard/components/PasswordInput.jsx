'use client'

import { useState } from 'react'

// A password or secret field with an eye to see what is being typed. It
// shows only what the person writes here: stored keys and passwords never
// come back to the browser.
export default function PasswordInput({ className = '', ...props }) {
  const [shown, setShown] = useState(false)
  const label = shown ? 'Ocultar lo escrito' : 'Mostrar lo escrito'
  return (
    <div className="relative">
      <input {...props} type={shown ? 'text' : 'password'} className={`${className} pr-10`}
             spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      <button type="button" onClick={() => setShown(s => !s)} aria-label={label} aria-pressed={shown} title={label}
              disabled={props.disabled} data-testid="reveal"
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-subtle hover:text-strong disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded-r-md">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {shown && <path d="M4 4l16 16" />}
        </svg>
      </button>
    </div>
  )
}
