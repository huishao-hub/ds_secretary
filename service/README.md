# AI-Secretary 本地时间规划引擎（service/）

桌面 AI 秘书的后端：本地 HTTP 服务 + SQLite 存储 + 提醒调度 + 确定性规划算法，
AI 可选接 DeepSeek，没有 Key 时完全本地运行。

- 运行时：Node **v24.16.0**，只用内置模块（`node:sqlite` / `node:http` / `node:crypto` / `node:fs` / `node:path` / `node:os`），**零 npm 依赖**。
- 契约：[`docs/API.md`](../docs/API.md) 是唯一契约；本文只讲实现与用法。
- 监听：仅 `127.0.0.1`，端口默认 `0`（系统分配），每次启动生成新 token。

---

## 1. 跑法

```powershell
# 默认：D:\AI-Secretary\data，日志写 D:\AI-Secretary\logs
node service/index.mjs

# 指定数据目录 / 端口
node service/index.mjs --data-dir D:\AI-Secretary\data --port 0

# 其它参数
node service/index.mjs --log-dir D:\AI-Secretary\logs --tick-ms 20000 --verbose
```

启动成功后写 `data\bridge.json`：

```json
{
  "port": 51234,
  "token": "64位hex",
  "pid": 1234,
  "startedAt": "2026-11-08T21:20:51",
  "version": "1.0.0"
}
```

调用示例：

```powershell
$b = Get-Content D:\AI-Secretary\data\bridge.json -Raw | ConvertFrom-Json
Invoke-RestMethod "http://127.0.0.1:$($b.port)/health"
Invoke-RestMethod "http://127.0.0.1:$($b.port)/settings" -Headers @{ Authorization = "Bearer $($b.token)" }
```

退出：`SIGINT` / `SIGTERM` 会停调度器、关 HTTP、关 DB、删除 `bridge.json`；
`process.on('exit')` 还有一层同步兜底。未捕获异常与未处理 rejection 只记日志，进程继续存活
（该服务被 DSH 托管，不能因为单个请求崩掉）。

### 作为库使用（测试用）

```js
import { createService } from './service/index.mjs';

const svc = await createService({ dataDir, port: 0, aiKey: null });
// svc.port / svc.token / svc.close()
await svc.close();
```

`createService` 还接受 `logDir`、`tickMs`、`aiTimeoutMs`、`aiEndpoint`（测试注入 mock 用）。

### AI Key

优先级：

1. 环境变量 `DEEPSEEK_API_KEY`
2. `service/config.local.json`（不提交到版本库）：

```json
{ "apiKey": "sk-..." }
```

Key 只用于请求头，**不写日志、不写 DB、不进 `/export`**。没有 Key 时 `/health` 的 `ai` 为 `"off"`，
所有 `/ai/*` 返回 `mode:"fallback"`，走本地确定性算法。

---

## 2. 模块职责

| 文件 | 职责 |
|---|---|
| `index.mjs` | 入口与生命周期：参数解析、DB/调度器/AI/HTTP 组装、`bridge.json`、优雅退出、进程级异常兜底、日志文件 |
| `db.mjs` | SQLite 建表/迁移（`PRAGMA journal_mode=WAL`、`foreign_keys=ON`、索引、`dedupeKey` 唯一索引）、语句缓存、事务、prefs 默认值、查询辅助 |
| `time.mjs` | 本地墙上时间、日期/时刻校验、ISO 周、季度、精度区间展开（`expandPrecision`）、重叠分钟数 |
| `model.mjs` | items 校验/实体化/CRUD、history、依赖环检测、proposals 应用、settings、export/import、待安排池查询 |
| `planner.mjs` | 5 天窗口（loadMin/freeSlots/冲突）、六类冲突检测、时间轴、确定性情景推演、待安排任务排期建议 |
| `reminders.mjs` | 提醒生成/去重/snooze/补发、water/rest/meal 调度、DND 延后、20 秒 tick 调度器 |
| `nlq.mjs` | 中文自然语言 → 结构化 ops 的确定性规则（年/季度/月/周/日/时段/重复/模糊词） |
| `ai.mjs` | DeepSeek 调用（15s 超时、JSON 校验、失败降级）、本地 fallback、上下文摘要、`/ai/plan` 建议 |
| `errors.mjs` | `ApiError(status, message, code)` |
| `http.mjs` | 路由、Bearer 鉴权、JSON 读写、错误映射、全部端点 |
| `../tests/test-service.mjs` | 端到端测试（真实起服务、真实 HTTP、真实 SQLite） |

