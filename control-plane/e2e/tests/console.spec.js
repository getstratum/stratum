// Functional tests of a running installation, in the order an administrator
// would work: sign in, connect a provider, register a gateway, give an agent a
// key and use it through the gateway, revoke it, delegate to an auditor, and
// read the audit log. Every object it creates carries "e2e-<run>" in its name
// and is revoked or disabled at the end, even when a step fails.
//
// Environment (README.md): STRATUM_E2E_CONSOLE_URL, STRATUM_E2E_EMAIL,
// STRATUM_E2E_PASSWORD; optionally STRATUM_E2E_GATEWAY_URL, STRATUM_E2E_MODEL,
// STRATUM_E2E_TEAM, STRATUM_E2E_SYNC_TIMEOUT_S.

import { test, expect } from '@playwright/test'

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`Set ${name} (see README.md)`)
  return v
}

const OWNER = { email: env('STRATUM_E2E_EMAIL'), password: env('STRATUM_E2E_PASSWORD') }
const GATEWAY = process.env.STRATUM_E2E_GATEWAY_URL?.replace(/\/+$/, '')
const MODEL = env('STRATUM_E2E_MODEL', 'ollama/mock-1')
const TEAM = env('STRATUM_E2E_TEAM', 'Engineering')
const SYNC_MS = Number(env('STRATUM_E2E_SYNC_TIMEOUT_S', '60')) * 1000
const RUN = `e2e-${Date.now().toString(36)}`

const created = { providerIds: [], gatewayIds: [], agentNames: [], userEmails: [] }

test.describe.configure({ mode: 'serial' })

let page
const alerts = []

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  // Confirmations are accepted; alerts (the console's error popups) are
  // recorded and fail the step that raised them.
  page.on('dialog', async (d) => {
    if (d.type() === 'alert') alerts.push(d.message())
    await d.accept()
  })
})

test.afterEach(() => {
  const raised = alerts.splice(0)
  expect(raised, 'the console showed an error popup').toEqual([])
})

test.afterAll(async () => {
  await cleanup().catch((err) => console.warn(`cleanup: ${err.message}`))
  await page?.close()
})

// --- helpers -------------------------------------------------------------------

async function signIn(email, password) {
  await page.goto('/login')
  await page.locator('input[type=email]').fill(email)
  await page.locator('input[type=password]').fill(password)
  await page.locator('button[type=submit]').click()
  await page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 30_000 })
}

async function signOut() {
  await page.getByRole('button', { name: 'Cerrar sesión' }).click()
  await page.waitForURL('**/login')
}

const dialog = (name) => page.getByRole('dialog', { name })
const nav = () => page.getByRole('navigation')

/** POST to the gateway's chat endpoint with `key`; the HTTP status. */
async function callGateway(key) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
    signal: AbortSignal.timeout(30_000),
  })
  await res.arrayBuffer()
  return res.status
}

/** Polls `fn` until it returns `want`, for at most `ms`. */
async function eventually(fn, want, ms, what) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await fn().catch((err) => `error: ${err.message}`)
    if (last === want) return Date.now()
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`${what}: still ${last} after ${ms / 1000} s (wanted ${want})`)
}

async function api(method, path, data) {
  const res = await page.request.fetch(path, { method, data })
  return { status: res.status(), body: await res.json().catch(() => null) }
}

async function cleanup() {
  // Back to the owner, whatever the last step left signed in.
  await page.request.delete('/api/session')
  await signIn(OWNER.email, OWNER.password)
  for (const id of created.providerIds) await api('DELETE', `/api/internal/providers?id=${id}`)
  for (const id of created.gatewayIds) await api('DELETE', `/api/internal/instances?id=${id}`)
  const agents = (await api('GET', '/api/agents')).body ?? []
  for (const a of agents.filter((a) => created.agentNames.includes(a.name))) {
    await api('POST', `/api/agents/${a.id}`, { action: 'remove-key' })
    await api('PATCH', `/api/agents/${a.id}`, { isActive: false })
  }
  const users = (await api('GET', '/api/users')).body ?? []
  for (const u of users.filter((u) => created.userEmails.includes(u.email) && u.is_active)) {
    await api('PATCH', `/api/users/${u.id}`, { isActive: false })
  }
}

