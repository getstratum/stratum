// Functional tests of a running installation, in the order an administrator
// would work: sign in, connect a provider, register a gateway, give an agent a
// key and use it through the gateway, revoke it, delegate to an auditor, and
// read the audit log. Every object it creates carries "e2e-<run>" in its name
// and is revoked or disabled at the end, even when a step fails.
//
// Environment (README.md): STRATUM_E2E_CONSOLE_URL, STRATUM_E2E_EMAIL,
// STRATUM_E2E_PASSWORD, STRATUM_E2E_TOTP_SECRET (the owner's second factor);
// optionally STRATUM_E2E_GATEWAY_URL, STRATUM_E2E_MODEL, STRATUM_E2E_TEAM,
// STRATUM_E2E_SYNC_TIMEOUT_S.

import { createHmac } from 'node:crypto'
import { test, expect } from '@playwright/test'

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`Set ${name} (see README.md)`)
  return v
}

const OWNER = {
  email: env('STRATUM_E2E_EMAIL'), password: env('STRATUM_E2E_PASSWORD'), totp: env('STRATUM_E2E_TOTP_SECRET', ''),
}
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

// TOTP (RFC 6238), as an authenticator app computes it.
const stepNow = () => Math.floor(Date.now() / 30_000)
function totpCode(secret, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, value = 0
  const key = []
  for (const ch of secret.toUpperCase().replace(/[\s=]/g, '')) {
    value = (value << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) { key.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', Buffer.from(key)).update(counter).digest()
  const o = mac[mac.length - 1] & 15
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
// The console accepts each code once, and the current step and the next
// one. The first code uses the next step (the installer may have just used
// the current one); later ones wait for their step when they have to.
const lastStep = new Map()
async function nextCode(secret) {
  const step = Math.max(stepNow() + 1, (lastStep.get(secret) ?? 0) + 1)
  while (stepNow() + 1 < step) await new Promise((r) => setTimeout(r, 1000))
  lastStep.set(secret, step)
  return totpCode(secret, step)
}

/**
 * Signs in. When the account asks for a second factor, answers with a code
 * from `secret` (the owner's by default), or stops there with stopAtCode.
 * `landing` is the page expected afterwards.
 */
async function signIn(email, password, { secret = email === OWNER.email ? OWNER.totp : '', landing = '/', stopAtCode = false } = {}) {
  await page.goto('/login')
  await page.locator('input[type=email]').fill(email)
  await page.locator('input[type=password]').fill(password)
  await page.locator('button[type=submit]').click()
  const codeStep = page.getByRole('heading', { level: 1, name: 'Verificación en dos pasos' })
  await expect(codeStep.or(page.getByRole('navigation'))).toBeVisible({ timeout: 30_000 })
  if (await codeStep.isVisible()) {
    if (stopAtCode) return
    if (!secret) throw new Error(`${email} has a second factor: set STRATUM_E2E_TOTP_SECRET (see README.md)`)
    await page.getByLabel('Código').fill(await nextCode(secret))
    await page.getByRole('button', { name: 'Ingresar' }).click()
  }
  await page.waitForURL((u) => new URL(u).pathname === landing, { timeout: 30_000 })
}

async function signOut() {
  await page.getByRole('button', { name: 'Cerrar sesión' }).click()
  await page.waitForURL('**/login')
}

const dialog = (name) => page.getByRole('dialog', { name })
const nav = () => page.getByRole('navigation')

/** POST to the gateway's chat endpoint with `key`; the HTTP status. */
async function callGateway(key, headers = {}) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
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

test('sign-in: a session the console no longer has goes back to sign-in', async () => {
  // A cookie from before the database was recreated (make demo-down, then
  // make demo), or from a session deleted on the server.
  const url = new URL('/', page.url() === 'about:blank' ? test.info().project.use.baseURL : page.url()).toString()
  await page.context().addCookies([{ name: 'stratum_session', value: 'a'.repeat(43), url }])
  await page.goto('/')
  await expect(page).toHaveURL(/\/login\?reason=session_expired$/)
  await expect(page.getByText('Tu sesión terminó')).toBeVisible()
  await page.context().clearCookies()
})

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
  for (const name of ['Inicio', 'Proveedores', 'Modelos', 'Gateways', 'Usuarios', 'Agentes', 'Políticas', 'Consumo', 'Auditoría']) {
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
  await d.getByLabel('Buscar proveedor').fill('custom')
  await d.getByRole('button', { name: /^Custom \(compatible con OpenAI\)/ }).click()
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
  await d.getByLabel('Buscar proveedor').fill('openai')
  await d.getByRole('button', { name: /^OpenAI\b/ }).click()
  await d.getByLabel('URL base').fill('http://proxy.example')
  await d.getByLabel('API key').fill('sk-e2e-not-a-real-key-000000')
  await d.getByRole('button', { name: /Guardar|Reemplazar/ }).click()
  await expect(d.getByText('La URL base tiene que ser https')).toBeVisible()
  await d.getByRole('button', { name: 'Cancelar' }).click()
})

test('providers: the catalog is searched and filtered; a catalog provider keeps its address', async () => {
  await page.goto('/providers')
  await page.getByRole('button', { name: 'Agregar proveedor' }).click()
  const d = dialog('Agregar proveedor')
  const list = d.getByRole('list', { name: 'Proveedores' })
  expect(await list.getByRole('listitem').count()).toBeGreaterThan(80)
  await d.getByRole('button', { name: /^Routers/ }).click()
  await expect(list.getByRole('button', { name: /^OpenRouter/ })).toBeVisible()
  await expect(list.getByRole('button', { name: /^Cerebras/ })).toHaveCount(0)
  await d.getByRole('button', { name: /^Todos/ }).click()
  await d.getByLabel('Con plan gratis').check()
  await expect(list.getByRole('button', { name: /^Anthropic/ })).toHaveCount(0)
  await d.getByLabel('Buscar proveedor').fill('cerebras')
  await list.getByRole('button', { name: /^Cerebras/ }).click()
  await expect(d.getByRole('link', { name: /Conseguir una API key de Cerebras/ })).toBeVisible()
  await d.getByLabel('API key').fill('csk-e2e-not-a-real-key-000000')
  await d.getByRole('button', { name: /Guardar|Reemplazar/ }).click()

  const row = page.locator('tr', { hasText: 'cerebras/' })
  await expect(row).toContainText('https://api.cerebras.ai/v1')
  const pc = (await api('GET', '/api/internal/providers')).body.providers.find((p) => p.provider === 'cerebras')
  created.providerIds.push(pc.id)
  await row.getByRole('button', { name: 'Revocar' }).click()
  await expect(row).toHaveCount(0)
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
  for (const gw of live) expect(gw.versions.length, `${gw.name} reports the version it runs`).toBeGreaterThan(0)
})

// --- models ----------------------------------------------------------------------

test('models: the catalog lists each model with its aliases and prices', async () => {
  await page.goto('/models')
  await expect(page.getByRole('heading', { level: 1, name: 'Modelos' })).toBeVisible()
  const haiku = page.locator('tr').filter({ hasText: 'claude-haiku-4-5-20251001' })
  await expect(haiku).toContainText('también claude-haiku-4-5')
  await page.getByRole('button', { name: 'openai', exact: true }).click()
  await expect(page.locator('tr').filter({ hasText: 'claude-haiku-4-5-20251001' })).toHaveCount(0)
})

test('models: the owner turns a model off for the organization, and on again', async () => {
  await page.goto('/models?provider=openai')
  const row = page.locator('tr').filter({ hasText: 'gpt-4o-mini' })
  const sw = row.getByRole('switch')
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect(row).toContainText('Nadie: está apagado')
  const model = ((await api('GET', '/api/models')).body ?? []).find((m) => m.provider === 'openai' && m.model_id === 'gpt-4o-mini')
  expect(model.enabled).toBe(false)
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
})

// --- agents and the gateway ---------------------------------------------------------

test('agents: a new key works through the gateway, and stops working when revoked', async () => {
  test.skip(!GATEWAY, 'no STRATUM_E2E_GATEWAY_URL')
  const name = `${RUN}-agent`
  created.agentNames.push(name)
  await page.goto('/agents')
  await page.getByRole('button', { name: '+ Nuevo agente' }).click()
  const d = dialog('Nuevo agente')
  await d.getByLabel('Nombre').fill(name)
  // Options read "<team> · <policy>".
  const team = d.getByLabel('Equipo')
  await team.selectOption(await team.locator('option', { hasText: TEAM }).first().getAttribute('value'))
  await d.getByRole('button', { name: 'Crear agente' }).click()

  const reveal = dialog('Key del agente generada')
  const key = (await reveal.getByTestId('revealed-key').textContent()).trim()
  expect(key).toMatch(/^aig_agt_[0-9a-f]{48}$/)
  await reveal.getByRole('button', { name: /cerrar/ }).click()

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

  // The agent's consumption, from its row: the request is there.
  await page.reload()
  const row = page.getByTestId('agent-row').filter({ hasText: name })
  await row.getByRole('link', { name: 'Ver consumo' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Consumo' })).toBeVisible()
  await expect(page.getByText(`Agente: ${name}`)).toBeVisible()
  await expect(page.locator('table tbody tr').first()).toBeVisible()
  await page.goto('/agents')

  await row.getByRole('button', { name: 'Revocar key' }).click()
  const t1 = Date.now()
  await eventually(() => callGateway(key), 401, SYNC_MS, 'the revoked key through the gateway')
  console.log(`  key refused ${((Date.now() - t1) / 1000).toFixed(1)} s after revocation`)
})

test('agents: an agent that acts for people follows each person, and stops for one whose access is taken away', async () => {
  test.skip(!GATEWAY, 'no STRATUM_E2E_GATEWAY_URL')
  const name = `${RUN}-portal`
  created.agentNames.push(name)
  await page.goto('/agents')
  await page.getByRole('button', { name: '+ Nuevo agente' }).click()
  const d = dialog('Nuevo agente')
  await d.getByLabel('Nombre').fill(name)
  const team = d.getByLabel('Equipo')
  await team.selectOption(await team.locator('option', { hasText: TEAM }).first().getAttribute('value'))
  await d.getByLabel('Actúa por personas').check()
  await d.getByRole('button', { name: 'Crear agente' }).click()
  const reveal = dialog('Key del agente generada')
  const key = (await reveal.getByTestId('revealed-key').textContent()).trim()
  await reveal.getByRole('button', { name: /cerrar/ }).click()
  await expect(page.getByTestId('agent-row').filter({ hasText: name }).getByText('actúa por personas')).toBeVisible()

  // Someone of the team the model is allowed for.
  const people = (await api('GET', '/api/users')).body ?? []
  const person = people.find((u) => u.is_active && u.team_name === TEAM && u.app_access !== false)
  expect(person, `an active person in ${TEAM}`).toBeTruthy()
  const as = { 'X-Stratum-User': person.id }

  await eventually(() => callGateway(key, as), 200, SYNC_MS, 'a request on behalf of a person')
  expect(await callGateway(key, { 'X-Stratum-User': '00000000-0000-4000-8000-000000000000' }), 'a person who does not exist').toBe(403)

  // The request is the person's in the console: under the agent as an
  // application (on behalf of people), never as the agent's own work.
  const agentId = (((await api('GET', '/api/agents')).body ?? []).find((a) => a.name === name) ?? {}).id
  await eventually(async () => {
    const row = await api('GET', `/api/consumption?by=user&app=${agentId}`)
    return (row.body?.rows ?? []).some((r) => r.key === person.id) ? 'theirs' : 'not yet'
  }, 'theirs', SYNC_MS, "the delegated request in the person's usage")
  expect((await api('GET', `/api/consumption?by=user&agent=${agentId}`)).body?.rows ?? [], 'not the agent\'s own work').toEqual([])

  // Taking their access to applications away reaches the gateway.
  expect((await api('PATCH', `/api/users/${person.id}`, { appAccess: false })).status).toBe(200)
  try {
    await eventually(() => callGateway(key, as), 403, SYNC_MS, 'a person without access to applications')
  } finally {
    await api('PATCH', `/api/users/${person.id}`, { appAccess: true })
  }
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
  await expect(nav().getByRole('link', { name: 'Auditoría' })).toBeVisible()
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
  await expect(page.getByRole('heading', { name: 'Agentes' })).toBeVisible()
  await expect(page.getByRole('button', { name: '+ Nuevo agente' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Editar|Rotar key|Desactivar)$/ })).toHaveCount(0)

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

// --- second factor ------------------------------------------------------------------

const admin = { email: `${RUN}-admin@example.com`, password: `${RUN}-admin-password` }

test('two-step: a new admin has to set it up before using the console', async () => {
  created.userEmails.push(admin.email)
  await page.goto('/users')
  await page.getByRole('button', { name: '+ Nuevo usuario' }).click()
  const d = dialog('Nuevo usuario')
  await d.getByLabel('Email').fill(admin.email)
  await d.getByLabel('Nombre').fill(`${RUN} admin`)
  await d.getByLabel('Rol', { exact: true }).selectOption({ label: 'Admin' })
  await d.getByPlaceholder('Dejar vacío si solo usa API key').fill(admin.password)
  await d.getByRole('button', { name: 'Crear usuario' }).click()
  await expect(page.locator('tr', { hasText: admin.email })).toBeVisible()
  await signOut()

  // Signed in with the password only: the account page, and nothing else.
  await signIn(admin.email, admin.password, { landing: '/account' })
  await expect(page.getByText('Tu rol requiere la verificación en dos pasos')).toBeVisible()
  expect((await api('GET', '/api/users')).body?.error).toBe('mfa_enrollment_required')
  await expect(nav().getByRole('link', { name: 'Usuarios' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Configurar' }).click()
  await page.getByLabel('Tu contraseña, para confirmar').fill(admin.password)
  await page.getByRole('button', { name: 'Continuar' }).click()
  admin.totp = (await page.getByTestId('mfa-secret').textContent()).replace(/\s/g, '')
  expect(admin.totp).toMatch(/^[A-Z2-7]{32}$/)
  await expect(page.getByRole('img', { name: 'Código QR para la aplicación de autenticación' })).toBeVisible()
  await page.getByLabel('2. Ingresá el código que muestra').fill('000000')
  await page.getByRole('button', { name: 'Activar' }).click()
  await expect(page.getByText('El código no coincide')).toBeVisible()
  await page.getByLabel('2. Ingresá el código que muestra').fill(await nextCode(admin.totp))
  await page.getByRole('button', { name: 'Activar' }).click()
  const codes = page.getByTestId('recovery-codes').locator('li')
  await expect(codes).toHaveCount(10)
  admin.recovery = await codes.allTextContents()
  await page.getByRole('button', { name: 'Ya los guardé' }).click()
  await page.waitForURL((u) => new URL(u).pathname === '/')
  await expect(nav().getByRole('link', { name: 'Usuarios' })).toBeVisible()
})

test('two-step: the next sign-in asks for a code; a recovery code works once', async () => {
  await signOut()
  // A wrong code first.
  await signIn(admin.email, admin.password, { stopAtCode: true })
  await page.getByLabel('Código').fill('000000')
  await page.getByRole('button', { name: 'Ingresar' }).click()
  await expect(page.getByText('Código incorrecto o vencido')).toBeVisible()
  await page.getByLabel('Código').fill(await nextCode(admin.totp))
  await page.getByRole('button', { name: 'Ingresar' }).click()
  await page.waitForURL((u) => new URL(u).pathname === '/')

  await signOut()
  await signIn(admin.email, admin.password, { stopAtCode: true })
  await page.getByLabel('Código').fill(admin.recovery[0])
  await page.getByRole('button', { name: 'Ingresar' }).click()
  await page.waitForURL((u) => new URL(u).pathname === '/account')
  await expect(page.getByText('te quedan 9')).toBeVisible()
})

test('two-step: the owner resets the admin\'s second factor', async () => {
  const adminCookies = await page.context().cookies()
  await signOut()
  await signIn(OWNER.email, OWNER.password)
  const ownerCookies = await page.context().cookies()
  await page.goto('/users')
  const row = page.locator('tr', { hasText: admin.email })
  await expect(row).toContainText('2 pasos')
  await row.getByRole('button', { name: 'Reiniciar 2 pasos' }).click()
  await expect(row).not.toContainText('2 pasos')

  // The admin's session ended.
  await page.context().clearCookies()
  await page.context().addCookies(adminCookies.filter((c) => c.name === 'stratum_session'))
  expect((await api('GET', '/api/session')).status).toBe(401)
  await page.context().clearCookies()
  await page.context().addCookies(ownerCookies)
})

// --- teams ---------------------------------------------------------------------------

test('teams: create an empty team and delete it; a team with people cannot be deleted', async () => {
  const name = `${RUN}-team`
  await page.goto('/teams')
  await page.getByRole('button', { name: '+ Nuevo equipo' }).click()
  const d = dialog('Nuevo equipo')
  await d.getByLabel('Nombre').fill(name)
  await d.getByRole('button', { name: 'Crear equipo' }).click()
  const row = page.getByTestId('team-row').filter({ hasText: name })
  await expect(row).toContainText('Sin política')

  await expect(page.getByTestId('team-row').filter({ hasText: TEAM }).first()
    .getByRole('button', { name: 'Eliminar' })).toBeDisabled()

  await row.getByRole('button', { name: 'Eliminar' }).click()
  await expect(row).toHaveCount(0)
})

// --- signing in with the organization's identity provider (SSO) -----------------------

const IDP = process.env.STRATUM_E2E_IDP_URL
const ssoUser = { email: `${RUN}-sso@acme.com`, password: `${RUN}-sso-password` }

/** Signs in with SSO from a fresh page: the mock provider signs in whoever is named. */
async function ssoSignIn(email) {
  await page.request.delete('/api/session')
  await page.goto('/login')
  await page.locator('input[type=email]').fill(email)
  await page.getByRole('button', { name: 'Entrar con SSO' }).click()
}

test('sso: the owner sets up the provider; people of its domain sign in with it, others are refused', async () => {
  test.skip(!IDP, 'no STRATUM_E2E_IDP_URL (a mock identity provider)')
  const put = await api('PUT', '/api/sso', { kind: 'oidc', issuer: IDP, clientId: 'stratum-e2e', clientSecret: 'idp-secret', domains: ['acme.com'] })
  expect(put.status, JSON.stringify(put.body)).toBe(200)
  expect(put.body.provider.clientSecretHint).toBeTruthy()
  expect(JSON.stringify(put.body)).not.toContain('idp-secret')
  const made = await api('POST', '/api/users', { email: ssoUser.email, name: 'SSO', role: 'auditor', password: ssoUser.password })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  created.userEmails.push(ssoUser.email)

  // The auditor, with SSO: no password, no second factor of the console's.
  await ssoSignIn(ssoUser.email)
  await page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 30_000 })
  const me = (await api('GET', '/api/session')).body
  expect([me.user.email, me.user.role]).toEqual([ssoUser.email, 'auditor'])
  const { requests } = await (await fetch(`${IDP}/requests`)).json()
  expect(requests.at(-1)).toEqual({ client_id: 'stratum-e2e', pkce: true })

  // Someone the provider knows and Stratum does not.
  await ssoSignIn(`${RUN}-nadie@acme.com`)
  await page.waitForURL('**/login?sso=account')
  await expect(page.locator('p[role=alert]')).toContainText('dada de alta en Stratum')
  // A domain without a provider.
  await page.locator('input[type=email]').fill('alguien@example.org')
  await page.getByRole('button', { name: 'Entrar con SSO' }).click()
  await expect(page.locator('p[role=alert]')).toContainText('no tiene ingreso con SSO')
  await signIn(OWNER.email, OWNER.password)
})

test('sso: required for the domain, the password stops working except for Owners; removed, it works again', async () => {
  test.skip(!IDP, 'no STRATUM_E2E_IDP_URL (a mock identity provider)')
  expect((await api('PUT', '/api/sso', { kind: 'oidc', issuer: IDP, clientId: 'stratum-e2e', domains: ['acme.com'], enforce: true })).status).toBe(200)
  await page.request.delete('/api/session')
  const refused = await page.request.post('/api/session', { data: { email: ssoUser.email, password: ssoUser.password } })
  expect(refused.status()).toBe(401)
  expect((await refused.json()).error).toBe('sso_required')
  // A wrong password says nothing about SSO.
  const wrong = await page.request.post('/api/session', { data: { email: ssoUser.email, password: 'wrong' } })
  expect((await wrong.json()).error).toBe('invalid_credentials')
  // The Owner keeps the password (and the second factor): the way in if the provider fails.
  await signIn(OWNER.email, OWNER.password)
  await page.goto('/sso')
  await expect(page.getByTestId('sso-state')).toContainText('la contraseña ya no sirve')
  expect((await api('DELETE', '/api/sso')).status).toBe(200)
  await page.request.delete('/api/session')
  const back = await page.request.post('/api/session', { data: { email: ssoUser.email, password: ssoUser.password } })
  expect(back.status()).toBe(200)
  await page.request.delete('/api/session')
  await signIn(OWNER.email, OWNER.password)
})

// --- audit log -------------------------------------------------------------------------

test('audit log: everything above is recorded, refusals included', async () => {
  await page.goto('/audit')
  for (const text of ['Agregó un proveedor', 'Revocó un proveedor', 'Registró un gateway', 'Rotó el token de un gateway',
    'Dio de baja un gateway', 'Creó una persona', 'Intento sin permiso', 'Cambió su contraseña',
    'Activó la verificación en dos pasos', 'Reinició la verificación en dos pasos de una persona',
    'Creó un equipo', 'Eliminó un equipo', ...(IDP ? ['Configuró el ingreso con SSO', 'Quitó el ingreso con SSO'] : [])]) {
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
