---
description: "The alarm query capability seam (ctx.alarmQuery): provider registry, explicit request resolution, registration-order-independent selection, the closed alarm vocabulary, and the AlarmError taxonomy, for plugin authors and deployments wiring an alarm system into the harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-integration-alarm

English | [中文](README.zh.md)

## Summary

`dsh-integration-alarm` lets tools and plugins query an alarm system without tying callers to a vendor. It selects a usable registered backend for each query and gives callers consistent cancellation, a closed alarm vocabulary, result caps, and typed errors. Choose it for tools that call `ctx.alarmQuery.query()`; the shipped `dsh-tool-integration-alarm` tool and an HTTP provider load it for you. A query requires a configured, usable provider because this package makes no network requests on its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when model-facing tools or other plugins need to read alarms from a concrete alarm system through one service. Compose it beside exactly one usable provider (or pin one with `provider`), then let consumers call `query`.

### Provider selection

`provider` is optional: with exactly one registered usable backend, it auto-selects. Pin an id when several providers are composed; selection resolves at execution time, never by registration order.

- A configured id that is registered and usable → that provider.
- A configured id not registered → `ALARM_PROVIDER_CONFIGURED_MISSING`.
- A configured id registered but unavailable → `ALARM_PROVIDER_CONFIGURED_UNAVAILABLE`.
- No id configured, exactly one usable → that provider.
- No id configured, several usable → `ALARM_PROVIDER_AMBIGUOUS`.
- No id configured, none usable → `ALARM_PROVIDER_UNAVAILABLE`.

### The closed alarm vocabulary

The seam owns the alarm shape: `id`, `title`, `severity` (`critical|high|medium|low`), `status` (`firing|acknowledged|resolved`), optional `source`, `firedAt`, `acknowledgedAt`, `resolvedAt`, `detail`. Providers map their vendor payloads into it; a new severity or status is a coordinated change across known packages, not a plugin extension. Timestamp fields are ISO-8601 by contract; the seam exports `isIso8601Timestamp` as the one structural check providers and consumers validate with, so wire decoding and model-input validation cannot drift apart.

### Registering a provider

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { AlarmQueryProvider } from '@deepseek-ai/dsh-integration-alarm'

export const inject = ['alarmQuery']

export function apply(ctx: Context): void {
  const provider: AlarmQueryProvider = {
    id: 'my-backend',
    available: () => true,
    query: (spec, signal) => queryUpstream(spec, signal),
  }
  ctx.alarmQuery.registerAlarmProvider(provider)
}

declare function queryUpstream(spec: Parameters<AlarmQueryProvider['query']>[0], signal?: AbortSignal): ReturnType<AlarmQueryProvider['query']>
```

Registration is an effect: disposing the contributing fiber unregisters the backend, and a duplicate id throws `ALARM_PROVIDER_DUPLICATE`. The returned disposer unregisters immediately.

### Request resolution and caps

`resolve(request)` is the single defaulting step between callers and providers: it applies the seam default `maxAlarms` (20) and yields a total spec, so providers never see a raw request. `query()` then enforces `spec.maxAlarms` on the result — an over-returning provider is truncated and flagged `truncated`; `total` keeps the source system's match count.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the seam and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The seam mirrors the web access seam's proven shape: a registry plus execution-time selection, an explicit resolution step, and a typed error taxonomy extending `HarnessError`. Defaults live in `resolve()` — never inline in `query()` — so the defaulting point is inspectable and testable. Caps are enforced where the complete result is known (`capAlarms`), matching the repository rule that bounds apply to the complete emitted value.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `AlarmQueryRuntime` service, registry, resolution, selection ladder, cap enforcement |
| [`src/types.ts`](src/types.ts) | The closed alarm vocabulary, request/spec/result types, provider interface, `AlarmError` |
| — | No runtime invariant companion is published; one process owns the registry and selection failures are loud typed errors a consumer observes directly, so independent observations cannot diverge. |

### Export shape

The service class is the plugin's default export, like `dsh-web`; function-style provider and consumer plugins mount beside it.

### Why no invariant companion

Independent observations cannot diverge here: one process owns the registry, and selection failures are already loud typed errors a consumer observes directly. An invariant companion would restate those errors with no second data source, so per the package invariant rules the wiring is omitted.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [integration group map](../README.md) — the sibling group page and its package table.
- [HTTP provider](../integration-alarm-http/README.md) — the REST backend that maps one alarm system into this vocabulary.
- [alarm_query tool](../tool-integration-alarm/README.md) — the model-facing consumer.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-integration-alarm) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-integration-alarm`, which turns seam results into the `alarm_query` tool schema, guidance, and retained tool-result tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

These limits define when the seam is a poor fit. They are current package constraints, not a task backlog.

- **Read-only vocabulary** — the seam queries alarms; acknowledging, silencing, or resolving them is a write capability that would need its own request/result contract and approval routing.
- **No paging cursor** — results are one capped page; a cursor protocol lands when a provider needs one, not before.
- **Severity and status are closed unions** — a vendor level outside `critical|high|medium|low` fails loud at the provider boundary instead of silently mislabeling.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: write-side alarm capability

Acknowledging, silencing, and resolving alarms need their own request/result contract plus approval routing; when the first consumer arrives, that capability is a sibling seam (or a second method family on this service), not an extension of `query`.

</details>