// --- sign-in -------------------------------------------------------------------

test('sign-in: a wrong password is refused without saying why', async () => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await page.locator('input[type=email]').fill(OWNER.email)
  await page.locator('input[type=password]').fill('not the password at all')
  await page.locator('button[type=submit]').click()
  await expect(page.getByText('Email o contraseña incorrectos')).toBeVisible()
})

test('sign-in: the owner gets in and sees every section', async () => {
  await signIn(OWNER.email, OWNER.password)
  for (const name of ['Overview', 'Users', 'Agents', 'Providers', 'Gateways', 'Audit log']) {
    await expect(nav().getByRole('link', { name, exact: true })).toBeVisible()
  }
  const me = await api('GET', '/api/session')
  expect(me.body.user.role).toBe('owner')
})

test('security: the session cookie is HttpOnly; another site cannot use it', async () => {
  const cookie = (await page.context().cookies()).find((c) => c.name === 'stratum_session')
  expect(cookie?.httpOnly).toBe(true)
  if (new URL(page.url()).protocol === 'https:') expect(cookie.secure).toBe(true)
  const res = await page.request.post('/api/policies', {
    headers: { origin: 'https://evil.example' }, data: { name: `${RUN}-csrf` },
  })
  expect(res.status()).toBe(403)
})

// --- providers -------------------------------------------------------------------

test('providers: add a custom endpoint, disable it, revoke it', async () => {
  const name = `${RUN}`
  await page.goto('/providers')
  await page.getByRole('button', { name: 'Agregar proveedor' }).click()
  const d = dialog('Agregar proveedor')
  await d.getByLabel('Proveedor').selectOption('custom')
  await d.getByLabel('Nombre corto').fill(name)
  await d.getByLabel('URL base').fill('http://e2e.invalid:9')
  await d.getByRole('button', { name: 'Guardar' }).click()

  const row = page.locator('tr', { hasText: `custom-${name}` })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Habilitado')
  const list = (await api('GET', '/api/internal/providers')).body.providers
  const pc = list.find((p) => p.provider === `custom-${name}`)
  created.providerIds.push(pc.id)
  expect(JSON.stringify(list)).not.toMatch(/api_key_encrypted/)

  await row.getByRole('button', { name: 'Deshabilitar' }).click()
  await expect(row).toContainText('Deshabilitado')
  await row.getByRole('button', { name: 'Revocar' }).click()
  await expect(row).toHaveCount(0)
})

test('providers: a preset needs its key and refuses plain http', async () => {
  await page.goto('/providers')
  await page.getByRole('button', { name: 'Agregar proveedor' }).click()
  const d = dialog('Agregar proveedor')
  await d.getByLabel('Proveedor').selectOption('openai')
  await d.getByLabel('URL base').fill('http://proxy.example')
  await d.getByLabel('API key').fill('sk-e2e-not-a-real-key-000000')
  await d.getByRole('button', { name: /Guardar|Reemplazar/ }).click()
  await expect(d.getByText('La URL base tiene que ser https')).toBeVisible()
  await d.getByRole('button', { name: 'Cancelar' }).click()
})

// --- gateways ----------------------------------------------------------------------

test('gateways: register (token shown once), rotate the token, disable', async () => {
  const name = `${RUN}-gw`
  await page.goto('/gateways')
  await page.getByRole('button', { name: 'Registrar gateway' }).click()
  await dialog('Registrar gateway').getByLabel('Nombre').fill(name)
  await dialog('Registrar gateway').getByRole('button', { name: 'Registrar', exact: true }).click()

  const tokens = dialog(`Credenciales de ${name}`)
  const first = await tokens.getByTestId('sync-token').textContent()
  const id = await tokens.getByTestId('instance-id').textContent()
  created.gatewayIds.push(id)
  expect(first).toMatch(/^dp_sync_[0-9a-f]{64}$/)
  await tokens.getByRole('button', { name: 'Ya lo guardé' }).click()

  const row = page.locator('tr', { hasText: name })
  await expect(row).toContainText('Nunca se conectó')
  const listed = await api('GET', '/api/internal/instances')
  expect(JSON.stringify(listed.body)).not.toContain(first)

  await row.getByRole('button', { name: 'Rotar token' }).click()
  const second = await dialog(`Credenciales de ${name}`).getByTestId('sync-token').textContent()
  expect(second).toMatch(/^dp_sync_[0-9a-f]{64}$/)
  expect(second).not.toBe(first)
  await dialog(`Credenciales de ${name}`).getByRole('button', { name: 'Ya lo guardé' }).click()

  await row.getByRole('button', { name: 'Dar de baja' }).click()
  await expect(row).toContainText('Dado de baja')
})

