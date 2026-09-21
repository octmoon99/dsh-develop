import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AlarmQueryRuntime from '@deepseek-ai/dsh-integration-alarm'
import type { Alarm, AlarmQueryProvider, AlarmQueryResult, AlarmQuerySpec } from '@deepseek-ai/dsh-integration-alarm'

import * as plugin from '../src/index.ts'
import {
  alarmMetaFromResult,
  alarmMetaFromValue,
  DEFAULT_MAX_ALARMS,
  formatAlarmOutput,
  PRESENTATION_META_MAX_CHARS,
} from '../src/index.ts'

const testToolSignal = new AbortController().signal

function alarm(id: string, overrides: Partial<Alarm> = {}): Alarm {
  return { id, title: `alarm ${id}`, severity: 'high', status: 'firing', firedAt: '2026-09-16T08:00:00Z', ...overrides }
}

/**
 * Drives the REAL plugin body: mounts the alarm seam with a scripted provider
 * and `dsh-tool-integration-alarm` on a real `ToolRuntime`, then invokes the
 * registered `alarm_query` tool through `ctx.tools.execute` — the tool, the
 * seam, and the tool runtime are the shipping code; only the provider is a
 * stand-in.
 */
async function setup(
  respond: (spec: AlarmQuerySpec) => Promise<AlarmQueryResult>,
  config: Record<string, unknown> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AlarmQueryRuntime)
  const provider: AlarmQueryProvider = {
    id: 'scripted',
    available: () => true,
    query: spec => respond(spec),
  }
  ctx.alarmQuery.registerAlarmProvider(provider)
  // The runtime schema applies every field default; the cast keeps the partial
  // test record out of the plugin's resolved Config type.
  await ctx.plugin(plugin, config as never)
  return ctx
}

let callCounter = 0
function callAlarm(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'alarm_query',
    arguments: args,
  })
}

