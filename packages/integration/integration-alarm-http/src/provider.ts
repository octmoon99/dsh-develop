/**
 * HTTP {@link AlarmQueryProvider} for the alarm query seam. It maps one alarm
 * system's REST API onto the seam's closed alarm vocabulary and never owns
 * provider selection. The wire contract it reads is fixed:
 * `GET {baseUrl}/alarms` with `severity`/`status`/`source`/`keyword`/`since`/
 * `until`/`limit` query parameters, answered by
 * `{ total: number, alarms: [{ id, title, severity, status, source?, firedAt,
 * acknowledgedAt?, resolvedAt?, detail? }] }`. Every unknown key, wrong type,
 * out-of-vocabulary value, or non-ISO-8601 timestamp fails loud as
 * `ALARM_PROVIDER_FAILED`; a response body over the byte budget fails the
 * attempt without being downloaded whole.
 * @module @deepseek-ai/dsh-integration-alarm-http/provider
 */

import type { Alarm, AlarmQueryProvider, AlarmQueryResult, AlarmQuerySpec, AlarmSeverity, AlarmStatus } from '@deepseek-ai/dsh-integration-alarm'
import { AlarmError, isIso8601Timestamp } from '@deepseek-ai/dsh-integration-alarm'

/** Registry id of the HTTP alarm provider. */
export const HTTP_ALARM_PROVIDER_ID = 'http'

