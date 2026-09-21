// Proves `maxAlarms` is real configurability and not a constant: the bound is
// set in a cordis.yml booted through the real Loader, the alarm seam and a
// scripted provider are equally composed through that file, and the bound the
// model-facing tool sends to the seam follows the configured value.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AlarmQueryRuntime from '@deepseek-ai/dsh-integration-alarm'
import type { AlarmQueryProvider, AlarmQuerySpec } from '@deepseek-ai/dsh-integration-alarm'
import * as ToolIntegrationAlarm from '@deepseek-ai/dsh-tool-integration-alarm'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The specs the scripted provider received. */
const seenSpecs: AlarmQuerySpec[] = []

/** A scripted provider plugin composed like any deployment plugin would be. */
const scriptedProviderPlugin = {
  name: 'test-alarm-provider',
  inject: ['alarmQuery'],
  apply(ctx: Context) {
    const provider: AlarmQueryProvider = {
      id: 'scripted',
      available: () => true,
      query: (spec) => {
        seenSpecs.push(structuredClone(spec))
        return Promise.resolve({
          alarms: [{
            id: 'a-1',
            title: 'CPU too high',
            severity: 'critical',
            status: 'firing',
            firedAt: '2026-09-16T08:00:00Z',
          }],
          total: 1,
          truncated: false,
        })
      },
    }
    ctx.alarmQuery.registerAlarmProvider(provider)
  },
}

/**
 * Boot a cordis.yml mounting the alarm seam, the scripted provider, and the
 * tool with the given `config:` lines.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-alarm-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-integration-alarm'",
    "- name: 'test-alarm-provider'",
    "- name: '@deepseek-ai/dsh-tool-integration-alarm'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-integration-alarm', AlarmQueryRuntime],
    ['test-alarm-provider', scriptedProviderPlugin],
    ['@deepseek-ai/dsh-tool-integration-alarm', ToolIntegrationAlarm],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('tool-integration-alarm real Loader composition through cordis.yml', () => {
  it('maxAlarms set in cordis.yml bounds the seam request end to end', async () => {
    const ctx = await boot(['    maxAlarms: 3'])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('alarm-loader'),
      name: 'alarm_query',
      arguments: { severity: 'critical' },
    })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      alarms: [{
        id: 'a-1',
        title: 'CPU too high',
        severity: 'critical',
        status: 'firing',
        firedAt: '2026-09-16T08:00:00Z',
      }],
      total: 1,
      truncated: false,
    })
    expect(seenSpecs.at(-1)).toEqual({ severity: 'critical', maxAlarms: 3 })
    expect(result.meta).toMatchObject({ total: 1, truncated: false })
  }, 30_000)

  it('defaults apply when the tool row carries no config', async () => {
    const ctx = await boot([])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('alarm-defaults'),
      name: 'alarm_query',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    expect(seenSpecs.at(-1)!.maxAlarms).toBe(20)
  }, 30_000)
})
