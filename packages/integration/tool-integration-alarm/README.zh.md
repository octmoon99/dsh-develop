---
description: "告警查询能力缝上的模型可见 alarm_query 工具：仅过滤参数、封闭告警结果结构、部署方约束的结果上限，以及供通道卡片使用的可回放呈现元数据，面向选择、配置或调试该工具的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-integration-alarm

[English](README.md) | 中文

## 概述

`dsh-tool-integration-alarm` 给代理一个只读告警工具：`alarm_query`。模型选择过滤器 —— 严重级别、状态、来源、关键词或 ISO-8601 时间窗 —— 部署方约束返回的告警数量。结果是缝的封闭告警结构加总匹配数，按每告警一行渲染给模型，并投影进可回放的呈现元数据，让通道卡片（例如飞书卡模板）无需重跑查询即可渲染。把它与一个可用提供方组合是唯一的安装步骤。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当代理应在对话中读取已接入告警系统的告警时使用本包。组合 `dsh-integration-alarm` 与一个提供方（例如 `dsh-integration-alarm-http`）以及本工具；任务需要告警事实时模型自行调用 `alarm_query`。

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
| `maxAlarms` | `20` | 返回告警上限（1–100），作用于每个查询 |
| `timeoutMs` | `30000` | 由工具超时策略强制的协作式调用预算 |
| `maxDetailChars` | `2000` | 单条告警 `detail` 字符上限；超长被截断、加省略号并标记 `detailTruncated` |

### What each call does

每个参数都是可选过滤器；无过滤调用返回至多 `maxAlarms` 条匹配告警。`since`/`until` 必须是 ISO-8601 且时间窗不得倒置。规范值是 `{ alarms, total, truncated }` 与封闭告警对象 —— 每条 `detail` 在 `maxDetailChars` 处截断并标记，因此值与会话日志保持有界、截断可辨识。面向模型的渲染是每告警一行加截断说明，而持久化的呈现元数据携带结构化告警与一份显示用 markdown —— 同样的空态行、展示数/总数与截断说明 —— 通道卡片把它读取作模板变量。

### Cards without provider code

飞书通道不需要任何提供方专属代码：绑定一个 `bindTool: alarm_query` 的 `cardTemplates` 条目，读取元数据的 `markdown`（`from: tool-result, path: markdown`）。这一个变量本身就写明 `No alarms found.`、展示数/总数与截断说明，卡片不可能展示会被当成完整结果的裸列表。[能力 overlay](../../../apps/cli/config/examples/alarm-query/cordis.yml) 与[飞书组合示例](../../../apps/cli/config/examples/alarm-query-feishu/cordis.yml)分别展示两种形态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Implementation internals — click to expand</summary>

本节解释工具背后的设计决策并指向实现代码；可观测行为见 [Use this package](#use-this-package)。

### Design philosophy

- **部署方拥有规模上限。** `maxAlarms` 是 Config 字段，绝不是模型可见参数 —— 模型不能放宽自己的结果预算。
- **先限界再渲染。** `maxDetailChars` 在规范值内部封顶每条告警的 `detail`，超长 detail 不会以全尺寸进入会话日志、卡片或元数据构建。
- **超限元数据降级而非截断。** 返回截断结构的 `presentationMeta` 会让回放卡片就完整性说谎；超过 `PRESENTATION_META_MAX_CHARS`（序列化 30,000 字符）时元数据降级为 `{}`，所有窄化器拒绝它，UI 回退到原始结果内容。规范值已被 `maxAlarms` 与 `maxDetailChars` 限界；该上限只会在 `maxAlarms` 很大的部署上触发。
- **结果陈述单一出处。** 空态行、计数头与截断说明是模型文本与卡片 markdown 共用的常量，两个呈现面不会漂移。
- **过滤器校验 schema DSL 表达不了的东西。** ISO-8601 解析与窗口顺序在 `execute` 检查，与 `dsh-tool-web` 的拆分一致。
- **只读即并发安全。** 工具声明 `isConcurrencySafe`，并行回合可以同时查询。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：Config schema、指引段、`alarm_query` 注册、渲染、元数据投影、呈现器 |
| — | 未发布运行时 invariant companion；除工具运行时已拥有的标准 `tool/call`/`tool/result` 事件外，本工具不注册任何持久状态。 |

### Export shape

插件是函数/命名空间插件：导出 `name` / `inject` / `apply`，无默认导出。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [alarm query seam](../integration-alarm/README.zh.md) — 工具消费的服务。
- [HTTP provider](../integration-alarm-http/README.zh.md) — 缝的一个后端。
- [integration group map](../README.zh.md) — 同组页面与包表。
- [Generated tool catalog](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-integration-alarm) — 模型收到的 `alarm_query` schema。
- [Generated configuration catalog](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-integration-alarm) — 全部可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### Tool schema

#### What the model sees

模型看到生成的 [`alarm_query` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-integration-alarm)：六个可选过滤参数 —— `severity`（`critical|high|medium|low`）、`status`（`firing|acknowledged|resolved`）、`source`、`keyword`、`since`、`until` —— 没有结果规模参数。描述陈述过滤器与返回字段。

#### Token effect

工具可见的每个请求上固定 schema 开销；给定配置下描述与 schema 稳定。

#### KV Cache effect

定义与可见性不变时前缀稳定。插件生命周期或范围限制可能使此 schema 的复用失效。

### Tool-call history and result

#### What the model sees

每个结果返回封闭告警对象、总匹配数与截断标志，渲染为 `1 of 9 matching alarms` 加每告警一行（`- [severity] status (firedAt source): title (#id) — detail`），空结果为 `No alarms found.`，截断时附收窄过滤器的提示。稳定失败是 `Error: invalid alarm_query: "since" must be an ISO-8601 timestamp`、`Error: invalid alarm_query: "until" must be an ISO-8601 timestamp` 与 `Error: invalid alarm_query: "since" must not be later than "until"`；提供方失败以其 `AlarmError` 码呈现。

#### Token effect

Token 增长随 `maxAlarms` 与告警字段长度变化；调用参数是小而固定的过滤器。这些结果保留至压缩。

#### KV Cache effect

Append-only；新可见内容跟随可复用请求前缀，不使既有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些边界定义本工具何时是不合适的选择。它们是当前包约束，不是任务清单。

- **Read-only** —— 工具只查询告警；从对话中确认或解决告警需要带自己审批路由的写工具。
- **No model-facing result-size control** —— 部署上限是刻意的；模型放宽的预算会绕过持久元数据上限。
- **No time-window default** —— 模型传入显式 ISO-8601 时间戳而非相对短语，让 `execute` 不含隐藏时钟策略；错误表述以响亮的 ISO-8601 失败浮出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

本 Dev Note 是维护者的工作上下文：尚未决定的开放问题与方向。它明确是非权威的 —— 已交付的行为、边界与已接受的依据存在于上文各节、包代码与所链接的 Agent Notes。

#### Future: relative time windows

自然语言时间窗（`最近 2 小时`）会把时钟策略挪进工具；当前的显式 ISO-8601 契约让 `execute` 对回放保持确定性。只有当消费方确实无法表述时间窗时再重新考虑。

</details>
