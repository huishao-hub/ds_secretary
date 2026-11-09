# AI-Secretary 本地服务 API 契约（v1）

本文件是**唯一契约**：规划引擎服务（`service/`）实现它，桌宠与规划中心（`app/`）只按它调用。
任何一方要改接口，先改本文件。

## 0. 运行方式

- 进程：`node service/index.mjs`，只监听 `127.0.0.1`，端口 `0`（由系统分配）。
- 启动后写 `D:\AI-Secretary\data\bridge.json`：

```json
{ "port": 51234, "token": "64位hex", "pid": 1234, "startedAt": "2026-11-08T21:10:00+08:00", "version": "1.0.0" }
```

- 除 `GET /health` 外，所有请求必须带 `Authorization: Bearer <token>`，否则 `401 {"error":"unauthorized"}`。
- 请求/响应均为 `application/json; charset=utf-8`。
- 时间约定：**所有日期时间一律本地墙上时间**，日期 `YYYY-MM-DD`，时刻 `HH:mm`，
  时间戳 `YYYY-MM-DDTHH:mm:ss`（不带时区偏移）；时区单独用 `tz` 字段（IANA，如 `Asia/Shanghai`）传递。
  这样能避免 DST 与跨时区把"模糊计划"错误换算成某一瞬间。
- 错误：`4xx/5xx` 返回 `{ "error": "message", "code": "OPTIONAL_CODE" }`。

## 1. 数据模型

### 1.1 `items`（统一节点：目标/项目/阶段/里程碑/任务/计划）

不强制层级，用户可以直接建一条三年后的里程碑，也可以只建明天下午两小时的任务。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `g_xxx` / `p_xxx` / `m_xxx` / `t_xxx`，按 kind 前缀 |
| `kind` | enum | `goal` `project` `phase` `milestone` `task` |
| `title` | string | 必填，≤120 字 |
| `notes` | string | 说明，≤2000 字 |
| `parentId` | string\|null | 父子关系；父不能是 `task` |
| `status` | enum | `idea` `planned` `active` `done` `cancelled` `paused`，默认 `planned` |
| `progress` | int 0–100 | 完成进度 |
| `precision` | enum | `year` `quarter` `month` `week` `day` `slot` `unscheduled` |
| `startDate` | `YYYY-MM-DD`\|null | 模糊区间的**开始** |
| `endDate` | `YYYY-MM-DD`\|null | 模糊区间的**结束**（year/quarter/month/week 的区间终点） |
| `startTime` | `HH:mm`\|null | 仅 `slot` 精度有 |
| `endTime` | `HH:mm`\|null | 仅 `slot` 精度有 |
| `dueDate` | `YYYY-MM-DD`\|null | 截止期限（可与 start 区间不同） |
| `fuzzyLabel` | string\|null | 用户原话的时间描述，如"六月中旬" |
| `locked` | 0\|1 | 用户锁定：AI 与自动化不得改动 |
| `priority` | int 0–4 | 0=最低 4=最高，默认 2 |
| `color` | string\|null | `#RRGGBB` |
| `tags` | string[] | |
| `source` | enum | `user` `ai` `import` |
| `createdAt` `updatedAt` | timestamp | |
| `completedAt` | timestamp\|null | 真实完成时刻 |

**精度语义（重要）**

- `year`：区间为该年 1/1–12/31；`quarter`：`Q1 1/1–3/31`…（`fuzzyLabel` 建议写 `2027 Q2`）；
- `month`：整月；`week`：ISO 周一到周日，`startDate` 为该周周一；
- `day`：当天，无具体时刻；
- `slot`：当天 + `startTime`/`endTime`，真正可提醒；
- `unscheduled`：**没有时间**，只在"待安排计划池"里，禁止推断成任何日期。

`quarter` 额外用 `fuzzyLabel` 记录季度号，服务端由 `startDate` 反推季度（1–4 月=Q1）。

### 1.2 `dependencies`

`{ id, fromId, toId, type }`，`type` 固定 `finish-to-start`（v1）。`fromId` 完成后 `toId` 才能开始。
禁止自环与成环（写入时校验）。

### 1.3 `reminders`