### 关键设计

- **精度实体化**：`year/quarter/month/week` 的 `startDate/endDate` 一律由 `time.expandPrecision`
  从 `startDate` 重算；`unscheduled` 强制清空所有时间字段；`day` 没有时刻；`slot` 才有 `HH:mm`。
  年度目标绝不会变成"某一天某一刻"。
- **锁定**：`locked=1` 的项被 `source:'ai'` 修改返回 `409 {"error":"locked","code":"LOCKED"}`；
  `source:'user'` 允许；proposal accept 逐条跳过 locked 并在 `skipped:[{id,reason:"locked"}]` 报告。
- **依赖**：写入时 DFS 检测自环/成环（`DEP_SELF_LOOP` / `DEP_CYCLE`）；`/conflicts` 报 `dependency`。
- **提醒幂等**：`dedupeKey` 唯一索引 + `INSERT ... ON CONFLICT DO NOTHING`；
  done/cancelled 撤销 pending；重启补发 `fireAt<=now` 的 pending（>24h 的 `start` 作废并标 `catchup`），
  `/reminders/due` 取走即标 `fired`，不会重复弹。
- **snooze**：原提醒 `snoozed` + `snoozedTo`；新提醒 `repeatOf` 指向原 id、`snoozedTo`/`fireAt` 为新时间。
- **proposal**：`/ai/plan` 只写 `proposals(status=draft)`，不写 items；accept 才落地并写 `history(source:'ai')`。
- **确定性**：窗口、冲突、排期、推演全部是纯函数；`/ai/simulate` 不写库、不联网。

---

## 3. 测试

```powershell
node tests/test-service.mjs
```

- 用 `os.tmpdir()` 下的临时 dataDir，不污染 `D:\AI-Secretary\data`。
- 35 个用例，覆盖契约要求：精度区间、季度、slot 提醒与 dedupeKey、窗口 overlap、
  locked 409、proposal 跳过 locked、done 撤销提醒、重启持久化与补发、snooze、`/ai/parse` 两个中文例句、
  `/ai/plan` 不改 items、依赖成环、鉴权、`/export` 无密钥，以及 catch-up、simulate 纯计算、
  analyze/chat、create-from-text、focus/dnd、water/meal/rest 调度、proposal reject、delete 级联、
  timeline、tree、窗口上限、DeepSeek mock 成功与降级。
- 输出 `PASS/FAIL` 与汇总；退出码非 0 表示失败。
- 2026-11-08 全量运行结果：`35 passed, 0 failed, 35 total`。

---

## 4. 数据与日志

- DB：`<dataDir>\secretary.db`（WAL 模式，附带 `-wal`/`-shm`）。
- 桥接：`<dataDir>\bridge.json`（关闭时删除；异常退出可能残留，下次启动覆盖）。
- 日志：`<logDir>\service.log`，超过 5MB 轮转为 `service.log.1`；默认 logDir 为 dataDir 同级的 `logs`
  （CLI 显式传入 `D:\AI-Secretary\logs`）。
- 备份：`GET /export`（`replace`/`merge` 用 `POST /import`）。

---

## 5. 契约实现备注与扩展

以下为实现层补充，**没有修改 `docs/API.md` 已有契约内容**，详见文末追加的"实现备注"：

