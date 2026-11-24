import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toCSV, LOG_COLUMNS } from '../lib/csv.js'

test('the Requests CSV says who a call was for, why it was refused and its labels', () => {
  const csv = toCSV([{
    created_at: '2026-11-16T20:28:36Z', provider: 'mcp', model_id: 'demo/borrar_todo', team_name: 'Engineering',
    agent_name: 'portal', user_email: 'sofia@acme.com', tokens_input: 0, tokens_output: 0, cost_usd: '0', latency_ms: 1300,
    status_code: 200, is_stream: false, error_message: null, labels: ['mcp', 'portal', 'decision_skipped'], pii_types: ['email', 'api_key'],
  }], LOG_COLUMNS)
  const [head, row] = csv.split('\n').map(l => l.split(','))
  const at = (name) => row[head.indexOf(name)]
  assert.equal(at('Agent'), 'portal')
  assert.equal(at('User'), 'sofia@acme.com')
  assert.equal(at('Reason'), '')
  assert.equal(at('Labels'), 'mcp;portal;decision_skipped')
  assert.equal(at('Sensitive data'), 'email;api_key')
})
