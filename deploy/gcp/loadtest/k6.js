// Constant-rate load through the public edge (DNS, TLS, load balancer,
// gateway, mock provider). 70% non-streamed, 30% streamed requests.
//
// Every failure is attributed to whoever produced it, because the verdict is
// about Stratum and the path to it has other moving parts:
//   gateway  the response carries X-Stratum-Request-Id, which the gateway
//            sets on everything it answers (5xx, unexpected status, or a
//            200 stream that ends without [DONE])
//   edge     an HTTP error without that header: the load balancer or Cloud
//            Armor answered (check its logs' statusDetails)
//   network  no HTTP response at all (connection reset, timeout): the path
//            k6 -> Cloud NAT -> load balancer, never logged by the LB
//
// Env: TARGET (https://host), API_KEY, RATE (req/s), DURATION, MODEL.
import http from 'k6/http'
import { check } from 'k6'
import { Counter } from 'k6/metrics'

const target = __ENV.TARGET
const key = __ENV.API_KEY
const model = __ENV.MODEL || 'ollama/mock-1'

const status2xx = new Counter('status_2xx')
const status429 = new Counter('status_429')
const gateway5xx = new Counter('gateway_5xx')
const gatewayOther = new Counter('gateway_other')
const brokenStreams = new Counter('broken_streams')
const edgeErrors = new Counter('edge_errors')
const networkErrors = new Counter('network_errors')

// Each failure is logged once, with a timestamp, so it can be matched
// against load balancer and gateway logs. Capped to keep logs readable.
const MAX_LOGGED = 100
let logged = 0
function logFailure(kind, res, stream) {
  if (logged >= MAX_LOGGED) return
  logged++
  console.warn(
    `K6_FAILURE ${JSON.stringify({
      t: new Date().toISOString(),
      kind,
      status: res.status,
      stream,
      error: res.error || undefined,
      error_code: res.error_code || undefined,
      request_id: res.headers['X-Stratum-Request-Id'] || undefined,
    })}`,
  )
}

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
  // No pass/fail threshold here: scripts/test.sh judges the counters below.
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
  const fromGateway = Boolean(res.headers['X-Stratum-Request-Id'])

  if (res.status === 0) {
    networkErrors.add(1)
    logFailure('network', res, stream)
  } else if (res.status >= 200 && res.status < 300) {
    status2xx.add(1)
  } else if (res.status === 429 && fromGateway) {
    status429.add(1)
  } else if (!fromGateway) {
    edgeErrors.add(1)
    logFailure('edge', res, stream)
  } else if (res.status >= 500) {
    gateway5xx.add(1)
    logFailure('gateway', res, stream)
  } else {
    gatewayOther.add(1)
    logFailure('gateway', res, stream)
  }

  if (stream && res.status === 200) {
    const complete = typeof res.body === 'string' && res.body.includes('data: [DONE]')
    if (!complete) {
      brokenStreams.add(1)
      logFailure('broken_stream', res, stream)
    }
    check(res, { 'stream completed': () => complete })
  } else {
    check(res, { 'status 200': (r) => r.status === 200 })
  }
}

export function handleSummary(data) {
  const m = (name, field = 'count') => (data.metrics[name] ? data.metrics[name].values[field] || 0 : 0)
  const result = {
    requests: m('http_reqs'),
    status_2xx: m('status_2xx'),
    status_429: m('status_429'),
    gateway_5xx: m('gateway_5xx'),
    gateway_other: m('gateway_other'),
    broken_streams: m('broken_streams'),
    edge_errors: m('edge_errors'),
    network_errors: m('network_errors'),
    p50_ms: m('http_req_duration', 'p(50)'),
    p95_ms: m('http_req_duration', 'p(95)'),
    p99_ms: m('http_req_duration', 'p(99)'),
  }
  return { stdout: `K6_RESULT ${JSON.stringify(result)}\n` }
}
