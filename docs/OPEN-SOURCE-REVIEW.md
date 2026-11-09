# 开源桌宠 / AI 陪伴项目调研报告

> 调研对象：`xShiroeNguyenx/desktop-companion`、`lshhhhhhh/OpenMeido`、`LorisYounger/VPet`、`moeru-ai/airi`
> 调研时间：**2026-11-08（Asia/Shanghai）**，下列 star / 提交时间 / Release 均为该时点的快照，会随时间变化。
> 调研方式：**只读**。未 clone、未 `npm install`、未运行任何项目代码。数据来自 GitHub REST API、raw 文件内容（经 API base64 通道获取）、以及 Live2D 官方条款页面。
> 目的：判断本项目（DSH：Electron + Node 的 AI Agent 桌面端，插件为 JS，可拉子进程、可起本地 HTTP 服务）能否"直接 fork 一个"来做"桌面叠层角色 + 时间规划"。

---

## 0. 一句话结论（先看这个）

**四个项目都不适合直接 fork 当作本项目的地基。** 原因不是"代码不好"，而是三条硬约束同时成立：

1. **美术资源许可与代码许可分离**：三个项目里最值钱的资产（角色立绘 / Live2D 模型 / 动画帧）要么是 **CC BY-NC 4.0**（禁商用、必须署名），要么是 **Live2D 官方 sample（禁止改动设计 / 其中"合作角色"禁止商用与分发）**，要么是 **VPet 的自定义动画条款（禁售卖、商用要弹窗告知并邮件报备）**。fork 代码 ≠ 拿到能分发的形象。
2. **架构目标不同**：它们的 AI 部分都是"陪聊 + 少量工具调用"，没有一个是"以时间规划/任务调度为核心"的；记忆、提醒、日程在它们那里是附属功能，不是主干。
3. **构建链在本机不成立**：Tauri 要 Rust stable + MSVC 工具链、VPet 要 Visual Studio + .NET + 管理员 `mklink`、Electron 项目要 pnpm + 数百 MB 依赖并产出 330–493 MB 安装包。

**推荐路线：自研轻量叠层客户端（Electron 透明窗，或 WPF + WebView2），复用它们的架构思想（尤其 OpenMeido 的 L1/L2/L3 记忆分层、airi 的 provider 抽象与 server channel 解耦、desktop-companion 的"选中即操作"交互），一行代码都不要抄。**
唯一可以"合规直接用"的是 **MIT / Apache-2.0 的代码片段 + 第三方开源库本身**（pixi.js、Cubism Components JS、sqlite-vec、electron-vite 等），而不是这些项目的形象资产。

---

## 1. 速览对比表