/** Fully resolved transport parameters; defaulting happens in the plugin Config, never inline. */
export interface HttpAlarmProviderOptions {
  /** Resolved alarm base directory URL (from {@link resolveAlarmBase}); queried at `{baseUrl}/alarms`. */
  readonly baseUrl: URL
  /** Resolves the bearer token per attempt, or `undefined` for anonymous access. */
  readonly resolveToken: () => Promise<string | undefined>
  /** Per-attempt timeout in milliseconds; bounds token resolution and the request alike. */
  readonly timeoutMs: number
  /** Ceiling on the response body in bytes; a body that crosses it fails the attempt. */
  readonly maxResponseBytes: number
  /** Retry attempts after the first failed attempt (0 = no retry). */
  readonly retries: number
  /** Backoff before the first retry; doubles per attempt. */
  readonly retryBaseDelayMs: number
  /** Backoff wait between attempts; overridable for deterministic tests. */
  readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Resolve one configured base URL into the directory URL the alarms path
 * joins onto: absolute `http`/`https` only, no query or fragment, pathname
 * always slash-terminated so `alarm/api/v1` and `alarm/api/v1/` produce the
 * same `{base}/alarms` target and no path segment is dropped.
 * @param baseUrl - the configured base URL.
 * @returns the normalized directory URL.
 */
export function resolveAlarmBase(baseUrl: string): URL {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch (error) {
    throw providerFailure(`baseUrl "${baseUrl}" is not an absolute URL`, error)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw providerFailure(`baseUrl "${baseUrl}" must be an http or https URL`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw providerFailure(`baseUrl "${baseUrl}" must not carry a query or fragment`)
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

/** Alarm severities the wire contract accepts, as a runtime set. */
const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low'])

/** Alarm statuses the wire contract accepts, as a runtime set. */
const STATUSES: ReadonlySet<string> = new Set(['firing', 'acknowledged', 'resolved'])

/** Fail loud with `ALARM_PROVIDER_FAILED`, chaining the cause when present. */
function providerFailure(message: string, cause?: unknown): AlarmError {
  return new AlarmError(`alarm http provider: ${message}`, 'ALARM_PROVIDER_FAILED', cause === undefined ? undefined : { cause })
}

/** Read one optional string field into its own keyed spread entry, rejecting non-string values. */
function optionalString(alarm: Record<string, unknown>, key: string): Record<string, string> {
  const value = alarm[key]
  if (value === undefined) return {}
  if (typeof value !== 'string') throw providerFailure(`alarm field "${key}" must be a string when present`)
  return { [key]: value }
}

/** Read one optional timestamp field, rejecting non-ISO-8601 values when present. */
function optionalTimestamp(alarm: Record<string, unknown>, key: string): Record<string, string> {
  const entry = optionalString(alarm, key)
  const value = entry[key]
  if (value !== undefined && !isIso8601Timestamp(value)) {
    throw providerFailure(`alarm field "${key}" must be an ISO-8601 timestamp when present`)
  }
  return entry
}

/** Read one required string field, rejecting missing or non-string values. */
function requiredString(alarm: Record<string, unknown>, key: string): string {
  const value = alarm[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw providerFailure(`alarm field "${key}" must be a non-empty string`)
  }
  return value
}

/**
 * Decode one vendor alarm object into the seam's {@link Alarm}. The wire
 * boundary is fully validated: required fields present and typed, optional
 * fields typed when present, severity/status inside the seam vocabulary, and
 * no unknown keys (a silently dropped field would make the projection lie
 * about what the source returned).
 * @param value - one element of the response's `alarms` array.
 * @returns the normalized alarm.
 */
export function decodeAlarm(value: unknown): Alarm {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw providerFailure('each alarms[] entry must be an object')
  }
  const alarm = value as Record<string, unknown>
  const known = ['id', 'title', 'severity', 'status', 'source', 'firedAt', 'acknowledgedAt', 'resolvedAt', 'detail']
  const unknownKey = Object.keys(alarm).find(key => !known.includes(key))
  if (unknownKey !== undefined) {
    throw providerFailure(`alarm field "${unknownKey}" is not part of the wire contract`)
  }
  const severity = requiredString(alarm, 'severity')
  if (!SEVERITIES.has(severity)) throw providerFailure(`alarm severity "${severity}" is outside the seam vocabulary`)
  const status = requiredString(alarm, 'status')
  if (!STATUSES.has(status)) throw providerFailure(`alarm status "${status}" is outside the seam vocabulary`)
  const firedAt = requiredString(alarm, 'firedAt')
  if (!isIso8601Timestamp(firedAt)) throw providerFailure('alarm field "firedAt" must be an ISO-8601 timestamp')
  return {
    id: requiredString(alarm, 'id'),
    title: requiredString(alarm, 'title'),
    severity: severity as AlarmSeverity,
    status: status as AlarmStatus,
    ...optionalString(alarm, 'source'),
    firedAt,
    ...optionalTimestamp(alarm, 'acknowledgedAt'),
    ...optionalTimestamp(alarm, 'resolvedAt'),
    ...optionalString(alarm, 'detail'),
  }
}

/**
 * Decode one full response body into the seam's {@link AlarmQueryResult}.
 * @param text - the raw response body text.
 * @returns the normalized result.
 */
export function decodeAlarmResponse(text: string): AlarmQueryResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw providerFailure('response body is not valid JSON', error)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw providerFailure('response body must be an object')
  }
  const body = parsed as Record<string, unknown>
  const unknownKey = Object.keys(body).find(key => key !== 'total' && key !== 'alarms')
  if (unknownKey !== undefined) {
    throw providerFailure(`response field "${unknownKey}" is not part of the wire contract`)
  }
  if (typeof body.total !== 'number' || !Number.isInteger(body.total) || body.total < 0) {
    throw providerFailure('response field "total" must be a non-negative integer')
  }
  if (!Array.isArray(body.alarms)) {
    throw providerFailure('response field "alarms" must be an array')
  }
  const alarms = body.alarms.map(decodeAlarm)
  if (alarms.length > body.total) {
    throw providerFailure(`response lists ${alarms.length} alarms but claims total ${body.total}`)
  }
  return { alarms, total: body.total, truncated: alarms.length < body.total }
}

/** The alarm query provider backed by the documented REST contract. */
export class HttpAlarmProvider implements AlarmQueryProvider {
  readonly id = HTTP_ALARM_PROVIDER_ID

  private readonly options: HttpAlarmProviderOptions

  constructor(options: HttpAlarmProviderOptions) {
    this.options = options
  }

  /** Always usable: the plugin validated the whole config before constructing this provider. */
  available(): boolean {
    return true
  }

