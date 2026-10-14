// Constant-rate load through the public edge (DNS, TLS, load balancer,
// gateway, mock provider). 70% non-streamed, 30% streamed requests.
//
// Env: TARGET (https://host), API_KEY, RATE (req/s), DURATION, MODEL,
//      MAX_ERROR_RATE (threshold for http_req_failed).
import http from 'k6/http'
import { check } from 'k6'
import { Counter } from 'k6/metrics'

const target = __ENV.TARGET
const key = __ENV.API_KEY
const model = __ENV.MODEL || 'ollama/mock-1'

const status2xx = new Counter('status_2xx')
const status429 = new Counter('status_429')
const status5xx = new Counter('status_5xx')
const statusOther = new Counter('status_other')
const brokenStreams = new Counter('broken_streams')

export const options = {
  discardResponseBodies: false,
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 40),
      timeUnit: '1s',
      duration: __ENV.DURATION || '5m',
      preAllocatedVUs: 150,
      maxVUs: 600,
    },
  },
  thresholds: {
    http_req_failed: [`rate<=${__ENV.MAX_ERROR_RATE || 0}`],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
}

export default function () {
  const stream = Math.random() < 0.3
  const res = http.post(
    `${target}/v1/chat/completions`,
    JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'load test' }] }),
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: '120s',
      tags: { kind: stream ? 'stream' : 'unary' },
    },
  )
  if (res.status >= 200 && res.status < 300) status2xx.add(1)
  else if (res.status === 429) status429.add(1)
  else if (res.status >= 500 || res.status === 0) status5xx.add(1)
  else statusOther.add(1)

  if (stream && res.status === 200) {
    const complete = typeof res.body === 'string' && res.body.includes('data: [DONE]')
    if (!complete) brokenStreams.add(1)
    check(res, { 'stream completed': () => complete })
  } else {
    check(res, { 'status 200': (r) => r.status === 200 })
  }
}

export function handleSummary(data) {
  const m = (name, field = 'count') => (data.metrics[name] ? data.metrics[name].values[field] || 0 : 0)
  const result = {
    requests: m('http_reqs'),
    failed_rate: m('http_req_failed', 'rate'),
    status_2xx: m('status_2xx'),
    status_429: m('status_429'),
    status_5xx: m('status_5xx'),
    status_other: m('status_other'),
    broken_streams: m('broken_streams'),
    p50_ms: m('http_req_duration', 'p(50)'),
    p95_ms: m('http_req_duration', 'p(95)'),
    p99_ms: m('http_req_duration', 'p(99)'),
  }
  return { stdout: `K6_RESULT ${JSON.stringify(result)}\n` }
}
