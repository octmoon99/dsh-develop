---
description: "The model-facing alarm_query tool over the alarm query capability seam: filter-only parameters, the closed alarm result structure, deployment-bounded result size, and replayable presentation meta for transport cards, for users and maintainers choosing, configuring, or debugging the tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-integration-alarm

English | [中文](README.zh.md)

## Summary

`dsh-tool-integration-alarm` gives the agent one read tool for alarms: `alarm_query`. The model picks filters — severity, status, source, keyword, or an ISO-8601 time window — and the deployment bounds how many alarms come back. Results are the seam's closed alarm structure plus the total match count, rendered as one line per alarm for the model and projected into replayable presentation meta so transport cards (for example the Feishu card templates) render without re-running the query. Mounting it beside a usable provider is the only setup.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when the agent should read alarms from the connected alarm system during a conversation. Compose `dsh-integration-alarm` plus a provider (for example `dsh-integration-alarm-http`) and this tool; the model calls `alarm_query` on its own when the task needs alarm facts.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-tool-integration-alarm'
  config:
    maxAlarms: 20
    timeoutMs: 30000
    maxDetailChars: 2000
```

| Field | Default | Meaning |
|---|---|---|
| `maxAlarms` | `20` | Upper bound on returned alarms (1–100), applied to every query |
| `timeoutMs` | `30000` | Cooperative tool-call budget enforced by the tool-timeout policy |
| `maxDetailChars` | `2000` | Per-alarm `detail` character cap; longer details are cut, ellipsized, and flagged `detailTruncated` |

### What each call does

Every parameter is an optional filter; an unfiltered call returns every matching alarm up to `maxAlarms`. `since`/`until` must be ISO-8601 and the window must not invert. The canonical value is `{ alarms, total, truncated }` with the closed alarm objects — each `detail` cut and flagged at `maxDetailChars`, so the value and the session log stay bounded and a cut stays identifiable. The model-facing render is one line per alarm plus a truncation note, and the persisted presentation meta carries the structured alarms and one display-ready markdown — the same empty-outcome line, shown-of-total count, and cut note — that transport cards read as their template variable.

### Cards without provider code

The Feishu channel needs zero provider-specific code: bind a `cardTemplates` entry with `bindTool: alarm_query` and read the meta's `markdown` (`from: tool-result, path: markdown`). That one variable already states `No alarms found.`, the shown-of-total count, and the cut notice, so the card can never show a bare list that reads as the complete result. The [capability overlay](../../../apps/cli/config/examples/alarm-query/cordis.yml) and the [Feishu composition example](../../../apps/cli/config/examples/alarm-query-feishu/cordis.yml) show both shapes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **The deployment owns the size bound.** `maxAlarms` is a Config field, never a model-facing parameter — the model cannot widen its own result budget.
- **Bounded before it is rendered.** `maxDetailChars` caps each alarm's `detail` inside the canonical value, so a giant detail never reaches the session log, the card, or the meta builder at full size.
- **Meta over the ceiling degrades, not truncates.** `presentationMeta` returning a truncated structure would make replayed cards lie about completeness; over `PRESENTATION_META_MAX_CHARS` (30,000 serialized characters) the meta degrades to `{}`, every narrower rejects it, and the UI falls back to the raw result content. The canonical value is already bounded by `maxAlarms` and `maxDetailChars`; the ceiling only trips on very large `maxAlarms` deployments.
- **One home for the outcome statements.** The empty line, the count header, and the cut note are shared constants behind both the model text and the card markdown, so the two surfaces cannot drift.
- **Filters validate what the schema DSL cannot express.** ISO-8601 parsing and window ordering are checked in `execute`, the same split `dsh-tool-web` uses.
- **Read-only is concurrency-safe.** The tool declares `isConcurrencySafe`, so parallel turns may query simultaneously.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: Config schema, guidance section, `alarm_query` registration, render, meta projection, presenters |
| — | No runtime invariant companion is published; the tool registers no durable state beyond the standard `tool/call`/`tool/result` events the tools runtime already owns. |

### Export shape

The plugin is a function/namespace plugin: it exports `name` / `inject` / `apply` and no default export.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [alarm query seam](../integration-alarm/README.md) — the service the tool consumes.
- [HTTP provider](../integration-alarm-http/README.md) — one backend for the seam.
- [integration group map](../README.md) — the sibling group page and its package table.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-integration-alarm) — the `alarm_query` schema the model receives.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-integration-alarm) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`alarm_query` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-integration-alarm): six optional filter parameters — `severity` (`critical|high|medium|low`), `status` (`firing|acknowledged|resolved`), `source`, `keyword`, `since`, `until` — with no result-size parameter. The description states the filters and the returned fields.

#### Token effect

Fixed schema cost on every request where the tool is visible; the description and schema are stable for a given configuration.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each result returns the closed alarm objects, the total match count, and the truncation flag, rendered as `1 of 9 matching alarms` plus one line per alarm (`- [severity] status (firedAt source): title (#id) — detail`), `No alarms found.` when empty, and a narrow-the-filters note when truncated. Stable failures are `Error: invalid alarm_query: "since" must be an ISO-8601 timestamp`, `Error: invalid alarm_query: "until" must be an ISO-8601 timestamp`, and `Error: invalid alarm_query: "since" must not be later than "until"`; provider failures surface with their `AlarmError` codes.

#### Token effect

Token growth scales with `maxAlarms` and alarm field lengths; call arguments are small fixed filters. Those results remain until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

These limits define when the tool is a poor fit. They are current package constraints, not a task backlog.

- **Read-only** — the tool queries alarms; acknowledging or resolving from a conversation needs a write tool with its own approval routing.
- **No model-facing result-size control** — the deployment bound is deliberate; a model-widened budget would bypass the durable-meta ceiling.
- **No time-window default** — the model passes explicit ISO-8601 stamps rather than relative phrases, keeping `execute` free of hidden clock policy; wrong phrasing surfaces as the loud ISO-8601 failure.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: relative time windows

A natural-language window (`last 2 hours`) would move clock policy into the tool; the current explicit ISO-8601 contract keeps `execute` deterministic for replay. Revisit only with a consumer that measurably fails to phrase windows.

</details>