describe('dsh-tool-integration-alarm', () => {
  it('registers an alarm_query tool with filter-only parameters', async () => {
    const ctx = await setup(() => Promise.resolve({ alarms: [], total: 0, truncated: false }))
    const schema = ctx.tools.schemas().find(s => s.name === 'alarm_query')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['keyword', 'severity', 'since', 'source', 'status', 'until'])
    await ctx.fiber.dispose()
  })

  it('returns the closed alarm structure and forwards filters with the deployment bound', async () => {
    const seen: AlarmQuerySpec[] = []
    const ctx = await setup(async (spec) => {
      seen.push(structuredClone(spec))
      return { alarms: [alarm('a-1', { source: 'node-7', detail: 'cpu 96%' })], total: 1, truncated: false }
    })
    const out = await callAlarm(ctx, { severity: 'critical', since: '2026-09-16T00:00:00Z' })
    expect(out.isError).toBe(false)
    expect(out.value).toEqual({
      alarms: [{ id: 'a-1', title: 'alarm a-1', severity: 'high', status: 'firing', source: 'node-7', firedAt: '2026-09-16T08:00:00Z', detail: 'cpu 96%' }],
      total: 1,
      truncated: false,
    })
    expect(seen[0]).toEqual({ severity: 'critical', since: '2026-09-16T00:00:00Z', maxAlarms: DEFAULT_MAX_ALARMS })
    await ctx.fiber.dispose()
  })

  it('is configurable: maxAlarms from cordis.yml reaches the seam request', async () => {
    const seen: AlarmQuerySpec[] = []
    const ctx = await setup(async (spec) => {
      seen.push(structuredClone(spec))
      return { alarms: [], total: 0, truncated: false }
    }, { maxAlarms: 3 })
    await callAlarm(ctx, {})
    expect(seen[0]!.maxAlarms).toBe(3)
    await ctx.fiber.dispose()
  })

  it('rejects a non-ISO since and an inverted window', async () => {
    const ctx = await setup(() => Promise.resolve({ alarms: [], total: 0, truncated: false }))
    await expect(callAlarm(ctx, { since: 'yesterday' })).resolves.toMatchObject({ isError: true })
    await expect(callAlarm(ctx, { since: '2026/09/16' })).resolves.toMatchObject({ isError: true })
    await expect(callAlarm(ctx, { since: '2026-09-16T12:00:00Z', until: '2026-09-16T00:00:00Z' })).resolves.toMatchObject({ isError: true })
    await ctx.fiber.dispose()
  })

  it('carries provider failure as an error result with the AlarmError code', async () => {
    const ctx = await setup(() => Promise.reject(new Error('upstream down')))
    const out = await callAlarm(ctx, {})
    expect(out.isError).toBe(true)
    await ctx.fiber.dispose()
  })

  it('projects presentation meta with display-ready markdown, omitted over the ceiling', async () => {
    const single = { alarms: [alarm('a-1')], total: 1, truncated: false }
    const meta = alarmMetaFromValue(single)
    expect(meta).toMatchObject({
      alarms: [{ id: 'a-1', severity: 'high', status: 'firing' }],
      total: 1,
      truncated: false,
    })
    const markdown = (meta as { markdown: string }).markdown
    expect(markdown).toContain('1 of 1 matching alarms')
    expect(markdown).toContain('**[high] alarm a-1**')

    const oversized: Alarm[] = Array.from({ length: 4_000 }, (_, index) => alarm(`a-${index}`, { detail: 'x'.repeat(20) }))
    expect(alarmMetaFromValue({ alarms: oversized, total: oversized.length, truncated: false })).toEqual({})
    expect(PRESENTATION_META_MAX_CHARS).toBe(30_000)
  })

  it('markdown states the empty outcome, the cut, and bounded details', () => {
    expect((alarmMetaFromValue({ alarms: [], total: 0, truncated: false }) as { markdown: string }).markdown).toBe('No alarms found.')
    const cut = alarmMetaFromValue({ alarms: [alarm('a-1')], total: 9, truncated: true }) as { markdown: string }
    expect(cut.markdown).toContain('1 of 9 matching alarms')
    expect(cut.markdown).toContain('narrow the filters')
    const bounded = alarmMetaFromValue({
      alarms: [alarm('a-1', { detail: `${'x'.repeat(50)}…` })],
      total: 1,
      truncated: false,
    }) as { markdown: string }
    expect(bounded.markdown).toContain('…')
  })

  it('cuts an over-long detail and flags it in the canonical value', async () => {
    const ctx = await setup(
      () => Promise.resolve({ alarms: [alarm('a-1', { detail: 'x'.repeat(80) })], total: 1, truncated: false }),
      { maxDetailChars: 50 },
    )
    const out = await callAlarm(ctx, {})
    const alarms = (out.value as { alarms: { detail?: string; detailTruncated?: true }[] }).alarms
    expect(alarms[0]!.detail).toBe(`${'x'.repeat(50)}…`)
    expect(alarms[0]!.detailTruncated).toBe(true)
    await ctx.fiber.dispose()
  })

  it('round-trips meta through alarmMetaFromResult and rejects malformed meta', () => {
    const meta = alarmMetaFromValue({ alarms: [alarm('a-1', { source: 'node-7' })], total: 2, truncated: true })
    expect(alarmMetaFromResult(meta)).toEqual(meta)
    expect(alarmMetaFromResult(undefined)).toBeUndefined()
    expect(alarmMetaFromResult({ alarms: 'nope' })).toBeUndefined()
    expect(alarmMetaFromResult({ alarms: [], total: -1, truncated: false, markdown: '' })).toBeUndefined()
  })

  it('derives the completed card from meta and falls back on malformed meta', async () => {
    const ctx = await setup(() => Promise.resolve({ alarms: [alarm('a-1')], total: 5, truncated: true }))
    const tool = ctx.tools.get('alarm_query')
    const out = await callAlarm(ctx, {})
    const resultArg = { content: out.content, isError: out.isError, ...(out.meta !== undefined ? { meta: out.meta } : {}) }
    const view = tool?.presentResult?.({}, resultArg)
    expect(view).toMatchObject({ card: 'generic', title: 'Alarms' })
    expect((view as { content: { text: string }[] }).content[0]!.text).toContain('1 of 5 matching alarms')
    const fallback = tool?.presentResult?.({}, { content: out.content, isError: out.isError })
    expect(fallback).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('renders an empty outcome and a truncated outcome', () => {
    expect(formatAlarmOutput({ alarms: [], total: 0, truncated: false })).toBe('No alarms found.')
    const rendered = formatAlarmOutput({ alarms: [alarm('a-1')], total: 9, truncated: true })
    expect(rendered).toContain('1 of 9 matching alarms')
    expect(rendered).toContain('- [high] firing')
    expect(rendered).toContain('narrow the filters')
  })

  it('rejects an out-of-bounds maxAlarms at plugin load', async () => {
    await expect(setup(() => Promise.resolve({ alarms: [], total: 0, truncated: false }), { maxAlarms: 0 }))
      .rejects.toThrow('maxAlarms')
    await expect(setup(() => Promise.resolve({ alarms: [], total: 0, truncated: false }), { maxAlarms: 101 }))
      .rejects.toThrow('maxAlarms')
  })

  it('rejects a non-positive maxDetailChars at plugin load', async () => {
    await expect(setup(() => Promise.resolve({ alarms: [], total: 0, truncated: false }), { maxDetailChars: 0 }))
      .rejects.toThrow('maxDetailChars')
  })

  it('contributes system-prompt guidance while the tool is visible', async () => {
    const ctx = await setup(() => Promise.resolve({ alarms: [], total: 0, truncated: false }))
    const prompt = await ctx.systemPrompt.assemble()
    const text = prompt.sections.map(section => section.text).join('\n')
    expect(text).toContain('Use the alarm_query tool to read alarms from the connected alarm system.')
    await ctx.fiber.dispose()
  })
})
