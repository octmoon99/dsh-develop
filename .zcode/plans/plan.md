# 飞书数智员工：PR 系列正式计划（修订版 5）

> 2026-09-18 修订说明：
> - PR1 收口新增 P1-7：审批决策人允许列表支持 user_id——`deciderUserIds` 与 `deciderOpenIds` 并列，分别匹配回调操作者的 `user_id`/`open_id`，任一命中即有资格，两列表均为空仍不认领。`operator.user_id` 为防御性线上字段（缺省即无资格，fail-closed），真实回调是否送达取决于应用权限范围，归 PR0 验证；P1-4 剩余项（`event.token`、`context.open_message_id`、`'warning'`）不变。
>
> 2026-09-17 修订说明：
> - 本文为执行计划；[plan2.md](plan2.md) 保留为对照草案。部署路线为每租户独立应用、实例、凭据和数据目录。
> - 新增 PR3 前六项必决问题、建议方案与准入验收，并同步修订 PR3a/PR3b 的事件提交、持久化和执行归属。
> - 保留 PR1/PR2 整改清单，修正 HTTP 测试方式、持久 inbox、存储分工和平台能力待验证项的表述。
> - 本次仅修改计划，不表示建议方案已实现或已通过实验；真实飞书验证归 PR0，PR1 合入及 UAT 状态沿用项目记录。
> - 明确模拟 A 先于 PR2 最终验收，模拟 C 与 PR3a 并行实现，H5 为非阻塞交付；区分设计准入、实现验收与真实平台前置条件。
> - 选定六项 #4 的写动作对端：[本地模拟报警系统](local-http-alarm-provider-plan.md)（`dev-fixtures/alarm-system/`），确立「模拟级/真实级」两级验收；P2-7 验证载体、PR3a/PR3b 对端、放行条件与里程碑分档同步更新。

## 已确认的决策记录

总目标：AI 原生数智员工基础能力包，飞书为 IM 通道，**独立租户实例**（一租户一应用一实例一凭据一数据目录），覆盖审批/督办/开放查询。

- 确认卡 = 工具审批确认（走 `approval/request` 瀑布）；集成 = 专用查询缝；长流程 = 独立 PR。**补 PR1 收口**：短审批需要可信决策人策略，群聊可见性不构成批准权限
- 长审批 = 会话事件 + 可重建投影，不增加另一份可独立修改的审批业务状态表；复用 dsh-schedule 中适用的时间解析与处理机制，但不照搬其仅在活 root agent 空闲时派发的限制。审批写入归属与忙碌会话处理先通过下文六项准入验证，冷会话恢复与运行时集成由 PR3b 补足。
- **（修订）过期驱动 = 服务端确定性裁决**：串行裁决时读服务端时间，达到 expiresAt 不再接受新批准，重复已完成请求返回原结果；提醒/督办文案可由模型生成，但状态正确性不得依赖「模型收到提醒后调用工具」
- **（修订）事件粒度 = `created` / `requested` / `decided` 三类 + 投递执行事件**；requested 携带独立 levelRequestId 与 expiresAt（或明确无截止）；同一条日志可完整重建流程，不要求每条事件重复整条审批链
- 卡集 = 声明式注册缝：三类卡（通知/动作/表单）保留。**（修订）**卡集/卡片/动作/已发送实例四层身份分离；动作目标分两类——Agent 任务（模型裁量）与确定性业务命令（不经模型选择）；form_value 不得覆盖服务端绑定的对象 ID、凭据引用或权限字段
- 出回合触发复用 PR3b 的外部事件 → resume 桥；点击本身入会话日志（model-visible ⟺ logged）
- **副作用顺序**：fold 保持纯函数；记录操作意图并确认持久化后才执行外部调用，再记录结果并确认持久化。恢复时按稳定操作 ID 处理未完成或结果不确定的操作。日志 append、持久化确认、外部接口成功分别记录；只有取得相应平台回执才能声称用户已收到或已读，发送 API 成功本身不证明这一点。
- **存储分工**：审批与操作执行事实由 Session 日志保存，投影及发现索引可重建；小规模人员/角色映射可放实例 settings 或从飞书解析，流程与组合配置由版本化声明和受信任 Cordis 配置承载，凭据经 credentials 引用。真正出现业务写入或向量检索需求时，由所属 Provider 接入 PostgreSQL，按需使用 pgvector；不为尚不存在的数据模型提前建库。更换会话后端实现 session-persistence Provider，是否变更格式版本取决于事件格式而非数据库选型；其他应用状态先确定所有者和持久化接口，不假定存在通用 storage 服务。独立实例使用独立数据库凭据与明确数据访问范围。
- **（修订）新事件默认 required-on-read**：逐类证明忽略后安全才设 `ignorable`；第一方事件不通过 `Session.append` 设 `ignorable`（无此参数），靠生成的 `KNOWN_SESSION_EVENT_TYPES` 目录承接；不因新增事件名 bump `SESSION_FORMAT_VERSION`，也不把不 bump 当作必须 ignorable 的理由
- **（新增）部署模型**：一租户一套飞书自建应用、一个独立运行实例、独立凭据与数据目录；首版每实例单审批/调度写入者，启动检查拒绝不受支持的重复运行；不建共享租户路由/跨租户 RLS/共享任务队列
- **（新增）交互卡格式**：现状本地 JSON 1.0 保持兼容；是否长期限定 1.0（及平台模板能否承载动态业务身份）由 PR0 实测能力矩阵后定，不写死未经验证的限制
- **二次刷新候选**：同步回调返回、延时更新 token、`PATCH /im/v1/messages/{message_id}`。官方参考列出延时 token 有效期 30 分钟、最多两次使用，但已有文档版本差异；具体次数、格式兼容、PATCH 更新期限和共享卡要求统一由 PR0 验证，不使用“约几次”作为接口保证。业务执行和恢复不依赖临时 token 可重复使用；失效后采用已验证的消息更新路径或另发状态消息。现有 JSON 1.0 实现不直接调用仅接受 2.0 的 cardkit 实体更新接口。

## 开工首查结论（2026-09-16，代码级 + 官方文档级）

