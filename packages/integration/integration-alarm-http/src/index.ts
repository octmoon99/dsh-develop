/**
 * HTTP alarm query provider plugin. It contributes to the `ctx.alarmQuery`
 * registry without owning the service: the transport, credential reference,
 * timeout, and retry behavior are Config fields so deployments tune them from
 * cordis.yml, never in code.
 * @module @deepseek-ai/dsh-integration-alarm-http
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-integration-alarm'
import { AlarmError } from '@deepseek-ai/dsh-integration-alarm'
import { HttpAlarmProvider, resolveAlarmBase } from './provider.ts'
import type { HttpAlarmProviderOptions } from './provider.ts'

export { HTTP_ALARM_PROVIDER_ID, HttpAlarmProvider, resolveAlarmBase } from './provider.ts'
export type { HttpAlarmProviderOptions } from './provider.ts'
export {
  decodeAlarm,
  decodeAlarmResponse,
} from './provider.ts'

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

/** Default credential-reference name for the bearer token. */
export const DEFAULT_TOKEN_ENV = 'DSH_ALARM_API_TOKEN'

/** Default ceiling on one response body. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576

/** Cordis plugin name used by loader diagnostics. */
export const name = 'integration-alarm-http'

/** The alarm seam this provider registers into. */
export const inject = ['alarmQuery']

/**
 * Plugin config: transport, credential mode, and retry bounds. `auth` states
 * the deployment's credential reality explicitly: `bearer` resolves the token
 * per attempt and fails loud when nothing resolves — an anonymous request is
 * never sent by accident; `anonymous` sends no token at all.
 */
export interface Config {
  /** Base URL of the alarm system; queried at `{baseUrl}/alarms`. */
  readonly baseUrl: string
  /** Whether the alarm system requires a bearer token (`bearer`) or none (`anonymous`). */
  readonly auth: 'bearer' | 'anonymous'
  /** Literal bearer token; prefer {@link Config.tokenEnv} so config files stay shareable. */
  readonly token?: string
  /** Credential-reference name holding the bearer token. */
  readonly tokenEnv: string
  /** Per-attempt timeout in milliseconds; bounds token resolution and the request alike. */
  readonly timeoutMs: number
  /** Ceiling on the response body in bytes; a body that crosses it fails the attempt. */
  readonly maxResponseBytes: number
  /** Retry attempts after the first failed attempt (0 = fail on first failure). */
  readonly retries: number
  /** Backoff before the first retry; doubles per attempt. */
  readonly retryBaseDelayMs: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  auth: z.union(['bearer', 'anonymous'] as const).default('bearer'),
  token: z.string().role('secret'),
  tokenEnv: z.string().role('credential-ref').default(DEFAULT_TOKEN_ENV),
  timeoutMs: z.number().default(10_000),
  maxResponseBytes: z.number().default(DEFAULT_MAX_RESPONSE_BYTES),
  retries: z.number().default(2),
  retryBaseDelayMs: z.number().default(400),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Omit<Config, 'token'>> & { token?: string }

/** A resource limit must be a positive finite number. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`integration-alarm-http: ${name} must be a positive finite number`)
  }
}

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertTimeoutMs(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`integration-alarm-http: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** The retry count must be a non-negative integer. */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`integration-alarm-http: ${name} must be a non-negative integer`)
  }
}

/** The response budget must be a positive integer. */
function assertMaxResponseBytes(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('integration-alarm-http: maxResponseBytes must be a positive integer')
  }
}

/** Register the HTTP alarm provider with `ctx.alarmQuery`. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertTimeoutMs(resolved.timeoutMs)
  assertNonNegativeInteger('retries', resolved.retries)
  assertPositiveFinite('retryBaseDelayMs', resolved.retryBaseDelayMs)
  assertMaxResponseBytes(resolved.maxResponseBytes)
  const baseUrl = resolveAlarmBase(resolved.baseUrl)
  const tokenRef = credentialRef(resolved.tokenEnv)
  const literalToken = resolved.token !== undefined && resolved.token.length > 0
    ? resolved.token
    : undefined
  const options: HttpAlarmProviderOptions = {
    baseUrl,
    resolveToken: async () => {
      if (resolved.auth === 'anonymous') return undefined
      if (literalToken !== undefined) return literalToken
      const credentials = ctx.get('credentials')
      const fromSeam = credentials !== undefined ? (await credentials.resolve(tokenRef))?.value : undefined
      // Without the seam the environment is the whole credential plane.
      const ambient = fromSeam === undefined
        ? launchEnvironmentOf(ctx).get(tokenRef)?.value
        : fromSeam
      if (ambient === undefined || ambient.length === 0) {
        throw new AlarmError(
          `alarm http provider: auth is "bearer" but token reference "${resolved.tokenEnv}" resolved no token`,
          'ALARM_PROVIDER_FAILED',
        )
      }
      return ambient
    },
    timeoutMs: resolved.timeoutMs,
    maxResponseBytes: resolved.maxResponseBytes,
    retries: resolved.retries,
    retryBaseDelayMs: resolved.retryBaseDelayMs,
    delay: (ms, signal) => setTimeoutRejecting(ms, signal),
  }
  ctx.alarmQuery.registerAlarmProvider(new HttpAlarmProvider(options))
}

/** Abort reason coerced to an Error so rejection reasons stay typed. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
}

/** Backoff wait that rejects promptly when the caller cancels and releases its abort listener either way. */
function setTimeoutRejecting(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal as AbortSignal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
