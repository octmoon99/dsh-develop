# 本地模拟报警系统

[English](README.md) | 中文

这个 FastAPI 进程提供 [`@deepseek-ai/dsh-integration-alarm-http`](../../packages/integration/integration-alarm-http/README.zh.md) 所读取的严格 REST 响应。它把报警保存在内存中，以 `normal` 场景启动，并提供带认证的管理接口来准备本地数据和注入有界故障。它是开发测试夹具，不是生产报警服务，也不保存 DSH 审批状态。

## 前置条件

使用 Python 3.12 或更高版本以及 [`requirements.txt`](requirements.txt) 和 [`requirements-dev.txt`](requirements-dev.txt) 中的版本。本地 Conda 环境 `cmenv` 已包含这些依赖；以下命令直接使用该环境，不创建新环境。

启动前设置两个不同的本地 Bearer token。DSH 只取得查询 token；管理 token 可以替换夹具数据和配置故障。

```sh
export ALARM_MOCK_READ_TOKEN=local-read-token
export ALARM_MOCK_ADMIN_TOKEN=local-admin-token
conda run -n cmenv python -m uvicorn alarm_mock.app:app --app-dir dev-fixtures/alarm-system --host 127.0.0.1 --port 18080 --workers 1
```

任一 token 缺失、为空、首尾含空白或两者相同时，进程在启动时失败。该命令只监听回环地址。状态保存在进程内，因此只使用一个 worker。

无需认证即可通过 `GET /healthz` 检查就绪状态；Swagger 位于 `http://127.0.0.1:18080/docs`。Swagger 同一时间只保存一个 Bearer 值，请根据调用的是查询接口还是管理接口切换 token。

## 查询协议

`GET /alarms` 要求查询 token，接受可选的 `severity`、`status`、`source`、`keyword`、`since`、`until` 和 `limit` 参数。`severity` 为 `critical|high|medium|low`；`status` 为 `firing|acknowledged|resolved`；`limit` 默认为 20，范围为 1–200。时间过滤器必须是带时区的 ISO-8601 日期时间，包含 `since` 下界且不包含 `until` 上界。所有过滤器取交集。结果按 `firedAt` 降序、再按 `id` 升序排列；`total` 统计 `limit` 截断前的匹配数量。

```sh
curl -H 'Authorization: Bearer local-read-token' 'http://127.0.0.1:18080/alarms?status=firing&limit=20'
```

响应顶层只有 `total` 和 `alarms`。每条报警必须包含 `id`、`title`、`severity`、`status` 和 `firedAt`；`source`、`acknowledgedAt`、`resolvedAt` 和 `detail` 为可选字段，缺失时省略。这个精确字段集合使 DSH HTTP Provider 能拒绝协议漂移，而不是静默丢弃字段。

## 管理接口

管理接口要求管理 token。

- `POST /_admin/alarms` 插入一条严格校验的报警；`id` 重复时返回 `409`。
- `POST /_admin/reset` 原子切换到 `normal`、`empty`、`many` 或 `long-detail`，并清除故障。可选的 `anchor` 使生成时间可重放；省略时使用当前时间。
- `PUT /_admin/faults` 选择 `none`、单次 `next-503` 或持久 `delay`；延迟模式的 `delayMs` 范围为 1 到 5000。故障只影响 `/alarms`。

```sh
curl -X POST -H 'Authorization: Bearer local-admin-token' -H 'Content-Type: application/json' -d '{"scenario":"many"}' http://127.0.0.1:18080/_admin/reset
```

进程重启后所有状态消失。该夹具不包含 H5 页面、数据库、报警确认动作、调度器、webhook 或飞书自动通知。

## 连接 DSH

把现有报警查询组合指向 `http://127.0.0.1:18080/`，保持 `auth: bearer`，并让 `DSH_ALARM_API_TOKEN` 解析为与 `ALARM_MOCK_READ_TOKEN` 相同的值。仅挂载能力的 overlay 位于 [`apps/cli/config/examples/alarm-query/cordis.yml`](../../apps/cli/config/examples/alarm-query/cordis.yml)；完整飞书组合示例位于 [`apps/cli/config/examples/alarm-query-feishu/cordis.yml`](../../apps/cli/config/examples/alarm-query-feishu/cordis.yml)。

本阶段验证查询与回复链路：在本地创建或复位报警，从飞书发起查询，让 Agent 调用 `alarm_query`，然后检查返回卡片和 Session 事件。报警产生后主动通知需要独立的持久事件和出站投递路径；该夹具不会通过直接调用飞书来绕过 DSH。

## 测试

在准备好的环境中运行夹具测试：

```sh
conda run -n cmenv python -m pytest dev-fixtures/alarm-system/tests
```

测试向隔离的应用实例传入显式 token 和固定时钟，不修改进程环境。真实网络用例原子申请临时回环端口，等待 `/healthz` 就绪，并在清理时等待 Uvicorn 完全停止。

从仓库根目录运行无密钥的组装会话场景：

```sh
pnpm run test:snapshot -t 'replays alarm-query through dsh --profile headless'
```

该场景通过随附的 headless profile 启动告警 seam、HTTP 提供方与面向模型的工具。回放模型的调用仍穿过操作系统分配端口上的真实 HTTP 监听器，提交的会话记录工具调用、限界后的结果、呈现元数据与最终模型轮次。这项确定性检查不能替代真实飞书平台上的手工 UAT，也不能替代目标告警厂商的协议认证。
