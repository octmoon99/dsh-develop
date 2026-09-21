/**
 * Vocabulary for the alarm query capability seam (`ctx.alarmQuery`). The seam
 * owns the closed alarm vocabulary: providers map their vendor payloads into
 * these objects, so a new severity or status is a coordinated change across
 * known packages, not a plugin extension.
 * @module @deepseek-ai/dsh-integration-alarm/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Alarm severity, most urgent first. Providers map vendor levels onto it. */
export type AlarmSeverity = 'critical' | 'high' | 'medium' | 'low'

/** Lifecycle state of one alarm. */
export type AlarmStatus = 'firing' | 'acknowledged' | 'resolved'

/**
 * One normalized alarm. Required fields are exactly what every alarm system
 * can supply; optional fields are omitted rather than invented so the seam
 * never lies about what the source returned.
 */
export interface Alarm {
  /** Stable alarm identity from the source system. */
  readonly id: string
  /** One-line summary of what fired. */
  readonly title: string
  readonly severity: AlarmSeverity
  readonly status: AlarmStatus
  /** Originating system, service, or metric, when the source names one. */
  readonly source?: string
  /** When the alarm fired, as a source-supplied ISO-8601 string. */
  readonly firedAt: string
  /** When an operator acknowledged it, when known. */
  readonly acknowledgedAt?: string
  /** When it was resolved, when known. */
  readonly resolvedAt?: string
  /** Longer explanation from the source, when present. */
  readonly detail?: string
}

/**
 * What a caller asks of the alarm capability. Every field is optional: the
 * seam's {@link AlarmQueryRuntime.resolve} step applies the explicit defaults
 * and yields a total {@link AlarmQuerySpec}; providers never see a raw
 * request.
 */
export interface AlarmQueryRequest {
  readonly severity?: AlarmSeverity
  readonly status?: AlarmStatus
  readonly source?: string
  /** Free-text match against title and detail. */
  readonly keyword?: string
  /** Only alarms fired at or after this ISO-8601 timestamp. */
  readonly since?: string
  /** Only alarms fired before this ISO-8601 timestamp. */
  readonly until?: string
  /** Upper bound on returned alarms; the seam truncates to it. */
  readonly maxAlarms?: number
}

/**
 * A fully resolved query: the single defaulting point between callers and
 * providers. `maxAlarms` is always a number; absent filters stay absent so a
 * provider can omit them from its upstream call.
 */
export interface AlarmQuerySpec extends Omit<AlarmQueryRequest, 'maxAlarms'> {
  readonly maxAlarms: number
}

/** Normalized query outcome. `total` counts matches in the source system. */
export interface AlarmQueryResult {
  readonly alarms: readonly Alarm[]
  /** Total matching alarms in the source system; never smaller than `alarms.length`. */
  readonly total: number
  /** True when the seam or the provider cut `alarms` down from `total`. */
  readonly truncated: boolean
}

/**
 * Structural ISO-8601 check shared by wire decoding and tool-input
 * validation: a calendar date, optionally with a time and a `Z` or
 * `±HH:MM` offset, that also parses as a real date-time. Rejects the looser
 * forms `Date.parse` alone admits (month names, slashes, bare times).
 * @param value - the candidate timestamp.
 * @returns whether the value is an ISO-8601 date or date-time.
 */
export function isIso8601Timestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$/.test(value)) return false
  return !Number.isNaN(Date.parse(value))
}

/**
 * One alarm-query backend. Registered with
 * `ctx.alarmQuery.registerAlarmProvider`.
 */
export interface AlarmQueryProvider {
  /** Stable string id, unique within the registry. */
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Run one resolved query; honor `signal` for cancellation. */
  query(spec: AlarmQuerySpec, signal?: AbortSignal): Promise<AlarmQueryResult>
}

/**
 * Closed {@link AlarmError} code union. Consumers switch on `code` ending in
 * `default: assertNever(...)`; adding a code is a coordinated change.
 */
export type AlarmErrorCode =
  | 'ALARM_PROVIDER_DUPLICATE'
  | 'ALARM_PROVIDER_CONFIGURED_MISSING'
  | 'ALARM_PROVIDER_CONFIGURED_UNAVAILABLE'
  | 'ALARM_PROVIDER_AMBIGUOUS'
  | 'ALARM_PROVIDER_UNAVAILABLE'
  | 'ALARM_PROVIDER_FAILED'

/**
 * Typed alarm-seam error with a machine-routable closed `code` and chained
 * `cause`. Provider execution failures (network, HTTP, malformed payload)
 * surface as `ALARM_PROVIDER_FAILED` with the underlying error as `cause`.
 */
export class AlarmError extends HarnessError {
  // The body only narrows `code` to the closed union; the pass-through super
  // call is the narrowing mechanism, not dead wiring.
  // oxlint-disable-next-line no-useless-constructor
  constructor(message: string, code: AlarmErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