| 维度 | desktop-companion | OpenMeido | VPet | AIRI |
|---|---|---|---|---|
| 仓库 | [xShiroeNguyenx/desktop-companion](https://github.com/xShiroeNguyenx/desktop-companion) | [lshhhhhhh/OpenMeido](https://github.com/lshhhhhhh/OpenMeido) | [LorisYounger/VPet](https://github.com/LorisYounger/VPet) | [moeru-ai/airi](https://github.com/moeru-ai/airi) |
| Star / Fork | 3 / 0 | 7 / 0 | **7197 / 713** | **51212 / 5158** |
| 最近提交（UTC） | 2026-11-08 12:41 | 2026-09-27 10:38 | 2026-11-07 18:28 | 2026-11-08 12:33 |
| 最近 Release | v0.12.3（2026-11-08） | v0.4.0（2026-09-27） | **无 GitHub Release** | v0.14.1（2026-10-30） |
| Archived | 否 | 否 | 否 | 否 |
| 主语言 | JavaScript（+ Rust） | TypeScript | C# | TypeScript |
| 仓库体积（API `size`） | ≈ 67 MB | ≈ 55 MB | **≈ 1.39 GB** | ≈ 628 MB |
| 安装包体积 | ≈ 50.8 MB（exe）/ 51.7 MB（msi）/ 107.7 MB（dmg） | **≈ 330.3 MB**（exe） | 走 Steam，无 GitHub 包 | **≈ 493.6 MB**（win exe）/ 202 MB（apk） |
| 代码许可 | **MIT**（但 GitHub API 判定为 `Other`/`NOASSERTION`） | **GNU GPL-3.0** | **Apache License 2.0** | **MIT** |
| 美术资源许可 | **CC BY-NC 4.0**（原创）+ Live2D Free Material（官方 sample） | Live2D Free Material（Hiyori / Natori）+ 字体 OFL 1.1 | **自定义动画条款**（非 Apache-2.0） | README/LICENSE **未声明**（见 §6） |
| 外壳 | Tauri 2（Rust + WebView2） | Electron 44 | WPF（.NET） | Electron（stage-tamagotchi） |
| 前端 | 原生 JS + PIXI.js | React 19 + pixi.js 7 | XAML | Vue 3 + UnoCSS |
| 角色渲染 | Live2D Cubism 4（PIXI） | Live2D Cubism 4（pixi-live2d-display） | **PNG 帧动画**（L2D/Spine 靠插件） | **Live2D + VRM（three.js）** |
| 面向用户 | 越南语用户（越/日/英） | 中文用户（二次元） | 中文用户（Steam 玩家） | 国际（英/中/日/韩…） |

数据来源：各自的 GitHub REST API `repos` 与 `releases` 端点（例：[dc repo API](https://api.github.com/repos/xShiroeNguyenx/desktop-companion)、[airi repo API](https://api.github.com/repos/moeru-ai/airi)），体积取自 Release assets 的 `size` 字段。

> ⚠️ 注意一处矛盾证据：desktop-companion 的 LICENSE 文件正文是标准 MIT，但文件末尾追加了两段"资产不适用 MIT"的说明，导致 GitHub 的许可证识别器给不出 SPDX，返回 `NOASSERTION`。**法律上以文件正文为准 = MIT（代码）+ 资产排除**。

---

## 2. 逐项目详查

### 2.1 desktop-companion

**维护状态**
- Star 3、Fork 0、Watch 3、open issues 0，单人项目，2026-06-27 建仓。
- 提交非常活跃：最近一次 push 与最新 Release 都在调研当天（2026-11-08）。
- Release 节奏密：v0.12.3 于 2026-11-08 11:26 UTC 发布，产物含 NSIS / MSI / macOS dmg / `latest.json` + `.sig` —— 这是 **Tauri updater 的标准产物形态**，可作为"确实是 Tauri 而非 Electron"的旁证。

**技术栈与架构**（来源：[README §Tech stack](https://github.com/xShiroeNguyenx/desktop-companion/blob/main/README.md)、[package.json](https://github.com/xShiroeNguyenx/desktop-companion/blob/main/package.json)）
- **Tauri 2**（Rust core + WebView2），前端为**原生 JS**（`app/js/`），测试用 `node --test`。
- `package.json` 只有一个 devDependency：`@tauri-apps/cli` —— 说明**没有前端打包器**，PIXI 等库是直接内嵌的，JS 依赖极轻；重量都在 Rust 侧。
- Live2D：**Cubism 4 + PIXI.js** 渲染；跨应用取词靠**全局鼠标钩子 + 模拟 Ctrl+C**（Windows）。
- 构建前置条件（README 明示）：Rust stable + MSVC C++ build tools + Node 18+ + Tauri prerequisites。
- 仓库根目录有 `src-tauri/`、`app/`、`models/`、`anna-app/`、`docs/`（目录存在性来自 [contents API](https://api.github.com/repos/xShiroeNguyenx/desktop-companion/contents/)；`models/` 与 `anna-app/` 的**具体内容我未能取到**，见 §8）。

**许可证**
- 代码：**MIT License**，`Copyright (c) 2026 Desktop Companion contributors`（[LICENSE](https://github.com/xShiroeNguyenx/desktop-companion/blob/main/LICENSE)）。
- 原创美术：**Creative Commons Attribution-NonCommercial 4.0 International（CC BY-NC 4.0）**，`Copyright © 2026 xShiroeNguyenx`，自 v0.9.5 起适用（[ASSETS-LICENSE.md](https://github.com/xShiroeNguyenx/desktop-companion/blob/main/ASSETS-LICENSE.md)）。
  - 覆盖范围：Gothic Aristocrat 等 19 个 Collection 模型、模型预览图、Bunny/Neko/Fox/Snow Lounge 侧边立绘、Miu 表情、街机图、水族箱图。
  - 条件：**必须署名 + 禁商用**（"don't use it in a paid or monetized product, service, or promotion"）。
  - 明确写了 AI 生成图（水族箱鱼）"作者持有权利的范围内"按 CC BY-NC 提供，并提示 AI 图未必受版权保护。
- **Live2D 官方 sample 模型**（Hiyori、Haru、Mao、Miara）**不在 MIT 也不在 CC BY-NC 内**，版权归 Live2D Inc.，适用 Live2D Free Material License Agreement。

**功能支持**

| 能力 | 支持 | 依据 |
|---|---|---|
| 透明窗口 | ✅ | "a transparent, always-on-top, draggable companion"（README 首条） |
| 桌面置顶 | ✅ | 同上 |
| 开机自启 | ✅ | "starts with Windows" |
| Live2D 自定义模型 | ✅ | "load your own `*.model3.json` models from any folder" |
| 长期记忆 | ❌（仅短期） | "remembers the last **10 turns** (stored only on your machine)" |
| 任务提醒 | ✅ 强 | 截止日期（当天早上/提前 1 小时/到点/逾期 3 天每日）、休息提醒、专注会话、Windows 通知 |
| 多角色 | ⚠️ 部分 | 19 个模型可切换、面板可站侧边立绘，但**同屏只有一个主角色** |
| 点穿 | ✅ | tray「Turn on click-through」 |

**集成 DSH 的难度：高**
- 它是 **Tauri/Rust 应用**，不是 Node 应用，DSH 的 JS 插件**无法** require/embed 它；也没有对外暴露的本地 API（README 未提）。
- 可行姿势只有两种：① 当独立 app 与 DSH 并列运行，用 UI 自动化/剪贴板做脏接口（不稳）；② 抄它的产品设计自己重写。两者都不叫"集成"。

**常驻内存/CPU**：README 未给任何数字 → **未知，需实测**。

---

### 2.2 OpenMeido

**维护状态**
- Star 7、Fork 0、open issues 0，单人项目，2026-05-19 建仓。
- **最近一次 push 是 2026-09-27**，距调研日约 6 周；v0.4.0 的 Release 说明自己写着"隔了几个月回来" —— 属于**低频维护、阶段性集中修复**的节奏。

**技术栈与架构**（来源：[package.json](https://github.com/lshhhhhhh/OpenMeido/blob/main/package.json)、[DESIGN.md](https://github.com/lshhhhhhh/OpenMeido/blob/main/DESIGN.md)）
- **Electron 44.4.5 + electron-vite + React 19 + TypeScript**，`electron-builder` 出 Windows 包。
- Live2D：`pixi.js@7` + `pixi-live2d-display-lipsyncpatch@0.5.0-ls-8`（第三方 fork，带口型同步补丁）。
- 数据：`better-sqlite3@13` + **`sqlite-vec`**（向量检索）+ `@huggingface/transformers` 在本地跑 **bge-small-zh-v1.5**（首次启用下载 ≈95 MB）。
- Agent：`ai@6`（Vercel AI SDK）+ `@ai-sdk/openai` / `@ai-sdk/google`，provider 走 OpenAI 兼容端点（GLM / Kimi / DeepSeek / Qwen / 豆包 / LM Studio 等）。
- 工具生态：`imapflow` + `mailparser`（读邮件）、`pdfjs-dist` + `mammoth`（PDF/Word）、`msedge-tts`、`adm-zip`（Live2D 模型 zip 导入）、`electron-updater`。
- **架构亮点（值得抄"思想"的部分）**：DESIGN.md 把边界写得很硬 ——
  - Renderer **永不直接发外部 HTTP**，所有网络走 main，API key 不进渲染进程；
  - `src/core/` 平台无关（不 import `electron` / `node:*` / 原生模块），存储/通知/截屏都藏在接口后面，为将来 PWA/Capacitor 留口；
  - 记忆分 **L1 工作窗口 / L2 向量召回 / L3 反思事实**（L3 当时标注为待实现）；
  - 明确"no Python，无 CLI，用户只装一个安装包"。

**许可证**
- 代码：**GNU General Public License v3.0**（[LICENSE](https://github.com/lshhhhhhh/OpenMeido/blob/main/LICENSE)，35 KB 全文；GitHub API 判定 `GPL-3.0`）。
- DESIGN.md 自述选 GPL 的理由：*"Copyleft was chosen so derivative desktop-companion forks must also stay open source."* —— **它就是冲着"防止别人闭源 fork"来的**，所以本项目若闭源/收费，用它就是直接违规。
- 随包资源（[README §自带内容版权说明](https://github.com/lshhhhhhh/OpenMeido/blob/main/README.md)）：
  - **Hiyori / Natori** —— Live2D Inc. 出品，[Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)；
  - **Live2D Cubism Core** —— Cubism SDK Release License（专有）；
  - **Cubism Components（JS runtime）** —— MIT；
  - 三款字体（小赖 / LXGW 文楷 / 得意黑）—— SIL OFL 1.1。

**功能支持**

| 能力 | 支持 | 依据 |
|---|---|---|
| 透明窗口 | ✅ | "透明窗口 + 点穿：形象边缘点击穿透" |
| 桌面置顶 | ✅ | DESIGN.md「Desktop-only features: Frameless transparent always-on-top window」 |
| 开机自启 | ⚠️ 未在文档中明确 | README/DESIGN 未提，**未验证** |
| Live2D 自定义模型 | ✅ 强 | Settings → Live2D → 导入 zip，还有"✨ AI 自动绑定表情/情绪" |
| 长期记忆 | ✅ 强 | memory.sqlite + 本地 embedding + RAG + 好感度 + lore 碎片；跨会话记住姓名/工作/兴趣 |
| 任务提醒 | ✅ | 自然语言加待办 + 提醒；v0.4.0 修了"超过 25 天的提醒会提前触发" |
| 多角色 | ✅ 部分 | 4 种 persona（女仆/妹妹/管家/大小姐）各自独立好感度，但同屏一个形象 |

**集成 DSH 的难度：中高**
- **同栈**（Electron + Node + TS），理论上 DSH 的插件生态能"看懂"它；但它是**单体应用**，没有对外 API、没有 SDK、没有 IPC 协议文档 —— 集成只能靠"改它的源码"或"外面套 UI 自动化"。
- 真正的拦路虎是 **GPL-3.0**：一旦把它的代码链接进本项目，本项目也得 GPL；而 DSH 如果是闭源分发，这条路直接死。

**常驻内存/CPU**：
- 文档**没有** RAM/CPU 数字 → **未知，需实测**。
- 但有一个硬指标可引用：**安装包 330,258,049 B ≈ 330 MB**，外加首次启用长期记忆再下载 **≈95 MB** 模型（README §数据存哪儿）。

---

### 2.3 VPet（虚拟桌宠模拟器）

**维护状态**
- Star **7197**、Fork 713、open issues 22、watch 7197，2022-12-13 建仓，**近 4 年持续维护**，最近 push 2026-11-07。
- **GitHub 上没有正式 Release**：`/releases/latest` 返回 404（不是超时，是干净的 `{"message":"Not Found"}`）。发行走 **Steam（免费）** 与 **NuGet 包 `VPet-Simulator.Core`**。
- 仓库体积 **≈1.39 GB**（动画帧为主），是四个项目里最重的。

**技术栈与架构**（[README](https://github.com/LorisYounger/VPet/blob/main/README.md)）
- **C# / WPF / .NET**，`VPet.sln` 解决方案，四层：
  - `VPet-Simulator.Core`（可内嵌到任意 WPF 应用：GraphCore 动画核心、GameCore、PetLoader、存档）
  - `VPet-Simulator.Windows`（主窗体、设置、BetterBuy、**ChatGPT 设置窗 `winCGPTSetting`**）
  - `VPet-Simulator.Tool`（MOD 制作工具）、`VPet-Simulator.Windows.Interface`
- 渲染是**PNG 帧动画**（`PNGAnimation`），不是 Live2D；官方动画量级 "32 种 × 4 状态 × 3 类型"。
- 生态：Steam 创意工坊 + 代码插件 MOD（README 明说插件可以"添加新的动画逻辑/显示方案（eg: l2d/spine）"）。
- 构建：Visual Studio 打开 `VPet.sln` → 选 x64 → 生成 `Vpet-Simulator.Windows` → **以管理员运行 `mklink.bat`** 链接 mod 目录，否则报"缺少模组 Core，无法启动桌宠"。

**许可证（这里是最容易踩雷的地方）**
- 代码：**Apache License 2.0**（[LICENSE](https://github.com/LorisYounger/VPet/blob/main/LICENSE) 为标准 Apache 2.0 全文，无附加条款；我检索过 `NonCommercial` / `CC BY` / `artwork` / `Live2D` 等关键词，**LICENSE 文件本身没有**资产例外）。
- **但 README 里另有一节「动画版权声明与授权」，把美术资源从 Apache-2.0 里摘出去了**（[README 第 134–164 行](https://github.com/LorisYounger/VPet/blob/main/README.md)）：
  - 桌宠动画文件版权归 **虚拟主播模拟器制作组**所有；
  - **非商用**：需告知用户动画来源并提供本仓库链接，然后可免费使用；
  - **商用**：首次使用需**弹窗醒目告知来源**、在用户可快捷访问的页面告知来源、**禁止出售动画文件盈利**、并**邮件联系作者**（`zoujin.dev@exlb.org`）；
  - **分发**：需告知全部授权信息 + 提供链接 + **禁止任何付费/收费**；
  - **图片**：程序内置图片同上；**Zip 照片图库禁止商用**。
- 换句话说：**代码可商用（Apache-2.0），皮肤不能随便商用（自定义条款）**。fork 了代码等于拿到一个没有脸的骨架。

**功能支持**

| 能力 | 支持 | 依据 |
|---|---|---|
| 透明窗口 | ✅ | WPF 桌宠基本能力；README"内置到任何 WPF 应用程序" |
| 桌面置顶 | ✅ | 桌宠形态默认置顶（README 未逐条写，属实现细节） |
| 开机自启 | ⚠️ 未验证 | README 未提 |
| Live2D 自定义模型 | ❌ 原生不支持 | 原生是 PNG 帧动画；L2D 要靠第三方插件 MOD（README 提到插件可加 l2d/spine） |
| 长期记忆 | ❌ | 无记忆系统；有存档（好感度/饥饿等游戏数值） |
| 任务提醒 | ⚠️ 需插件 | README 举例插件可加"闹钟/记事板"；原生不是任务系统 |
| 多角色 | ✅ 通过 MOD | 创意工坊可换人物动画；同屏仍单角色 |
| AI 对话 | ⚠️ 有但不强 | 存在 `winCGPTSetting`（ChatGPT 设置窗），非 agent 架构 |

**集成 DSH 的难度：高**
- 栈完全不同（.NET/WPF vs Electron/Node）。它的 `VPet-Simulator.Core` 是 **NuGet 包，只能内嵌进 WPF 宿主**；DSH 是 Electron，接不上。
- 除非做一个 WPF 壳进程与 DSH 通过本地 HTTP/WS 通信 —— 但那时你已经在自研了，不如直接用 WebView2 自绘。

**常驻内存/CPU**：README 未给 → **未知，需实测**。仓库 1.39 GB 主要是动画帧，不代表运行时内存。

---

### 2.4 AIRI（Project AIRI）

**维护状态**
- Star **51212**、Fork 5158、open issues 290、subscribers 189，2024-12-01 建仓，**当天仍在 push**（2026-11-08 12:33 UTC）。
- 最新 Release **v0.14.1（2026-10-30）**；但仓库根 `package.json` 版本已是 **0.15.1** —— 主干领先已发布版本，属高频迭代。
- 发布面很广：Windows exe、macOS dmg/zip（arm64 + x64）、Linux deb/rpm/AppImage/flatpak/pacman、Android apk、iOS ipa、以及 winget / scoop / brew / nix 安装方式。

**技术栈与架构**（[README](https://github.com/moeru-ai/airi/blob/main/README.md)、[package.json](https://github.com/moeru-ai/airi/blob/main/package.json)）
- **pnpm 11 monorepo + Turborepo + Vue 3 + UnoCSS + TypeScript**，`packageManager: pnpm@11.24.0`。
- 三个 stage：`stage-web`（浏览器）、`stage-tamagotchi`（**Electron 桌面**）、`stage-pocket`（Capacitor 移动）。
- 共享包：`stage-ui`、`core-agent`、`core-character`、`pipelines-audio`、`stage-ui-live2d`、`stage-ui-three`、`server-sdk`、`server-runtime`。
- 集成：discord-bot、minecraft-bot、telegram、factorio；另有 hosted backend（api-server / auth-server / PostgreSQL / Redis）。
- 渲染：**Live2D + VRM（three.js）双栈**，带自动眨眼、auto look-at、idle 眼动。
- LLM：自研 `xsai`，README 列出 **约 30 家** provider（OpenAI / Anthropic / Gemini / DeepSeek / Qwen / Ollama / vLLM / SGLang / OpenRouter…）。
- 语音：多 provider TTS（ElevenLabs / Azure / OpenAI 兼容 / 阿里 / 本地 Kokoro）+ 客户端 ASR + VAD。
- 桌面端还声称可用 **CUDA / Apple Metal**（经 HuggingFace `candle`）跑本地推理。

**许可证**
- 代码：**MIT License**，`Copyright (c) 2024-PRESENT Neko Ayaka`（[LICENSE](https://github.com/moeru-ai/airi/blob/main/LICENSE)），`package.json` 也写 `"license": "MIT"`。
- **美术资源许可：README 与 LICENSE 都没有单独声明**。README 只说图标、Live2D 工具等衍生项目放在 `@proj-airi` 组织下，**没有**给"随包发布的 AIRI 形象（Live2D/VRM）适用什么许可"的说明。
  - 这意味着：**不能假定 MIT 覆盖角色形象**。详见 §6 与 §8。

**功能支持**

| 能力 | 支持 | 依据 |
|---|---|---|
| 透明窗口 | ⚠️ 未验证 | README 无任何 transparent / overlay 描述，它是"应用窗口"形态 |
| 桌面置顶 | ⚠️ 未验证 | 同上 |
| 开机自启 | ⚠️ 未验证 | 同上 |
| Live2D 自定义模型 | ✅ | Live2D + VRM 双栈，Roadmap 打勾 |
| 长期记忆 | ⚠️ **WIP** | Roadmap：`Memory` 大项**未打勾**；子项里"浏览器内数据库（DuckDB WASM / pglite）"已勾，"Memory Alaya"标注 WIP |
| 任务提醒 | ❌ | README 无任务/日程/提醒功能 |
| 多角色 | ✅ | 有 character switcher、AIRI Cards、Flux packages |

**集成 DSH 的难度：中**
- 它是四个里**唯一有"对外接口"概念**的：`server-runtime` + `server-sdk` 组成的 **server channel（WebSocket）**，discord-bot / minecraft-bot 就是通过它接进来的（README 架构图明确画了 `SDK <-->|server channel| Runtime`）。理论上 DSH 插件可以作为又一个 channel 客户端接进去。
- 但代价：接的是**一个 628 MB / 51k star / 每天几十次提交的巨型应用**，不是 SDK；版本漂移、构建复杂（pnpm workspace + turbo + native 依赖）、文档以站点为主。为一个"叠层小助手"背这套，性价比极低。

**常驻内存/CPU**：README 未给 → **未知，需实测**。硬指标：Windows 安装包 **≈493.6 MB**。

---

## 3. 功能矩阵（横向）

| 能力 | desktop-companion | OpenMeido | VPet | AIRI |
|---|---|---|---|---|
| 透明窗口 | ✅ | ✅ | ✅ | 未验证 |
| 桌面置顶 | ✅ | ✅ | ✅ | 未验证 |
| 开机自启 | ✅ | 未验证 | 未验证 | 未验证 |
| 点击穿透 | ✅ | ✅ | — | — |
| Live2D 自定义模型 | ✅（model3.json 文件夹） | ✅（zip 导入 + AI 绑表情） | ❌（插件才行） | ✅ |
| 长期记忆 | ❌（10 轮） | ✅（sqlite + 本地向量 + RAG） | ❌ | WIP |
| 任务提醒 | ✅（截止日/休息/专注） | ✅（自然语言待办） | ❌（插件） | ❌ |
| 多角色 | ⚠️ 可换不可同屏 | ⚠️ 4 persona 单形象 | ⚠️ MOD 换皮 | ✅ |
| 语音 | 音效（日/越/英） | ✅ 4 种 TTS | — | ✅ 多 provider + ASR |
| 自带 AI | Claude / Gemini | 8 家（含 LM Studio 本地） | ChatGPT 窗 | ~30 家 |
| 对 DSH 的可集成性 | 差（Rust 壳） | 中（同栈但单体 + GPL） | 差（.NET） | 中（有 WS channel） |

---

## 4. 许可证专题：代码许可 ≠ 资源许可（本次调研最重要的发现）

### 4.1 三者分离的现实

| 层 | 典型许可 | 能不能商用 | 能不能再分发 | 要不要署名 |
|---|---|---|---|---|
| **代码** | MIT / Apache-2.0 / GPL-3.0 | MIT、Apache 可以；GPL 需开源 | MIT/Apache 可以 | MIT/Apache 保留版权声明 |
| **原创美术** | CC BY-NC 4.0（desktop-companion） | ❌ 不可以 | ✅ 可以（非商用） | ✅ 必须 |
| **Live2D 官方 sample** | Free Material License + 各角色单独条款 | ⚠️ 分角色，见下 | ⚠️ 受限 | ✅ 指定文案 |
| **Live2D 运行时** | Cubism Core 专有 + Cubism Components 开源 | 需遵守 SDK 协议 | 需遵守 SDK 协议 | 视协议 |
| **VPet 动画/图片** | 自定义条款 | ⚠️ 要弹窗 + 邮件报备 + 禁售卖 | ⚠️ 禁收费分发 | ✅ 必须 |

### 4.2 Live2D 官方模型的真实限制（已核到原文）

来源：[Terms of Use for Live2D Cubism Sample Data](https://www.live2d.com/en/learn/sample/model-terms/)（页面标注发布/修改于 2026-03-06），配合 [Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)。

该页面把 sample 数据分成**三类，条款完全不同**：

1. **Live2D 原创角色**（Izumi、Kei、Shizuku、Mao Niziiro、Nito、**Haru**、**Hiyori Momose**、**Miara**、Mark-kun、Wankoromochi…）
   - 使用时必须同意 Free Material License Agreement；
   - 还要遵守**每个角色的单独限制**，其中最关键两条：
     - **Miara、Hiyori Momose：「No changes of any kind to the design of this character are permitted.」**
     - Mark-kun 不得改画成美型；Nito 必须保持头身比；Shizuku 不得改名/改设定；
   - **必须标注版权声明**，给了两套文案：
     - 有简介位（YouTube/B 站/应用商店描述）："This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author's sole discretion."
     - 无简介位（Twitter/TikTok 等）："This content uses sample data owned and copyrighted by Live2D Inc."
2. **合作角色（Collaboration characters）：Jin Natori、Tsumiki Harugasa**
   - 原文：**"You may neither use Collaboration Character and the related data for commercial purposes nor alter nor distribute them."**
   - 即：**禁商用 + 禁改编 + 禁分发**；且 Jin Natori 必须保持"管家"身份设定。
3. **外部授权角色**：**Hatsune Miku**（Crypton 的 Character Usage Guidelines / piapro 条款）、**Unity-chan**（Unity Technologies Japan 的指南与许可）—— 责任在用户，Live2D 不担责。

> 这条直接命中两个项目：
> - **OpenMeido 默认捆绑 Hiyori + Natori**，其中 **Natori 属于"合作角色"→ 不可商用、不可改编、不可分发**。它 README 里那句"商业使用前请阅读条款"其实还说得太轻。
> - **desktop-companion 捆绑 Hiyori、Haru、Mao、Miara**，其中 **Hiyori 与 Miara 明文禁止任何设计改动** —— 所以"二创/换色/改模"这条路对它们是堵死的，而 CC BY-NC 的"remix"许可并不适用于这些官方模型。

### 4.3 关于 Cubism SDK / Cubism Core

- OpenMeido 的 README 写得很清楚，可作交叉验证：**Live2D Cubism Core — Cubism SDK Release License（专有）**；**Cubism Components（JS runtime）— MIT**。
- 官方入口：[Cubism SDK Release License](https://www.live2d.com/en/sdk/license/)、[Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)、[Live2D Open Software License Agreement](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html)。
- 注意 Free Material License 页面里出现过 **"Middle-Scale or Large-Scale Enterprise"** 与 **§2.1.3.2** 的表述 —— 说明该协议对**企业规模分档**。具体营收阈值我**没有逐条核验**（见 §8）。

### 4.4 "是否含官方动漫角色素材"

| 项目 | 是否含第三方/官方动漫角色 |
|---|---|
| desktop-companion | 含 **Live2D 官方 sample 4 个**（Hiyori/Haru/Mao/Miara，© Live2D Inc.）；**不含**初音/Unity-chan |
| OpenMeido | 含 **Hiyori + Natori**（© Live2D Inc.）；Natori 为合作角色，限制最严 |
| VPet | 自己的 VUP 角色动画（版权属"虚拟主播模拟器制作组"），非官方动漫 IP |
| AIRI | README 未声明；其形象为项目自有角色（AIRI），但**许可未写明** |

---

## 5. 为什么"直接 fork 其中一个"对本项目不成立

### 5.1 逐条对照本项目的四个否决点

| 否决点 | desktop-companion | OpenMeido | VPet | AIRI |
|---|---|---|---|---|
| **许可证传染性** | MIT，无传染 ✅ | **GPL-3.0，强传染 ❌** | Apache-2.0，无传染 ✅（但资产另有条款） | MIT，无传染 ✅ |
| **美术资源不可分发** | ❌ CC BY-NC + Live2D sample | ❌ Live2D sample（含禁商用角色） | ❌ 自定义动画条款 | ⚠️ 未声明，风险未知 |
| **架构只做聊天/陪伴，不做时间规划** | ⚠️ 有任务+截止提醒，但没有"日程规划/排期"引擎 | ⚠️ 有自然语言待办+提醒，无排期 | ❌ 游戏化桌宠 | ❌ 纯陪伴/直播向 |
| **本机无法离线构建** | ❌ 要 Rust stable + MSVC + Tauri 依赖 | ❌ 要 Node + pnpm + 330 MB 产物 | ❌ 要 VS + .NET + 管理员 mklink | ❌ 要 pnpm monorepo + turbo + 493 MB 产物 |
| **能否被 JS 插件驱动** | ❌ Tauri/Rust | ⚠️ 同栈但无对外 API | ❌ .NET | ⚠️ 有 server channel |

### 5.2 分别说清楚

**（1）desktop-companion：技术上最接近，法律上最不能 fork**
它的产品形态（透明置顶 + 选中即操作 + 任务截止提醒 + 休息/专注）几乎就是本项目想要的"叠层助手"。但：
- 它的**灵魂是那 19 个 Live2D 模型和四套 Lounge 立绘**，全部 CC BY-NC 4.0 —— 你不能把它做成要卖/要挂赞助的产品；
- 官方 sample（Hiyori/Miara）**连设计都不能改**；
- 它没有"排期/规划"能力，只有"任务的截止时间 + 提醒"，这是两件事；
- Rust 壳让 DSH 的 JS 侧完全插不进去。
→ **可作为"产品需求规格书"来读，不可作为代码基座。**

**（2）OpenMeido：架构最值得学，但 GPL 让它成为"毒药基座"**
- 它的 DESIGN.md 明说选 GPL 就是为了**逼所有 fork 保持开源**。本项目若要做闭源商业版，一行都不能链接。
- 但它把"陪伴型 Agent 的工程边界"写得很成熟（renderer 不碰网络、core 平台无关、L1/L2/L3 记忆、流式 PCM 驱动口型、工具调用走 SDK）—— 这些是**思想**，思想不受版权保护，可以自由借鉴。
- 且它**默认捆绑了 Natori**，合作角色禁商用/禁分发 —— 连"拿来当 demo 用"都要小心。

**（3）VPet：代码最自由，资产最受限，栈最不搭**
- Apache-2.0 是全四个里对商用最友好的代码许可；
- 但**动画与图片不在 Apache-2.0 里**：商用要弹窗告知 + 邮件报备 + 禁售卖，分发禁收费。你 fork 完发现"能跑但没有合法皮肤"；
- C#/WPF 与 DSH 的 Electron/Node 完全不通用；
- 它本质是**养成游戏**（饥饿/工作/创意工坊），不是助手。

**（4）AIRI：最闪亮，也最不划算**
- MIT 干净，51k star 说明生态健康；
- 但它是"AI VTuber 平台"，不是"桌面叠层助手"：没有任务提醒、记忆还在 WIP、透明叠层形态未在文档中出现；
- 628 MB 仓库 / 493 MB 安装包 / 每天几十次提交 —— 把它当依赖等于把一条湍急的河接进自家水管；
- 角色形象许可**未声明**，这比"明说 CC BY-NC"更危险（无法判断能否商用）。

### 5.3 关于"无法在用户机器上离线构建"

这点值得单独强调，因为它是**交付形态**问题，不是技术偏好：

| 项目 | 构建前置（均为 README/文档明示） | 终端用户机器上可行吗 |
|---|---|---|
| desktop-companion | Rust stable + MSVC C++ build tools + Node 18+ + Tauri prerequisites | ❌ 普通用户没有 Rust/MSVC |
| OpenMeido | Node + `npm install` + electron-builder；产物 330 MB | ⚠️ 可行但极重，且需联网拉依赖 |
| VPet | Visual Studio + .NET + **管理员权限 mklink** | ❌ 更不可能 |
| AIRI | pnpm 11 + turbo monorepo + 493 MB 产物 | ❌ 依赖树巨大 |

→ 所以"让用户在本地构建"这条路对四个项目全部关闭。**要交付，必须由我们自己产出预编译产物**；而一旦要自己产出产物，就没有理由套一个我们不熟悉的构建链。

---

## 6. 推荐路线

### 6.1 结论：自研轻量叠层客户端，复用"架构思想"而非代码

**形态选择（二选一，按交付优先级）**

| 方案 | 组成 | 优点 | 代价 | 适用 |
|---|---|---|---|---|
| **A. Electron 叠层（推荐给 DSH）** | 一个独立 `BrowserWindow`：`transparent: true` + `alwaysOnTop` + `setIgnoreMouseEvents(true, {forward:true})`，渲染 `pixi.js` + `pixi-live2d-display`；与 DSH 用本地 WS/HTTP 通信 | 与 DSH **同运行时**（Node/Electron），插件纯 JS 即可；Live2D 生态现成；开发最快 | 常驻内存基线高（Chromium）；安装包 ~150 MB+ | 想快速落地、和 DSH 共享一套 Node 能力 |
| **B. WPF + WebView2 叠层** | WPF 做窗口/托盘/热键/自启，WebView2 里跑同一套 pixi Live2D 页面 | 冷启动与内存更省；系统集成（全局热键、开机自启、任务栏行为）在 Win32 层更顺 | 需要 C# 侧另写一套与 DSH 的桥；两套语言 | 要求"轻、稳、常驻"的正式版 |

> 我倾向 **先用 A 做 MVP**（因为 DSH 本身是 Electron+Node，复用最大化），**把渲染层做成一个纯 Web 页面**（Live2D + 气泡 + 提醒卡），这样将来要换到 B 时，**渲染层零改动**，只换壳。这是从 desktop-companion（Tauri 壳 + WebView 渲染）和 OpenMeido（Electron 壳 + React 渲染）身上学到的**同一课：壳与渲染解耦**。

### 6.2 可以直接借鉴的"思想清单"（不含代码）

| 来源 | 借鉴什么 | 为什么值得 |
|---|---|---|
| **desktop-companion** | ①"选中文本 → 浮出小花 → 点击/长按出径向菜单"的交互；②把"翻译/回复/存任务/存笔记"做成**同一入口的多个动作**；③任务截止的四段提醒（当天早/提前 1h/到点/逾期每日）；④`model3.json` 文件夹即插即用 | 这是"叠层助手"最省打扰的交互范式，比聊天窗好 |
| **OpenMeido** | ① **L1 工作窗口 / L2 向量召回 / L3 反思事实** 三层记忆；② renderer 不碰网络、API key 只在 main；③ `core/` 平台无关 + 存储/通知藏在接口后；④ 流式 PCM 驱动 Live2D 口型；⑤ 安全清单（zip 路径穿越、CSP、单实例、DPAPI 加密 key、防提示注入） | 直接把"陪伴 Agent 的工程边界"抄过来，能省几个月踩坑。它的 v0.4.0 release notes 本身就是一份高质量的**缺陷清单**，逐条对照可避免重犯 |
| **VPet** | ① 动画状态机（32×4×3）与"状态→动画"的映射表；② MOD/资源包目录规范（用户可换皮而不动代码）；③ `Core` 可内嵌（库化思维） | 资源包化是"合法换皮"的唯一出路：**代码自带空壳，形象由用户自备** |
| **AIRI** | ① provider 抽象（一个 `xsai` 式薄层覆盖 30 家）；② **server channel（WS）解耦**：UI 与能力分离，bot 作为客户端接入；③ 音频管线（VAD→ASR→LLM→TTS 流式） | 这套解耦正好是 DSH 插件需要的形状：**插件只做通道，不碰渲染** |

### 6.3 与 DSH 的具体接入设计（建议）

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  DSH（Electron + Node）      │        │  叠层客户端（新写，轻）        │
│  - Agent / 规划 / 工具调用    │◄──WS──►│  - 透明置顶窗口 + Live2D      │
│  - 长期记忆（SQLite）         │  HTTP  │  - 表情/口型/气泡              │
│  - 提醒调度（主进程 timer）    │        │  - 无状态，纯展示 + 输入        │
└─────────────────────────────┘        └──────────────────────────────┘
         ▲  插件（JS）：起子进程 / 转发消息 / 注册本地端口
         └──────────────────────────────────────────────────────────
```

- **职责切分**：**DSH 拥有"大脑 + 记忆 + 调度"**，叠层客户端只拥有"脸 + 耳朵 + 嘴"。这样"时间规划"能力天然落在 DSH 侧（它本来就能跑 Agent、能起本地服务、能拉子进程），不需要向任何开源项目借。
- **通信**：叠层客户端启动时连 `ws://127.0.0.1:<port>`（DSH 插件起的本地服务），协议自定义三五种消息：`say` / `emotion` / `reminder` / `state` / `input`。**不要**让叠层客户端直接持有 API key。
- **插件形态**：DSH 插件负责 ① 拉起叠层进程（`child_process.spawn`）② 端口分配与健康检查 ③ 把 Agent 的 token 流按句切分推给叠层 ④ 进程退出时清理。**全程 JS，零 Rust、零 C#。**
- **形象来源（关键）**：**不要内置任何 Live2D 官方 sample**。三条合规路径：
  1. 自己/外包画一套模型（最干净，成本最高）；
  2. 在 [nizima](https://nizima.com/) 等平台购买带商用授权的模型（查清授权范围）；
  3. 首发**不带形象**，提供"导入你自己的 `model3.json`"（学 desktop-companion 的"load from any folder"），把授权责任交给用户 —— 这也是 VPet 创意工坊模式的法律逻辑。

---

## 7. 绝对不能直接拿来用的东西（红线清单）

| # | 对象 | 出处 | 为什么不能 |
|---|---|---|---|
| 1 | **Gothic Aristocrat 等 19 个 Live2D 模型、四套 Lounge 立绘、Miu 表情、街机图、水族箱图** | desktop-companion `ASSETS-LICENSE.md` | **CC BY-NC 4.0**：禁商用（"don't use it in a paid or monetized product, service, or promotion"）；商用需另询作者 |
| 2 | **Hiyori / Miara / Haru / Mao 等 Live2D 原创角色** | Live2D Sample Terms | Free Material License 约束 + **Hiyori、Miara 禁止任何设计改动**；必须附指定版权声明 |
| 3 | **Jin Natori（Natori）/ Tsumiki Harugasa** | Live2D Sample Terms（合作角色） | **禁商用 + 禁改编 + 禁分发**（原文明确） |
| 4 | **初音未来 / Unity-chan 素材** | Live2D Sample Terms（外部授权） | 受 Crypton / Unity Japan 各自指南约束，与 Live2D 无关 |
| 5 | **VPet 的动画帧与内置图片** | VPet README「动画版权声明与授权」 | 非 Apache-2.0：商用需弹窗告知 + 邮件报备 + **禁售卖**；分发**禁收费** |
| 6 | **OpenMeido 的源码** | GPL-3.0 | 强传染；闭源/收费产品链接即违规 |
| 7 | **各项目的名称、图标、角色名** | 商标/商誉 | VPet 是 Steam 上架产品；`vpeticon.*`、AIRI 名称均不宜复用 |
| 8 | **项目内音频（音效/语音库）与 TTS 音色** | 各项目 media | 音效多为作者自制或第三方，未见独立授权声明；TTS 音色（如 GPT-SoVITS 克隆）另有声音权问题 |
| 9 | **Cubism Core（moc3 运行时）** | Live2D | 专有软件，须遵守 Cubism SDK Release License；**只有 Cubism Components（JS）是 MIT** |

**可以放心用的**：pixi.js（MIT）、pixi-live2d-display（MIT）、Cubism Components JS（官方开源协议）、sqlite-vec、better-sqlite3、electron-vite、Vercel AI SDK、xsai 等**第三方库本身** —— 这些是项目的依赖，不是项目的资产。

---

## 8. 我没有验证到的事

以下内容我**没有**拿到证据，请勿当作结论使用。逐条注明原因：

**A. 抓取失败（技术原因）**
1. **GitHub 在调研后段大面积返回 504**（页面是 GitHub 的 "Unicorn! / We couldn't respond to your request in time" 网关超时页）。因此以下内容**未取到**：
   - `desktop-companion/src-tauri/Cargo.toml`（Rust 依赖清单）→ 它的依赖体积只能定性说"较重"，没有量化；
   - `desktop-companion/models/` 与 `anna-app/` 目录内容 → **无法确认仓库内是否直接存放了 Live2D 模型文件**（只能从 `ASSETS-LICENSE.md` 说"模型在 `models` release 的 zip 里"间接推断）；
   - `VPet` 的 releases 列表与 tags（`/releases/latest` 返回 404 这一条是有效证据，但"历史上是否有过 release"未验证）。
2. **`raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 在本机被重置**（`ECONNRESET`），所以所有文件正文是通过 `api.github.com/contents` 的 base64 通道取的，**只能取到单文件，不能取整树**。
3. `CHANGELOG.md`（desktop-companion，69 KB）、`PLAN.md`（168 KB）、`BUILD.md`（OpenMeido）等大文件**未读**，因此"历史演进/放弃过的功能"未考察。

**B. 文档本身没写（不是抓不到，是对方没说）**
4. **四个项目的 RAM / CPU 常驻数据，全部没有**。README 里没有任何内存或占用说明 → 本报告一律写"未知，需实测"。安装包体积只是**磁盘**指标，不能推内存。
5. **AIRI 的透明窗口 / 桌面置顶 / 开机自启 / 任务提醒**：README 与 Roadmap 均未提及。我**没有**去读它的 docs 站点或源码，所以这四项是"未验证"，不是"不支持"。
6. **AIRI 随包美术资源（AIRI 形象 Live2D/VRM、图标）的许可**：README 与 LICENSE 都没有单独声明。我**不敢推断**它是否可商用 —— 这类项目常见做法是把模型放在 `@proj-airi` 的其他仓库并单独授权，但**我没有证据**。
7. **OpenMeido 是否支持开机自启**：README/DESIGN 未写，未验证。
8. **VPet 是否支持开机自启、是否有长期记忆**：README 未写；`winCGPTSetting` 的具体能力（只是聊天窗还是有工具调用）**未读源码，不确定**。
9. **"多角色同屏"**：四个项目都只能**单角色**（可切换），"同时出现两个角色"未见任何文档支持 —— 但这属于**从文档推断**，未实测。

**C. 法务细节未逐条核验**
10. **Live2D Free Material License Agreement 正文**（含 §2.1.3.2、Middle/Large-Scale Enterprise 的营收分档阈值）：我只读了 [Sample Terms 汇总页](https://www.live2d.com/en/learn/sample/model-terms/)，**没有逐条读 EULA 正文**。做商业决策前必须让法务读原文。
11. **Cubism SDK Release License 的分档与义务**（[链接](https://www.live2d.com/en/sdk/license/)）：**未读**。
12. **CC BY-NC 4.0 的"NonCommercial"边界**（例如"带广告的免费产品"算不算商用）：这是公认的灰色地带，**本报告不做判断**，只按最保守解释（禁商用）处理。
13. **OpenMeido 的 Natori 与 README 的"Haru"表述存在版本差异**：`DESIGN.md`（2026-05-17 草稿）写的是"Hiyori / Haru"，当前 README 写的是"Hiyori / Natori"。**哪个是当前实际捆绑的，未通过二进制或资源目录核实**。若确为 Natori，则 §4.2 的"合作角色禁商用"直接适用于它。

**D. 会随时间变化的数据**
14. 所有 star / fork / 提交时间 / Release 版本都是 **2026-11-08 的快照**；`airi` 主干版本（0.15.1）已高于最新 Release（0.14.1），说明它的节奏是"先合主干再发版"，下次调研数字会变。

---

## 附录：本次实际打开的 URL

**GitHub（仓库页 / API / 文件）**
- https://github.com/xShiroeNguyenx/desktop-companion
- https://api.github.com/repos/xShiroeNguyenx/desktop-companion
- https://api.github.com/repos/xShiroeNguyenx/desktop-companion/contents/
- https://api.github.com/repos/xShiroeNguyenx/desktop-companion/releases/latest
- https://github.com/xShiroeNguyenx/desktop-companion/blob/main/LICENSE
- https://github.com/xShiroeNguyenx/desktop-companion/blob/main/ASSETS-LICENSE.md
- https://github.com/xShiroeNguyenx/desktop-companion/blob/main/README.md
- https://github.com/xShiroeNguyenx/desktop-companion/blob/main/package.json
- https://api.github.com/repos/lshhhhhhh/OpenMeido
- https://api.github.com/repos/lshhhhhhh/OpenMeido/releases/latest
- https://github.com/lshhhhhhh/OpenMeido/blob/main/README.md
- https://github.com/lshhhhhhh/OpenMeido/blob/main/LICENSE
- https://github.com/lshhhhhhh/OpenMeido/blob/main/package.json
- https://github.com/lshhhhhhh/OpenMeido/blob/main/DESIGN.md
- https://api.github.com/repos/LorisYounger/VPet
- https://api.github.com/repos/LorisYounger/VPet/releases/latest → **404 Not Found**
- https://github.com/LorisYounger/VPet/blob/main/README.md
- https://github.com/LorisYounger/VPet/blob/main/LICENSE
- https://api.github.com/repos/moeru-ai/airi
- https://api.github.com/repos/moeru-ai/airi/releases/latest
- https://github.com/moeru-ai/airi/blob/main/README.md
- https://github.com/moeru-ai/airi/blob/main/LICENSE
- https://github.com/moeru-ai/airi/blob/main/package.json

**Live2D 官方**
- https://www.live2d.com/en/learn/sample/model-terms/ ✅（已读到原文表格）
- https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html（仅引用链接，**未读正文**）
- https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html（仅引用链接，未读）
- https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html（仅引用链接，未读）
- https://www.live2d.com/en/sdk/license/（仅引用链接，未读）

**尝试但失败**
- `https://raw.githubusercontent.com/...`（全部仓库）→ `ECONNRESET`
- `https://cdn.jsdelivr.net/gh/...`（jsDelivr 镜像）→ `ECONNRESET`
- `https://www.live2d.com/en/terms/live2d-free-material-license-agreement/` → 404（该路径已废弃，正确路径在 `/eula/` 下）
- `https://api.github.com/repos/xShiroeNguyenx/desktop-companion/contents/src-tauri` → 504
- `https://api.github.com/repos/LorisYounger/VPet/releases?per_page=3` → 504
