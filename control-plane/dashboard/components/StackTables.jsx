'use client'

import { useEffect } from 'react'

/**
 * Gives each cell of a table with class "stack" its column's name
 * (data-label), which the narrow-screen CSS shows before the value
 * (globals.css). Done once here for every table of the console, and again
 * whenever a page adds rows.
 */
function label(root) {
  for (const table of root.querySelectorAll('table.stack')) {
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim())
    if (!heads.length) continue
    for (const tr of table.querySelectorAll('tbody tr')) {
      let col = 0
      for (const td of tr.children) {
        const span = Number(td.getAttribute('colspan') || 1)
        if (span === 1 && heads[col] && td.dataset.label !== heads[col]) td.dataset.label = heads[col]
        col += span
      }
    }
  }
}

export default function StackTables() {
  useEffect(() => {
    let frame = 0
    const run = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => label(document)) }
    run()
    const mo = new MutationObserver(run)
    mo.observe(document.body, { childList: true, subtree: true })
    return () => { mo.disconnect(); cancelAnimationFrame(frame) }
  }, [])
  return null
}
