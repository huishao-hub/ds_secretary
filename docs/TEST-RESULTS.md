# 验收测试记录

测试环境：Windows 10 家庭中文版 26200（25H2），2560×1440@125%，Node v24.16.0，PowerShell 5.1，时区 Asia/Shanghai。
测试时间：2026-11-08 21:2x–21:3x。

图例：✅ 真实环境验证 ｜ 🧪 自动化测试通过 ｜ 👤 尚需你人工确认 ｜ ❌ 暂不支持

---

## A. 服务端自动化（`node tests\test-service.mjs`）

真实输出（本轮重跑）：

```
PASS  28 /focus and /dnd persist and appear in /state  (3ms)
PASS  29 scheduler creates water / meal / rest reminders and dedupes  (9ms)
PASS  30 proposal reject and lock endpoint  (9ms)
PASS  31 delete detaches children and cancels reminders  (6ms)
PASS  32 /window clamps days to 1..14 and /items filters work  (5ms)
PASS  33 api mode uses model ops through injected endpoint  (25ms)
PASS  34 api failures degrade to local fallback (timeout / refused)  (24ms)
PASS  35 week/day precision, padded HH:mm, and /tree  (7ms)

================================================================
TEST SUMMARY: 35 passed, 0 failed, 35 total
================================================================
```

🧪 35/35 通过（真实起 HTTP 服务 + 真实 SQLite + 真实鉴权）。

---

## B. 需求书 13 项验收

### 测试 1 · 桌宠运行 ✅👤
真实环境：进程 `powershell.exe -File app\Pet.ps1` 常驻，透明置顶窗口出现在桌面右下角，
截图 `logs\shot-pet-1.png`（300×327）可见角色与气泡。
拖动/缩放/隐藏的鼠标操作**没有自动化验证**，需你手动点一下确认。

### 测试 2 · 桌宠动画 ✅
同一进程在不同状态截到不同表情帧：`GREETING`（happy+sparkle）、`REMINDING`（talk+exclaim）、
`IDLE`（idle）、`blink`。状态机日志可见 `state -> X` 序列。
连续运动（呼吸/摇摆/浮动/点头）由 `Update-Animation` 每帧驱动，非图片切换。

### 测试 3 · 长期规划 ✅🧪
真实调用 `POST /items {title:"2027 年系统研究 AI", precision:"year"}` →
返回 `startDate=2027-01-01, endDate=2027-12-31, startTime=null`，`fuzzyLabel="2027 年"`。
**没有被压成某一天某一刻**。DB 中现存即此条。

### 测试 4 · 季度规划 ✅
`precision:"quarter"` → `2027-04-01 ~ 2027-06-30`，`fuzzyLabel="2027 Q2"`，在时间轴上按区间渲染。

### 测试 5 · 近期精细规划 ✅
`POST /items {precision:"slot", startDate:"2026-11-09", startTime:"14:00", endTime:"16:00"}`
→ 自动生成 start(`2026-11-09T14:00`) 与 end(`2026-11-09T16:00`) 两条提醒，
`dedupeKey=item:t_xxx:start:2026-11-09`；规划中心周视图按 14:00–16:00 的横向位置渲染。

### 测试 6 · 开机主动提醒 ✅👤
- 真实轨迹：以新 sessionId 启动 → `/boot/hello` 返回 `shouldGreet=true` → 桌宠进入 `GREETING`
  并弹出「晚上好，今天有 1 处安排冲突，先看一眼再开工吧。」+ 摘要（已排 4 项/待安排 1 项/冲突 1 处/下一件：周会）
  + 三个按钮，截图 `logs\shot-pet-1.png`（21:27:35）。
- 幂等：同一 sessionId 再启动 → `boot hello skipped: session already greeted`（日志可见），不再重复弹。
- 不同 sessionId → 再次问候（`/boot/hello` 实测 `shouldGreet=true`）。
- **重启电脑后是否自动出现，需要你亲自重启验证**（涉及真实登录事件）。

### 测试 7 · 稍后提醒 ✅🧪
`/boot/ack {action:"later", snoozeMin:30}` 生成 30 分钟后的提醒（自动化测试 17）；
`/reminders/:id/ack {action:"snooze"}` 生成新提醒行并带 `repeatOf`（自动化测试 09）。

