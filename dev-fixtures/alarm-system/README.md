# Local alarm system fixture

English | [中文](README.zh.md)

This FastAPI process supplies the strict REST response consumed by [`@deepseek-ai/dsh-integration-alarm-http`](../../packages/integration/integration-alarm-http/README.md). It keeps alarms in memory, starts with the `normal` scenario, and exposes authenticated administrative routes for local data setup and bounded fault injection. It is a development fixture, not a production alarm service or a source of DSH approval state.

## Prerequisites

Use Python 3.12 or later with the versions in [`requirements.txt`](requirements.txt) and [`requirements-dev.txt`](requirements-dev.txt). The local `cmenv` Conda environment already supplies them; the commands below use that environment and do not create another one.

Set two distinct local-only bearer tokens before startup. The read token is the only credential DSH receives; the admin token can replace fixture data and configure faults.

```sh
export ALARM_MOCK_READ_TOKEN=local-read-token
export ALARM_MOCK_ADMIN_TOKEN=local-admin-token
conda run -n cmenv python -m uvicorn alarm_mock.app:app --app-dir dev-fixtures/alarm-system --host 127.0.0.1 --port 18080 --workers 1
```

The process fails at startup when either token is absent, empty, surrounded by whitespace, or equal to the other token. It binds loopback only in this command. Use one worker because state is process-local.

Readiness is available without authentication at `GET /healthz`; Swagger is available at `http://127.0.0.1:18080/docs`. Swagger uses one bearer value at a time, so switch between the read and admin token according to the route.

## Query contract

`GET /alarms` requires the read token and accepts optional `severity`, `status`, `source`, `keyword`, `since`, `until`, and `limit` parameters. `severity` is `critical|high|medium|low`; `status` is `firing|acknowledged|resolved`; `limit` defaults to 20 and accepts 1–200. Time filters require timezone-qualified ISO-8601 date-times, include `since`, and exclude `until`. All filters intersect. Results sort by `firedAt` descending and then `id` ascending; `total` counts matches before `limit` truncation.

```sh
curl -H 'Authorization: Bearer local-read-token' 'http://127.0.0.1:18080/alarms?status=firing&limit=20'
```

The response has only `total` and `alarms`. Each alarm has required `id`, `title`, `severity`, `status`, and `firedAt`; `source`, `acknowledgedAt`, `resolvedAt`, and `detail` are optional and omitted when absent. This exact field set lets the DSH HTTP provider reject drift instead of silently discarding it.

## Administrative routes

Administrative routes require the admin token.

- `POST /_admin/alarms` inserts one strict alarm; a duplicate `id` returns `409`.
- `POST /_admin/reset` atomically selects `normal`, `empty`, `many`, or `long-detail` and clears faults. An optional `anchor` makes generated timestamps reproducible; omission uses the current time.
- `PUT /_admin/faults` selects `none`, one-shot `next-503`, or persistent `delay` with `delayMs` from 1 through 5000. Faults affect `/alarms` only.

```sh
curl -X POST -H 'Authorization: Bearer local-admin-token' -H 'Content-Type: application/json' -d '{"scenario":"many"}' http://127.0.0.1:18080/_admin/reset
```

All state disappears on process restart. There is no H5 page, database, acknowledgment action, scheduler, webhook, or automatic Feishu notification in this fixture.

## Connect DSH

Point the existing alarm-query composition at `http://127.0.0.1:18080/`, keep `auth: bearer`, and resolve `DSH_ALARM_API_TOKEN` to the same value as `ALARM_MOCK_READ_TOKEN`. The capability-only overlay lives at [`apps/cli/config/examples/alarm-query/cordis.yml`](../../apps/cli/config/examples/alarm-query/cordis.yml); the complete Feishu composition example lives at [`apps/cli/config/examples/alarm-query-feishu/cordis.yml`](../../apps/cli/config/examples/alarm-query-feishu/cordis.yml).

This stage validates a query-and-reply path: create or reset local alarms, send a Feishu query, let the agent call `alarm_query`, and inspect the returned card and Session events. Alarm-created proactive notification requires a separate durable event and outbound-delivery path; this fixture does not bypass DSH by calling Feishu directly.

## Tests

Run the fixture tests in the prepared environment:

```sh
conda run -n cmenv python -m pytest dev-fixtures/alarm-system/tests
```

The suite passes explicit tokens and a fixed clock to isolated app instances instead of mutating process environment. Its real-network case atomically binds an ephemeral loopback port, waits for `/healthz`, and waits for Uvicorn to stop during teardown.

Run the keyless assembled-session scenario from the repository root:

```sh
pnpm run test:snapshot -t 'replays alarm-query through dsh --profile headless'
```

The scenario boots the shipped headless profile with the alarm seam, HTTP provider, and model-facing tool. Its replayed model call still crosses a real HTTP listener on an operating-system-assigned loopback port, and the committed Session records the call, bounded result, presentation metadata, and final model turn. This deterministic check does not replace manual UAT against the real Feishu platform or protocol certification against a target alarm vendor.