test('gateways: the installation\'s own gateways are syncing', async () => {
  test.skip(!GATEWAY, 'no STRATUM_E2E_GATEWAY_URL')
  const { body } = await api('GET', '/api/internal/instances')
  const live = body.instances.filter((i) => i.status === 'online')
  expect(live.length, 'at least one gateway synced in the last 2 minutes').toBeGreaterThan(0)
})

// --- agents and the gateway ---------------------------------------------------------

test('agents: a new key works through the gateway, and stops working when revoked', async () => {
  test.skip(!GATEWAY, 'no STRATUM_E2E_GATEWAY_URL')
  const name = `${RUN}-agent`
  created.agentNames.push(name)
  await page.goto('/agents')
  await page.getByRole('button', { name: '+ New agent' }).click()
  const d = dialog('New agent')
  await d.getByLabel('Name').fill(name)
  // Options read "<team> · <policy>".
  const team = d.getByLabel('Team')
  await team.selectOption(await team.locator('option', { hasText: TEAM }).first().getAttribute('value'))
  await d.getByRole('button', { name: 'Create agent' }).click()

  const reveal = dialog('Agent key generated')
  const key = (await reveal.getByTestId('revealed-key').textContent()).trim()
  expect(key).toMatch(/^aig_agt_[0-9a-f]{48}$/)
  await reveal.getByRole('button', { name: /close/ }).click()

  expect(await callGateway(`${key}x`), 'an unknown key').toBe(401)
  const t0 = Date.now()
  await eventually(() => callGateway(key), 200, SYNC_MS, 'the new key through the gateway')
  console.log(`  key accepted ${((Date.now() - t0) / 1000).toFixed(1)} s after creation`)

  // The gateway reports the request to the control plane (ADR-0009) and the
  // console counts it for the agent.
  const t2 = Date.now()
  await eventually(async () => {
    const agent = ((await api('GET', '/api/agents')).body ?? []).find((a) => a.name === name)
    return Number(agent?.requests_month ?? 0) > 0 ? 'counted' : 'not yet'
  }, 'counted', SYNC_MS, "the agent's request in the console's usage")
  console.log(`  usage reported ${((Date.now() - t2) / 1000).toFixed(1)} s after the request`)

  const row = page.getByTestId('agent-row').filter({ hasText: name })
  await row.getByRole('button', { name: 'Revoke key' }).click()
  const t1 = Date.now()
  await eventually(() => callGateway(key), 401, SYNC_MS, 'the revoked key through the gateway')
  console.log(`  key refused ${((Date.now() - t1) / 1000).toFixed(1)} s after revocation`)
})

// --- people, roles, my account -------------------------------------------------------

const auditor = { email: `${RUN}-auditor@example.com`, password: `${RUN}-first-password`, next: `${RUN}-second-password` }

test('users: the owner creates an auditor', async () => {
  created.userEmails.push(auditor.email)
  await page.goto('/users')
  await page.getByRole('button', { name: '+ Nuevo usuario' }).click()
  const d = dialog('Nuevo usuario')
  await d.getByLabel('Email').fill(auditor.email)
  await d.getByLabel('Nombre').fill(`${RUN} auditor`)
  await d.getByLabel('Rol', { exact: true }).selectOption({ label: 'Auditor/a' })
  await d.getByPlaceholder('Dejar vacío si solo usa API key').fill(auditor.password)
  await d.getByRole('button', { name: 'Crear usuario' }).click()
  await expect(page.locator('tr', { hasText: auditor.email })).toContainText('Auditor/a')
})

