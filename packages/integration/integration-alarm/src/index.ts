/**
 * Service Definition for the alarm query capability seam (`ctx.alarmQuery`):
 * the provider registry, the explicit request-resolution step, and
 * registration-order-independent provider selection. Duplicate ids are
 * rejected. At execution time a configured provider must exist and be usable;
 * without one, exactly one usable provider is required, so selection never
 * depends on registration order.
 * @module @deepseek-ai/dsh-integration-alarm
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  AlarmQueryProvider,
  AlarmQueryRequest,
  AlarmQueryResult,
  AlarmQuerySpec,
} from './types.ts'
import { AlarmError } from './types.ts'

export { AlarmError } from './types.ts'
export type {
  Alarm,
  AlarmErrorCode,
  AlarmQueryProvider,
  AlarmQueryRequest,
  AlarmQueryResult,
  AlarmQuerySpec,
  AlarmSeverity,
  AlarmStatus,
} from './types.ts'
export { isIso8601Timestamp } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    alarmQuery: AlarmQueryRuntime
  }
}

/**
 * Config for the alarm seam. `provider` pins which registered provider wins;
 * omitted means auto-select when exactly one usable provider is registered.
 * Operational overrides must feed this same field rather than introduce a
 * hidden priority chain.
 */
export interface AlarmQueryRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one usable. */
  readonly provider?: string
}

/**
 * The alarm query service, registered as `ctx.alarmQuery` (one instance per
 * context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `ALARM_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `ALARM_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `ALARM_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `ALARM_PROVIDER_UNAVAILABLE`.
 */
export class AlarmQueryRuntime extends Service {
  /** Provider selection config for this instance. */
  static Config: z<AlarmQueryRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private providers = new Map<string, AlarmQueryProvider>()
  private readonly providerId: string | undefined

  constructor(ctx: Context, config: AlarmQueryRuntimeConfig = {}) {
    super(ctx, 'alarmQuery')
    this.providerId = config.provider
  }

  /**
   * Register an alarm provider. Throws {@link AlarmError}
   * `ALARM_PROVIDER_DUPLICATE` if its id is already registered. Returns a
   * disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerAlarmProvider(provider: AlarmQueryProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new AlarmError(`an alarm provider with id "${provider.id}" is already registered`, 'ALARM_PROVIDER_DUPLICATE')
    }
    const providers = this.providers
    const dispose = this.ctx.effect(function* () {
      providers.set(provider.id, provider)
      yield () => providers.delete(provider.id)
    }, 'alarmQuery.registerAlarmProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * The explicit defaulting step between callers and providers: apply the
   * seam's own defaults to one request and yield a total {@link AlarmQuerySpec}.
   * The only seam default is `maxAlarms`; absent filters pass through absent so
   * providers can omit them upstream.
   * @param request - the caller's query request.
   * @returns the resolved query spec.
   */
  resolve(request: AlarmQueryRequest): AlarmQuerySpec {
    return { ...request, maxAlarms: request.maxAlarms ?? DEFAULT_MAX_ALARMS }
  }

  /**
   * Run one resolved query through the selected provider. Resolves the
   * provider at call time with the selection rules above, then enforces
   * `spec.maxAlarms` on the result: if the provider over-returns, `alarms[]`
   * is truncated and `truncated` set.
   * @param request - the caller's query request; defaulted through {@link resolve}.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the query outcome, capped to the spec's `maxAlarms`.
   */
  async query(request: AlarmQueryRequest, signal?: AbortSignal): Promise<AlarmQueryResult> {
    const spec = this.resolve(request)
    const provider = resolveProvider(this.providerId, this.providers)
    const result = await provider.query(spec, signal)
    return capAlarms(result, spec.maxAlarms)
  }
}

/** Seam-level default returned-item bound when a request omits `maxAlarms`. */
export const DEFAULT_MAX_ALARMS = 20

/** Resolve the selected provider or throw the matching {@link AlarmError}. */
function resolveProvider(configuredId: string | undefined, providers: ReadonlyMap<string, AlarmQueryProvider>): AlarmQueryProvider {
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new AlarmError(`configured alarm provider "${configuredId}" is not registered`, 'ALARM_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new AlarmError(`configured alarm provider "${configuredId}" is registered but unavailable`, 'ALARM_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new AlarmError('no usable alarm provider is registered', 'ALARM_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new AlarmError(`multiple usable alarm providers are registered (${ids}); configure one explicitly`, 'ALARM_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** Enforce `maxAlarms` on a result: truncate `alarms[]` and flag it. */
function capAlarms(result: AlarmQueryResult, maxAlarms: number): AlarmQueryResult {
  if (result.alarms.length <= maxAlarms) return result
  return { ...result, alarms: result.alarms.slice(0, maxAlarms), truncated: true }
}

export default AlarmQueryRuntime
