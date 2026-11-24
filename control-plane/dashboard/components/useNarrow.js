'use client'

import { useEffect, useState } from 'react'

/**
 * Whether the window is narrower than Tailwind's md (768 px): a phone, or a
 * tablet held upright. Pages render their tables as cards there.
 *
 * One or the other is rendered, never both hidden by CSS, so a page never
 * holds the same text twice. The server renders the wide layout; a phone
 * switches right after loading.
 */
export function useNarrow() {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767.98px)')
    const update = () => setNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return narrow
}
