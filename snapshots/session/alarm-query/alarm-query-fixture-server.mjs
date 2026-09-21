/** Deterministic loopback alarm gateway for the alarm-query Session snapshot. */
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

const RECORDED_BASE = new URL('http://127.0.0.1:43119/')
const TOKEN = 'snapshot-read-token'

const RESPONSE = {
  total: 2,
  alarms: [{
    id: 'snapshot-001',
    title: 'Snapshot database connection pool exhausted',
    severity: 'critical',
    status: 'firing',
    source: 'snapshot-database',
    firedAt: '2026-09-20T02:00:00Z',
    detail: 'Connections at 98%.',
  }],
}

/** Cordis plugin name. */
export const name = 'alarm-query-fixture-server'

function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return undefined
}

function transportInput(input, transportBase) {
  const raw = requestUrl(input)
  if (raw === undefined) return input
  let url
  try {
    url = new URL(raw)
  } catch {
    return input
  }
  if (url.origin !== RECORDED_BASE.origin) return input
  const target = new URL(url.pathname + url.search, transportBase)
  return input instanceof Request ? new Request(target, input) : target
}

function reject(response, message) {
  response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: message }))
}

function serve(request, response) {
  const url = new URL(request.url ?? '/', RECORDED_BASE)
  if (request.method !== 'GET' || url.pathname !== '/alarms') {
    reject(response, 'expected GET /alarms')
    return
  }
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    reject(response, 'expected snapshot bearer token')
    return
  }
  if (request.headers.accept !== 'application/json') {
    reject(response, 'expected application/json')
    return
  }
  const expected = new URLSearchParams({ severity: 'critical', status: 'firing', limit: '1' })
  if (url.searchParams.toString() !== expected.toString()) {
    reject(response, `unexpected query: ${url.searchParams.toString()}`)
    return
  }
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(RESPONSE))
}

/** Start the loopback gateway and restore the process fetch when its fiber stops. */
export async function apply(ctx) {
  let restoreFetch = () => {}
  await applyLoopbackServerEffect(ctx, {
    label: 'alarm-query-fixture-server',
    requestListener: serve,
    onListening: (address) => {
      const transportBase = new URL(RECORDED_BASE)
      transportBase.port = String(address.port)
      const originalFetch = globalThis.fetch
      const fixtureFetch = async (input, init) => originalFetch(transportInput(input, transportBase), init)
      globalThis.fetch = fixtureFetch
      restoreFetch = () => {
        if (globalThis.fetch !== fixtureFetch) {
          throw new Error('alarm-query-fixture-server: global fetch owner changed before cleanup')
        }
        globalThis.fetch = originalFetch
      }
    },
    onCleanup: () => restoreFetch(),
  })
}
