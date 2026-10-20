// Gateway versions from the User-Agent of their syncs (lib/gateway-version.js).

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { gatewayVersion, olderThan, ignoresModelSwitch } = await import('../lib/gateway-version.js')

test('gatewayVersion: what the gateway puts in its User-Agent', () => {
  assert.equal(gatewayVersion('stratum-gateway/v0.2.0'), '0.2.0')
  assert.equal(gatewayVersion('stratum-gateway/0.1.1'), '0.1.1')
  assert.equal(gatewayVersion('stratum-gateway/v0.3.0-rc.1'), '0.3.0-rc.1')
  assert.equal(gatewayVersion('stratum-gateway/dev'), 'dev')
  assert.equal(gatewayVersion('stratum-gateway/v0.2.0 (linux)'), '0.2.0')
  for (const ua of [null, undefined, '', 'curl/8.5.0', 'Mozilla/5.0 stratum-gateway/v0.2.0',
    'stratum-gateway/', `stratum-gateway/${'9'.repeat(41)}`, 'stratum-gateway/<script>']) {
    assert.equal(gatewayVersion(ua), null, String(ua))
  }
})

test('olderThan and the model switch: releases only', () => {
  assert.ok(olderThan('0.1.1', '0.2.0'))
  assert.ok(olderThan('0.9.9', '0.10.0'), 'numeric, not text, order')
  assert.ok(!olderThan('0.2.0', '0.2.0'))
  assert.ok(!olderThan('0.10.0', '0.9.0'))
  assert.ok(!olderThan('dev', '0.2.0'), 'a development build is not known to be old')
  assert.ok(ignoresModelSwitch('0.1.1'))
  assert.ok(ignoresModelSwitch('0.1.0'))
  assert.ok(!ignoresModelSwitch('0.2.0'))
  assert.ok(!ignoresModelSwitch('0.2.0-rc.1'))
  assert.ok(!ignoresModelSwitch('1.0.0'))
  assert.ok(!ignoresModelSwitch('dev'))
})
