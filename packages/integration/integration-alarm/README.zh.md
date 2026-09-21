---
description: "告警查询能力缝（ctx.alarmQuery）：提供方注册表、显式请求解析、与注册顺序无关的选择梯、封闭告警词汇表与 AlarmError 分类，面向把告警系统接入 harness 的插件作者与部署方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-integration-alarm

[English](README.md) | 中文

## 概述

`dsh-integration-alarm` 让工具与插件查询告警系统而不绑定具体厂商。它为每次查询选择一个可用的已注册后端，并向调用方提供一致的取消、封闭告警词汇表、结果上限与类型化错误。为调用 `ctx.alarmQuery.query()` 的工具选择本包；随附的 `dsh-tool-integration-alarm` 工具与 HTTP 提供方会为你装载它。查询要求存在已配置且可用的提供方，因为本包自身不发任何网络请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当模型可见的工具或其他插件需要通过一个服务读取具体告警系统的告警时使用本包。把它与恰好一个可用提供方组合（或用 `provider` 显式指定），再让消费方调用 `query`。

### Provider selection

`provider` 可省略：恰好一个已注册可用后端时自动选中。组合了多个提供方时显式指定 id；选择在执行时解析，绝不依赖注册顺序。

- 配置的 id 已注册且可用 → 该提供方。
- 配置的 id 未注册 → `ALARM_PROVIDER_CONFIGURED_MISSING`。
- 配置的 id 已注册但不可用 → `ALARM_PROVIDER_CONFIGURED_UNAVAILABLE`。
- 未配置 id 且恰好一个可用 → 该提供方。
- 未配置 id 且多个可用 → `ALARM_PROVIDER_AMBIGUOUS`。
- 未配置 id 且无可用的 → `ALARM_PROVIDER_UNAVAILABLE`。

### The closed alarm vocabulary

缝拥有告警形状：`id`、`title`、`severity`（`critical|high|medium|low`）、`status`（`firing|acknowledged|resolved`），可选 `source`、`firedAt`、`acknowledgedAt`、`resolvedAt`、`detail`。提供方把厂商载荷映射进来；新增严重级别或状态是跨已知包的协调变更，不是插件扩展。时间戳字段按契约是 ISO-8601；缝导出 `isIso8601Timestamp` 作为提供方与消费方共同使用的结构校验，wire 解码与模型输入校验不会漂移。

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

注册即效应：释放贡献它的 fiber 即注销后端，重复 id 抛出 `ALARM_PROVIDER_DUPLICATE`。返回的清理器立即注销。

### Request resolution and caps

`resolve(request)` 是调用方与提供方之间唯一的默认化步骤：应用缝默认 `maxAlarms`（20）并产出完整 spec，提供方因此从不看到原始请求。`query()` 随后对结果强制执行 `spec.maxAlarms` —— 超量返回的提供方被截断并标记 `truncated`；`total` 保留源系统的匹配计数。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Implementation internals — click to expand</summary>

本节解释缝背后的设计决策并指向实现代码；可观测行为见 [Use this package](#use-this-package)。

### Design philosophy

本缝沿用了 web 访问缝经过验证的形状：注册表加执行时选择、显式解析步骤、继承 `HarnessError` 的类型化错误分类。默认值只存在于 `resolve()` —— 绝不内联在 `query()` —— 因此默认化点可检视、可测试。上限在完整结果可知处强制执行（`capAlarms`），符合仓库"边界作用于完整产出值"的规则。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `AlarmQueryRuntime` 服务、注册表、解析、选择梯、上限强制 |
| [`src/types.ts`](src/types.ts) | 封闭告警词汇表、请求/spec/结果类型、提供方接口、`AlarmError` |
| — | 未发布运行时 invariant companion；注册表由单进程拥有，选择失败是消费方可直接观察的响亮类型化错误，独立观察不会分叉。 |

### Export shape

服务类是插件的默认导出，与 `dsh-web` 一致；函数式提供方与消费方插件在它旁边装载。

### Why no invariant companion

此处独立观察不会分叉：一个进程独占注册表，选择失败已是消费方能直接观察的响亮类型化错误。invariant companion 只会复述这些错误而没有第二数据源，因此按包 invariant 规则省略其接线。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [integration group map](../README.zh.md) — 同组页面与包表。
- [HTTP provider](../integration-alarm-http/README.zh.md) — 把一个告警系统映射进本词汇表的 REST 后端。
- [alarm_query tool](../tool-integration-alarm/README.zh.md) — 模型可见消费方。
- [Generated configuration catalog](../../../docs/config-catalog.zh.md#deepseek-aidsh-integration-alarm) — 全部可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

Indirectly, through `dsh-tool-integration-alarm`, which turns seam results into the `alarm_query` tool schema, guidance, and retained tool-result tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些边界定义本缝何时是不合适的选择。它们是当前包约束，不是任务清单。

- **Read-only vocabulary** —— 缝只查询告警；确认、静默或解决告警属于写能力，需要自己的请求/结果契约与审批路由。
- **No paging cursor** —— 结果是单页截断；游标协议在某个提供方确实需要时才落地。
- **Severity and status are closed unions** —— 厂商级别超出 `critical|high|medium|low` 时在提供方边界响亮失败，而不是静默贴错标签。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

本 Dev Note 是维护者的工作上下文：尚未决定的开放问题与方向。它明确是非权威的 —— 已交付的行为、边界与已接受的依据存在于上文各节、包代码与所链接的 Agent Notes。

#### Future: write-side alarm capability

确认、静默与解决告警需要自己的请求/结果契约与审批路由；当第一个消费方出现时，该能力是兄弟缝（或本服务上的第二组方法族），不是 `query` 的扩展。

</details>