| 字段 | 说明 |
|---|---|
| `id` | `r_xxx` |
| `itemId` | 关联 items.id，可为 null（独立提醒，如喝水/休息） |
| `kind` | `start` `end` `due` `water` `rest` `meal` `custom` `boot` |
| `title` | 通知标题 |
| `body` | 通知正文 |
| `fireAt` | 本地时间戳 `YYYY-MM-DDTHH:mm:ss` |
| `status` | `pending` `fired` `acked` `snoozed` `dismissed` `cancelled` `done` |
| `firedAt` | 首次真正弹出的时间 |
| `snoozedTo` | 推迟到 |
| `repeatOf` | 因 snooze 生成的提醒指向原提醒 id |
| `dedupeKey` | 去重键，唯一索引。如 `item:t_123:start:2026-11-09`、`water:2026-11-09T14:00` |

**去重与幂等**：`dedupeKey` 唯一；同一 `dedupeKey` 永不二次入队。
任务被 `cancelled`/`done` 后其 pending 提醒立即 `cancelled`；已完成任务不再产生 `start` 提醒。

### 1.4 `proposals`（AI 建议，未确认前绝不落库为正式计划）

`{ id, kind, title, summary, ops:[...], payload, status:draft|accepted|rejected|expired, createdAt, expiresAt }`

`ops` 元素：
```json
{ "op":"create", "item": { "kind":"task", "title":"…", "precision":"slot",
  "startDate":"2026-11-09","startTime":"14:00","endTime":"16:00" } }
{ "op":"update", "id":"t_123", "patch": { "startDate":"…", "startTime":"…" } }
{ "op":"delete", "id":"t_123" }
```
`accept` 时逐条应用，写 `history`（`source:'ai'`），**遇到 `locked=1` 的 item 直接跳过并在结果里报告**。

### 1.5 其他表

- `history`：`{ id, itemId, at, action, before, after, source }`，每次写操作一条。
- `prefs`：`{ key, value }`，键见 §5。
- `memory`：`{ id, kind:preference|routine|impression, text, confidence, source, createdAt, expiresAt }`。
- `bootEvents`：`{ id, kind:login|service_start|resume, at, greeted, snoozeUntil, action }`。
- `focus`：`{ active, startedAt, plannedEndAt, note }`（存 prefs）。

## 2. 接口

### 2.1 基础

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ ok, version, dbPath, ai:"api"\|"off", now, tz, uptimeSec }`（免鉴权） |
| GET | `/state` | `{ now, tz, focus, dnd:{active,until,reason}, ai:{mode,model}, boot:{id,at,greeted} }` |
| GET | `/stats` | `{ items, reminders:{pending,fired}, dbBytes, rssBytes }` |
| GET | `/export` | 全量 JSON 备份 `{ version, exportedAt, items, dependencies, reminders, prefs, memory, history }` |
| POST | `/import` | body 同上，`mode:"replace"\|"merge"` |

### 2.2 计划项

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/items` | 查询，参数 `kind,status,q,from,to,parentId,locked,unscheduled=1,limit` → `{ items:[…], total }` |
| GET | `/items/:id` | 单个（含 `children`, `deps`, `reminders`） |
| POST | `/items` | 创建，返回完整 item；若 `precision:"slot"` 且时间合法，**同步生成 start/end 提醒** |
| PATCH | `/items/:id` | 局部更新；`locked` 项被 AI 来源修改时返回 `409 {error:"locked"}`（`source:'user'` 允许） |
| DELETE | `/items/:id` | 级联子项（子项 `parentId` 置 null，不删）与提醒 `cancelled` |
| POST | `/items/:id/progress` | `{ progress, status }`，`done` 时写 `completedAt`，取消 pending start 提醒 |
| POST | `/items/:id/lock` | `{ locked:true\|false }` |
| GET | `/tree` | 层级树 `{ nodes:[{item, children:[…]}] }`，用于左侧栏 |

