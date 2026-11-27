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
  // The person: their own key, or the one an agent acted for.
  { key: 'user_email',   label: 'User' },
  { key: 'tokens_input', label: 'Tokens In' },
  { key: 'tokens_output',label: 'Tokens Out' },
  // The part of Tokens In written to or read from the prompt cache.
  { key: 'tokens_cache_write', label: 'Cache write tokens' },
  { key: 'tokens_cache_read',  label: 'Cache read tokens' },
  // Where it came from, as the gateway saw it.
  { key: 'client_ip',    label: 'Client IP' },
  { key: 'user_agent',   label: 'User agent' },
  // Empty: the model has no price (not a cost of 0).
  { key: 'cost_usd',     label: 'Cost USD',      format: v => (v == null ? '' : parseFloat(v).toFixed(8)) },
  { key: 'latency_ms',   label: 'Latency ms' },
  { key: 'status_code',  label: 'Status' },
  { key: 'is_stream',    label: 'Streaming' },
  { key: 'error_message', label: 'Reason' },
  { key: 'images',       label: 'Images' },
  { key: 'audio_seconds', label: 'Audio seconds' },
  { key: 'labels',       label: 'Labels',        format: v => (Array.isArray(v) ? v.join(';') : '') },
  // What the policy's PII and DLP found in the request (logged, redacted or blocked).
  { key: 'pii_types',    label: 'Sensitive data', format: v => (Array.isArray(v) ? v.join(';') : '') },
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