1. **压缩**：压缩只重写 model surface（`compaction/summary` + replace op），会话日志严格 append-only（`packages/compaction/compaction-basic/src/region.ts`）；`schedule/change` 等 log-only 事件不构成 surface 节点，压缩不删不改，投影状态天然幸存。`inheritedEventCount` 是 fork 血统切点，与压缩无关；fork 继承历史不拥有原流程执行权。approval-flow 镜像 `packages/schedule/schedule/src/projection.ts` 契约；新事件须 `pnpm run gen-persistence-catalog` 登记。真实风险仅在 model 上下文面：审批前后的对话可能被摘要掉，pending 信息要靠已记录上下文补回。
2. **唤醒与持久输入**：[Agent 实现](../../packages/core/agent-loop/src/agent.ts) 的 followup 经 send/wakeDriver 提交后续回合，相位机串行管理 idle/maintenance/running；[inbox 实现](../../packages/core/agent-loop/src/inbox.ts) 已通过 Session 事件和投影保存待处理输入。普通 followup 的 FIFO 不证明业务状态处理没有冲突：runMaintenance 只接受真正 idle 的 Agent，忙碌时抛错，不能作为任意时刻均可进入的审批事务。PR3 需验证独立于模型长回合的裁决方式，复用持久 inbox 并补业务任务关联和完成语义；审批使用自有事件，不复用短审批的回合内决议。PR3b 还需提供冷会话恢复、实例启动发现和显式通知目标，不能依赖消息路由私有 ensureAgent 或已清除的 anchor。
3. **时效与载荷**：按三秒回调预算设计短响应；SDK 的 WS handler 返回值封装与 HTTP 回包路径提供实现依据，但具体回调载荷、格式兼容、延时 token 次数和消息更新条件仍需 PR0 在锁定版本下验证。SDK 1.73.3 相关类型包含 token 与 context.open_message_id，当前 parseCardAction 未读取（见 P1-4）；类型存在不代表真实环境已经验收。

## PR0 — 平台验证与语义确定（新增；可与 PR2 并行）

目标：消除影响 PR3b/PR4 的平台假设。以现有文档和 SDK 阅读结果为输入完成**真实环境实测**，记录实际 SDK 版本、卡片格式、接口与结果；实测与资料不一致时回查对应版本，不以官网段落或模拟 SDK 测试替代真实回调验证。本节实测项均为飞书平台行为；`dev-fixtures/alarm-system` 本地模拟报警系统只覆盖报警协议对端，不覆盖本节任何一项，不得以模拟服务结果替代：

| 实测项 | 必须回答 |
|---|---|
| 长连接 + HTTP 双入口 | 锁定 SDK 版本下真实回调载荷、身份字段、回包结构与超时行为 |
| 卡片格式矩阵 | 按钮、表单、同步返回更新在本地 JSON 1.0 / 2.0 下各自支持什么 |
| 平台模板 | 能否绑定动态业务身份；发布版本与实例变量如何保存 |
| 延时更新 | token 实测次数上限（2 还是 3）、共享卡行为、回包顺序要求 |
| message.patch | 可更新的卡片范围、消息年龄、频控、撤回状态限制 |
| 主动发送 | 指定审批人/群组可达性与所需应用权限 |

业务语义同步确定：每级审批人策略、取消权限、超时终止规则、角色解析方式；按下文六项要求确定可执行的业务动作及受信任审批规则；首个对端采用模拟报警系统，真实厂商接入另行验收。配置变更可调整样式，不能悄悄替换已发送实例的业务动作语义。

## PR3 前必须解决的六个问题

本节是 PR3a/PR3b 的实施准入要求。PR0 和 PR1/PR2 收口期间可进行有界技术验证，但在写入归属、业务动作和授权规则未定稿前，不以单纯增加事件类型代替完整设计。

### 1. 忙碌会话中的审批裁决

**问题**：runMaintenance 只在 idle 时接受任务；把所有 decided 都放进该方法会阻塞忙碌会话的点击与到期处理，不能同时承诺及时裁决。

**建议方案**：分离持久受理、状态裁决和模型续跑。为流程提供单写入者、按 flow 串行的确定性处理路径，不等待模型回合结束。先验证现有 Session 写入、持久化确认和日志不变量是否允许由所属插件在忙碌会话提交这类 log-only 事件；若不允许，则评估由独立流程 Session 承载权威事件、显式关联对话 Session，并验证发现、恢复和 fork 语义。两种方案在 PR3a 前择一记录，不能同时维护两份审批权威，也不能为了绕过限制直接写 JSONL 或强行调用 maintenance。优先现有扩展点，若必须改变核心生命周期，则单独论证并更新架构，不把它算作普通适配。

**验收**：使用可控的长工具调用保持对话忙碌，同时测试有效点击、到期和两者竞争；受理及裁决满足配置预算，截止后不接受新批准，模型通知可延后。持久受理不等于批准；按串行裁决时的服务端时间判定，队列延误跨越截止时刻不能凭客户端点击时间倒签。fold 重放得到唯一结果，Session 写入仍由合法所有者完成。

### 2. 多级推进与恢复的事件提交位置

**问题**：将 created/requested 限定在活回合工具调用中，会阻止服务端在批准后或重启时自动补出下一申请。

**建议方案**：首次创建可由 request_approval 工具触发，后续 requested、decided 和恢复补偿由审批运行时按同一串行写入规则提交，不要求模型回合。由固定的 flow/级次生成或查回稳定 levelRequestId，恢复不重新分配身份。expiresAt 在创建级次申请时按已解析规则计算并持久化；读取侧只派生是否到期，不随当前配置重新计算截止时间。恢复缺失级次时的起算点需确定并可重放，不能用每次重启时间延长审批窗口。

**验收**：在 created 后、上级 decided 后和下级 requested 前分别中断，不启动模型也能恢复唯一的正确申请；重复恢复不增加级次、不改写已有截止时间。

### 3. 外部副作用必须晚于持久化确认

**问题**：append 时立即发卡或调用业务接口，仍可能出现外部成功而日志丢失的窗口。

**建议方案**：固定执行顺序为“操作意图与稳定操作 ID → 持久化确认 → 外部调用 → 结果记录与持久化确认”。持久化失败或结果未知时不声称成功；外部成功但回执或结果记录丢失时，优先使用业务幂等键和结果查询恢复。接口不支持幂等或查询时转入明确的不确定状态及人工处理，不自动重放敏感写操作。发送 API 成功仅代表平台接受发送；用户收到、已读需独立回执证明。

