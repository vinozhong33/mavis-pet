# mavis-pet v0 — 总结

## 这是什么

屏幕上的动画宠物 floater,根据 mavis 的 lifecycle 事件实时反应:
- mavis 调用工具 → 宠物 `run`
- mavis 工具失败 → 宠物 `failed`(2s 后回 run/idle)
- mavis 输出完一段回复 → 宠物 `wave`(1s 后回 idle)
- 全局空闲 30s → 宠物 `idle`

复用 [petdex](https://github.com/crafter-station/petdex) 的开放 spritesheet 格式,可以装它社区的所有宠物。

## 项目位置

`~/mavis-pet/` (你可以 `git init` 之后 push 到任何 git 远端)

```
mavis-pet/
├── packages/
│   ├── broker/      Node + TS,事件中枢 + 状态机 + WS server
│   ├── floater/     Tauri (Rust),桌面透明窗口 + sprite 动画
│   └── cli/         npm 包,顶层 mavis-pet 命令
├── plan-mavis-pet.md       初始设计文档
└── roadmap-mavis-pet.md    v0 不做的功能清单(R1-R10)
```

## 怎么用

**首次安装(已经做完了,你现在直接用):**
```bash
cd ~/mavis-pet/packages/cli
node bin/mavis-pet.mjs install boba    # 已装
node bin/mavis-pet.mjs hook install     # 已装
node bin/mavis-pet.mjs start            # 已起
```

**现在就有效**:你看到的屏幕上的宠物,会随我和你后面任何对话/工具调用动起来。

**日常控制:**
```bash
node bin/mavis-pet.mjs status      # 看状态
node bin/mavis-pet.mjs switch <slug>  # 切宠物(先 install)
node bin/mavis-pet.mjs stop        # 关
```

**全局安装(随时随地敲 mavis-pet,不用 cd):**
```bash
cd ~/mavis-pet/packages/cli
npm link
# 之后任意位置 `mavis-pet status` 就能跑
```

## v0 已实现

- [x] Broker:Node + TS,33/33 测试全过,状态机用 Clock 抽象保证时间确定
- [x] Floater:Tauri v2,透明 + frameless + always-on-top + 拖拽,3.2MB binary
- [x] CLI:install / list / switch / start / stop / status / hook install/uninstall
- [x] Petdex 兼容:能装它所有宠物,sprite 格式(8×9 frame, 192×208 px) 自动识别
- [x] 自动重连:broker 没起 floater 保持 idle,broker 上线自动连
- [x] 切宠物热重载:`switch` 通知 broker→floater 重新加载
- [x] mavis hook 集成:3 条 user hook 自动装到 mavis daemon
- [x] 给 main agent 的 skill 文档,排错指引

## v0 不做(roadmap)

详见 `~/mavis-pet/roadmap-mavis-pet.md` 的 R1-R10。简短:
- jump / review / extra1-2 状态(需要 mavis 加新 hook event)
- 桌面右键菜单切宠物
- macOS 系统通知(你已有飞书通道)
- Linux / Windows 支持
- PR 回上游 petdex
- 自家 mavis brand 宠物素材

## 故障排查 5 条

| 现象 | 处理 |
|---|---|
| 屏幕看不到宠物 | `mavis-pet status`,floater not running 就 `start`;running 但看不到可能在屏幕角外,`stop && start` |
| 宠物在屏幕但不切动画 | curl 模拟事件验 broker:`curl -XPOST ... /event`;broker state 不变 → broker 状态机有问题(跑 broker 包 npm test);state 变了但不切 → wsClients 看是不是 0,floater 重启 |
| mavis 干活宠物不反应 | `mavis hook list \| grep mavis-pet`,3 条都在?没有就 `hook install` |
| broker 起不来 | 7857 端口可能被占,`MAVIS_PET_BROKER_PORT=7858 mavis-pet start` |
| 某只宠物加载不出 | 看 `~/.mavis/pets/<slug>/` 有没有 `pet.json` + `spritesheet.{webp,png}`,缺了重 install |

## 接下来的事(要不要做你说)

- **R1 jump 状态** — mavis 加 `UserMessage` hook 后,你发消息时宠物跳一下。要做我去给 mavis 提需求
- **R8 右键菜单** — 装第 3 只宠物时再做最优
- **打包成正式 npm 包** — 做完了可以 `npx mavis-pet install boba` 一行起飞,适合分享

随时说"启动 R1"/"做右键菜单"/"打包发布",我从 roadmap 捞背景接着干。
