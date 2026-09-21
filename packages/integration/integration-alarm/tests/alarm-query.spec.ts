import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AlarmQueryRuntime, {
  AlarmError,
  isIso8601Timestamp,
  type Alarm,
  type AlarmQueryProvider,
  type AlarmQueryResult,
  type AlarmQuerySpec,
} from '@deepseek-ai/dsh-integration-alarm'

function alarm(id: string, overrides: Partial<Alarm> = {}): Alarm {
  return { id, title: `alarm ${id}`, severity: 'high', status: 'firing', firedAt: '2026-09-16T08:00:00Z', ...overrides }
}

function result(alarms: readonly Alarm[], total = alarms.length, truncated = false): AlarmQueryResult {
  return { alarms, total, truncated }
}

/** A scripted provider capturing the specs it received. */
function makeProvider(
  id: string,
  available: boolean,
  query: (spec: AlarmQuerySpec) => Promise<AlarmQueryResult>,
): AlarmQueryProvider & { specs: AlarmQuerySpec[] } {
  const specs: AlarmQuerySpec[] = []
  return {
    id,
    specs,
    available: () => available,
    query: (spec) => {
      specs.push(structuredClone(spec))
      return query(spec)
    },
  }
}

/** Mount an AlarmQueryRuntime on a fresh root context with the given config. */
type Mounted = { ctx: Context; runtime: AlarmQueryRuntime }

async function mountAlarm(config: ConstructorParameters<typeof AlarmQueryRuntime>[1] = {}): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(AlarmQueryRuntime, config)
  return { ctx, runtime: ctx.alarmQuery }
}

describe('resolve', () => {
  it('applies the seam default to maxAlarms and passes absent filters through absent', async () => {
    const { runtime } = await mountAlarm()
    expect(runtime.resolve({})).toEqual({ maxAlarms: 20 })
    expect(runtime.resolve({ severity: 'critical', maxAlarms: 5 })).toEqual({ severity: 'critical', maxAlarms: 5 })
  })
})