**验收**：对意图提交前后、外部返回前后和结果持久化前后注入中断；证明没有未持久化意图驱动的业务调用，重复恢复不造成可避免的重复写入，不确定状态可以查询和处理。

### 4. 首个审批必须绑定可核对的业务写动作

**问题**：alarm_query 只读；仅完成卡片逐级批准不能验证“审批后执行业务”的里程碑。

**决定（2026-09-17）**：写动作对端选定为[本地模拟报警系统](local-http-alarm-provider-plan.md)（`dev-fixtures/alarm-system/`，外部测试夹具，FastAPI + SQLite）。最小动作 = 其阶段 C 的「确认单条告警」写接口（`POST /alarms/{id}/acknowledge` + `GET /alarms/{id}/action-state` + `GET /operations/{operationId}`，带 expectedVersion、操作 ID/幂等键、同事务提交与 409 语义）。接口方案已确定，待实现与验证，不将设计声明视为接口已可用；模拟系统只保存报警状态，不保存 DSH 的审批权威状态。**两级验收**：模拟级——机制、恢复与端到端集成对本地模拟系统验证，通过即满足 PR3a/PR3b 验收与首个里程碑的机制面；真实级——接入真实告警系统时保留为正式交付条件，按同一验收矩阵重跑协议与业务验收，不因模拟级通过而豁免；真实厂商的认证、限流、幂等行为差异归真实级单列。

**PR3a/PR3b 分工**：PR3a 开始前确定写接口、对象版本、参数、权限、幂等键、超时后的查询确认和失败语义；PR3a 开发期间并行实现模拟系统阶段 C 与最小动作 Consumer/Provider，完成前必须通过真实 HTTP 写入、幂等与恢复测试。模拟服务的接口实现不等待审批引擎，但 Agent 使用写能力必须经过审批与权限路径。PR3b 接入飞书完成模拟级端到端验收。动作通过受控工具或命令路径执行，业务批准与工具权限分别检查；模拟接口不信任模型传入的 approved 标志，测试管理凭据不交给 Agent。PR4 从这个动作与查询通知提炼通用卡集，不让 PR3 反向依赖尚未实现的 PR4。

**验收**：模拟系统中的业务对象在审批前不可执行、通过后产生预期外部状态（`action-state`/`operations` 可核对），参数或版本变化使旧批准失效，重复点击或重启不重复执行（幂等键返回首次结果）；证据包含外部状态或回执，不仅是模型文字和流程终态。真实级验收在真实系统接入时按同一矩阵重跑。

### 5. 审批链来自受信任规则

**问题**：仅验证点击者在 approvers 中不足以防止越权；如果模型能任意指定审批人、级数或超时策略，就可能先构造一条过于宽松的审批链。

**建议方案**：由管理员维护的版本化流程配置决定业务动作对应的流程、审批角色、申请资格、自批规则、级次和超时策略。模型只提交允许的业务字段及可选择范围内的流程引用，服务端按实例身份和规则解析并授权后生成快照。首版建议逐级串行、每级任一指定审批人可决议、拒绝即终止；自批默认禁止，仅经明确配置允许。配置变化不重新解释已有申请，但执行前仍检查账号停用等当前禁止条件；替换审批人或关键参数走取消并重新申请，不静默改链。

**验收**：模型篡改 approvers、缩短审批链、选择不适用流程、替换动作参数或尝试自批均被拒绝；合法申请能够由可信规则解析。表单和按钮 value 不能覆盖这些规则，人员停用后的处理结果明确。

### 6. 标准能力包的完整性与适配范围

**问题**：“能力齐全”容易被理解成任意系统无需适配、任意业务仅导入模板即可运行。

**建议方案**：完整性定义为查询、短交互、持久审批、受控动作、通知、任务及配置导入均具有标准接口和至少一个可用实现。已有动作的组合可通过声明式配置交付；新增外部协议或业务动作仍需对应 Provider/Consumer，并完成鉴权和真实协议验证。每个交付包提供能力与依赖清单、支持的动作版本及未支持事项；导入遇到缺失能力应明确拒绝。飞书原生审批中心同步、可视化流程设计器、会签/转交/加签和共享多租户服务不在首版承诺内。

**验收**：两个独立实例可用同一包版本配置不同凭据与人员；支持的模板可导入，引用未安装动作或不兼容版本的模板明确失败，不生成只有界面而无法执行的流程。

## PR1 — feishu 短交互闭环 ✅ 已合入 `feishu/wangyue`（UAT 通过）＋收口整改

原分支 `feishu/card-interactions`，已交付：`lark.ts` 双通道回调入口（长连接 `card.action.trigger` + HTTP `CardActionHandler`）、`edges.ts` 双通道注册与 `<path>/card` 路由、`interaction.ts` 桥（瀑布认领/委托/中止、pending 表、回调即原地刷新）、`interaction-card.ts` 构建器、`config.ts` `interactionCards` 段、四组 spec、README×3 + Agent Note。

**回看发现的缺陷与缺口**（详见文末整改清单，收口小 PR 处理 P1-1/P1-2/P1-5/P1-6/P1-7）：

- **P1-1（缺陷）dispatch 先消费后验证**：`packages/feishu/feishu/src/interaction.ts:248-252` 在校验 outcome 之前就删除 pending；携带合法 interactionId 但无合法 verdict 的（畸形/篡改）点击会吞掉 pending，瀑布悬挂直至请求中止。整改：先验证（interactionId 匹配、kind 匹配、approval 必须带合法 outcome、操作者资格）全部通过才 delete + settle。
- **P1-2（缺口）无决策人门禁**：`dispatch` 仅将 `operatorOpenId` 用于已结算卡展示，任何能看到卡的人都可决议。整改：`interactionCards` 增加审批决策人策略（允许 open_id 列表或派生规则），先验证后消费；无可信身份不放行。
- **P1-3（缺口）卡片未声明 `update_multi`**：全 src 无此字段，`PATCH /im/v1/messages` 刷新路径被堵。整改：`interaction-card.ts` 构建器卡 config 加 `update_multi: true`（PR0 实测确认后定稿）。
- **P1-4（缺口）`parseCardAction` 未透出 `event.token` 与 `context.open_message_id`**；`CardActionResponse.toast.type` 缺官方支持的 `'warning'`。归 PR3b（若 P1-3 提前则随行）。
- **P1-5/P1-6（文档）**：Agent Note `.md:9`/`.zh.md:9` 的 `im.v1.card.update/batchUpdate` 实为 cardkit v1 `card.card.update/batch_update`（2.0-only 实质结论不变）；Alternatives 段漏记官方存在的两条 1.0 可更新路径（延时更新 token、PATCH message），应补记为 PR3b/PR4 设计输入。