### 测试 8 · 主动任务提醒 ✅👤
真实触发：21:29 建 `21:32` 的任务 → 21:32:05 桌宠日志出现 `reminders: 1`（服务端 `/reminders/due` 投递成功）。
因为当时前台是**全屏游戏**，免打扰判定为真，提醒被有意延后（不会丢，解除全屏后照常弹出）。
面板本身用调试钩子截图为证：`logs\shot-pet-1.png`（21:33:42，标题/正文/开始/完成/推迟 30 分钟/跳过/查看计划）。
**真实弹窗（未被全屏遮挡时）需你人工确认一次。**

### 测试 9 · AI 规划建议 ✅
`POST /ai/plan {days:5}` 读真实库 → 返回 `proposal(status=draft)`，摘要里是真实数字
（"从 2026-11-08 起 5 天，待安排池有 1 项… - 2026-11-08 23:00-00:00 整理文献"）。
规划中心右栏渲染成卡片，带「接受 / 忽略」，**未接受前不写库**（自动化测试 12 验证 items 数量不变）。

### 测试 10 · 计划推演 ✅🧪
`POST /ai/simulate` 返回 `baseline / alternative / diff / risks / affected`，纯计算不改数据（自动化测试 24）。
**UI 上还没有推演输入框**，目前只能通过 API / Agent 工具调用 —— 属于未完成项。

### 测试 11 · 数据恢复 ✅🧪
关闭服务再开同一 `data` 目录 → 数据仍在、`bridge.json` 重建、待发提醒不重复（自动化测试 08 / 23）。
桌宠位置/高度/置顶/免打扰设置存 `data\pet-settings.json`，重启后恢复。

### 测试 12 · AI 权限 ✅🧪
`locked=1` 的项被 `source:"ai"` 的 PATCH 请求打回 `409`；用户来源可以改（自动化测试 05）。
proposal accept 遇到 locked 项跳过并在结果里报告（自动化测试 06）。

### 测试 13 · 稳定性 👤 部分
已验证：服务重启恢复、`uncaughtException`/`unhandledRejection` 兜底、每 20s 调度 tick 无错误
（`/state.scheduler = {ticks:31, lastError:null}`）。
未验证：连续运行数天的内存曲线、真实重启电脑、夏令时（东八区无夏令时）、断网时 UI 表现。

---

## C. 保留的喝水 / 休息功能 ✅🧪

- 规则仍在：喝水分每 120 分钟、休息每 50 分钟后提醒 10 分钟、午饭 11:00 / 晚饭 18:00（45 分钟补提醒窗口）。
- 自动化测试 29 覆盖"创建 water/meal/rest 提醒并去重"。
- 运行态确认：`/state.scheduler` 在跑（ticks 递增，无错误），但**本轮没有等到真实的 50/120 分钟到点**，
  所以"到点真的弹出来"这件事需要你等一个工作时段确认。

---

## D. 资源占用（实测，非估计）

| 进程 | 常驻内存 RSS | 空闲 CPU |
|---|---|---|
| 桌宠（powershell + WPF） | 186–202 MB | 2.85% 单核（12fps 待机动画） |
| 规划引擎（node） | 57 MB | 0.07% 单核 |
| 规划中心（窗口打开时） | 约 90 MB | 打开后 0%（无动画） |

测量方法：静置 60 秒，取 `(CPU_after - CPU_before) / 60`。
桌宠的大头是 PowerShell + WPF 运行时基线（约 140MB），角色贴图只占十几 MB（按显示尺寸解码）。

---

## E. 未实现 / 需你确认清单

| 项 | 状态 |
|---|---|
| 手臂骨骼动画（挥手）、换装、多角色切换 | ❌ v1 未做 |
| Live2D 模型导入 | ❌ 未做（授权问题，见 docs/OPEN-SOURCE-REVIEW.md） |
| 情景推演 UI 入口 | ❌ 只有 API / Agent 工具 |
| 长期记忆管理界面 | ❌ 只有数据表与 API |
| 真实重复任务（每天/每周） | ❌ 只落地下一次 |
| 透明区域完全鼠标穿透 | ❌ 窗口矩形内空白区仍可拖动 |
| 开机自启 | ⚠️ 默认关闭，需你在「设置」里勾选授权 |
| 重启电脑后的开机问候 | 👤 需你实测一次 |
| 喝水/休息到点真实弹出 | 👤 需你等 50 分钟实测 |
| 鼠标拖动/缩放/托盘隐藏 | 👤 需你手动点一遍 |
