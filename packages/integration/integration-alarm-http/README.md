---
description: "The HTTP backend for the alarm query capability seam: reads one alarm system's REST API into the closed alarm vocabulary, with credential-referenced bearer auth, per-attempt timeout, and bounded retry, for deployments wiring a concrete alarm system."
kind: "package-reference"
---

# @deepseek-ai/dsh-integration-alarm-http

English | [中文](README.zh.md)

## Summary

`dsh-integration-alarm-http` connects `ctx.alarmQuery` to one alarm system over HTTP. It reads the documented REST contract, maps vendor payloads into the seam's closed alarm vocabulary, authenticates with a credential-referenced bearer token, and retries transient failures within configured bounds. Compose it beside `dsh-integration-alarm`; it registers itself as the `http` provider and never owns selection.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when your alarm system can serve the REST contract below. Set `baseUrl` to the system's root; the provider queries `{baseUrl}/alarms`.

### The wire contract

`GET {baseUrl}/alarms` with optional `severity`, `status`, `source`, `keyword`, `since`, `until` query parameters (each forwarded only when the resolved query carries it) plus `limit` (the resolved `maxAlarms`, an upstream cost bound the seam still enforces on the returned array). The response body is:

```json
{
  "total": 42,
  "alarms": [
    {
      "id": "a-1",
      "title": "CPU too high",
      "severity": "critical",
      "status": "firing",
      "source": "node-7",
      "firedAt": "2026-09-16T08:00:00Z",
      "acknowledgedAt": "2026-09-16T08:05:00Z",
      "resolvedAt": "2026-09-16T09:00:00Z",
      "detail": "cpu usage 96% for 5 minutes"
    }
  ]
}
```

`total` is a non-negative integer counting the source system's matches; every `alarms[]` entry carries required `id`, `title`, `severity`, `status`, `firedAt` and the optional fields shown, with `firedAt`/`acknowledgedAt`/`resolvedAt` as ISO-8601 timestamps. The boundary is strict: an unknown key, wrong type, out-of-vocabulary severity or status, non-ISO timestamp, or an `alarms` list longer than `total` fails loud as `ALARM_PROVIDER_FAILED` — a silently dropped field would make the projection lie about what the source returned. This strictness belongs to the standard gateway protocol this package defines; a provider adapting a system that tolerates vendor drift picks its own compatibility policy and ships as its own package — the rejection is not a requirement every third-party adapter must copy.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-integration-alarm-http'
  config:
    baseUrl: https://alarm.internal.example.com
    auth: bearer
    tokenEnv: DSH_ALARM_API_TOKEN
    timeoutMs: 10000
    maxResponseBytes: 1048576
    retries: 2
    retryBaseDelayMs: 400
```

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | required | Alarm system root; queried at `{baseUrl}/alarms` |
| `auth` | `bearer` | `bearer` requires a token and fails loud when none resolves; `anonymous` sends no token at all |
| `token` | — | Literal bearer token; prefer `tokenEnv` so config files stay shareable |
| `tokenEnv` | `DSH_ALARM_API_TOKEN` | Credential-reference name holding the bearer token |
| `timeoutMs` | `10000` | Per-attempt timeout; bounds token resolution and the request alike |
| `maxResponseBytes` | `1048576` | Response-body ceiling in bytes; a body crossing it fails the attempt without being downloaded whole |
| `retries` | `2` | Retry attempts after the first failed attempt |
| `retryBaseDelayMs` | `400` | Backoff before the first retry; doubles per attempt |

`baseUrl` must be an absolute `http`/`https` URL without a query or fragment; the plugin normalizes it into a directory (a missing trailing slash is added), so `https://host/api/v1` and `https://host/api/v1/` both query `https://host/api/v1/alarms` and no path segment is dropped.

The token resolves per attempt under the same timeout as the request: literal `token` when set, else the credentials seam (`tokenEnv` reference, e.g. `~/.dsh/.credentials.yaml`), else the ambient launch environment. In `bearer` mode (the default) an unresolvable reference fails loud with `ALARM_PROVIDER_FAILED` before any request is sent — an anonymous request is never sent by accident; in `anonymous` mode no token is read and no header is sent.

### Retry behavior

Network failures, timeouts (including a token resolution that outlives `timeoutMs`), token-resolution errors, and HTTP `429/500/502/503/504` are retried up to `retries` times with doubling backoff; decode failures, responses over `maxResponseBytes`, and every other status fail on the spot, because the upstream answered and the answer is wrong, not late. Caller cancellation is never retried.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

Vendor mapping happens once, at the wire boundary, into the seam's closed objects — downstream code trusts TypeScript. The provider borrows the credential-resolution pattern from the DeepSeek search provider (credentials seam with ambient-environment fallback), and every tunable is a validated Config field, per the no-hardcoded-tunables rule.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: Config schema, validation, provider registration, token wiring |
| [`src/provider.ts`](src/provider.ts) | `HttpAlarmProvider`: URL assembly, attempt/timeout/retry loop, strict decoders |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Export shape

The plugin is a function/namespace plugin: it exports `name` / `inject` / `apply` and no default export.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [alarm query seam](../integration-alarm/README.md) — the service this provider registers into.
- [alarm_query tool](../tool-integration-alarm/README.md) — the model-facing consumer of the seam.
- [Capability overlay example](../../../apps/cli/config/examples/alarm-query/cordis.yml) — the three alarm plugins over any profile.
- [Feishu composition example](../../../apps/cli/config/examples/alarm-query-feishu/cordis.yml) — the complete Feishu bot plus alarm card composition.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-integration-alarm-http) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-integration-alarm`, which turns the mapped alarm results into the `alarm_query` tool schema, guidance, and retained tool-result tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

These limits define when the provider is a poor fit. They are current package constraints, not a task backlog.

- **One fixed wire contract** — the REST shape above is the whole contract; a system that cannot serve it needs an adapter service or its own provider package.
- **Bearer token only** — no signature, mTLS, or refresh-token flows; a credential that expires mid-run fails loud until rotated.
- **No response pagination** — one request carries the capped result set; large windows rely on `limit` and filters.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: adapter guidance for non-conforming systems

An alarm system that cannot serve the wire contract unchanged should get an adapter service or its own provider package; folding per-tenant field mapping into this package would move contract enforcement into deployment data.

</details>