已有处理路径：重复点击/取消后点击返回 stale toast；中止 settle cancelled；插件卸载随 scope 释放认领路径。回调采用同步短响应设计，真实环境是否满足三秒预算由 PR0 验证，不能仅凭代码路径视为时效验收通过。

收口验收：真实 Loader 组合、双入口回调验证、无权点击、非法动作不消费 pending、重复点击及中止路径。短交互仍为当前回合临时状态，重启失效，不伪装持久审批。

## PR2 — integration/alarm-query 专用查询缝（实施中：工作区未提交）

三包已在工作区落地（`packages/integration/`）：`integration-alarm`（Definition，`ctx.alarmQuery`，provider 选择梯 + `ALARM_PROVIDER_*` 封闭码）、`integration-alarm-http`（Provider，Config：baseUrl/credentials 引用/tokenEnv/timeoutMs/retryBaseDelayMs）、`tool-integration-alarm`（Consumer，`alarm_query` 工具 + presentationMeta 超预算降级为 `{}` + truncated 标识）；`apps/cli/config/examples/alarm-query/` 示例已建。此前评审记录：4 个测试文件 51 项测试通过（沙箱外重跑，本次文档修订未重跑）；其中 `http-alarm.spec.ts` 的 24 项测试使用本地 HTTP 服务和真实 fetch，覆盖 Provider 查询、重试、取消、超时与解码等行为。已有 HTTP 路径验证，但实际 CLI 配置、HTTP Provider、会话与飞书渲染的完整组合及 keyless 快照证据仍待补齐（P2-7）。

plan2.md 附录「PR2 工作区评审」的问题展开为文末清单 **P2-1…P2-8**；P2-7 按已有 HTTP 测试与尚缺的组合、快照证据分别描述。修复顺序：先 P2-1/P2-2/P2-3/P2-4（配置覆盖、URL 拼接、取消超时、卡片信息表达），再 P2-5/P2-6（结果预算、时间与鉴权策略），最后 P2-7/P2-8（组合与快照验收、提交范围；P2-8 随提交处理）。保留三包分层不变。仍有效的一般检查点：

- `{baseUrl}/alarms` 固定 GET 协议在 README 定位为**标准网关协议**，不承诺改 baseUrl 即兼容任意厂家（随 P2-2 一并落实文档定位）
- 外部 API 新增无关字段是否容忍，由供应商兼容策略决定，不机械等同持久事件 strict 校验（P2-6）
- 不引入独立应用启动脚本，示例走 dsh profile overlay（随 P2-1/P2-7 落实）；capability-seams 表更新（已在工作区改动中）
- 本 PR 的报警卡随后作为 PR4 卡集的第一个真实 Consumer 收编，业务 Provider 不依赖飞书卡片 JSON

## PR3a — 持久审批状态机与恢复

新组 `packages/approval/`，首包 `@deepseek-ai/dsh-approval-flow`，落实 Definition、运行时 Provider 和 request_approval Consumer；仅在角色需要独立演进时分包。包含 `src/{types,projection,index}.ts`、测试、README 及所需语言配对、Agent Note。只有存在可独立观察且可能分歧的关系才增加 invariant 模块，否则在 README 说明省略原因。跑 `gen-persistence-catalog` 登记新事件；SessionEventMap 变更同 PR 更新 TS/Python SDK expected outputs；参考 compaction-basic 的 log-only 并发 append 用例验证压缩与审批事件共存。按已确定接口并行实现模拟系统阶段 C 与最小写动作 Consumer/Provider，PR3a 完成前通过真实 HTTP 写入与恢复验收；对端为本地模拟报警系统（`dev-fixtures/alarm-system` 阶段 C 接口，见六项 #4）；PR3b 接入飞书完成模拟级端到端验收，真实系统验收在接入真实告警系统时单列重跑。

**事件（log-only，无 surfaceOp）**：采用前述准入验证选定的合法写入归属与串行规则。首次 created 可由工具触发；后续 requested、decided 与恢复补偿由审批运行时提交，不要求活跃模型回合，也不假定忙碌 Agent 可以进入 runMaintenance。

| 事件 | 主要记录 |
|---|---|
| `approval-flow/created` | flowId（品牌化）、请求幂等键、发起者、受信任流程规则 ID/版本、标题、业务引用、业务对象版本、完整审批链、绑定动作及解析后参数、创建时间 |
| `approval-flow/requested` | flowId、独立 levelRequestId、levelIndex、requestedAt、expiresAt 或明确无截止 |
| `approval-flow/decided` | flowId、levelRequestId、levelIndex、结果（approved/rejected/expired/cancelled）、可信操作者或系统原因、裁决时间、请求关联标识 |
| 投递与执行事件 | 稳定操作 ID、操作类别、目标、尝试/完成状态、外部回执及失败类别；具体拆分由恢复需求确定 |

approvers 用受约束身份类型（非空去重，open_id 与实例应用绑定）；允许/拒绝必须有操作者，系统过期必须有原因，不用全可选字段表达互斥来源。

**投影**：保存活动流程 + 防重复裁决所需的完成记录；校验五条——申请唯一、级次连续、先申请后决策、终态不可再次推进、动作与批准内容一致（仅 levelIndex 单调不够）。fold 纯函数、`seq < inheritedEventCount` 忽略、与 append 路径共享严格解码器（非法即抛）；stateVersion 1；fold 不读取当前时钟；expiresAt 在 requested 中持久化，读取侧仅派生是否到期，过期终态仍由 decided 事件确认。fork 验证：继承历史不重复发卡、不执行原审批。

**服务与授权**：审批链按前述管理员规则解析并固定快照，模型不能任意指定审批人或缩短审批链。`request_approval` 工具在持久化确认后返回流程身份与等待状态，不挂回合；未确认持久化时返回明确不确定结果与安全查询方式，重试不产生重复申请（幂等键）。决策接口接收**可信 actor**（来自验证后的入口，不从模型或按钮 value 自报）、levelRequestId、结果与幂等关联。受保护业务操作执行时核对批准记录与对象/参数版本；权限策略与业务批准分别检查。

