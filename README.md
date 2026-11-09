# AI Personal Secretary · 智能桌宠时间规划秘书

一位住在你 Windows 桌面上的二次元 AI 秘书：**汐**。
她不只是会聊天 —— 她保存你的长期目标、把模糊计划（"2027 年研究 AI"）和精确任务（"明天 14:00–16:00 写方案"）
放在**同一个真实数据库**里，每天开机主动问你未来五天怎么安排，并在该喝水、该休息、该开工的时候真的提醒你。

> 所有数据在本机 SQLite；AI 走本地规划算法 + 可选的 DeepSeek API，不联网也能用。

---

> **不会用？** 先看 [使用手册](使用手册.md) —— 按「想做什么 → 点哪里 → 会发生什么」写，含建计划的七种填法。

## 0. 从仓库部署（新机器）

```powershell
git clone git@github.com:huishao-hub/ds_secretary.git D:\AI-Secretary
cd D:\AI-Secretary

# 配置 Key（不配也能用，只是聊天走本地规则）
Copy-Item service\config.local.example.json service\config.local.json
notepad service\config.local.json

# 启动
powershell -NoProfile -ExecutionPolicy Bypass -File app\launch.ps1
```

> 仓库里**不含**运行数据：`data/`（SQLite、token、桌宠位置）、`logs/`、以及 `service/config.local.json` 里的 Key。
> 角色立绘在 `assets/character/`，仅个人使用，别分发。

## 1. 现在就能跑起来（3 步）

```powershell
# 1) 启动本地规划服务 + 桌宠
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\AI-Secretary\app\launch.ps1"

# 2) 打开时间规划中心
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\AI-Secretary\app\PlanningCenter.ps1"

# 3) 只跑服务（调试用）
node D:\AI-Secretary\service\index.mjs --data-dir D:\AI-Secretary\data
```

DSH 侧：插件已安装为 profile bundle `@local/dsh-ai-secretary`，DSH 启动时会自动拉起服务与桌宠，
并把 `secretary_agenda` / `secretary_plan_item` / `secretary_findings` / `secretary_open` 四个工具交给 Agent。

---

## 2. 目录结构

```
D:\AI-Secretary\
  app\
    launch.ps1              启动器：确保服务在跑 → 拉起桌宠
    Pet.ps1                 桌宠叠加层（透明置顶窗口、分层动画、气泡、提醒、托盘）
    PlanningCenter.ps1      时间规划中心（三栏：目标树 / 多尺度时间轴 / AI 面板）
    lib\Rig.ps1             角色骨架：分层渲染、表情交叉淡入、特效
    lib\Bridge.ps1          与服务通信（异步 HTTP、绝阻塞 UI）
    lib\Theme.ps1           浅色/深色主题
  service\                  本地规划引擎（Node 24，零 npm 依赖，node:sqlite）
    index.mjs http.mjs model.mjs planner.mjs reminders.mjs nlq.mjs ai.mjs db.mjs time.mjs
  assets\character\         角色立绘与分层资源 + rig.json
  data\                     secretary.db / bridge.json / pet-settings.json / 缓存
  logs\                     pet.log / planner.log / service.log / plugin.log
  plugin\                   DSH 插件（@local/dsh-ai-secretary）
  docs\                     API 契约、角色说明、开源调研、测试结果
  tests\                    服务端 35 用例 + 角色骨架冒烟测试
```

---

## 3. 功能与实现状态

| 需求 | 状态 | 说明 |
|---|---|---|
| 桌面常驻、透明、置顶、拖动、缩放、记忆位置 | ✅ 已实现 | WPF 叠加层，滚轮缩放 80–520px，位置存 `pet-settings.json` |
| 二次元女性秘书形象、眨眼、呼吸、动作 | ✅ 已实现 | 分层骨骼 + 4 套表情帧；见 `docs/CHARACTER.md` |
| 多尺度时间轴（年/季/月/周/日/甘特） | ✅ 已实现 | 滚轮 + Ctrl 缩放、左右平移、拖拽改期、里程碑、冲突标记 |
| 任意时间跨度 + 模糊时间 | ✅ 已实现 | `precision = year/quarter/month/week/day/slot/unscheduled`，模糊计划存区间，绝不压缩成某一天 |
| 未来五天精细规划（滚动窗口） | ✅ 已实现 | 默认 5 天、30 分钟粒度，可配置 |
| 开机登录主动邀请规划 | ✅ 已实现 | 系统启动时间推 sessionId，同一登录只问候一次；"稍后提醒"落真实提醒行 |
| 系统级通知 | ✅ 已实现 | 托盘气泡（Win10 进操作中心）+ 桌宠弹窗 |
| 任务/喝水/休息/饭点提醒 | ✅ 已实现 | 唯一 dedupeKey、snooze 生成新行、重启补发一次、取消/完成即撤销 |
| 免打扰 / 全屏应用检测 | ✅ 已实现 | 手动开关 + 时间段 + 前台全屏窗口检测 |
| 锁屏 / 休眠 / 唤醒 | ✅ 已实现 | `SystemEvents.SessionSwitch` / `PowerModeChanged` |
| AI 自然语言建计划 | ✅ 已实现 | `/ai/parse` 确定性中文解析；拿不准就反问，不猜时刻 |
| AI 冲突分析与情景推演 | ✅ 已实现 | 6 类冲突、baseline/alternative/diff/risks |
| AI 建议需用户确认 | ✅ 已实现 | 一律先落 `proposal(draft)`，接受后逐条应用并跳过 locked |
| 长期记忆 / 偏好 | ⚠️ 部分 | `prefs` + `memory` 表已建，UI 未做记忆管理页 |
| 开机自启动 | ⚠️ 默认关闭 | 设置里勾选才写入 HKCU Run（需你同意） |
| 手臂骨骼动画（挥手） | ❌ v1 未做 | 单张立绘无法分离手臂；用身体姿态 + 表情 + 特效替代，见 `docs/CHARACTER.md` |
| Live2D 模型导入 | ❌ v1 未做 | 需要 Cubism Core 授权，见 `docs/OPEN-SOURCE-REVIEW.md` |