describe('registerAlarmProvider', () => {
  it('registers a provider and unregisters it via the returned disposer', async () => {
    const { runtime } = await mountAlarm()
    const provider = makeProvider('p', true, () => Promise.resolve(result([alarm('1')])))
    const dispose = runtime.registerAlarmProvider(provider)
    await expect(runtime.query({})).resolves.toEqual(result([alarm('1')]))
    dispose()
    await expect(runtime.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_UNAVAILABLE' })
  })

  it('rejects a duplicate id with ALARM_PROVIDER_DUPLICATE', async () => {
    const { runtime } = await mountAlarm()
    runtime.registerAlarmProvider(makeProvider('p', true, () => Promise.resolve(result([]))))
    let caught: unknown
    try {
      runtime.registerAlarmProvider(makeProvider('p', true, () => Promise.resolve(result([]))))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AlarmError)
    expect((caught as AlarmError).code).toBe('ALARM_PROVIDER_DUPLICATE')
  })
})

describe('provider selection ladder', () => {
  it('selects the configured id when registered and available', async () => {
    const a = makeProvider('a', true, () => Promise.resolve(result([alarm('a')])))
    const b = makeProvider('b', true, () => Promise.resolve(result([alarm('b')])))
    const { runtime } = await mountAlarm({ provider: 'b' })
    runtime.registerAlarmProvider(a)
    runtime.registerAlarmProvider(b)
    await expect(runtime.query({})).resolves.toEqual(result([alarm('b')]))
  })

  it('throws ALARM_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { runtime } = await mountAlarm({ provider: 'gone' })
    runtime.registerAlarmProvider(makeProvider('a', true, () => Promise.resolve(result([]))))
    await expect(runtime.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_CONFIGURED_MISSING' })
  })

  it('throws ALARM_PROVIDER_CONFIGURED_UNAVAILABLE when the configured provider is unavailable', async () => {
    const { runtime } = await mountAlarm({ provider: 'a' })
    runtime.registerAlarmProvider(makeProvider('a', false, () => Promise.resolve(result([]))))
    await expect(runtime.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_CONFIGURED_UNAVAILABLE' })
  })

  it('auto-selects exactly one usable provider', async () => {
    const { runtime } = await mountAlarm()
    runtime.registerAlarmProvider(makeProvider('a', false, () => Promise.resolve(result([]))))
    runtime.registerAlarmProvider(makeProvider('b', true, () => Promise.resolve(result([alarm('b')]))))
    await expect(runtime.query({})).resolves.toEqual(result([alarm('b')]))
  })

  it('throws ALARM_PROVIDER_AMBIGUOUS when several providers are usable', async () => {
    const { runtime } = await mountAlarm()
    runtime.registerAlarmProvider(makeProvider('a', true, () => Promise.resolve(result([]))))
    runtime.registerAlarmProvider(makeProvider('b', true, () => Promise.resolve(result([]))))
    await expect(runtime.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_AMBIGUOUS' })
  })

  it('throws ALARM_PROVIDER_UNAVAILABLE when nothing usable is registered', async () => {
    const { runtime } = await mountAlarm()
    runtime.registerAlarmProvider(makeProvider('a', false, () => Promise.resolve(result([]))))
    await expect(runtime.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_UNAVAILABLE' })
  })
})

describe('query', () => {
  it('forwards the resolved spec and the cancellation signal to the provider', async () => {
    const { runtime } = await mountAlarm()
    let receivedSpec: AlarmQuerySpec | undefined
    let receivedSignal: AbortSignal | undefined
    runtime.registerAlarmProvider({
      id: 'a',
      available: () => true,
      query: (spec, signal) => {
        receivedSpec = structuredClone(spec)
        receivedSignal = signal
        return Promise.resolve(result([]))
      },
    })
    const controller = new AbortController()
    await runtime.query({ severity: 'critical' }, controller.signal)
    expect(receivedSpec).toEqual({ severity: 'critical', maxAlarms: 20 })
    expect(receivedSignal).toBe(controller.signal)
  })

  it('truncates an over-returning provider to maxAlarms and flags truncated', async () => {
    const { runtime } = await mountAlarm()
    const alarms = Array.from({ length: 5 }, (_, index) => alarm(String(index)))
    runtime.registerAlarmProvider(makeProvider('a', true, () => Promise.resolve(result(alarms, 5))))
    await expect(runtime.query({ maxAlarms: 2 })).resolves.toEqual({
      alarms: [alarm('0'), alarm('1')],
      total: 5,
      truncated: true,
    })
  })

  it('keeps a provider-flagged truncation as-is', async () => {
    const { runtime } = await mountAlarm()
    runtime.registerAlarmProvider(makeProvider('a', true, () => Promise.resolve(result([alarm('0')], 9, true))))
    await expect(runtime.query({ maxAlarms: 5 })).resolves.toEqual(result([alarm('0')], 9, true))
  })

  it('propagates provider failures as-is', async () => {
    const { runtime } = await mountAlarm()
    const failure = new AlarmError('upstream down', 'ALARM_PROVIDER_FAILED')
    runtime.registerAlarmProvider(makeProvider('a', true, () => Promise.reject(failure)))
    await expect(runtime.query({})).rejects.toBe(failure)
  })
})

describe('registration is an effect', () => {
  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, runtime } = await mountAlarm()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.alarmQuery.registerAlarmProvider(makeProvider('a', true, () => Promise.resolve(result([alarm('1')]))))
    }, { inject: ['alarmQuery'] }))
    await expect(runtime.query({})).resolves.toEqual(result([alarm('1')]))
    await fiber.dispose()
    await expect(runtime.query({})).rejects.toMatchObject({ code: 'ALARM_PROVIDER_UNAVAILABLE' })
  })
})

describe('isIso8601Timestamp', () => {
  it('accepts dates, datetimes, fractional seconds, and offsets', () => {
    expect(isIso8601Timestamp('2026-09-16')).toBe(true)
    expect(isIso8601Timestamp('2026-09-16T08:00:00Z')).toBe(true)
    expect(isIso8601Timestamp('2026-09-16 08:00:00')).toBe(true)
    expect(isIso8601Timestamp('2026-09-16T08:00:00.123Z')).toBe(true)
    expect(isIso8601Timestamp('2026-09-16T08:00:00+08:00')).toBe(true)
  })

  it('rejects loose Date.parse forms and impossible dates', () => {
    expect(isIso8601Timestamp('not-a-date')).toBe(false)
    expect(isIso8601Timestamp('Sept 16, 2026')).toBe(false)
    expect(isIso8601Timestamp('2026/09/16')).toBe(false)
    expect(isIso8601Timestamp('08:00:00')).toBe(false)
    expect(isIso8601Timestamp('2026-13-45')).toBe(false)
  })
})