### 2.3 时间窗口与冲突

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/window?days=5&from=YYYY-MM-DD` | 近期精细窗口：`{ days:[{date,weekday,items:[…],loadMin,freeSlots:[{start,end,min}],conflicts:[…]}], unscheduledCandidates:[…], summary:{totalMin,busyDays,tightestDay} }` |
| GET | `/conflicts` | `{ conflicts:[{ id, type, severity, itemIds, message, suggestion }] }`，`type`：`overlap` `due-risk` `dependency` `overload` `stale-goal` `no-execution` |
| GET | `/timeline?from=&to=&scale=year\|quarter\|month\|week\|day` | 时间轴渲染数据：`{ range:{from,to}, rows:[{item, lane, start, end, precision}], milestones:[…] }`，模糊计划给出 `start/end` 区间与其精度 |

### 2.4 AI

| 方法 | 路径 | body | 说明 |
|---|---|---|---|
| POST | `/ai/parse` | `{ text, apply:false }` | **只解析，不写库**。`{ intent, ops:[…], questions:[…], confidence }`；时间不明时 `questions` 里反问，**不得擅自假定精确时刻** |
| POST | `/ai/create-from-text` | `{ text, confirm:true }` | 解析并落地（用户已确认的场景），写 history `source:'ai'` |
| POST | `/ai/plan` | `{ days:5, from? }` | 读真实数据生成 5 天安排建议 → 返回**新建的 proposal**（未应用） |
| POST | `/ai/analyze` | `{ scope:"5d"\|"30d"\|"all" }` | 冲突/风险/逾期/长期目标无进展 的自然语言分析 + 结构化 `findings` |
| POST | `/ai/simulate` | `{ scenario, options? }` | 情景推演：`{ baseline:{…}, alternative:{…}, diff:[…], risks:[…], affected:[…] }`，**不修改任何数据** |
| POST | `/ai/chat` | `{ text, context? }` | 秘书对话，注入真实计划摘要；`{ reply, mode:"api"\|"fallback", usedContext:{items:n} }` |

AI 未配置 Key 时全部走确定性本地算法（规则 + 模板），`mode:"fallback"`，**不得伪造模型输出**。

### 2.5 建议（proposals）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/proposals?status=draft` | 列表 |
| POST | `/proposals` | 手动建草稿 |
| POST | `/proposals/:id/accept` | 应用 ops → `{ applied, skipped:[{id,reason:"locked"}] }` |
| POST | `/proposals/:id/reject` | |

### 2.6 提醒

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/reminders/due` | **弹出队列**（取走即标记 `fired`）：`{ items:[{id,kind,title,body,itemId,fireAt,actions:["start","done","snooze","skip","open"]}] }` |
| POST | `/reminders/:id/ack` | `{ action:"start"\|"done"\|"snooze"\|"skip"\|"dismiss", snoozeMin?:30 }`；`snooze` 生成新提醒（`snoozedTo`），`skip` 只停本条 |
| GET | `/reminders?status=pending` | 管理用 |
| POST | `/reminders` | 手动加 |

### 2.7 开机/登录邀请

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/boot/hello` | 桌宠启动时调用：`{ shouldGreet, sessionId, kind:"login"\|"resume"\|"restart", greeting, summary:{ days:5, planned:12, unscheduled:3, dueSoon:[…], conflicts:n, firstTask:{…}\|null }, actions:["plan","view","later"] }`。同一 `sessionId` 只 `shouldGreet:true` 一次 |
| POST | `/boot/ack` | `{ sessionId, action:"plan"\|"view"\|"later", snoozeMin:30 }` → 生成/取消对应提醒 |

