import { createServer, type Server } from 'node:http'
import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AlarmQueryRuntime, { AlarmError } from '@deepseek-ai/dsh-integration-alarm'
import * as AlarmHttp from '@deepseek-ai/dsh-integration-alarm-http'
import { HttpAlarmProvider, resolveAlarmBase } from '@deepseek-ai/dsh-integration-alarm-http'
import type { HttpAlarmProviderOptions } from '@deepseek-ai/dsh-integration-alarm-http'

/** One request the test server observed. */
interface ServedRequest {
  path: string
  authorization: string | undefined
}

let server: Server | undefined
let baseUrl: string | undefined

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve()
      return
    }
    // The provider's fetch keeps connections alive; without closing them the
    // server never finishes draining and the suite hangs on teardown.
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })
  server = undefined
  baseUrl = undefined
})

/** Start a local alarm API recording requests and answering from a script. */
async function startAlarmApi(
  respond: (request: ServedRequest) => { status: number; body: string },
): Promise<void> {
  const requests: ServedRequest[] = []
  server = createServer((req, res) => {
    const request: ServedRequest = {
      path: req.url ?? '/',
      authorization: req.headers.authorization,
    }
    requests.push(request)
    const { status, body } = respond(request)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  baseUrl = `http://127.0.0.1:${address.port}`
  served.requests = requests
}

/** Requests recorded by the most recent {@link startAlarmApi}. */
const served: { requests: ServedRequest[] } = { requests: [] }

const VENDOR_BODY = JSON.stringify({
  total: 1,
  alarms: [{
    id: 'a-1',
    title: 'CPU too high',
    severity: 'critical',
    status: 'firing',
    source: 'node-7',
    firedAt: '2026-09-16T08:00:00Z',
    detail: 'cpu usage 96% for 5 minutes',
  }],
})

/** Options with deterministic, instant backoff and a stubbed token. */
function testOptions(overrides: Partial<HttpAlarmProviderOptions> = {}): HttpAlarmProviderOptions {
  return {
    baseUrl: resolveAlarmBase(baseUrl ?? 'http://127.0.0.1:1'),
    resolveToken: () => Promise.resolve('secret-token'),
    timeoutMs: 5_000,
    maxResponseBytes: 1_048_576,
    retries: 2,
    retryBaseDelayMs: 1,
    delay: () => Promise.resolve(),
    ...overrides,
  }
}

/** Boot the seam plus this provider on a fresh context. */
async function mountProvider(options: ConstructorParameters<typeof HttpAlarmProvider>[0]) {
  const ctx = new Context()
  await ctx.plugin(AlarmQueryRuntime)
  ctx.alarmQuery.registerAlarmProvider(new HttpAlarmProvider(options))
  return ctx
}

describe('query', () => {
  it('maps the vendor payload onto the closed alarm vocabulary', async () => {
    await startAlarmApi(() => ({ status: 200, body: VENDOR_BODY }))
    const ctx = await mountProvider(testOptions())
    await expect(ctx.alarmQuery.query({ severity: 'critical' })).resolves.toEqual({
      alarms: [{
        id: 'a-1',
        title: 'CPU too high',
        severity: 'critical',
        status: 'firing',
        source: 'node-7',
        firedAt: '2026-09-16T08:00:00Z',
        detail: 'cpu usage 96% for 5 minutes',
      }],
      total: 1,
      truncated: false,
    })
    await ctx.fiber.dispose()
  })

  it('sends the resolved filters, the limit, and the bearer token', async () => {
    await startAlarmApi(() => ({ status: 200, body: VENDOR_BODY }))
    const ctx = await mountProvider(testOptions())
    await ctx.alarmQuery.query({
      severity: 'high',
      status: 'firing',
      source: 'node-7',
      keyword: 'cpu',
      since: '2026-09-16T00:00:00Z',
      until: '2026-09-16T12:00:00Z',
      maxAlarms: 7,
    })
    expect(served.requests[0]).toMatchObject({
      authorization: 'Bearer secret-token',
    })
    const params = new URL(served.requests[0]!.path, 'http://x').searchParams
    expect(params.get('severity')).toBe('high')
    expect(params.get('status')).toBe('firing')
    expect(params.get('source')).toBe('node-7')
    expect(params.get('keyword')).toBe('cpu')
    expect(params.get('since')).toBe('2026-09-16T00:00:00Z')
    expect(params.get('until')).toBe('2026-09-16T12:00:00Z')
    expect(params.get('limit')).toBe('7')
    await ctx.fiber.dispose()
  })

  it('requests anonymously when no token resolves', async () => {
    await startAlarmApi(() => ({ status: 200, body: VENDOR_BODY }))
    const ctx = await mountProvider(testOptions({ resolveToken: () => Promise.resolve(undefined) }))
    await ctx.alarmQuery.query({})
    expect(served.requests[0]!.authorization).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('retries a transient 503 and succeeds on the second attempt', async () => {
    let calls = 0
    await startAlarmApi(() => {
      calls++
      return calls === 1 ? { status: 503, body: '{}' } : { status: 200, body: VENDOR_BODY }
    })
    const ctx = await mountProvider(testOptions())
    await expect(ctx.alarmQuery.query({})).resolves.toMatchObject({ total: 1 })
    expect(calls).toBe(2)
    await ctx.fiber.dispose()
  })

  it('fails with ALARM_PROVIDER_FAILED once retries are exhausted', async () => {
    await startAlarmApi(() => ({ status: 503, body: '{}' }))
    const ctx = await mountProvider(testOptions({ retries: 1 }))
    await expect(ctx.alarmQuery.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_FAILED' })
    expect(served.requests.length).toBe(2)
    await ctx.fiber.dispose()
  })

  it('does not retry a definitive 401', async () => {
    await startAlarmApi(() => ({ status: 401, body: '{}' }))
    const ctx = await mountProvider(testOptions())
    await expect(ctx.alarmQuery.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_FAILED' })
    expect(served.requests.length).toBe(1)
    await ctx.fiber.dispose()
  })

  it('rejects a malformed body without retrying', async () => {
    await startAlarmApi(() => ({ status: 200, body: 'not json' }))
    const ctx = await mountProvider(testOptions())
    await expect(ctx.alarmQuery.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_FAILED' })
    expect(served.requests.length).toBe(1)
    await ctx.fiber.dispose()
  })

  it('honors the cancellation signal', async () => {
    await startAlarmApi(() => ({ status: 200, body: VENDOR_BODY }))
    const ctx = await mountProvider(testOptions())
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.alarmQuery.query({}, controller.signal)).rejects.toBeInstanceOf(Error)
    await ctx.fiber.dispose()
  })

  it('times out an unresponsive upstream', async () => {
    server = createServer(() => { /* never responds */ })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    const ctx = await mountProvider(testOptions({
      baseUrl: resolveAlarmBase(`http://127.0.0.1:${address.port}`),
      retries: 0,
      timeoutMs: 50,
      delay: () => Promise.resolve(),
    }))
    await expect(ctx.alarmQuery.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_FAILED' })
    await ctx.fiber.dispose()
  })

  it('keeps every path segment with and without a trailing slash on baseUrl', async () => {
    await startAlarmApi(() => ({ status: 200, body: VENDOR_BODY }))
    const base = baseUrl!.replace(/\/$/, '')
    for (const configured of [`${base}/api/v1`, `${base}/api/v1/`]) {
      served.requests.length = 0
      const ctx = await mountProvider(testOptions({ baseUrl: resolveAlarmBase(configured) }))
      await ctx.alarmQuery.query({})
      expect(served.requests[0]!.path.startsWith('/api/v1/alarms')).toBe(true)
      await ctx.fiber.dispose()
    }
  })

  it('rejects a hanging token resolution through the attempt timeout', async () => {
    await startAlarmApi(() => ({ status: 200, body: VENDOR_BODY }))
    const ctx = await mountProvider(testOptions({
      resolveToken: () => new Promise(() => { /* never resolves */ }),
      retries: 0,
      timeoutMs: 50,
      delay: () => Promise.resolve(),
    }))
    await expect(ctx.alarmQuery.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_FAILED' })
    expect(served.requests).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('honors the caller signal while the token resolution hangs', async () => {
    await startAlarmApi(() => ({ status: 200, body: VENDOR_BODY }))
    const ctx = await mountProvider(testOptions({
      resolveToken: () => new Promise(() => { /* never resolves */ }),
      retries: 0,
      timeoutMs: 5_000,
      delay: () => Promise.resolve(),
    }))
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 20)
    await expect(ctx.alarmQuery.query({}, controller.signal)).rejects.toBeInstanceOf(Error)
    expect(served.requests).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('fails loud over the byte budget without downloading whole or retrying', async () => {
    await startAlarmApi(() => ({ status: 200, body: 'x'.repeat(10_000) }))
    const ctx = await mountProvider(testOptions({ maxResponseBytes: 1_000 }))
    await expect(ctx.alarmQuery.query({})).rejects.toThrow(/budget/)
    expect(served.requests).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('accepts a body exactly at the byte budget and decodes multibyte text', async () => {
    const detail = '告警细节'.repeat(3)
    await startAlarmApi(() => ({
      status: 200,
      body: JSON.stringify({
        total: 1,
        alarms: [{ id: 'a-1', title: 'CPU 过高', severity: 'critical', status: 'firing', firedAt: '2026-09-16T08:00:00Z', detail }],
      }),
    }))
    const bodyBytes = Buffer.byteLength(JSON.stringify({
      total: 1,
      alarms: [{ id: 'a-1', title: 'CPU 过高', severity: 'critical', status: 'firing', firedAt: '2026-09-16T08:00:00Z', detail }],
    }), 'utf8')
    const ctx = await mountProvider(testOptions({ maxResponseBytes: bodyBytes }))
    await expect(ctx.alarmQuery.query({})).resolves.toMatchObject({ alarms: [{ id: 'a-1', detail }] })
    await ctx.fiber.dispose()
  })

  it('releases the backoff abort listener once the wait finishes', async () => {
    let calls = 0
    await startAlarmApi(() => {
      calls++
      return calls === 1 ? { status: 503, body: '{}' } : { status: 200, body: VENDOR_BODY }
    })
    const ctx = await mountProvider(testOptions())
    const controller = new AbortController()
    await ctx.alarmQuery.query({}, controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})

describe('decodeAlarmResponse (wire boundary)', () => {
  const cases: [name: string, body: string][] = [
    ['unknown top-level key', '{"total":0,"alarms":[],"cursor":"x"}'],
    ['non-integer total', '{"total":1.5,"alarms":[]}'],
    ['negative total', '{"total":-1,"alarms":[]}'],
    ['missing alarms array', '{"total":0}'],
    ['alarm severity outside the vocabulary', '{"total":1,"alarms":[{"id":"1","title":"t","severity":"urgent","status":"firing","firedAt":"x"}]}'],
    ['alarm status outside the vocabulary', '{"total":1,"alarms":[{"id":"1","title":"t","severity":"low","status":"open","firedAt":"x"}]}'],
    ['unknown alarm key', '{"total":1,"alarms":[{"id":"1","title":"t","severity":"low","status":"firing","firedAt":"x","assignee":"a"}]}'],
    ['missing required alarm key', '{"total":1,"alarms":[{"id":"1","severity":"low","status":"firing","firedAt":"x"}]}'],
    ['non-ISO firedAt', '{"total":1,"alarms":[{"id":"1","title":"t","severity":"low","status":"firing","firedAt":"16/09/2026"}]}'],
    ['non-ISO acknowledgedAt', '{"total":1,"alarms":[{"id":"1","title":"t","severity":"low","status":"firing","firedAt":"2026-09-16T08:00:00Z","acknowledgedAt":"yesterday"}]}'],
    ['alarms longer than total', '{"total":0,"alarms":[{"id":"1","title":"t","severity":"low","status":"firing","firedAt":"x"}]}'],
    ['non-object root', '[]'],
  ]
  for (const [name, body] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => AlarmHttp.decodeAlarmResponse(body)).toThrow(AlarmError)
    })
  }

  it('flags truncation when the source has more alarms than it returned', () => {
    const decoded = AlarmHttp.decodeAlarmResponse('{"total":2,"alarms":[{"id":"1","title":"t","severity":"low","status":"firing","firedAt":"2026-09-16T08:00:00Z"}]}')
    expect(decoded.truncated).toBe(true)
  })
})

describe('resolveAlarmBase', () => {
  it('normalizes root and prefixed bases into slash-terminated directories', () => {
    expect(resolveAlarmBase('http://alarm.internal').href).toBe('http://alarm.internal/')
    expect(resolveAlarmBase('http://alarm.internal/api/v1').href).toBe('http://alarm.internal/api/v1/')
    expect(resolveAlarmBase('http://alarm.internal/api/v1/').href).toBe('http://alarm.internal/api/v1/')
  })

  it('rejects non-http protocols, relative URLs, and bases with a query or fragment', () => {
    expect(() => resolveAlarmBase('ftp://alarm.internal')).toThrow(/http or https/)
    expect(() => resolveAlarmBase('alarm.internal/alarms')).toThrow(/absolute URL/)
    expect(() => resolveAlarmBase('http://alarm.internal/?token=1')).toThrow(/query or fragment/)
    expect(() => resolveAlarmBase('http://alarm.internal/#section')).toThrow(/query or fragment/)
  })
})

describe('apply config validation', () => {
  async function mountPlugin(config: Record<string, unknown>): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(AlarmQueryRuntime)
    // The runtime schema applies every field default; the cast keeps the
    // partial test record out of the plugin's resolved Config type.
    await ctx.plugin(AlarmHttp, config as never)
    return ctx
  }

  it('rejects a zero timeoutMs', async () => {
    await expect(mountPlugin({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 0 })).rejects.toThrow('timeoutMs')
  })

  it('rejects a negative retry count', async () => {
    await expect(mountPlugin({ baseUrl: 'http://127.0.0.1:1', retries: -1 })).rejects.toThrow('retries')
  })

  it('rejects a zero backoff base', async () => {
    await expect(mountPlugin({ baseUrl: 'http://127.0.0.1:1', retryBaseDelayMs: 0 })).rejects.toThrow('retryBaseDelayMs')
  })

  it('rejects an unusable baseUrl and a non-positive byte budget', async () => {
    await expect(mountPlugin({ baseUrl: 'ftp://alarm.internal' })).rejects.toThrow(/http or https/)
    await expect(mountPlugin({ baseUrl: 'not a url' })).rejects.toThrow(/absolute URL/)
    await expect(mountPlugin({ baseUrl: 'http://127.0.0.1:1', maxResponseBytes: 0 })).rejects.toThrow('maxResponseBytes')
  })

  it('fails loud on a query when bearer auth resolves no token, without sending a request', async () => {
    await startAlarmApi(() => ({ status: 200, body: VENDOR_BODY }))
    const ctx = await mountPlugin({
      baseUrl: baseUrl,
      tokenEnv: 'DSH_ALARM_TEST_UNSET_TOKEN',
      retries: 0,
    })
    await expect(ctx.alarmQuery.query({})).rejects.toThrow(/resolved no token/)
    expect(served.requests).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('sends no token at all in anonymous mode', async () => {
    await startAlarmApi(() => ({ status: 200, body: VENDOR_BODY }))
    const ctx = await mountPlugin({
      baseUrl: baseUrl,
      auth: 'anonymous',
      tokenEnv: 'DSH_ALARM_TEST_UNSET_TOKEN',
      retries: 0,
    })
    await expect(ctx.alarmQuery.query({})).resolves.toMatchObject({ total: 1 })
    expect(served.requests[0]!.authorization).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('registers under the http id on a valid config', async () => {
    const ctx = await mountPlugin({ baseUrl: 'http://127.0.0.1:1', retries: 0 })
    expect(() => ctx.alarmQuery.registerAlarmProvider({
      id: AlarmHttp.HTTP_ALARM_PROVIDER_ID,
      available: () => true,
      query: () => Promise.reject(new Error('unused')),
    })).toThrow(AlarmError)
    await ctx.fiber.dispose()
  })
})
