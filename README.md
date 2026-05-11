# mavis-pet

> 屏幕上的动画桌面宠物 floater,根据 [mavis](https://mavis.run) 的活动实时反应。完全兼容 [petdex](https://github.com/crafter-station/petdex) 的 sprite 包格式。

![status: v0](https://img.shields.io/badge/status-v0-blue) ![macOS arm64](https://img.shields.io/badge/macOS-arm64-success) ![license: MIT](https://img.shields.io/badge/license-MIT-green)

mavis 在跑工具时宠物 `run`,出错 `failed`(沮丧 2 秒后回 run),输出完一段回复 `wave`(挥手),全局静默 30 秒回 `idle`。

## Quick start

```bash
npm i -g mavis-pet
mavis-pet install boba          # 装一只宠物(petdex gallery)
mavis-pet hook install          # 把 3 条 mavis hook 写入 ~/.mavis/hooks/
mavis-pet start                 # 启动 broker + floater
```

floater binary 不在 npm 里(GUI 二进制太大),首次 `start` 如果找不到会提示去 [GitHub Release](https://github.com/<your-org>/mavis-pet/releases) 下 .app 解压到 `~/.mavis/pet/floater`。

或者一键脚本:

```bash
curl -fsSL https://raw.githubusercontent.com/<your-org>/mavis-pet/main/install.sh | sh
```

## 怎么工作

```
mavis daemon ──hook script──► broker (Node, :7857) ──WS──► floater (Tauri)
```

- **broker** 维护 per-session 状态机,聚合后推宠物状态
- **floater** Tauri 透明 always-on-top 窗口,渲染 spritesheet 动画
- **hook** mavis 注册的 3 条 user script hook,通过 stdin 拿 sessionId/toolName 然后 POST broker

详细协议见 [`packages/broker/PROTOCOL.md`](./packages/broker/PROTOCOL.md)。

## CLI 命令

```bash
mavis-pet install <slug>      # 从 petdex 装宠物到 ~/.mavis/pets/<slug>/
mavis-pet list                # 列已装宠物 + 标记 active
mavis-pet switch <slug>       # 切 active 宠物(broker 热重载)
mavis-pet start               # 启 broker + floater
mavis-pet stop                # 关
mavis-pet status              # 看状态
mavis-pet hook install        # 注册 3 条 user hook
mavis-pet hook uninstall      # 删那 3 条
```

env:
- `MAVIS_PET_BROKER_PORT`(默认 7857)
- `MAVIS_PET_FLOATER`(覆盖 floater binary 路径)
- `MAVIS_PET_MANIFEST`(覆盖 petdex manifest URL)

## 项目结构

```
mavis-pet/
├── packages/
│   ├── broker/      Node + TS,事件中枢 + 状态机 + WS server,33/33 测试
│   ├── floater/     Tauri (Rust),透明 always-on-top sprite 动画窗口
│   └── cli/         npm 包 mavis-pet,顶层命令
├── plan-mavis-pet.md       原始设计文档
├── roadmap-mavis-pet.md    v0 不做的 R1-R10
└── MAVIS-PET-V0-SUMMARY.md
```

## 跟 codex 桌面宠物的关系

- **Sprite 资源 100% 兼容**(都用 petdex 的 8 行 × 6 帧 spritesheet 格式)
- 桌面端独立实现(我们用 Tauri,petdex-desktop 用 Zig)
- Hook 集成走 mavis 自己的 hook 系统(petdex 那边走 codex 的)
- 已知差距(roadmap 里):speech bubbles、`/pet` slash command、Hatch-pet 创建流程、6 种附加状态(jump/review/extra1-2)

## 平台支持

- ✅ macOS arm64 (Apple Silicon)
- 🚧 macOS Intel — 需要 build,没自动 release
- 🚧 Linux/Windows — Tauri 跨平台原则上可,需要分别 spike

## License

MIT — see [LICENSE](./LICENSE)

## 致谢

- [petdex](https://github.com/crafter-station/petdex) — sprite 格式 + manifest API + 全部宠物素材
- [mavis](https://mavis.run) — 提供 hook 系统让我们能挂上去
