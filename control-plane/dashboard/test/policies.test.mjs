import { test } from 'node:test'
import assert from 'node:assert/strict'
import { policyFields } from '../lib/policies.js'

test('a policy says what its gateways do with personal data and with credentials', () => {
  assert.deepEqual(policyFields({ piiAction: 'redact', dlpAction: 'block' }), { piiAction: 'redact', dlpAction: 'block' })
  assert.deepEqual(policyFields({ piiAction: 'off' }), { piiAction: 'off' })
  assert.deepEqual(policyFields({}), {})
  for (const bad of ['', 'mask', null, 1]) {
    assert.throws(() => policyFields({ piiAction: bad }), /Datos personales/)
    assert.throws(() => policyFields({ dlpAction: bad }), /Credenciales/)
  }
})
