// Every handler exported by a route file under app/api must have gone
// through lib/route.js: route() (console session + permission), publicRoute()
// or tokenRoute(). A new route that skips the access check fails here.
//
// Runs without a database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { GUARD } from '../lib/route.js'
import { PERMISSIONS } from '../lib/authz.js'

const API = fileURLToPath(new URL('../app/api', import.meta.url))
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

// The only routes that do not need a console session, and why.
const PUBLIC = {
  'healthz/route.js:GET':  'container health check',
  'session/route.js:POST': 'sign-in',
  'session/route.js:DELETE': 'sign-out (works without a valid session)',
}
const SYNC_TOKEN = {
  'internal/sync/route.js:GET':     'gateways fetch their configuration',
  'internal/metrics/route.js:POST': 'gateways report metrics',
}

function routeFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return routeFiles(p)
    return name === 'route.js' ? [p] : []
  })
}

const files = routeFiles(API)

test('every API handler checks access', async () => {
  assert.ok(files.length > 15, 'found the route files')
  const seen = []
  for (const file of files) {
    const mod = await import(pathToFileURL(file).href)
    const rel = relative(API, file).split('\\').join('/')
    for (const method of METHODS) {
      if (!(method in mod)) continue
      const key = `${rel}:${method}`
      seen.push(key)
      const guard = mod[method]?.[GUARD]
      assert.ok(guard, `${key} is not wrapped in route(), publicRoute() or tokenRoute()`)
      if (guard.kind === 'public') assert.ok(PUBLIC[key], `${key} is public but not listed in PUBLIC`)
      else if (guard.kind === 'sync-token') assert.ok(SYNC_TOKEN[key], `${key} uses a sync token but is not listed in SYNC_TOKEN`)
      else {
        assert.equal(guard.kind, 'session')
        assert.ok(PERMISSIONS[guard.permission], `${key} uses unknown permission ${guard.permission}`)
      }
    }
  }
  for (const key of [...Object.keys(PUBLIC), ...Object.keys(SYNC_TOKEN)]) {
    assert.ok(seen.includes(key), `${key} is listed but no longer exists`)
  }
})
