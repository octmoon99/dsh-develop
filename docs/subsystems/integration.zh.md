# 系统集成

[English](integration.md) | 中文

告警查询缝 —— 一条位于 `ctx.alarmQuery` 服务上的[能力缝](../../.agents/notes/implemented/architecture/2026-09-16-integration-alarm-query.zh.md)，跨包拆分：Service Definition（[dsh-integration-alarm](../../packages/integration/integration-alarm)，`ctx.alarmQuery` 与提供方注册表）、Service Provider（[dsh-integration-alarm-http](../../packages/integration/integration-alarm-http)，把一个告警系统的 REST API 映射进缝词汇表）、Consumer（[dsh-tool-integration-alarm](../../packages/integration/tool-integration-alarm)，`alarm_query` 工具 schema 与呈现）。集成缝是**可选能力**，不属于 agent-loop 主干 —— 其词汇表在此，不在 [core.md](core.zh.md)。更换提供方不改变模型询问告警的方式；通道卡片读持久化的呈现元数据，从不读提供方代码。未来系统（工单、CMDB、值班）作为自己的缝重复这一三角色拆分。

Source: [`packages/integration/integration-alarm/src/types.ts`](../../packages/integration/integration-alarm/src/types.ts)

## Request, resolution, and result

调用方发送可选过滤器；缝的 `resolve(request)` 步骤应用唯一的缝默认（`maxAlarms`，默认 `20`）并产出完整 spec，提供方因此从不看到原始请求。消费方的部署上限（`dsh-tool-integration-alarm` 的 `maxAlarms` 配置，1–100）经 spec 流转；缝在返回路上强制执行 —— 超量返回的提供方被截断并标记。

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

缝拥有告警形状；提供方把厂商载荷映射进来。严重级别与状态是封闭联合 —— 词汇表外的厂商级别在提供方边界响亮失败，而不是静默贴错标签。可选字段被省略而非虚构，缝因此从不说谎。

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

每条能力注册一个后端；选择在执行时解析，绝不依赖注册顺序。`AlarmError extends HarnessError` 带封闭码联合：消费方按 `code` 切换并路由，绝不解析消息。

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

选择梯：配置的 id 必须已注册且可用（否则 `ALARM_PROVIDER_CONFIGURED_MISSING` / `ALARM_PROVIDER_CONFIGURED_UNAVAILABLE`）；未配置 id 时要求恰好一个可用提供方（多个为 `ALARM_PROVIDER_AMBIGUOUS`，没有为 `ALARM_PROVIDER_UNAVAILABLE`）。提供方执行失败 —— 网络、超时、畸形载荷 —— 以 `ALARM_PROVIDER_FAILED` 浮出并链上底层错误为 `cause`；重复注册 id 抛出 `ALARM_PROVIDER_DUPLICATE`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
