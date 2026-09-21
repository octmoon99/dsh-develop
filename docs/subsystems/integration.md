# Systems Integration

English | [中文](integration.zh.md)

The alarm query seam — a [capability seam](../../.agents/notes/implemented/architecture/2026-09-16-integration-alarm-query.md) on one `ctx.alarmQuery` service, split across packages: Service Definition ([dsh-integration-alarm](../../packages/integration/integration-alarm), `ctx.alarmQuery` + the provider registry), Service Provider ([dsh-integration-alarm-http](../../packages/integration/integration-alarm-http), one alarm system's REST API mapped into the seam vocabulary), and Consumer ([dsh-tool-integration-alarm](../../packages/integration/tool-integration-alarm), the `alarm_query` tool schema and presentation). Integration seams are **optional capabilities**, not part of the agent-loop spine — their vocabulary lives here, not in [core.md](core.md). A provider swap does not change how the model asks for alarms; a transport card reads persisted presentation meta, never provider code. Future systems (ticketing, CMDB, on-call) repeat this three-role split as their own seam.

Source: [`packages/integration/integration-alarm/src/types.ts`](../../packages/integration/integration-alarm/src/types.ts)

## Request, resolution, and result

Callers send optional filters; the seam's `resolve(request)` step applies the one seam default (`maxAlarms`, default `20`) and yields a total spec, so providers never see a raw request. The consumer's deployment bound (`dsh-tool-integration-alarm`'s `maxAlarms` config, 1–100) flows through the spec; the seam enforces it on the way back — a provider that over-returns is truncated and flagged.

```ts type-equiv
/**
 * What a caller asks of the alarm capability. Every field is optional: the
 * seam's {@link AlarmQueryRuntime.resolve} step applies the explicit defaults
 * and yields a total {@link AlarmQuerySpec}; providers never see a raw
 * request.
 */
interface AlarmQueryRequest {
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
```

```ts type-equiv
/**
 * A fully resolved query: the single defaulting point between callers and
 * providers. `maxAlarms` is always a number; absent filters stay absent so a
 * provider can omit them from its upstream call.
 */
interface AlarmQuerySpec extends Omit<AlarmQueryRequest, 'maxAlarms'> {
  readonly maxAlarms: number
}
```

```ts type-equiv
/** Normalized query outcome. `total` counts matches in the source system. */
interface AlarmQueryResult {
  readonly alarms: readonly Alarm[]
  /** Total matching alarms in the source system; never smaller than `alarms.length`. */
  readonly total: number
  /** True when the seam or the provider cut `alarms` down from `total`. */
  readonly truncated: boolean
}
```

## The closed alarm vocabulary

The seam owns the alarm shape; providers map vendor payloads into it. Severity and status are closed unions — a vendor level outside them fails loud at the provider boundary instead of silently mislabeling. Optional fields are omitted rather than invented, so the seam never lies about what the source returned.

```ts type-equiv
/** Alarm severity, most urgent first. Providers map vendor levels onto it. */
type AlarmSeverity = 'critical' | 'high' | 'medium' | 'low'
```

```ts type-equiv
/** Lifecycle state of one alarm. */
type AlarmStatus = 'firing' | 'acknowledged' | 'resolved'
```

```ts type-equiv
/**
 * One normalized alarm. Required fields are exactly what every alarm system
 * can supply; optional fields are omitted rather than invented so the seam
 * never lies about what the source returned.
 */
interface Alarm {
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
```

## Providers and errors

One backend registers per capability; selection resolves at execution time and never depends on registration order. `AlarmError extends HarnessError` with a closed code union: consumers switch on `code` and route, never by parsing messages.

```ts type-equiv
/**
 * One alarm-query backend. Registered with
 * `ctx.alarmQuery.registerAlarmProvider`.
 */
interface AlarmQueryProvider {
  /** Stable string id, unique within the registry. */
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Run one resolved query; honor `signal` for cancellation. */
  query(spec: AlarmQuerySpec, signal?: AbortSignal): Promise<AlarmQueryResult>
}
```

Selection ladder: a configured id must be registered and usable (`ALARM_PROVIDER_CONFIGURED_MISSING` / `ALARM_PROVIDER_CONFIGURED_UNAVAILABLE` otherwise); without a configured id exactly one usable provider is required (`ALARM_PROVIDER_AMBIGUOUS` when several, `ALARM_PROVIDER_UNAVAILABLE` when none). Provider execution failures — network, timeout, malformed payload — surface as `ALARM_PROVIDER_FAILED` with the underlying error as `cause`; a duplicate registration id throws `ALARM_PROVIDER_DUPLICATE`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxalarmquery--alarmqueryruntime"></a>

### `ctx.alarmQuery` — `AlarmQueryRuntime`

The alarm query service, registered as `ctx.alarmQuery` (one instance per context).

Selection semantics (resolved at execution time, never order-dependent):

- A configured id that is registered and `available()` → that provider.
- A configured id not registered → `ALARM_PROVIDER_CONFIGURED_MISSING`.
- A configured id registered but unavailable → `ALARM_PROVIDER_CONFIGURED_UNAVAILABLE`.
- No id configured, exactly one registered usable provider → that provider.
- No id configured, multiple usable providers → `ALARM_PROVIDER_AMBIGUOUS`.
- No id configured, no usable provider → `ALARM_PROVIDER_UNAVAILABLE`.

```ts cordis-catalog
/**
 * Register an alarm provider. Throws {@link AlarmError}
 * `ALARM_PROVIDER_DUPLICATE` if its id is already registered. Returns a
 * disposer; disposed with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerAlarmProvider(provider: AlarmQueryProvider): () => void

/**
 * The explicit defaulting step between callers and providers: apply the
 * seam's own defaults to one request and yield a total {@link AlarmQuerySpec}.
 * The only seam default is `maxAlarms`; absent filters pass through absent so
 * providers can omit them upstream.
 * @param request - the caller's query request.
 * @returns the resolved query spec.
 */
resolve(request: AlarmQueryRequest): AlarmQuerySpec

/**
 * Run one resolved query through the selected provider. Resolves the
 * provider at call time with the selection rules above, then enforces
 * `spec.maxAlarms` on the result: if the provider over-returns, `alarms[]`
 * is truncated and `truncated` set.
 * @param request - the caller's query request; defaulted through {@link resolve}.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the query outcome, capped to the spec's `maxAlarms`.
 */
async query(request: AlarmQueryRequest, signal?: AbortSignal): Promise<AlarmQueryResult>
```

Source: [`packages/integration/integration-alarm/src/index.ts`](../../packages/integration/integration-alarm/src/index.ts)
<!-- END GENERATED cordis-surface -->
