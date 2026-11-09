# 资源说明（NOTICE）

本仓库的**代码**采用 MIT 许可（见 [LICENSE](LICENSE)）。以下**美术与音频资源**不在 MIT 覆盖范围内。

## 角色立绘

- 文件：`assets/character/source-850.png` 及其派生的 `assets/character/layers/*.png`、`assets/character/icon.png`
- 来源：作者为本项目自备并用于本项目演示的二次元角色插画（AI 生成图，作者持有使用权）。
- 授权：**仅授权随本仓库用于本项目演示**。你可以阅读、学习、fork 代码，
  但**不要把这些图片直接用于你的产品或二次分发**。
- 想换成自己的角色：把 `assets/character/source-850.png` 换成你的图，然后跑
  `tools/prep_character.py` + `tools/build_character.py` 重新生成图层与 `rig.json`。
  详见 [docs/CHARACTER.md](docs/CHARACTER.md)。

## 其他

- 界面全部用 WPF 原生控件与矢量绘制，没有引入第三方图标库或字体文件。
- 没有内置任何 Live2D 官方模型或 Cubism 运行时。
  关于为什么不直接用 Live2D，见 [docs/OPEN-SOURCE-REVIEW.md](docs/OPEN-SOURCE-REVIEW.md)（含官方条款核对）。

## 第三方依赖

代码零 npm 运行时依赖，仅使用 Node.js 内置模块（`node:sqlite`、`node:http` 等）。
桌宠与规划中心使用 Windows 自带 .NET/WPF，无需额外安装。
