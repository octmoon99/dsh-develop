---
description: "Package map for the systems-integration capability family: the alarm query seam, its HTTP backend, and the model-facing tool that consumes them."
kind: "package-group"
---

# integration/ — systems-integration capability family

English | [中文](README.zh.md)

## Summary

The `integration/` packages connect the agent to external business systems through dedicated query seams. The first seam is alarm query: one service (`ctx.alarmQuery`), one HTTP backend that maps a concrete alarm system's REST API into the closed alarm vocabulary, and the model-facing `alarm_query` tool whose results also feed transport cards. Use this family when an external system should be readable from conversations without binding tools or transports to a vendor; each future system (ticketing, CMDB, on-call) repeats the same three-role split rather than growing this group's packages sideways.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

Three packages play the alarm roles.

| Package | Role | ctx key |
|---|---|---|
| [`integration-alarm/`](integration-alarm/README.md) | Alarm query service: provider registry, explicit resolution, one selection and error policy | `ctx.alarmQuery` |
| [`integration-alarm-http/`](integration-alarm-http/README.md) | Reads one alarm system's REST API into the seam vocabulary | registers on `ctx.alarmQuery` |
| [`tool-integration-alarm/`](tool-integration-alarm/README.md) | Exposes `alarm_query` to the model | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Systems integration subsystem](../../docs/subsystems/integration.md) — the seam's requests, results, provider availability, and `AlarmError`.
- [Alarm query seam Agent Note](../../.agents/notes/implemented/architecture/2026-09-16-integration-alarm-query.md) — the seam's design, the wire-contract decision, and the presentation-meta ceiling.
- [Capability overlay example](../../apps/cli/config/examples/alarm-query/cordis.yml) — the three alarm plugins over any profile.
- [Feishu composition example](../../apps/cli/config/examples/alarm-query-feishu/cordis.yml) — the complete Feishu bot plus alarm card composition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: one seam per system, not one group per system

Ticketing, CMDB, and on-call integration each become their own capability seam in this group when a consumer arrives; a shared "generic query" package is deliberately not the direction.

</details>
