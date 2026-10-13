/**
 * Client-side CSV export utilities.
 * No server round-trip needed — generates and downloads directly in the browser.
 */

export function toCSV(rows, columns) {
  const escape = v => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }

  const header = columns.map(c => escape(c.label)).join(',')
  const body   = rows.map(row =>
    columns.map(c => escape(
      typeof c.format === 'function' ? c.format(row[c.key], row) : row[c.key]
    )).join(',')
  )

  return [header, ...body].join('\n')
}

export function downloadCSV(content, filename) {
  const bom  = '\uFEFF'  // UTF-8 BOM so Excel opens it correctly
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ─── Column definitions ───────────────────────────────────────────────────────

export const LOG_COLUMNS = [
  { key: 'created_at',   label: 'Timestamp',     format: v => new Date(v).toISOString() },
  { key: 'provider',     label: 'Provider' },
  { key: 'model_id',     label: 'Model' },
  { key: 'team_name',    label: 'Team' },
  { key: 'agent_name',   label: 'Agent' },
  { key: 'tokens_input', label: 'Tokens In' },
  { key: 'tokens_output',label: 'Tokens Out' },
  { key: 'cost_usd',     label: 'Cost USD',      format: v => parseFloat(v ?? 0).toFixed(8) },
  { key: 'latency_ms',   label: 'Latency ms' },
  { key: 'status_code',  label: 'Status' },
  { key: 'is_stream',    label: 'Streaming' },
]

export const PROVIDER_COLUMNS = [
  { key: 'provider',    label: 'Provider' },
  { key: 'requests',    label: 'Requests' },
  { key: 'tokens',      label: 'Tokens' },
  { key: 'cost',        label: 'Cost USD',     format: v => parseFloat(v ?? 0).toFixed(8) },
  { key: 'avgLatency',  label: 'Avg Latency ms' },
  { key: 'errors',      label: 'Errors' },
]

export const MODEL_COLUMNS = [
  { key: 'model',        label: 'Model' },
  { key: 'provider',     label: 'Provider' },
  { key: 'requests',     label: 'Requests' },
  { key: 'tokensInput',  label: 'Tokens In' },
  { key: 'tokensOutput', label: 'Tokens Out' },
  { key: 'cost',         label: 'Cost USD',     format: v => parseFloat(v ?? 0).toFixed(8) },
  { key: 'avgLatency',   label: 'Avg Latency ms' },
]
