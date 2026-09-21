# Agent Note：告警查询能力缝 —— 封闭词汇表后的一个 REST 后端

Status: implemented

[English](2026-09-16-integration-alarm-query.md) | 中文

## Problem

代理无法从真实告警系统读取告警：没有服务拥有告警词汇表或提供方选择，而告警结果的通道卡片本需要在飞书包里写提供方代码。各告警平台返回的厂商载荷形态各异，直接读原始 JSON 的工具会让模型解析类散文结构，并让贴错标签的严重级别静默通过。

## Decision

- **新组 `packages/integration/` 里的一条能力缝，三个角色三个包。** `dsh-integration-alarm` 拥有 `ctx.alarmQuery`：提供方注册表、显式 `resolve(request): AlarmQuerySpec` 默认化步骤（缝默认 `maxAlarms` 20）、与注册顺序无关的选择梯、封闭码联合的 `AlarmError extends HarnessError`。`dsh-integration-alarm-http` 把一份成文的 REST 契约映射进缝。`dsh-tool-integration-alarm` 拥有面向模型的 schema、渲染与呈现。未来系统重复这一拆分，而不是让任何包横向生长。
- **缝拥有封闭告警词汇表。** 严重级别（`critical|high|medium|low`）、状态（`firing|acknowledged|resolved`）与字段集是缝类型；时间戳字段按契约是 ISO-8601，用缝导出的 `isIso8601Timestamp` 校验，wire 解码与模型输入校验共用一条规则。HTTP 提供方在 wire 边界严格解码厂商 JSON —— 未知键、错误类型、词汇表外的值、非 ISO 时间戳、比 `total` 更长的 `alarms` 列表都以 `ALARM_PROVIDER_FAILED` 响亮失败。这份严格性属于本包定义的标准网关协议；适配容忍漂移的系统的提供方独立成包并自选策略。下游代码信任 TypeScript。
- **只重试幂等所覆盖的。** 网络失败、超时、令牌解析错误与 HTTP 429/5xx 在 Config 边界内按翻倍退避重试；解码失败、超出字节预算的响应体与其他状态立即失败，调用方取消绝不重试。超时按次生效，经 `AbortSignal.any` 与调用方信号合并，且同样约束凭据解析：令牌 Promise 与该次尝试的中止守卫竞速，落败的解析继续运行但结果被丢弃。
- **鉴权是显式模式，不是回退。** `auth: bearer`（默认）按次解析令牌，解析不到就在任何请求发出前以 `ALARM_PROVIDER_FAILED` 响亮失败 —— 绝不意外发出匿名请求；`auth: anonymous` 不读令牌、不发头部。
- **baseUrl 一次解析成目录。** `resolveAlarmBase` 在插件装载时只接受不带 query 与 fragment 的绝对 `http`/`https` URL，并把 pathname 补上尾斜杠，`…/api/v1` 与 `…/api/v1/` 都查询 `…/api/v1/alarms`，不丢路径段；提供方只接收解析后的 URL，不收原始字符串。
- **响应与细节先限界再渲染。** 提供方在 `maxResponseBytes` 下流式读取响应体，预算一越界即取消流，超限应答绝不整份下载；工具在规范值内部把每条告警的 `detail` 封顶在 `maxDetailChars`，截断、加省略号并标记 `detailTruncated`，值、会话日志、卡片与元数据构建都见不到全尺寸的超长字段。
- **模型从不决定自己的结果规模。** `alarm_query` 只暴露过滤器；部署上限（`maxAlarms`，1–100，默认 20）是 Config 字段，经缝的解析步骤生效。
- **超限呈现元数据降级而非截断。** 工具的 `presentationMeta` 携带结构化告警与一份显示用 markdown；超过序列化 30,000 字符时返回 `{}`，所有元数据窄化器拒绝它，回放的 UI 与通道卡片回退到原始结果内容。规范值已被 `maxAlarms` 与 `maxDetailChars` 限界；该上限只会在 `maxAlarms` 很大的部署上触发。`presentationMeta` 合法上不能返回 `undefined` —— 运行时会对它做快照与校验 —— 因此降级是一个显式形状，不是省略。
- **通道卡片读元数据，不读提供方代码，且一个变量承载全部结果陈述。** 飞书包零改动：一个 `bindTool: alarm_query` 的 `cardTemplates` 条目绑定元数据的 `markdown`，它本身就写明空态（`No alarms found.`）、展示数/总数与截断说明 —— 与模型文本共用同一组常量 —— 任何呈现面都展示不出会被当成完整结果的裸列表。能力 overlay 只带告警三件套、叠加任意 profile；独立的飞书组合示例携带完整机器人与卡片条目，cardTemplates 条目即卡片的唯一归属 —— 计划中的卡集缝将把这一纪律形式化到每个技能拥有的卡。

