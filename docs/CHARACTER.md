# 角色系统说明（汐 / Xi）

## 1. 形象来源与授权

- 立绘：本机 `assets\character\source-850.png`（用户自备的 AI 生成图，850×1275）。
- 衍生资源（抠图、分层、表情帧、特效）由 `tools\prep_character.py`、`tools\build_character.py` 在本机生成，
  不含任何第三方动漫角色素材，也不含 Live2D 官方模型。
- **仅个人使用**：这套形象没有商用授权，请不要分发或用于商业项目。
- 若要换角色：替换 `source-850.png` 后重跑两个脚本即可（需重新量眼睛/嘴的坐标，见 §4）。

## 2. 为什么不是 Live2D

调研结论（见 `docs\OPEN-SOURCE-REVIEW.md`）：Live2D 的官方 sample 模型与 Cubism Core 有明确授权限制，
合作角色模型（如 Natori）明文禁止商用/改编/分发；四个候选开源桌宠的美术资源都不能随本项目分发。
因此 v1 采用**自研分层骨骼（伪 Live2D）**：用同一张立绘切出可独立变换的图层，
配合整像素级变换与表情帧交叉淡入，达成"持续运动 + 五官状态"的观感，且完全离线、零授权风险。

## 3. 分层与动画

`assets\character\rig.json` 定义：

| 部件 | 内容 | 动画 |
|---|---|---|
| `body` | 颈线以下整身（含裙、腿、尾鳍） | 呼吸（ScaleY 0.55%）、摇摆（±0.55°）、上下浮动（±1.1px），全部绕"脚底中心" |
| `head` | 颈线以上（脸 + 头发 + 耳朵） | 绕颈部枢轴 (418,262) 旋转 ±2.6°、平移 ±0.6px |
| `head.variants` | `idle / talk / blink / happy` 四套烘焙表情 | 双层 Image 交叉淡入（眨眼 55–90ms，表情 180ms） |
| `fx.*` | sweat / zzz / sparkle / exclaim / think | 透明度补间 |

**表情帧是"修图烘焙"而不是贴一层皮**：把眼睛/嘴的区域用从下巴取的局部肤色按椭圆羽化盖掉，
再用 4 倍超采样画闭眼弧线与微笑线。这样接缝在 180px 显示尺寸下不可见，也不会出现"贴绷带"感。

头部与身体之间留 16px 重叠，避免点头时露缝。

## 4. 重新标定坐标（换图时）

1. `python tools\prep_character.py` → 输出 `build/base.png`（抠图）与 `build/debug-face.png`（带网格的调试图）。
2. 看 `debug-face.png` 量出：眼睛外框（含睫毛）、嘴巴外框、颈线高度、颈部枢轴。
3. 改 `tools\build_character.py` 顶部常量：`NECK_Y`、`NECK_PIVOT`、`EYES`、`MOUTH`。
4. `python tools\build_character.py` → 重新生成 `layers\*.png` 与 `rig.json`，并用 `build\preview-heads.png` 自检。

## 5. 状态机

`app\Pet.ps1` 里的 `$script:stateDef`：

| 状态 | 表情 | 特效 | 触发 |
|---|---|---|---|
| IDLE | idle | — | 默认 |
| GREETING | happy | sparkle | `/boot/hello` 返回 shouldGreet |
| THINKING | idle | think | 提问后等待 AI |
| TALKING | talk | — | 说话、气泡 |
| PLANNING | idle | think | 规划相关交互 |
| REMINDING | talk | exclaim | 收到提醒 |
| HAPPY | happy | sparkle | 任务完成 |
| FOCUS | idle | — | 专注模式（低幅运动） |
| SLEEPING | blink | zzz | 锁屏 / 休眠 |
| ERROR | talk | sweat | 服务不可用 |

状态切换只走 `Set-State`，**模型无法直接调用**；模型只能通过结构化接口影响业务数据，
桌宠再根据业务事件自行选择状态——这是"受约束的角色状态接口"。

## 6. 性能

- 动画时钟 30fps 上限，按状态降频：IDLE 12fps、FOCUS 10fps、SLEEPING 8fps，面板打开时 30fps。
- 图片按显示尺寸用 `DecodePixelWidth` 解码（默认约 200px 宽），不加载原始 850px。
- 空闲时无高频轮询：提醒 5s、桥接任务 120ms（仅在有在途请求时工作）、全屏检测 6s。

## 7. v1 明确没做的

- 手臂/手指骨骼（挥手）——单张立绘无法分离手臂，用身体倾斜 + 表情 + 特效替代。
- 多套服装 / 换装 / 角色切换 UI（`rig.json` 支持多角色目录，但 UI 只加载一个）。
- 视线跟随（180px 尺寸下位移不足 1px，做了也看不见），改为头部随状态微动。
- Live2D 模型导入（需要 Cubism Core 授权与额外运行时）。
