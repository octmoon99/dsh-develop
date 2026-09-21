---
description: "告警查询能力缝的 HTTP 后端：把一个告警系统的 REST API 读入封闭告警词汇表，带凭证引用的 Bearer 鉴权、单次尝试超时与有界重试，面向接入具体告警系统的部署方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-integration-alarm-http

[English](README.md) | 中文

## 概述

`dsh-integration-alarm-http` 把 `ctx.alarmQuery` 连接到一个基于 HTTP 的告警系统。它读取下文的 REST 契约，把厂商载荷映射进缝的封闭告警词汇表，用凭证引用的 Bearer 令牌鉴权，并在配置边界内重试瞬态失败。把它与 `dsh-integration-alarm` 组合；它把自己注册为 `http` 提供方，从不拥有选择权。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当你的告警系统能提供下述 REST 契约时使用本包。把 `baseUrl` 设为系统根地址；提供方查询 `{baseUrl}/alarms`。

### The wire contract

`GET {baseUrl}/alarms`，可选查询参数 `severity`、`status`、`source`、`keyword`、`since`、`until`（仅在解析后的查询携带时转发），以及 `limit`（解析后的 `maxAlarms`，上游成本边界；缝仍对返回数组强制执行上限）。响应体为：

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

`total` 是计数的非负整数，统计源系统的匹配数；每个 `alarms[]` 条目携带必需的 `id`、`title`、`severity`、`status`、`firedAt` 与所示可选字段，`firedAt`/`acknowledgedAt`/`resolvedAt` 为 ISO-8601 时间戳。边界是严格的：未知键、错误类型、词汇表外的严重级别或状态、非 ISO 时间戳、比 `total` 更长的 `alarms` 列表都会以 `ALARM_PROVIDER_FAILED` 响亮失败 —— 静默丢弃字段会让投影就源返回内容说谎。这份严格性属于本包定义的标准网关协议；适配一个容忍厂商字段漂移的系统的提供方自行选择兼容策略并独立成包 —— 该拒绝不是每个第三方适配方的必要条件。

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
| `baseUrl` | required | 告警系统根地址；查询 `{baseUrl}/alarms` |
| `auth` | `bearer` | `bearer` 要求令牌、解析不到响亮失败；`anonymous` 完全不发送令牌 |
| `token` | — | 字面 Bearer 令牌；优先用 `tokenEnv` 保持配置文件可共享 |
| `tokenEnv` | `DSH_ALARM_API_TOKEN` | 持有 Bearer 令牌的凭证引用名 |
| `timeoutMs` | `10000` | 单次尝试超时；同样约束令牌解析与请求 |
| `maxResponseBytes` | `1048576` | 响应体字节上限；越界即失败该次尝试，不整份下载 |
| `retries` | `2` | 首次失败后的重试次数 |
| `retryBaseDelayMs` | `400` | 首次重试前的退避基数；按次翻倍 |

`baseUrl` 必须是不带 query 与 fragment 的绝对 `http`/`https` URL；插件把它规范化为目录（缺尾斜杠会补上），因此 `https://host/api/v1` 与 `https://host/api/v1/` 都查询 `https://host/api/v1/alarms`，不丢路径段。

令牌按尝试解析，与请求共用同一超时：设置了字面 `token` 则用之，否则走凭证缝（`tokenEnv` 引用，如 `~/.dsh/.credentials.yaml`），再否则是环境启动层。`bearer` 模式（默认）下引用解析不到令牌时在任何请求发出前就以 `ALARM_PROVIDER_FAILED` 响亮失败 —— 绝不会意外发出匿名请求；`anonymous` 模式不读令牌、不发头部。

### Retry behavior

网络失败、超时（含令牌解析超出 `timeoutMs`）、令牌解析错误、HTTP `429/500/502/503/504` 按翻倍退避重试至多 `retries` 次；解码失败、超出 `maxResponseBytes` 的响应与其他状态立即失败 —— 上游已应答而应答是错的，不是迟了。调用方取消绝不重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Implementation internals — click to expand</summary>

本节解释提供方背后的设计决策并指向实现代码；可观测行为见 [Use this package](#use-this-package)。

### Design philosophy

厂商映射只发生一次，在 wire 边界映射进缝的封闭对象 —— 下游代码信任 TypeScript。提供方借用 DeepSeek 搜索提供方的凭证解析模式（凭证缝加环境层回退），所有可调项都是经过校验的 Config 字段，符合无可调硬编码规则。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：Config schema、校验、提供方注册、令牌接线 |
| [`src/provider.ts`](src/provider.ts) | `HttpAlarmProvider`：URL 组装、尝试/超时/重试循环、严格解码器 |
| — | 未发布运行时 invariant companion；本包不含其所挂接缝已强制契约之外的独立事件序列或可变数据关系。 |

### Export shape

插件是函数/命名空间插件：导出 `name` / `inject` / `apply`，无默认导出。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [alarm query seam](../integration-alarm/README.zh.md) — 本提供方注册进的服务。
- [alarm_query tool](../tool-integration-alarm/README.zh.md) — 缝的模型可见消费方。
- [能力 overlay 示例](../../../apps/cli/config/examples/alarm-query/cordis.yml) — 三报警插件，叠加任意 profile。
- [飞书组合示例](../../../apps/cli/config/examples/alarm-query-feishu/cordis.yml) — 完整飞书机器人加告警卡组合。
- [Generated configuration catalog](../../../docs/config-catalog.zh.md#deepseek-aidsh-integration-alarm-http) — 全部可接受的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

Indirectly, through `dsh-tool-integration-alarm`, which turns the mapped alarm results into the `alarm_query` tool schema, guidance, and retained tool-result tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些边界定义本提供方何时是不合适的选择。它们是当前包约束，不是任务清单。

- **One fixed wire contract** —— 上述 REST 形状即全部契约；无法提供它的系统需要一个适配服务或自己的提供方包。
- **Bearer token only** —— 无签名、mTLS 或刷新令牌流程；运行中过期的凭证会响亮失败直到轮换。
- **No response pagination** —— 单个请求承载截断结果集；大窗口依赖 `limit` 与过滤器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

本 Dev Note 是维护者的工作上下文：尚未决定的开放问题与方向。它明确是非权威的 —— 已交付的行为、边界与已接受的依据存在于上文各节、包代码与所链接的 Agent Notes。

#### Future: adapter guidance for non-conforming systems

无法原样提供 wire 契约的告警系统应获得适配服务或自己的提供方包；把逐租户字段映射折叠进本包会把契约执行挪进部署数据。

</details>