test('roles: an auditor reads but cannot change anything', async () => {
  await signOut()
  await signIn(auditor.email, auditor.password)
  await expect(nav().getByRole('link', { name: 'Audit log' })).toBeVisible()
  await page.goto('/providers')
  await expect(page.getByRole('heading', { name: 'Proveedores' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Agregar proveedor' })).toHaveCount(0)
  await page.goto('/gateways')
  await expect(page.getByRole('button', { name: 'Registrar gateway' })).toHaveCount(0)
  // People and agents: listed, without the controls that change them (the
  // page asks /api/session what the auditor may do; wait for it).
  await page.goto('/users')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('tr', { hasText: auditor.email })).toBeVisible()
  await expect(page.getByRole('button', { name: '+ Nuevo usuario' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Editar|Desactivar|Revocar key)$/ })).toHaveCount(0)
  await page.goto('/agents')
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
  await expect(page.getByRole('button', { name: '+ New agent' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Edit|Rotate key|Deactivate)$/ })).toHaveCount(0)

  // The server refuses even when the UI is bypassed.
  expect((await api('POST', '/api/users', { email: `${RUN}-x@example.com`, giveApiKey: true })).status).toBe(403)
  expect((await api('POST', '/api/internal/instances', { name: `${RUN}-x` })).status).toBe(403)
  expect((await api('GET', '/api/internal/providers')).status).toBe(200)
})

test('my account: the auditor changes their password, which ends other sessions', async () => {
  await page.goto('/account')
  await page.getByLabel('Contraseña actual').fill(auditor.password)
  await page.getByLabel('Contraseña nueva').fill(auditor.next)
  await page.getByLabel('Repetir la nueva').fill(auditor.next)
  await page.getByRole('button', { name: 'Cambiar contraseña' }).click()
  await expect(page.getByText('Contraseña cambiada.')).toBeVisible()
  await signOut()
  await page.goto('/login')
  await page.locator('input[type=email]').fill(auditor.email)
  await page.locator('input[type=password]').fill(auditor.password)
  await page.locator('button[type=submit]').click()
  await expect(page.getByText('Email o contraseña incorrectos')).toBeVisible()
  await signIn(auditor.email, auditor.next)
})

test('users: deactivating the auditor ends their session at once', async () => {
  const auditorCookies = await page.context().cookies()
  await signOut()
  await signIn(OWNER.email, OWNER.password)
  const ownerCookies = await page.context().cookies()
  await page.goto('/users')
  const row = page.locator('tr', { hasText: auditor.email })
  await row.getByRole('button', { name: 'Desactivar' }).click()
  await expect(row).toContainText('Inactivo')

  // The auditor's old session no longer works.
  await page.context().clearCookies()
  await page.context().addCookies(auditorCookies.filter((c) => c.name === 'stratum_session'))
  expect((await api('GET', '/api/session')).status).toBe(401)
  await page.context().clearCookies()
  await page.context().addCookies(ownerCookies)
})

// --- audit log -------------------------------------------------------------------------

test('audit log: everything above is recorded, refusals included', async () => {
  await page.goto('/audit')
  for (const text of ['Agregó un proveedor', 'Revocó un proveedor', 'Registró un gateway', 'Rotó el token de un gateway',
    'Dio de baja un gateway', 'Creó una persona', 'Intento sin permiso', 'Cambió su contraseña']) {
    await expect(page.getByText(text).first(), text).toBeVisible()
  }
  if (GATEWAY) await expect(page.getByText('Revocó la key de un agente').first()).toBeVisible()
  await page.getByLabel('Resultado').selectOption('denied')
  await expect(page.getByText('Intento sin permiso').first()).toBeVisible()
  await expect(page.getByText('Registró un gateway')).toHaveCount(0)
})

test('sign-out: the session ends on the server too', async () => {
  const cookies = await page.context().cookies()
  await signOut()
  await page.context().addCookies(cookies.filter((c) => c.name === 'stratum_session'))
  expect((await api('GET', '/api/users')).status).toBe(401)
})
