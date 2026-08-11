import Fastify from 'fastify'
import cors    from '@fastify/cors'
import pg      from 'pg'
import Redis   from 'ioredis'

import { authHook }    from './auth.js'
import { handleProxy } from './proxy.js'
import { meRoute }     from './me.js'
import { loginRoute }  from './login.js'
import { metricsRoute }        from './metrics.js'
import { changePasswordRoute } from './change-password.js'

// ─── DB & Redis ───────────────────────────────────────────────────────────────

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
})

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
})

redis.on('error', (err) => console.error('[redis]', err.message))

// ─── App ──────────────────────────────────────────────────────────────────────

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } })

app.decorate('db', db)
app.decorate('redis', redis)

await app.register(cors, { origin: true })

app.addHook('preHandler', authHook)

// ─── Routes ───────────────────────────────────────────────────────────────────

// Public
app.get( '/health',       async () => ({ status: 'ok', ts: new Date().toISOString() }))
app.post('/auth/login',   loginRoute)

// Authenticated
app.get( '/me',           meRoute)

// Observability — no auth required so Prometheus can scrape without a token
app.get( '/metrics',      metricsRoute)
app.post('/auth/change-password', changePasswordRoute)
app.post('/proxy/:provider/*', handleProxy)

// Convenience: /proxy/auto/* — provider resolved from agent's configured model
// Same handler; 'auto' is resolved inside handleProxy
app.post('/proxy/auto/*', (req, reply) => {
  req.params = { ...req.params, provider: 'auto' }
  return handleProxy.call(app, req, reply)
})

// ─── Start ────────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT || '8080')

try {
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`\n🚀 AI Gateway running on http://localhost:${port}`)
  console.log(`   POST /auth/login  — password auth → JWT`)
  console.log(`   GET  /me          — user info + models`)
  console.log(`   POST /proxy/openai/*`)
  console.log(`   POST /proxy/anthropic/*\n`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

async function shutdown() {
  await app.close()
  await db.end()
  redis.quit()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)
