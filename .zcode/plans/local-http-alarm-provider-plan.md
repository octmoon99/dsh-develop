# 本地 HTTP 模拟报警系统实施计划

> 状态：阶段 A 的最小首版已实施，并已完成本地协议测试、DSH 查询链路与负责人手工飞书 UAT；阶段 B/C 尚未实施。本文保留后续扩展方法、接口与验收范围。面向当前每租户独立应用、实例、凭据和数据目录的部署路线；关联主计划见 [plan.md](plan.md)。

## 1. 目标与首版范围

在本机启动一个独立的模拟报警服务，让现有 integration-alarm-http Provider 经真实 HTTP 查询。先证明查询、过滤、截断、错误处理和飞书展示能够协作，再为 PR3 的审批后写入提供可控制的外部系统。

首个交付只需接口、Swagger、固定种子数据和可重置的内存状态；不等待 H5、不建设数据库平台、不接真实厂商。第二个交付增加单页 H5；第三个交付按审批进度增加持久状态与确认报警接口。模拟系统只保存报警状态，不保存 DSH 的审批权威状态。

本地模拟通过只能证明自定义网关协议下的集成；真实厂商字段、认证、限流、幂等和飞书平台行为仍按主计划单独验收。

## 2. 架构与技术选择

```text
Swagger / H5 ──测试管理接口──> 本地模拟服务：数据、查询、统计、故障控制
                                  ↑ 真实 HTTP
飞书 → DSH Agent → alarm_query → integration-alarm-http
                                  ↓
                         工具结果、Session 日志、飞书卡片
```

