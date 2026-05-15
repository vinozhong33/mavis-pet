# mavis-pet

> 一只活在 macOS 桌面上的小宠物,根据 [mavis](https://mavis.run) 的事件实时反应——你发消息、agent 跑工具、tool 出错、session 结束,它都跟你互动。

![status: v0.7.5](https://img.shields.io/badge/status-v0.7.5-blue)
![macOS arm64](https://img.shields.io/badge/macOS-arm64-success)
![npm](https://img.shields.io/badge/npm-mavis--pet-cb3837)
![tests: 68/68](https://img.shields.io/badge/tests-68%2F68-brightgreen)
![license: MIT](https://img.shields.io/badge/license-MIT-green)

灵感来自 [petdex](https://petdex.crafter.run)(给 claude-code / codex / opencode 这些 cli agent 做的桌宠),但 petdex 没支持 MiniMax / mavis(GUI app + daemon 架构跟 cli agent 完全不同),所以单独定制了一个。

---

## 这是什么

mavis-pet 是给 mavis 用户的桌面伴随 floater。透明、永远置顶(包括别的 app 全屏时也浮在最上层)、可拖拽、**透明区域点击穿透**(v0.7.5)、零打扰。

宠物素材完全兼容 [petdex](https://petdex.crafter.run) 的开放 spritesheet 格式 —— 上面所有宠物 mavis-pet 都能装,包括 codex 用户已经下载过的(自动扫 `~/.codex/pets/`)。

### 它能给你的实际感受

- **干活时**:你和 mavis 聊天、agent 跑 bash/edit,宠物在屏幕角落小跑,**所有 active session 一栏卡片**实时显示状态(thinking / streaming / waiting / done),不用切 mavis 终端
- **多 agent 并发**:cron / worker / 主 session 同时跑,卡片自动堆叠(老卡上,新卡下,不互换位置),完成 30s 自动消失
- **告捷时**:agent 答完一段,宠物挥手 + `done!` 气泡 + 卡片绿色 ✓
- **报错时**:tool 失败,宠物秒变沮丧 + `oops` 气泡
- **等审批时**:perm 弹窗等用户决策,卡片亮起蓝色 ⏰,宠物头顶飘 `your turn`
- **session 起停时**:`morning` / `bye` 气泡

---

## 安装

**前置**:已经在用 MiniMax(Test 或正式包都支持)。**仅 macOS Apple Silicon**。

### 推荐(npm)

```bash
npm install -g mavis-pet
mavis-pet install
```

`install` 是一键 wizard:bootstrap + 配置 launchd KeepAlive,**重启电脑也自动起**。

装完桌面右下角会出现宠物。下次 mavis 跑任务时,卡片会自动出现在宠物上方。

### 验证

```bash
mavis-pet status
# active pet : super-goku
# broker     : running (state: run)
# floater    : running (pid xxxxx)
# hooks      : 6 installed
```

发条消息给 mavis,看宠物是否跳一下并飘 `hey!` —— 通了就装好了。

### 自己 build(改源码用)

```bash
git clone git@github.com:vinozhong33/mavis-pet.git ~/mavis-pet
cd ~/mavis-pet
(cd packages/broker && npm install && npm run build && npm test)
(cd packages/cli && npm install && npm run build && npm link)
(cd packages/floater && cargo build --release)   # 首编 ~2 分钟
cp packages/floater/target/release/mavis-pet-floater ~/.mavis/pet/floater
mavis-pet install
```

---

## 换宠物

```bash
open https://petdex.crafter.run     # 浏览全部 + 看 slug
npx -y petdex install <slug>        # 例:super-goku / doraemon / mochi
mavis-pet switch <slug>             # 立刻热重载,无需重启 floater
mavis-pet list                      # 看本机已装哪些(★ 标记 active)
```

### 自定义宠物

```
~/.mavis/pets/<your-slug>/
├── pet.json            # { "frame_w":192, "frame_h":208, "rows":9, "cols":8, "frame_count":6, "frame_duration_ms":1100 }
└── spritesheet.webp    # 1536×1872(默认 192×208 × 8 列 × 9 行)
```

行序对应状态:`idle / wave / run / failed / review / jump / extra1 / extra2`(从上到下)。每行前 6 帧是动画。

---

## CLI 速查

```bash
mavis-pet install                # 一键 wizard(首装用)
mavis-pet install <slug>         # 装一只 petdex 宠物
mavis-pet uninstall              # 完整卸载(launchd + binary + hooks)
mavis-pet list                   # 已装宠物 + active 标记
mavis-pet switch <slug>          # 切 active(热重载)
mavis-pet start / stop           # 启 / 关 broker + floater
mavis-pet status                 # broker / floater / hooks 状态
mavis-pet hook install           # 注册 6 条 mavis hook(install 已自动做)
mavis-pet hook uninstall         # 删那 6 条
```

环境变量:
- `MAVIS_PET_BROKER_PORT`(默认 7857)
- `MAVIS_PET_FLOATER`(覆盖 floater binary 路径)
- `MAVIS_PET_NONINTERACTIVE=1`(install 不弹任何确认,适合脚本)

---

## 8 状态映射

| 状态 | 触发 | 持续 | 默认气泡 |
|------|------|------|---------|
| `extra1` | SessionStart | 2.5s | morning |
| `extra2` | SessionEnd + 自动 forget | 2.5s | bye |
| `jump` | UserPromptSubmit | 1.5s | hey! |
| `failed` | PostToolUse 失败 / toolResult 含 error | 2s | oops |
| `wave` | MessageComplete | 1s | done! |
| `run` | PreToolUse / PostToolUse 成功 / streaming_text | 持续 | — |
| `review` | daemon SSE phase=waiting_perm | 持续 | your turn |
| `idle` | 30s 静默或无活动 session | 持续 | — |

优先级:`failed > review > jump > extra1 > extra2 > wave > run > idle`。多 session 并行时按这个顺序聚合全局 pet state。

---

## 工作原理

```
       ┌────────────────────┐
       │   mavis daemon     │
       │  (你已经在用)     │
       └─────────┬──────────┘
                 │ 6 个 user-script hook (PreToolUse / PostToolUse /
                 │   MessageComplete / UserPromptSubmit /
                 │   SessionStart / SessionEnd)
                 │ + SSE stream /mavis/api/events
                 │   (session.status_update phase=thinking|streaming_text|
                 │    waiting_perm|done — 用于卡片实时 subtitle)
                 ▼
       POST http://127.0.0.1:7857/event       ws://127.0.0.1:7857/ws
                 │                                    ▲
       ┌─────────▼──────────┐                         │
       │  broker (Node TS)  │  per-session 状态机 +   │
       │       :7857        │  SSE consumer +         │
       │                    │  全局聚合 + bubble 映射 │
       └─────────┬──────────┘                         │
                 │ broadcastState / broadcastSessions │
                 └────────────────────────────────────┘
                                ▼
                      ┌─────────────────────┐
                      │  floater (Tauri)    │  透明 NSPanel +
                      │   sprite + cards    │  click-through poller +
                      │                     │  跨 fullscreen Space
                      └─────────────────────┘
```

- **broker** 注入 `Clock` 抽象,68/68 测试都用 `FakeClock` 跑,时间相关行为完全确定
- **floater** 用 `tauri-nspanel`(BongoCat 同款)swizzle Tauri 的 NSWindow → NSPanel,加 NonactivatingPanel mask + Dock level + stationary collection behavior,跨 macOS 26 fullscreen Space 浮在最上(macOS 14/15 旧的 NSWindow + setLevel 配方在 macOS 26 失效,详见 [`tauri-macos-floater.md`](.))
- **click-through**:CSS 父级 `pointer-events: none` + Rust 8ms 轮询 cursor + 动态 toggle `NSWindow.ignoresMouseEvents`,boba 周围透明区域不"吃"点击
- **hook** payload 走 stdin(mavis daemon 协议),script 自动用 `/usr/bin/jq` 解析

详细 broker 协议见 [`packages/broker/PROTOCOL.md`](./packages/broker/PROTOCOL.md)。

---

## 项目结构

```
mavis-pet/
├── packages/
│   ├── broker/        Node + TS 事件中枢:状态机 + HTTP /event/status/switch + WS /ws
│   │                  68/68 测试,Clock 抽象,SSE consumer,bubble 字段,8 状态优先级
│   ├── floater/       Tauri (Rust):透明 NSPanel + sprite 动画 + 卡片堆叠 + click-through
│   └── cli/           npm 包 mavis-pet:install wizard / list / switch / start / stop / hook
│
├── plan-mavis-pet.md           原始设计
├── roadmap-mavis-pet.md        v0.4+ 路线
├── MAVIS-PET-V0-SUMMARY.md     完整功能 + 故障排查清单
└── release/                    每个 release 的 floater zip(npm publish 后非必需)
```

---

## 跟 codex / petdex-desktop 的关系

| | mavis-pet | petdex-desktop |
|---|---|---|
| 目标 agent | MiniMax / mavis(GUI + daemon) | claude-code / codex / opencode 等 cli agent |
| 宠物素材 | petdex 开放格式 | 同上(完全兼容) |
| 状态来源 | mavis daemon 6 个 hook + SSE event stream | cli agent 进程 hook |
| 进程架构 | broker (Node) + floater (Tauri/Rust) | 单一 native app |
| 装法 | `npm install -g mavis-pet` + wizard | `petdex up` |
| 多 session 卡片堆叠 | ✅ 老在上 / 新在下 / 不互换 | — |
| 透明像素点击穿透 | ✅ v0.7.5 | 视实现 |
| 跨别 app fullscreen | ✅ tauri-nspanel | 视实现 |

简短说:**mavis-pet 是给 daemon 架构 agent 准备的 petdex 类工具**,素材层共享,状态机 + 渲染独立实现。

---

## 路线图

### 已做
- ✅ 8 状态映射 + 气泡 + 优先级聚合(v0.2)
- ✅ daemon SSE consumer(`session.status_update` real-time phase + textPreview)(v0.6)
- ✅ 多 session 卡片堆叠 + 30s 自动消失(v0.6.1)
- ✅ install wizard + launchd KeepAlive 自启(v0.7)
- ✅ npm publish + 一键 `npm install -g mavis-pet`(v0.7.4 - v0.7.5)
- ✅ macOS click-through + 多屏定位(v0.7.5,by [@yuyuaichicu](https://github.com/yuyuaichicu))

### 未做(按优先级)
- 公司同事广泛接入 + 真实使用反馈收集(v0.7.5 现在阶段)
- 通过 mavis main repo PR 把 mavis-pet 升级成 mavis plugin / 内置子命令
- 跨平台:Linux / Windows(`mouse_position` crate 跨平台,理论可适配)
- 桌面通知:重要事件(perm 长时未审批 / agent failed)触发 macOS native notification
- mavis 自有 brand 宠物素材

完整描述 + 估算见 [`roadmap-mavis-pet.md`](./roadmap-mavis-pet.md)。

---

## Contributors

- **[vino](https://github.com/vinozhong33)** — 项目发起 + 主要开发
- **[@yuyuaichicu](https://github.com/yuyuaichicu)** — v0.7.5 macOS click-through + multi-monitor positioning ([PR #1](https://github.com/vinozhong33/mavis-pet/pull/1))

欢迎 PR / issue / 飞书 ping。任何让 mavis 用着更顺的想法都欢迎提。

---

## License

MIT — 见 [LICENSE](./LICENSE)

## 致谢

- [petdex](https://petdex.crafter.run) — 开放 sprite 格式 + manifest API + 全部宠物素材
- [mavis](https://mavis.run) — 提供 hook 系统 + SSE event stream 让我们能挂上去
- [tauri-nspanel](https://github.com/ahkohd/tauri-nspanel)(BongoCat 同款)— macOS 26 跨 fullscreen Space 配方
- 内部 mavis 团队的早期反馈