**崩溃恢复（测试注入中断并重建运行时验证）**：created 已提交但首级申请未写入 → 按固定链生成同一首级申请；上级批准已提交但下级未申请 → 补出唯一下级申请；申请已提交但未发卡/未登记到期 → 恢复缺失操作；卡片已发送但回执未知 → 平台幂等或查询确认，不可确认时记录不确定状态按定义策略处理；流程完成但业务命令/Agent 后续任务未完成 → 按持久操作状态继续。Agent 后续输入复用已有持久 inbox，补业务操作关联及完成确认；不把 followup 误认为纯内存队列。所有外部副作用遵守“意图持久化确认后调用、结果持久化后确认完成”的顺序。

## PR3b — 主动发卡、冷会话恢复与超时处理

接入前完成所选飞书交互路径的 PR0 实测，以及 PR1 的可信身份、决策人资格、非法点击不消费等收口修复。暂未采用的平台模板等探索项不阻塞 PR3a；后续启用某路径前仍须完成对应验证。PR3b 完成时保留双入口真实回调验收要求。

- **主动发送**：扩展 feishu 出站适配（改 `packages/feishu/feishu/src/lark.ts` + 新增发送模块）：按接收人/群 ID 主动发送，保存 messageId 与更新关联信息；审批消息逐接收目标记录投递结果，部分成功不视为全部发送成功；平台接受发送不等同于用户收到或已读。
- **按钮 value（桥设计定稿）**：`{kind: 'approval-flow', flowId, levelRequestId, cardInstanceId, sessionId}` 封闭联合，dispatch 按 kind 路由（`'interaction'` PR1 存量 / `'approval-flow'` 本 PR / `'card-set'` PR4）；服务端从持久记录核对会话、应用身份与操作者资格；**旧级次卡片不能用于当前级次**，即使同一人是两级审批人。
- **回调受理语义**：回调只承担验证、持久受理与短响应，不等待模型或外部业务 API；达到定义的持久受理点后才返回「已受理」；平台时限内无法完成时按真实重投规则返回失败并允许幂等重试，不提前报告批准成功。
- **schedule 复用与冷会话发现**：确认实际可复用接口（时间解析、记录、串行处理），不假定存在 `ctx.schedule` 通用调度服务；实例启动时发现有待办审批或未完成操作的 Session，有界并发恢复；发现索引为可重建派生数据，丢失后从持久 Session 重建；恢复过程不为扫描会话调用模型。
- **服务端确定性过期**（决策记录第 3 条）：截止时间到达由服务端提交过期状态，提醒文本与督办解释可由模型生成；使用准入验证确定的审批裁决路径，长期繁忙 agent 不无限延长接受窗口，不将普通模型提醒作为到期执行器。如扩展 schedule 公开行为，单独定义自动到期处理与普通用户提醒的差别并补测试。
- **外部事件到 Agent 的续跑**：定义持久后续任务身份（已受理/已投递/已消费/执行结束）；复用现有持久 inbox 与消费追踪机制，仅补缺失的业务关联和执行完成语义，不并行维护第二套输入队列；`followup()`/`whenIdle()` 不构成单任务成功回执；统一控制同一会话的恢复与投递，避免飞书消息、审批回调、schedule、jobs 同时创建重复 Agent；后台回合显式携带通知目标与交互审批归属，不依赖已清除的原消息 anchor。
- 验收：服务停机跨越截止时间、冷会话收到点击、忙碌会话到期、重复回调、发送失败、下一级接收人不可达、恢复回合再次进入工具审批；另验证忙碌期间点击与到期竞争、持久化失败时不调用业务接口、写动作的幂等及不确定结果处理（对端为本地模拟系统阶段 C；真实系统接入时重跑该项）。

## PR4 — 声明式卡集与受控动作（修订）

新组 `packages/cards/`。三类卡语义保留（notify 回合回复位渲染、action 点击触发、form 填入提交触发）。

- **四层身份**：卡集定义 / 卡片定义 / 动作定义 / 已发送卡片实例各自独立 id（品牌化，照 `WorkflowRunId` 工厂）；实例固定业务引用、动作版本、可信参数、允许操作者、有效期及一次性或可重复策略；同一模板发出的不同业务卡片不共享可消费身份。
- **两类动作目标**：Agent 任务 = 持久记录点击与输入，经 PR3b 续跑机制提交模型，允许模型分析选择工具，产品文案不承诺执行固定命令；确定性业务命令 = 按注册动作与已验证参数经受控执行路径调用业务能力，保留权限/审批/工具或命令日志，不让模型重新选择操作（优先复用现有工具或命令执行机制，复用 PR3 的最小业务执行入口，本 PR 仅补通用动作注册所需的适配，不绕过检查直调 Provider；通知模型的步骤发生在执行事实记录之后）。
- **渲染与刷新**：通知卡复用现有工具结果与 context 变量机制（`TemplateVariableRule`）；交互卡格式按 PR0 实测结果定（不把本地 JSON 1.0 或平台模板写成未经验证的永久限制）；刷新按实际可用性选同步返回 / 延时更新 / message.patch，更新失败不撤销已提交业务结果；卡片超出更新期限时发送新状态消息并保持业务关联，不把旧卡仍显示按钮理解为操作仍有效。
- **表单防覆盖**：字段 schema 服务端验证（长度、枚举、业务引用）；form_value 不能覆盖服务端绑定的对象 ID、凭据引用或权限字段；卡片内容、表单输入与真实操作者记录来源明确。
- **租户样式覆盖只改展示**：不能通过替换模板重绑定工具、改变批准对象或放宽操作者权限；插件或动作版本不可用时已发送实例明确失效，不静默映射到新动作。
- **注册归属**：普通 SKILL.md 是内容资源不会自行调 `ctx.cardSets`；技能关联卡集由其加载插件或声明解析器注册，明确卸载行为。
- Consumer：alarm-query 注册报警卡集（PR2 收编），并接入 PR3 已验证的写动作，覆盖通知与确定性操作两条路径。apps/cli 仅承载配置组合示例，业务实现留在能力包中。验收覆盖实例去重、动作版本、参数防覆盖、权限检查、异步结果关联、插件释放及 keyless 快照。

## PR5 — 长查询、进度通知与督办（修订）