建议用 Python FastAPI + Uvicorn 实现外部模拟服务，使用独立虚拟环境和锁定依赖；首版无需 React、前端构建链、Redis、PostgreSQL 或 Docker。FastAPI 根据路由与模型生成 OpenAPI，并提供交互文档，适合先用 Swagger 调接口造数据。参见 [FastAPI 官方入门](https://fastapi.tiangolo.com/tutorial/first-steps/)。

这是独立的外部系统测试夹具，不属于 DSH Python SDK/runtime，不调用 Agent，也不增加独立 Node 应用入口。DSH 仍通过受支持的 dsh profile 启动；不要给正式业务包添加 demo bin 或 SDK argv 启动逃逸。若后续改成仓库内 Node 应用，必须重新按应用启动规则设计。

建议未来实现目录为 `dev-fixtures/alarm-system/`，与正式 `packages/integration/` 分离。目录为拟新增位置，实施时检查上级规则并补必要说明；不将实现放进 apps/cli。apps/cli 最多提供配置组合示例。

```text
 dev-fixtures/alarm-system/
   README.md                 安装、启动、复位和验收步骤
   requirements.in           最小运行依赖声明
   requirements.lock         实施时生成并锁定依赖
   requirements-dev.lock     测试依赖
   alarm_mock/
     app.py                  HTTP 入口、配置与生命周期
     models.py               请求、响应和枚举
     store.py                内存状态；后续 SQLite 实现
     scenarios.py            种子场景与受控故障
     static/index.html       第二阶段的单页 H5
   tests/                    协议、过滤、故障和后续写入测试
```

锁定文件的生成命令、Python 版本与安装步骤由实施者在本机验证后写进 README。不把未验证的依赖版本填成“已支持”。虚拟环境、运行数据、日志不提交。

## 3. 与当前 Provider 对齐的查询协议

协议依据为 [HTTP Provider 源码](../../packages/integration/integration-alarm-http/src/provider.ts) 与 [报警类型](../../packages/integration/integration-alarm/src/types.ts)。实施开始时重新核对这些文件，防止工作区后续修改导致计划过期。

### 3.1 路径、过滤和排序

业务查询接口固定为 `GET /alarms`，默认开发地址拟设 `http://127.0.0.1:18080/`。端口通过启动参数配置；占用时明确失败，避免悄悄换端口使 Provider 连错服务。

| 参数 | 模拟服务约定 |
|---|---|
| severity | critical / high / medium / low，单值精确匹配 |
| status | firing / acknowledged / resolved，单值精确匹配 |
| source | 单值精确匹配 |
| keyword | 在 title 与 detail 中做不区分大小写的子串匹配 |
| since | 按 firedAt 过滤，包含下界 |
| until | 按 firedAt 过滤，不包含上界 |
| limit | 正整数；拟默认 20、最大 200，服务配置可调；越界明确拒绝 |

过滤条件取交集；时间要求带时区的 ISO-8601，统一转为 UTC 比较；since 不小于 until 时返回 422。排序拟采用 firedAt 降序、同时间按 id 升序，保证重复查询稳定。total 是过滤后、limit 裁剪前数量。当前 Provider 没有 offset/cursor，不在本阶段承诺分页；限制条数与分页不是同一能力。

### 3.2 响应示例

```json
{
  "total": 1,
  "alarms": [
    {
      "id": "demo-alarm-001",
      "title": "演示数据库连接失败",
      "severity": "critical",
      "status": "firing",
      "source": "demo-database",
      "firedAt": "2026-09-17T02:00:00Z",
      "detail": "本地合成数据，用于验证查询和审批"
    }
  ]
}
```

顶层仅返回 total、alarms；单条必填 id、title、severity、status、firedAt，可选 source、acknowledgedAt、resolvedAt、detail。可选字段缺失时省略，不返回 null。当前解码器拒绝未知字段，因此不要在此响应加入 code、message、data、version 或 truncated；truncated 由 Provider 根据数量派生。内部版本与管理信息通过管理或操作查询接口返回。

空结果必须是 `{"total":0,"alarms":[]}`；截断场景可返回 total=50 和 20 条 alarms。测试用畸形响应仅通过显式故障开关产生，不能污染正常序列化。

### 3.3 认证与运行限制

首版使用可配置的本地演示 Bearer token，查询 token 与管理 token 分离；DSH 只取得查询 token。测试环境可显式开启匿名查询，不能把缺少必需 token 自动降级为匿名。管理接口始终校验管理 token；H5 从用户输入获取并仅保存在页面内存，Swagger 支持输入对应认证信息，不将密钥写入页面源码或 URL。

默认监听 127.0.0.1，仅用于开发；限制请求体、批量造数数量和故障响应大小。H5 与接口同源，无需开放任意来源 CORS。管理写请求要求 JSON、有效管理 token，并拒绝不匹配的浏览器 Origin；命令行请求可无 Origin。

## 4. 模拟管理接口与数据场景

这些是拟实现的测试接口，不是现有 alarm_query 的能力，也不注册成模型工具。

| 接口 | 用途与主要输入 |
|---|---|
| GET /healthz | 服务就绪、存储模式；不返回凭据 |
| GET /docs、GET /openapi.json | Swagger 与机器可读接口定义 |
| POST /_admin/alarms | 创建一条指定字段报警；ID 冲突返回 409 |
| POST /_admin/generate | 输入 count、seed、时间锚点，生成可重放批次 |
| POST /_admin/reset | 输入场景名，原子替换演示数据并清空故障及请求记录 |
| GET /_admin/stats | 全量状态/级别数量及最后变更时间；标明统计范围 |
| PUT /_admin/faults | 设置故障模式、参数与剩余触发次数 |
| GET /_admin/requests | 最近有界请求记录：路径、状态码、耗时、请求 ID |

`reset` 与批量操作和查询之间要有一致的状态可见性，不返回半批数据。内存模式单进程、单 worker；使用短临界区保护状态，延迟故障在锁外等待。重启恢复种子，不宣称内存数据持久。

预置场景：normal（12 条，四级严重性与三种状态均覆盖）、empty、many（50 条）、long-detail（可配置长字段）、unicode（中文及多字节字符）。普通演示的时间以显式重置时的 UTC 时间为锚点；自动化测试使用固定时钟与 seed，避免“最近一小时”随日期失效。reset 返回实际时间锚点供验证。

故障模式：前 N 次 503、持续 401、429、响应延迟、非法 JSON、未知字段、非法枚举、total 小于列表长度、受限的大响应。只影响 /alarms，不能让故障开关阻塞 healthz 或管理复位；模式互斥，重置立即恢复正常。请求记录不得保存 Authorization，容量和响应大小有配置上限。断连/丢回执属于后续写入恢复测试，不是首版必需。

## 5. 实施步骤与接入方法

### 阶段 A：接口与 Swagger，先验查询

1. 创建独立夹具目录、虚拟环境和依赖锁；用 FastAPI 明确响应模型，关闭会导致可选字段输出 null 的序列化方式。
2. 实现内存 store、种子场景、GET /alarms、健康检查及新增/生成/复位接口；启动时校验配置，通过生命周期管理初始化与清理资源。
3. 打开 Swagger，先复位 normal，查询全部，再按状态、严重性、时间及数量过滤，检查 total 与列表。
4. 实现有限故障模式与请求记录，验证 Provider 的真实 HTTP 重试、取消和超时。
5. 新建仅挂载三报警插件的本地 overlay，加载现有受支持 profile；验证工具输出与 Session 日志，再接飞书卡片。

未来 README 的启动命令草案如下；目录与锁文件尚未实现，本次未执行，实施者必须原样试跑后才将其作为已验证指引：

```sh
cd dev-fixtures/alarm-system
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m uvicorn alarm_mock.app:app --host 127.0.0.1 --port 18080 --workers 1
```

启动前通过本地环境设置 `ALARM_MOCK_READ_TOKEN` 和 `ALARM_MOCK_ADMIN_TOKEN`；模拟服务必须明确拒绝缺失的必需配置。示例不包含实际 token，不依赖生产凭据。

Provider 配置应保持当前支持字段，拟采用以下值；这是插件 config 片段，不是完整可运行的 Cordis 文档：

```yaml
baseUrl: http://127.0.0.1:18080/
tokenEnv: DSH_ALARM_API_TOKEN
timeoutMs: 1500
retries: 1
retryBaseDelayMs: 100
```

将 DSH_ALARM_API_TOKEN 对应的 credential 设为模拟服务查询 token；按实际 profile 的 credentials Provider 绑定，不假定所有启动方式均读取 shell 环境。工具 timeoutMs 需大于多次 HTTP 尝试与退避的总预算，拟设 5000；凭据准备仍须单独验证主计划中的取消/超时问题。

[现有示例](../../apps/cli/config/examples/alarm-query/cordis.yml) 同时挂载报警插件并替换 feishu-bot 整段配置。不能为方便本地测试直接覆盖用户现有白名单、模板与权限：仅挂能力的 overlay 与飞书完整组合样例分开；飞书入口沿用实际 profile 的配置，保留其访问策略。最终 dsh 启动命令由实施者根据真实 profile 与 Loader 实测补入 README，不照抄未经验证的组合命令。

本地根路径 URL 避开当前 `new URL('alarms', baseUrl)` 对无尾斜杠路径前缀的歧义；不因此宣称主计划 P2-2 已修复。另设带路径前缀用例用于 Provider 整改验证。

### 阶段 B：单页 H5，便于展示与造数

增加同源 `/` 页面，使用原生 HTML/CSS/JavaScript，暂不引入前端工程。页面显示“本地模拟报警系统”与内存/持久模式；提供状态/级别统计、报警列表、条件查询、生成一条、批量生成、选择场景复位、故障开关和最近请求。

默认手动刷新，可开启可配置的低频刷新；统计基于全量数据、列表基于当前过滤和 limit，分别显示，避免把当前页数量当作总数。列表说明“展示 N / 匹配 M”，空数据与请求错误分开呈现。复位前显示即将删除的模拟数据范围；文本用 textContent 等安全方式呈现，不插入来自 detail 的原始 HTML。页面文案集中管理；若复用仓库 Client UI，遵守其 typed locale 规则。

首版不做大屏、图表库、用户系统、WebSocket 或定时推送。Swagger 已能完成全部造数工作，H5 不阻塞接口验收。Swagger 静态资源若依赖外部网络，README 标明；需要断网演示时再本地托管相关资源，不能默认宣称完全离线。

### 阶段 C：为 PR3 增加确认报警与持久恢复

在查询稳定后，增加 SQLite 存储与受控写接口，仍作为外部模拟系统。数据库路径显式配置，每个模拟实例独立目录；仅首次初始化种子，正常重启不重置。演示复位显式清除报警与操作记录，只用于隔离测试场景。

拟新增 `POST /alarms/{id}/acknowledge`、`GET /alarms/{id}/action-state` 与 `GET /operations/{operationId}`。action-state 提供对象版本等执行前信息；写请求携带 expectedVersion、操作 ID/幂等键与备注，使用独立写入凭据。SQLite 同一事务保存报警变更和操作结果，HTTP 成功只在事务提交后返回。

相同幂等键及相同动作、对象、参数返回首次结果；相同键配不同输入返回 409；版本不匹配也返回 409。只有 firing 可首次确认；resolved 不允许确认，已确认对象不新增业务变更。内部版本不加入 /alarms 的既有查询响应。故障用例覆盖提交后丢回执，恢复方通过操作查询判定，不盲目重复写入。

现有 alarm_query 只读，不会因模拟服务新增接口自动获得写能力。PR3 仍需最小动作 Definition/Consumer/Provider、可信审批规则、参数绑定、权限检查和持久意图；模拟接口不得直接信任模型传来的 approved=true，也不把测试管理 token 交给 Agent。H5 管理操作标注“测试操作”，不能用手动改状态冒充审批链路通过。

该阶段证明“审批后确实产生外部写入”机制，但只属于本地模拟验收，不满足主计划要求的真实业务系统最终验收。

## 6. 网络部署与“推送”的含义

| 运行位置 | 接入方式 |
|---|---|
| DSH 与模拟服务同一主机 | 使用 127.0.0.1:18080 |
| DSH 在容器，服务在宿主机 | 按运行环境配置宿主机可达地址；容器内 localhost 不是宿主机，不能直接照抄本机 URL |
| DSH 在远程服务器 | 将模拟服务部署在该测试服务器或配置受控隧道；远程进程不能访问笔记本的 localhost |

默认优先两个进程都在本机。若跨主机访问，再明确监听地址、测试网络访问限制和认证，不把管理接口公开到互联网。飞书 WebSocket 模式下 DSH 从本机向外连接，模拟报警查询不要求飞书直接访问本机；若使用飞书 HTTP 回调，其公网可达性属于另一条入口。

H5 或 Swagger 的“生成报警”是写入模拟系统，之后由 Agent 查询；不是主动向飞书推送。首次交付用“生成”按钮命名。新增报警后自动通知需另行接 webhook ingress 或定时轮询，并实现去重、持久受理及通知策略，不纳入本计划首版。

## 7. 验收矩阵与证据

| 层次 | 验证内容 | 通过证据 |
|---|---|---|
| 无模型协议验证 | normal/empty、过滤交集、时间上下界、limit/total、认证失败、错误输入 | 自动化结果与对应 HTTP 响应 |
| 真实 Provider 集成 | 真实监听端口，通过 HttpAlarmProvider 发请求；503 重试、401 不重试、超时、取消、解码失败 | Provider 结果、脱敏请求记录与次数 |
| 配置组合 | 实际 profile/overlay 能加载；保留飞书白名单和权限；凭据解析一致 | Loader 验证与已执行启动步骤 |
| 模型工具链 | Agent 调用 alarm_query，结果可从 Session 重建 | 工具事件与 keyless 录制会话快照 |
| 飞书端到端 | 正常、空结果、截断、大字段、服务失败均有可辨识输出 | 真实飞书结果及对应 Session/请求 ID |
| H5（阶段 B） | 造数后统计、列表和查询一致；故障可复位；文案不混淆推送与生成 | 浏览器操作证据；GUI PR 按仓库要求附真实流程 GIF |
| 审批写入（阶段 C） | 未批准无写入、通过后变更、重复回调、重启、丢回执可查 | 审批日志、操作结果、外部状态及事务测试 |

CI 使用动态端口、独立临时目录和实例级状态，等待真实就绪信号，不用固定 sleep；测试负责关闭连接、服务与子进程，不遗留后台服务。故障计数属于每个测试实例，避免并发互相影响。外部 HTTP 集成测试必须运行真正网络路径，不能仅用 FastAPI TestClient 代替；服务内部测试可使用 TestClient。

先运行针对夹具和受影响 Provider 的检查；必要的 Python/HTTP 测试需接入可执行的仓库检查入口或明确单独命令，不能写了测试却从不运行。只宣称已执行的检查通过，修改正式能力时按主计划补 Agent Note、README 与相应快照。

## 8. 实施边界与交付顺序

交付 A：Swagger + 内存数据 + 查询/管理接口 + 故障控制 + 独立配置与真实 Provider 验证。完成后即可用于 PR2 初步集成测试，先无模型，再接 Agent 和飞书。

交付 B：单页 H5。复用同一接口与数据，不复制后端过滤或业务状态逻辑。

交付 C：SQLite + 业务确认 + 幂等结果查询，跟随 PR3 动作实现。写入能力不得早于审批与权限路径验证投入 Agent 使用。

本任务实施时不顺便修复所有 PR2 问题；遇到已知缺陷，记录它在空卡、超时、URL 或结果预算上的影响，并归回主计划相应整改项。不得通过模拟服务特判伪造“全部通过”。切换真实系统时保留能力接口与查询 Consumer，调整配置或新增厂商 Provider，逐项重跑协议与真实业务验收。

## 9. 依据与实施记录要求

仓库依据：[Provider 配置](../../packages/integration/integration-alarm-http/src/index.ts)、[查询协议实现](../../packages/integration/integration-alarm-http/src/provider.ts)、[类型与时间语义](../../packages/integration/integration-alarm/src/types.ts)、[现有组合示例](../../apps/cli/config/examples/alarm-query/cordis.yml)、[主计划](plan.md)、[架构与应用启动规则](../../docs/architecture.md)。

框架依据：[FastAPI OpenAPI 与 Swagger](https://fastapi.tiangolo.com/tutorial/first-steps/)、[生命周期管理](https://fastapi.tiangolo.com/advanced/events/)、[生命周期测试](https://fastapi.tiangolo.com/advanced/testing-events/)。这些资料用于选型；框架功能存在不代表仓库内实现已经通过验证。

实施记录需列出实际依赖版本、存储模式、执行命令、失败与修复、通过的验收项以及未执行项。本次计划编写只核对源码和官方资料，未安装依赖、启动服务、修改 Provider 或调用飞书。