**已知限制见第 7 节。**

---

## 4. 桌宠操作

| 操作 | 效果 |
|---|---|
| 左键单击 | 弹出快捷面板：聊天 / 近期计划 / 新建任务 / 规划五天 / 下一个任务 / 专注模式 |
| 左键双击 | 打开时间规划中心 |
| 右键 | 菜单：规划中心、说话、下一个任务、总在最前、免打扰、隐藏、专注 45 分钟、调整大小、设置、退出 |
| 按住拖动 | 移动；松手保存位置 |
| 滚轮 | 缩放角色高度 |
| 托盘双击 | 打开规划中心 |
| 托盘气泡点击 | 打开规划中心 |

---

## 5. 规划中心

- **左栏**：长期目标 / 项目树（含进度条、🔒 锁定标记）、待安排计划池、搜索。
- **中栏**：时间轴。`年 / 季 / 月 / 周 / 日 / 甘特` 六种尺度；`＋/－` 或 `Ctrl+滚轮` 平滑缩放；
  `◀ ▶` 平移；`今天` 回到当前；拖拽色块改期（写回数据库并记 `history`）；右键改期块可编辑/锁定/完成/删除。
- **右栏**：冲突与风险、AI 建议（接受/忽略）、和秘书对话。
- 颜色：优先级 0–4 由灰蓝到红；里程碑是紫色菱形；锁定的计划描金色边。

---

## 6. 数据与安全

- SQLite：`data\secretary.db`（WAL）。备份：`GET /export` 导出 JSON；`POST /import` 恢复。
- 本地服务只绑 `127.0.0.1`，端口随机，每次启动新 token，写在 `data\bridge.json`（仅本机可读）。
- 网页/其他设备无法直接调用：所有写接口都要 Bearer token。
- API Key 只从 `service\config.local.json` 或环境变量读，不进日志、不进 `/export`。
- 模型只能返回**结构化计划操作**，不能执行任何系统命令。

---

## 7. 已知限制（如实列出）

1. **单张立绘**：角色只有一个角度，没有手臂骨骼，所以"挥手"用身体倾斜 + 表情替代；转身/换装未做。
2. **非 Live2D**：自研分层骨骼（伪 Live2D），运动幅度控制在 ±3° 以内避免接缝；不是 Cubism 网格变形。
3. **透明区域不能完全鼠标穿透**：窗口矩形内角色外的空白区域仍会接收点击（会触发拖动）。
4. **重复任务**：`每天/每周` 只落地下一次发生日，没有真正的重复规则（需 v2 schema）。
5. **AI 无 Key 时**走确定性本地算法，语气与灵活度有限；有 Key 才有自然语言润色。
6. **时区固定东八区**：`tz` 上报 `Asia/Shanghai`，不做跨时区换算。
7. **单实例**：同一 `data` 目录只能跑一个服务进程。
8. **开机自启默认关闭**，需要在设置里勾选（会写入当前用户 `HKCU\...\Run`）。

---

## 8. 实测资源占用

| 进程 | 常驻内存 | 空闲 CPU |
|---|---|---|
| 桌宠（powershell + WPF） | 186–202 MB | 2.85% 单核（12fps 待机动画） |
| 规划引擎（node） | 57 MB | 0.07% 单核 |
| 规划中心（窗口打开时） | ~90 MB | 0% |

桌宠的大头是 PowerShell/WPF 运行时基线（约 140 MB），角色贴图按显示尺寸解码只占十几 MB。
测量方法：静置 60 秒，取 `(CPU_after − CPU_before) / 60`。

## 9. 测试

```powershell
node D:\AI-Secretary\tests\test-service.mjs      # 服务端 35 个端到端用例
powershell -File D:\AI-Secretary\tests\smoke-rig.ps1   # 角色骨架渲染冒烟
```

真实测试记录见 `docs\TEST-RESULTS.md`。