## Alternatives considered

**带每租户 JSON 路径的通用 REST 查询工具。** 一个工具加映射配置可读任何系统，但每个字段名都变成部署数据：贴错标签的严重级别以错误答案而非加载时契约失败的形式浮现，模型解析类型系统从未见过的厂商形态。专用缝一次付出三个包的成本，未来系统继承该模式。

**重试解码失败。** 对畸形体重试整个请求，是把"上游答错了"当成"上游答迟了"；为确定性失败加倍负载。重试循环因此只包裹传输，解码在循环之后。

**超限时完全省略元数据。** 运行时把 `presentationMeta` 的返回值校验为无损 JSON，返回 `undefined` 是工具输出失败而非省略。空对象降级保住了诚实的回退（原始结果内容）而不引入错误路径。

## Consequences

飞书纯靠配置渲染告警卡；告警三件套立即可从 Web UI 使用（元数据 markdown 上的通用卡）；wire 契约是不合格告警系统必须适配的集成面（适配服务或自己的提供方包）。测试覆盖缝的选择梯、解析、上限、HMR 安全注册与共享 ISO-8601 校验；提供方针对本地 HTTP 服务器（映射、含缺令牌响亮失败的鉴权模式、重试、超时、凭据解析约束、字节预算边界、路径前缀拼接、严格解码）；工具经真实 Loader 组合证明 `maxAlarms` 是活的可配置项，另覆盖细节封顶、结果陈述与元数据上限。仓库内的 `dev-fixtures/alarm-system` FastAPI 进程通过可复用的真实 HTTP 端点提供相同的严格响应，并带有内存场景、彼此分离的查询与管理凭据以及有界查询故障；它明确不提供持久化或飞书主动投递。它的测试原子申请临时回环端口，等待服务就绪，并等待 Uvicorn 完全停止。`dsh-system-prompt` 增加了一个附加式段落顺序常量（`TOOL_INTEGRATION_ALARM`），这是唯一的基础包改动。

## Verification

- **FastAPI fixture 拥有独立的真实网络检查。** 它的协议套件验证鉴权、过滤、半开时间窗口、严格管理写入、场景替换、有界故障，以及经操作系统分配的回环端口访问的 Uvicorn 监听器。HTTP 提供方的包测试另行覆盖生产传输实现与失败规则。
- **keyless Session fixture 证明组装后的模型可见路径。** [`snapshots/session/alarm-query`](../../../../snapshots/session/alarm-query/snapshot.yml) 通过随附的 headless profile 启动真实 seam、HTTP 提供方与工具；只有模型适配器由回放替代。它的回环 fixture 会拒绝错误的方法、过滤器、结果上限、`Accept` 头或 bearer token，而会话固定 `alarm_query` 调用、截断后的规范结果、呈现元数据与最终模型轮次。该场景是确定性的 CI 证据，不模拟飞书。
- **真实飞书投递仍是手工证据。** 2026-09-20 的一次负责人本地 UAT 使用能力 overlay、FastAPI fixture、实时模型服务与真实飞书传输；告警结果成功完成该路径。这次运行不认证目标厂商的鉴权、schema 漂移、限流或生产可用性；这些项目需要独立的提供方级验收。

## Related decisions

本缝沿用 [web 能力缝决策](2026-06-24-web-capability-seam.zh.md)。工具呈现契约与元数据回退规则遵循 [render-intent-union note](2026-07-02-tool-render-intent-union.zh.md) 与 [client-derived presentation note](2026-08-23-client-derived-tool-presentation.zh.md)。本缝卡所依托的飞书卡模板绑定记录在 [card-templates note](2026-09-11-feishu-card-templates.zh.md)。