- 长查询 jobs 化**限定**：jobs-local 为进程内实现，不跨重启；按任务类型定重启语义——可安全重复的只读查询保存输入与任务身份后可重跑，有外部写入的任务必须幂等/支持结果查询/人工处理不确定结果；真正需要持久执行时实现适当 Provider，不在卡片层补一套任务系统。
- 通知与督办：复用 PR3b 发送能力与 PR4 卡集；通知目标、频率、静默时段、合并策略、重试预算及升级对象来自 Config 或已解析流程规则；状态变化与通知投递分开记录，通知失败不阻止流程终结；督办规则确定何时触发发给谁，模型负责说明、不决定是否越过截止；未实现的转交/加签不得通过督办文案间接执行。
- 验收：长任务完成与回合切换竞态、任务取消、重启恢复策略、通知限流、部分投递失败、重复完成通知。

## PR6 — 标准能力包与独立实例配置交付（重写）

- 通过 dsh profile 与 bundle 组合的标准安装方案；业务差异由实例配置与 Provider 表达，不复制修改核心代码。交付范围遵守前述第六项：每类标准能力至少有一个可用实现，新增系统协议仍需适配，不承诺任意系统即插即用。
- 带版本的流程与卡集导入格式：验证引用的工具、动作版本、审批人、卡集和凭据引用；先完整验证再应用，不允许半套流程生效。
- 区分可分发的声明式业务配置与受信任的 Cordis 部署配置：cordis.yml 支持可执行表达式，业务模板导入不得直接获得任意插件加载或代码执行能力。
- 导出不含凭据与不必要个人数据；导入后由部署者绑定本实例凭据与人员身份。
- 部署检查：独立目录、文件权限、应用身份、业务连接、模型配置、飞书事件与回调订阅、主动发送权限、接收目标可达性；单写入者保护、健康状态、失败投递查询、备份恢复与升级说明（升级后不因动作定义改变重新解释旧审批）。
- 如启用 PG：独立业务数据库访问权限；不为本部署路线实现共享租户 schema/RLS。
- 验收：部署两个独立实例验证互不混用，完成一次备份恢复后的未完成审批处理。

## 通用交付纪律（每 PR 验收）

缝三角色完整（仅在角色需独立演进时分包，不机械一角色一包）；注册即效应；品牌化 id；封闭联合 + `assertNever`；durable 边界全验（事件 JSON、转换校验、zod stateSchema），typed 边界信任 TS；可调项全走 Config；错配响亮；优先插件扩展点，确需修改 agent-loop 时另行论证并同步架构与双 SDK 验证；model-visible ⟺ logged；纯投影、状态迁移、恢复和并发路径分别验证；真实 Loader 组合 + 必要的 keyless 快照；新 Session 事件同 PR 更新声明、运行时识别、SDK 预期输出；Agent Note + 双语 README + i18n 配对；typecheck/lint/constraints + 受影响包单测；推送前 dsh-pre-push-checks；作者 octmoon。

## 执行顺序与里程碑

推荐执行顺序如下。模拟系统 A/B/C 是交付范围标识，不代表必须 A → B → C 串行实施；查询与审批验证的依赖为 A → C，H5 的 B 可并行或后补。本节统一规定主计划与模拟方案的实施依赖。

| 顺序 | 工作 | 依赖与完成条件 |
|---|---|---|
| 1 | 模拟 A、PR2 整改、PR0、PR1 收口及六项技术验证并行 | A 提供查询、Swagger、种子数据与故障控制；不等待 PR2 全部整改完毕才开始 |
| 2 | PR2 模拟级组合验收 | A 可用，相关整改完成；实际配置下完成 HTTP 查询 → 工具 → Session → 飞书展示及 keyless 快照验证 |
| 3 | 六项设计确定，PR3a 与模拟 C 并行 | 先固定写接口与恢复语义，再并行实现审批状态机、动作适配和模拟系统持久写入；PR3a 完成前联合验收 |
| 4 | PR3b | 完成所选飞书路径的 PR0 实测及 PR1 安全收口；结合已验收 PR2、PR3a 和模拟 C 完成两级审批闭环 |
| 5 | PR4 → PR5 → PR6 | 在已验证动作上扩展卡集、督办与独立实例配置交付 |
| 可并行 | 模拟 B（H5） | 依赖 A 的接口，不作为 C、PR2 或 PR3 的放行条件；Swagger 足以支持前期造数与检查 |

上表是推荐交付顺序，不把 PR2 全部飞书验收设为平台无关 PR3a 开发的硬前置。六项设计及必要技术验证完成后即可推进 PR3a；完整模拟级里程碑必须等 PR2 查询链路与 PR3b 飞书链路均通过。模拟 C 的接口实现可先用独立 HTTP 测试验证，不能因等待审批引擎而与 PR3a 互相阻塞。

| 阶段 | 放行条件 |
|---|---|
| PR3a 开始前 | 六项设计决策明确，忙碌裁决与合法写入可行、持久化确认接口经过必要技术验证；写动作对端与接口语义确定、授权规则和交付范围明确。不要求模拟 C 已全部实现，不将后续完整恢复验收提前当作开工条件 |
| PR3a 完成 | 状态机、合法写入归属、恢复及持久化故障测试通过；模拟 C 可用，最小动作消费端与提供端齐备，真实 HTTP 写入、版本冲突、幂等及结果查询验证通过 |
| PR3b 接入前 | 所选飞书路径的 PR0 实测和 PR1 身份/权限/非法点击处理收口通过；平台无关准备工作可提前进行 |
| PR3b 完成 | 双入口真实回调、主动发送、冷恢复及忙碌到期通过；结合已验收 PR2、PR3a 与模拟 C 完成模拟级完整里程碑 |
| PR4 至 PR6 | 在已验证动作上扩展卡集、督办与配置交付；两个独立实例通过隔离与备份恢复验收，真实厂商接入按真实级标准另行验收 |

PR2 为里程碑提供模拟报警查询输入，为 PR4 提供报警卡 Consumer；PR3 的写动作不等待 PR4。PR6 的实例隔离原则从第一阶段执行，配置导入和运维交付在能力稳定后完成。PR0 未采用路径的验证可延后至启用前，不能以模拟报警服务替代任何飞书平台验证。