  /**
   * Resolve the bearer token under the attempt's timeout/cancel regime. A
   * resolution that loses the race keeps running unobserved and its result is
   * discarded; the attempt reports the abort instead.
   */
  private async resolveTokenBounded(attemptSignal: AbortSignal, url: string): Promise<string | undefined> {
    if (attemptSignal.aborted) throw providerFailure(`request to ${url} was aborted`)
    const resolution = this.options.resolveToken()
    const guard = new Promise<never>((_, reject) => {
      attemptSignal.addEventListener('abort', () => {
        reject(providerFailure(`token resolution for ${url} was aborted`, new Error('token resolution exceeded its budget')))
      }, { once: true })
    })
    try {
      return await Promise.race([resolution, guard])
    } catch (error) {
      // The losing resolution's eventual rejection has no observer.
      resolution.catch(() => {})
      throw error instanceof AlarmError ? error : providerFailure(`token resolution for ${url} failed`, error)
    }
  }

  /**
   * Read the response body under {@link HttpAlarmProviderOptions.maxResponseBytes},
   * cancelling the stream as soon as the budget is crossed so an oversized
   * answer is not downloaded whole before failing.
   */
  private async readBody(response: Response, url: string): Promise<string> {
    const body = response.body
    if (body === null) return ''
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let received = 0
    let text = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > this.options.maxResponseBytes) {
          try {
            await reader.cancel()
          } catch {
            // The stream was already broken; the budget breach is the report.
          }
          throw providerFailure(`response from ${url} exceeded the ${this.options.maxResponseBytes}-byte budget`)
        }
        text += decoder.decode(value, { stream: true })
      }
      return text + decoder.decode()
    } catch (error) {
      if (error instanceof AlarmError) throw error
      throw providerFailure(`reading the response from ${url} failed`, error)
    }
  }

  /** One attempt against the alarm system; returns the raw response text. */
  private async attempt(url: string, signal: AbortSignal | undefined): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs)
    const attemptSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    const token = await this.resolveTokenBounded(attemptSignal, url)
    try {
      const response = await fetch(url, {
        signal: attemptSignal,
        headers: {
          accept: 'application/json',
          ...token === undefined ? {} : { authorization: `Bearer ${token}` },
        },
      })
      if (!response.ok) {
        throw providerFailure(`request to ${url} returned HTTP ${response.status}`)
      }
      const text = await this.readBody(response, url)
      if (attemptSignal.aborted) throw providerFailure(`request to ${url} was aborted`)
      return text
    } catch (error) {
      if (error instanceof AlarmError) throw error
      throw providerFailure(`request to ${url} failed`, error)
    }
  }

  /** @inheritdoc */
  async query(spec: AlarmQuerySpec, signal?: AbortSignal): Promise<AlarmQueryResult> {
    const url = new URL('alarms', this.options.baseUrl)
    const params = url.searchParams
    if (spec.severity !== undefined) params.set('severity', spec.severity)
    if (spec.status !== undefined) params.set('status', spec.status)
    if (spec.source !== undefined) params.set('source', spec.source)
    if (spec.keyword !== undefined) params.set('keyword', spec.keyword)
    if (spec.since !== undefined) params.set('since', spec.since)
    if (spec.until !== undefined) params.set('until', spec.until)
    params.set('limit', String(spec.maxAlarms))
    // The limit parameter is an upstream cost bound; the seam still enforces
    // maxAlarms on the returned array.
    const target = url.toString()
    for (let attempt = 0; ; attempt++) {
      let text: string
      try {
        text = await this.attempt(target, signal)
      } catch (error) {
        const retryable = error instanceof AlarmError
          && error.code === 'ALARM_PROVIDER_FAILED'
          && isRetryable(error)
          && signal?.aborted !== true
        if (!retryable || attempt >= this.options.retries) throw error
        await this.options.delay(this.options.retryBaseDelayMs * 2 ** attempt, signal)
        continue
      }
      // Decode failures are never retried: the upstream answered; the answer
      // is not the wire contract.
      return decodeAlarmResponse(text)
    }
  }
}

/** Whether one failed attempt is worth retrying: network failures, timeouts, throttling, transient 5xx. */
function isRetryable(error: AlarmError): boolean {
  const cause = error.cause
  if (cause !== undefined) return true
  // Messages this provider itself minted for HTTP status codes.
  return / returned HTTP (429|500|502|503|504)$/.test(error.message)
}
