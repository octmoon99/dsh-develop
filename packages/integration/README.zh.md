---
description: "系统集成能力家族的包地图：告警查询缝、其 HTTP 后端，以及消费它们的模型可见工具。"
kind: "package-group"
---

# integration/ — 系统集成能力家族

[English](README.md) | 中文

## 概述

`integration/` 包通过专用查询缝把代理连接到外部业务系统。第一条缝是告警查询：一个服务（`ctx.alarmQuery`）、一个把具体告警系统 REST API 映射进封闭告警词汇表的 HTTP 后端，以及结果同时供通道卡片使用的模型可见 `alarm_query` 工具。当外部系统应可从对话中读取、而工具与通道不应绑定厂商时使用本家族；未来的每个系统（工单、CMDB、值班）重复同样的三角色拆分，而不是让本组的包横向生长。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

三个包承担告警角色。

| Package | Role | ctx key |
|---|---|---|
| [`integration-alarm/`](integration-alarm/README.zh.md) | 告警查询服务：提供方注册表、显式解析、统一选择与错误策略 | `ctx.alarmQuery` |
| [`integration-alarm-http/`](integration-alarm-http/README.zh.md) | 把一个告警系统的 REST API 读入缝词汇表 | 注册到 `ctx.alarmQuery` |
| [`tool-integration-alarm/`](tool-integration-alarm/README.zh.md) | 向模型暴露 `alarm_query` | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Systems integration subsystem](../../docs/subsystems/integration.zh.md) — 缝的请求、结果、提供方可用性与 `AlarmError`。
- [Alarm query seam Agent Note](../../.agents/notes/implemented/architecture/2026-09-16-integration-alarm-query.zh.md) — 缝的设计、wire 契约决策与呈现元数据上限。
- [能力 overlay 示例](../../apps/cli/config/examples/alarm-query/cordis.yml) — 三报警插件，叠加任意 profile。
- [飞书组合示例](../../apps/cli/config/examples/alarm-query-feishu/cordis.yml) — 完整飞书机器人加告警卡组合。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

本 Dev Note 是维护者的工作上下文：尚未决定的开放问题与方向。它明确是非权威的 —— 已交付的行为、边界与已接受的依据存在于上文各节、包代码与所链接的 Agent Notes。

#### Future: one seam per system, not one group per system

工单、CMDB 与值班集成在消费方出现时各自成为本组里自己的能力缝；刻意不朝"通用查询"包的方向走。

</details>