首个完整里程碑分两级。**模拟级**（DSH 与模拟报警服务可运行于本机；飞书交互仍使用真实平台，模型回合仍需可用模型服务，不是完全离线验收）：一个独立实例接收任务，查询模拟报警源，按管理员规则发起绑定「确认告警」写动作的两级审批，经无权点击、重复点击和一次服务重启后仍正确完成；批准前不执行，批准后模拟系统产生可核对的状态或回执（`action-state`/`operations`），重复恢复不重复写入；结果通过飞书发送，并区分平台发送成功与用户接收状态。**真实级**（待目标告警系统确定后）：同一验收矩阵对真实系统重跑协议与业务验收。模拟级通过后即可扩大卡集类型和流程规模；真实级通过前不向租户承诺真实系统即插即用。

## 已实施内容回看整改清单（2026-09-16）

| 编号 | 位置 | 问题 | 整改 | 归属 |
|---|---|---|---|---|
| P1-1 | `packages/feishu/feishu/src/interaction.ts:248-252` | dispatch 先删 pending 后验 outcome；畸形点击（合法 interactionId + 无合法 verdict）吞掉 pending，瀑布悬挂直至请求中止 | 先验证（id/kind/outcome/操作者资格）后消费；非法点击返回错误 toast 且不动 pending | PR1 收口 |
| P1-2 | 同上 `dispatch` / `answerApproval` | 无决策人门禁，operatorOpenId 仅作展示，「能看到卡即可点」 | `interactionCards` Config 增加审批决策人策略，验证通过才消费（实施为 open_id/user_id 双允许列表，见 P1-7） | PR1 收口 |
| P1-3 | `packages/feishu/feishu/src/interaction-card.ts` | 卡片 config 未声明 `update_multi: true`，PATCH 刷新路径不可用 | 构建器补声明（PR0 实测确认后定稿） | PR1 收口（随 PR0 结论） |
| P1-4 | `packages/feishu/feishu/src/interaction.ts:50-74` | `parseCardAction` 未透出 `event.token` 与 `context.open_message_id`；toast.type 缺 `'warning'` | 扩展 wire 校验字段（延时更新与 PATCH 都需要）；`operator.user_id` 已作为 P1-7 随收口实施，本项剩余 `event.token`、`context.open_message_id` 与 `'warning'` | PR3b |
| P1-5 | `.agents/notes/implemented/architecture/2026-09-14-feishu-card-interactions.md:9`、`.zh.md:9` | `im.v1.card.update/batchUpdate` 命名笔误（实为 cardkit v1 `card.card.update/batch_update`） | 改正命名，实质结论不变 | PR1 收口 |
| P1-6 | 同 Note「Alternatives considered」段 | 漏记官方两条 1.0 可更新路径（延时更新 token、PATCH message），「callback 响应完全取代更新 API」表述过强 | 补记两条路径为 PR3b/PR4 设计输入 | PR1 收口 |
| P1-7 | `packages/feishu/feishu/src/{interaction,config}.ts` | 决策人门禁只能按 open_id 配置；部署方人员档案常以 user_id 管理 | `parseCardAction` 防御性透出 `operator.user_id`；`deciderUserIds` 与 `deciderOpenIds` 并列，任一命中即资格；`user_id` 是否真实随回调送达取决于应用权限范围，归 PR0 验证 | PR1 收口（2026-09-18 实施） |
| P2-1…P2-8 | `packages/integration/`、示例与锁文件（工作区未提交） | 见下「P2 整改明细」（已有测试与待补证据分别列明） | 按明细逐项整改；顺序 P2-1→4 → P2-5/6 → P2-7/8 | PR2 整改 |

### P2 整改明细（plan2.md 附录「PR2 工作区评审」裁定；实施会话的整改输入）