1. **依赖接口**：契约 §1.2 定义了 `dependencies` 表但 §2 没有路由，补了
   `GET /dependencies?itemId=`、`POST /dependencies`、`DELETE /dependencies/:id`（附加扩展）。
2. **source 传递**：`PATCH /items/:id` 从 `body.source` 或请求头 `X-Source` 读取，
   仅 `"ai"` 视为 AI 来源（会触发 locked 409），默认 `"user"`。
3. **bootEvents.sessionId**：为了"同一 `sessionId` 只 shouldGreet 一次"，表里加了 `sessionId`
   列与唯一索引（契约 §1.5 的字段列表未列，但 §2.7 的行为要求它）。
4. **`bridge.json.startedAt`** 按 §0 的 timestamp 约定不带偏移（示例里的 `+08:00` 未采用），
   `tz` 由 `/health` 单独返回。
5. **`phase` 的 id 前缀**复用 `p_`（契约只给了 `g_/p_/m_/t_` 四种前缀）。
6. **`/export`** 严格按契约列出的键：`version/exportedAt/items/dependencies/reminders/prefs/memory/history`；
   `proposals`、`bootEvents` 不在其中，`/import` 也不会清空它们。导出前递归剔除疑似密钥字段。
7. **`PATCH /settings`** 拒绝 `apiKey/secret/token/password` 类键（`SECRET_KEY_NOT_ALLOWED`）；
   未登记的普通键宽松接受（便于 App 先行加字段）。
8. **`/window` 的每日 items** 是"当天有实体安排（slot/day）或当天到期"的条目；
   年度/季度目标不会铺满每一天，它们在 `/timeline` 与 `/conflicts` 中体现。
9. **`no-execution`** 只针对 `quarter/month`（契约原文"季/月级计划"）；年度目标由 `stale-goal` 覆盖。
10. **`/ai/parse`** 忽略 `apply` 字段（契约要求只解析不写库）；`/ai/simulate` 不调用模型。

---

## 6. 已知限制（诚实清单）

1. **重复任务**：v1 schema 没有 recurrence 字段。`nlq` 会把"每天/每周/每月"解析成
   下一次发生日 + `tags:["repeat:daily"]` + notes 说明，**不会自动生成未来实例**；真正的重复排程需要 v2 schema。
2. **提醒展示**：服务只维护队列（`/reminders/due`），系统通知/桌宠气泡由 `app/` 端实现。
3. **休息计时**：依赖 `POST /focus` 的专注会话或"正在进行中的 slot 任务"；
   没有 OS 级键鼠活动检测，也没有检测全屏应用。DND 只支持手动开关与时间窗。
4. **单个自然语言时段的歧义**（如"两点到四点"没说是上午下午）会反问，不生成 slot；
   只给开始时间（如"明天下午 3 点开会"）时按 `day` 落库并反问时长，不猜结束时间。
5. **AI api 模式**：需要真实 `DEEPSEEK_API_KEY` 才能对真实服务验收；本仓库测试用本地 mock
   验证了请求格式、JSON 校验、超时/拒绝时的降级路径（未对外网发真实模型请求）。
6. **并发**：单进程、单 SQLite 连接模型，不适合多个服务实例同时写同一个 dataDir。
7. **`/import replace`** 只重建契约列出的六张表；`proposals` 与 `bootEvents` 保留。
8. **喝水**冷启动不立即提醒（先建立 120 分钟锚点）；午饭/晚饭只有 45 分钟补提醒窗口。
9. **长期目标 stale-goal** 以 `updatedAt`/history 的最近活动时间为准，30 天无进展才报；
   若用户只改备注也会被算作"有活动"。
10. **时间基准**：所有日期时间按运行机器的本地墙上时间处理，`tz` 固定上报
    `Asia/Shanghai`；机器时区若不在东八区，需要由部署方保证。