### 2.8 设置 / 专注 / 免打扰

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/settings` | 全部设置 + 默认值 |
| PATCH | `/settings` | 局部更新，写 `prefs` |
| POST | `/focus` | `{ active:true, minutes:45 }` / `{ active:false }` |
| POST | `/dnd` | `{ active:true, until:"HH:mm"\|null }` |
| POST | `/water/ack` | 保留旧桌宠行为：喝水/休息提醒的快捷确认 |

## 3. 提醒调度规则（服务内，非模型）

- **喝水**：每 120 分钟，`dedupeKey=water:<日期T时:分>`；免打扰/全屏时**延后**不丢。
- **休息**：连续工作 50 分钟 → 提醒休息 10 分钟；休息结束后重新计时。
- **午饭/晚饭**：11:00 / 18:00，45 分钟补提醒窗口，当天只提醒一次。
- **任务**：`slot` 精度任务在 `startTime` 触发 `start`，`endTime` 触发 `end`；`dueDate` 当天 09:00 触发 `due`（若未完成）。
- 服务重启后按 `fireAt <= now` 且 `status=pending` 且未过期（>24h 的 `start` 提醒作废）补发一次，不重复。
- 已 `cancelled`/`done` 的任务不再产生提醒；`snooze` 一律生成**新**提醒行。

## 4. 安全

- 只绑 `127.0.0.1`，随机端口 + 每次启动新 token。
- 不接受模型生成的任意 shell/系统命令；`/ai/*` 只能返回结构化计划操作。
- 写操作校验 `locked`；密钥只从 `service/config.local.json` 或环境变量读，绝不写日志、不出现在 `/export`。

## 5. 默认设置（prefs）

```json
{
  "petHeight": 180, "petScale": 1.0, "topmost": true, "alwaysOnTop": true,
  "autoStart": false, "bootGreeting": true, "bootSnoozeMin": 30,
  "fineWindowDays": 5, "slotMinutes": 30, "timeFormat": "24h",
  "timezone": "system", "language": "zh-CN", "theme": "system",
  "taskReminder": true, "aiSuggestions": true, "aiAutoApply": false,
  "waterEveryMin": 120, "restEveryMin": 50, "restLengthMin": 10,
  "meals": ["11:00", "18:00"], "dnd": { "active": false, "from": "23:00", "to": "07:00" },
  "notify": { "system": true, "pet": true, "sound": false }
}
```

---

## 实现备注（v1 实现追加，不改变上述契约）

以下为 `service/` 落地时补充的实现约定，**只追加、不修改上文契约**。

1. **依赖接口（契约 §1.2 有表、§2 无路由）**
   实现补充了三条附加路由，用于建依赖与验证成环：
   - `GET /dependencies?itemId=` → `{ dependencies:[{id,fromId,toId,type}] }`
   - `POST /dependencies` body `{ fromId, toId, type? }` → 依赖；自环 `400 DEP_SELF_LOOP`，成环 `400 DEP_CYCLE`
   - `DELETE /dependencies/:id` → `{ deleted:true, id }`
   这三条是**附加扩展**，不改变已有接口语义。

2. **写操作的 source 来源**
   `PATCH /items/:id` 与 `POST /items/:id/progress` 从 `body.source` 或请求头 `X-Source` 读取来源，
   取值 `user|ai|import`；仅 `ai` 会触发 locked 409，缺省按 `user`。
   `POST /items` 的 `body.source` 用于记录创建来源。

3. **bootEvents 增加 sessionId**
   为实现 §2.7"同一 sessionId 只 shouldGreet 一次"，`bootEvents` 表除 §1.5 列出的字段外增加
   `sessionId` 列并建唯一索引；`sessionId` 由桌宠端传入。

4. **bridge.json 时间格式**
   按 §0"时间戳 `YYYY-MM-DDTHH:mm:ss` 不带时区偏移"输出 `startedAt`；
   §0 示例中的 `+08:00` 未采用，时区由 `/health` 的 `tz` 单独给出。

5. **id 前缀**
   `phase` 复用 `p_` 前缀（契约只列了 `g_/p_/m_/t_` 四种）。

6. **`/export` 与 `/import` 范围**
   `/export` 严格输出 §2.1 列出的键（`version,exportedAt,items,dependencies,reminders,prefs,memory,history`），
   不含 `proposals` 与 `bootEvents`；`/import replace` 也只重建这几张表，不会清空提案与开机事件。
   导出前递归剔除疑似密钥字段；`prefs` 中的密钥字段不会回显到 `/settings`。

7. **`/settings` 校验**
   `PATCH /settings` 校验 §5 全部已知键的类型；`apiKey/secret/token/password` 类键返回
   `400 SECRET_KEY_NOT_ALLOWED`；未登记键宽松接受（便于 App 先行加字段）。

8. **`/window` 每日 items 口径**
   `days[].items` 只包含"当天有实体安排（`slot`/`day`）或当天到期"的条目；
   年度/季度等模糊区间的目标不逐日重复列出，它们在 `/timeline` 与 `/conflicts` 中体现。
   `unscheduledCandidates` 为 item 对象 + `candidateReason`（`unscheduled`|`due-soon`）+ `dueInDays`。

9. **冲突范围**
   `no-execution` 按契约原文只覆盖 `quarter/month` 计划；年度目标由 `stale-goal` 覆盖。
   `severity` 取 `high|medium|low`；附加字段 `date`、`minutes`、`daysLeft` 等用于前端定位。

10. **`/ai/parse` 与 `/ai/simulate`**
    `/ai/parse` 忽略 `apply` 字段（本接口永不写库）；`/ai/simulate` 为纯本地确定性计算，
    即使配置了 Key 也不调用模型，保证"不修改任何数据"。

11. **提醒**
    `snooze` 生成的新提醒同样带 `snoozedTo`（与原提醒一致），`repeatOf` 指向原 id；
    任务完成时撤销其 `pending` 的 `start/end/due` 提醒。
    补发时 `>24h` 的 `start` 提醒置 `cancelled`，其余 `fireAt<=now` 的 `pending` 保持并在
    `/reminders/due` 返回一次（附加字段 `catchup:1` 表示补发）。

12. **附加响应字段**
    为便于桌宠定位，部分响应含契约之外的附加字段（如 `/window.summary.from/to/days/freeMin`、
    `/proposals/:id/accept.errors`、`/state.scheduler`）；不改变契约字段的含义与类型。