- **P2-1 示例整段覆盖 feishu 配置（成立，中）**。位置：`apps/cli/config/examples/alarm-query/cordis.yml:34-72`（feishu-bot patch 行；`:9-11` 注释已承认替换语义）。问题：patch 替换目标行整段 config，示例只复述了 feishu-bot 示例的 7 个字段——真实实例更低层设置的 `allowChatIds`、自有 `cardTemplates`、权限预设会被清掉；示例命令只加载本 patch，干净 profile 上 `feishu-bot` 行不存在（unmatched target）。整改：拆成「只挂三报警插件的能力 overlay」与「含飞书卡的完整组合示例」两份，后者明确要求部署者合并实例配置并给出完整前置配置。验收：带群白名单/只读权限/自有卡片的实例接入报警查询后原策略保留；干净 profile 按文档步骤获得完整飞书组合。
- **P2-2 带路径前缀的 baseUrl 拼接错误（成立，中）**。位置：`packages/integration/integration-alarm-http/src/provider.ts:174`（`new URL('alarms', baseUrl)`）；`{baseUrl}/alarms` 的声明另见 provider 模块头、`HttpAlarmProviderOptions.baseUrl`、`Config.baseUrl` 三处。问题：无尾斜杠的带路径 baseUrl 丢最后一段（`/api/v1` → `/api/alarms`），有尾斜杠则保留——同一配置语义随尾斜杠漂移，与文档不一致。整改：在 apply 的显式 resolve 步骤确定目录语义、统一尾部斜杠、校验协议（http/https），provider 只接已解析 URL。验收：根路径、带路径前缀、有无尾斜杠、非法协议配置均有用例；README 网关协议定位同步落定。
- **P2-3 凭据解析不受超时和取消约束（成立，中高）**。位置：`packages/integration/integration-alarm-http/src/provider.ts:148-151`（`await resolveToken()` 在 signal 建立后、try 外且不挂任何 signal）；`src/index.ts:120-129`（退避等待正常完成不移除 abort listener）。问题：远端凭据 Provider 挂起时 `timeoutMs` 与调用方取消均不生效，查询无限等待；退避监听器滞留累积。现有单测未暴露（mock 的 resolveToken 立即返回）。整改：凭据准备纳入完整超时/取消/错误处理（传递 signal 或显式有界等待并定义结果丢弃规则）；退避正常结束移除监听。验收：预先取消、凭据解析期间取消、凭据超时/解析失败均按约定结束；正常退避与取消都释放计时器与监听器。
- **P2-4 飞书卡片遗漏空结果与截断提示（成立，中）**。位置：`packages/integration/tool-integration-alarm/src/index.ts:157-166`（`alarmMarkdown` 只生成列表体，无计数头/截断注记/空态文案，零结果 = 空串）；`apps/cli/config/examples/alarm-query/cordis.yml:66-71`（模板只绑 `meta.markdown`）；对照 `packages/feishu/feishu/src/template.ts:144-146`（required 只拒 `undefined`，空串通过，空卡体照常渲染）。问题：截断时卡片无「展示 N / 总计 M」与截断提示，用户可能把局部结果当全部；meta 的 `total`/`truncated` 未被绑定（Web UI 的 `presentAlarmResult` 反而带 N of M，`tool .../index.ts:318-327`，唯独飞书卡缺信息）。整改：卡片呈现明确表达「暂无报警」「展示 N / 总计 M」「结果已截断，请缩小条件」（保持单一来源，不在两处各写一份）；空串与 required 的语义在飞书模板侧一并明确。验收：经真实模板变量解析与渲染路径验证（不能只验证工具文本）；空结果、截断、超 maxLength 三态均有用例。
- **P2-5 结果预算没有覆盖完整处理过程（成立，中高）**。位置：`packages/integration/integration-alarm-http/src/provider.ts:163`（`response.text()` 无字节上限，上游无视 limit 时先全量下载+解析再裁剪）；`tool-integration-alarm/src/index.ts:118-129`（`formatAlarmOutput`）与 `:282-299`（execute 返回值）不限单字段长度，超大 detail 全量进工具结果与会话日志；`:177-184`（30k 上限只保 meta，降级为 `{}` 不消除此前的下载/解析/字符串构造开销）；`:131-140` JSDoc「the durable log stays bounded」表述过度。整改：增加可配置的响应字节预算（Config），定义长字段与大结果的截断/拒绝/溢出保存策略；修正 JSDoc。验收：超大单条、超量返回、多字节文本、预算临界值用例；模型输出与卡片都能辨识结果是否完整。
- **P2-6 时间字段校验与鉴权模式需要明确（成立，低-中）**。位置：`packages/integration/integration-alarm/src/types.ts:31-32`（firedAt 声明 ISO-8601）vs `integration-alarm-http/src/provider.ts:92`（解码只查非空字符串）；`tool-integration-alarm/src/index.ts:67-77`（`Date.parse` 判 since/until，V8 接受大量非 ISO 形式）；`integration-alarm-http/src/index.ts:41-42, 98-105`（token 引用解析不到 → 匿名请求，与「Misconfiguration fails loud」原则相悖）；`provider.ts:77-81, 115-118`（未知字段一概拒绝）。整改：wire 边界与工具输入按声明的时间格式显式校验（ISO-8601 与区间语义）；显式区分匿名模式与必须鉴权模式（后者缺凭据响亮失败且不发出匿名请求）；未知字段拒绝定位为自有网关协议行为，README 不外推为第三方接入必要条件。验收：`not-a-date` 拒绝用例；必须鉴权模式缺凭据不发出请求；文档表述对齐。
- **P2-7 PR2 验收证据仍需补齐**。`http-alarm.spec.ts` 已有本地 HTTP 服务配合真实 fetch 的 24 项测试；现有 Loader 组合测试使用脚本化 Provider，不能替代实际 HTTP 与 CLI 示例的完整组合。待补：① 模拟报警源的真实 HTTP 协议验证；② 实际 CLI 示例配置组合验证；③ HTTP 结果经会话日志到飞书卡片的链路测试；④ alarm_query 的 keyless 录制会话快照。①②④ 以[本地模拟报警系统](local-http-alarm-provider-plan.md)交付 A 为验证载体（真实 HTTP 协议对端 + CLI 组合 + 快照录制，走真实网络路径）；③ 依赖飞书真实环境。模拟 A 必须先于本项最终验收完成，可与 PR2 整改并行建设。四项证据齐备后 PR2 的模拟级验收方视为完成；真实厂商协议验证另列为实际接入时的交付条件，不以本地模拟通过替代。keyless 快照与真实 HTTP 集成分别保留证据，不将快照回放等同于实时飞书验收，也不将已有 HTTP 测试误写为缺失或 mock fetch。
- **P2-8 提交范围与辅助改动（成立，低，随提交处理）**。位置：`pnpm-lock.yaml`（`@testing-library/dom` 10.4.1→10.4.2 等无关传递漂移）；未跟踪文件中的 `.zcode/plans/plan-sess_*.md`（会话临时文件）、`docs/subsystems/integration.*` 与再生成目录里的存量飞书内容。整改：保留报警能力必需的文档与目录更新，逐项确认其他辅助变更来源；无关依赖漂移独立提交或在 PR 说明中解释；会话临时文件不入库。验收：PR diff 只含报警能力相关改动 + 有来源说明的辅助改动。

## 参考依据

仓库：[飞书适配器](../../packages/feishu/feishu/src/lark.ts)、[交互桥](../../packages/feishu/feishu/src/interaction.ts)、[会话路由](../../packages/feishu/feishu/src/conversation.ts)、[schedule 行为](../../packages/schedule/schedule/README.md)、[schedule 投影](../../packages/schedule/schedule/src/projection.ts)、[schedule 运行时](../../packages/schedule/schedule/src/runtime.ts)、[jobs-local 限制](../../packages/jobs/jobs-local/README.md)、[Session 事件定义](../../packages/core/session/src/types.ts)、[compaction 实现](../../packages/compaction/compaction-basic/src/region.ts)、[PR1 Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-feishu-card-interactions.md)。

官方：[卡片回传交互回调](https://open.feishu.cn/document/feishu-cards/card-callback-communication?lang=zh-CN)、[延时更新消息卡片](https://open.feishu.cn/document/ukTMukTMukTM/uMDO1YjLzgTN24yM4UjN)、[更新应用发送的消息卡片（PATCH）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch)、[Node.js SDK 处理回调](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks?lang=zh-CN)、[全量更新卡片实体（cardkit，2.0-only）](https://open.feishu.cn/document/cardkit-v1/card/update?lang=zh-CN)。

对照草案：[plan2.md](plan2.md)（历史对照；PR1 合入 `feishu/wangyue` 与 UAT 通过沿用项目记录，本次未重新核验合入状态）。

写动作对端：[local-http-alarm-provider-plan.md](local-http-alarm-provider-plan.md)（本地模拟报警系统，`dev-fixtures/alarm-system/`；两级验收中模拟级的载体，阶段 A 亦为 P2-7 ①②④ 的验证载体）。
