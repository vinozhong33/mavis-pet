# mavis-pet

> 一只活在你 macOS 桌面上的小宠物,根据 [mavis](https://mavis.run) 的事件实时反应——你发消息、agent 跑工具、tool 出错、session 结束,它都跟你互动。

![status: v0.2.1](https://img.shields.io/badge/status-v0.2.1-blue)
![macOS arm64](https://img.shields.io/badge/macOS-arm64-success)
![tests: 38/38](https://img.shields.io/badge/tests-38%2F38-brightgreen)
![license: MIT](https://img.shields.io/badge/license-MIT-green)

---

## 这是什么

mavis-pet 是给 mavis 用户配的桌面伴随 floater。透明、永远置顶(包括别的 app 全屏时也浮在最上层)、可拖拽、点不到、零打扰。

宠物素材完全兼容 [petdex](https://github.com/crafter-station/petdex) 的开放 spritesheet 格式——上面所有宠物 mavis-pet 都能装,**包括 codex 用户已经下载过的**(自动扫 `~/.codex/pets/`)。

### 它能给你的实际感受

- **干活时**:你和 mavis 聊天、agent 跑 bash/edit,宠物在屏幕角落小跑,**主任务在哪个进度一眼可见**,不用切 mavis 终端
- **告捷时**:agent 答完一段,宠物挥手 + 飘出 `done!` 气泡——再也不用盯着流式输出等结尾
- **报错时**:tool 失败,宠物秒变沮丧 + 飘 `oops` 气泡,不用滚屏找 stack trace
- **session 起停时**:`morning` / `bye` 气泡,知道有 cron / worker 醒了或刚下班
- **你发消息时**:宠物开心一跳 + `hey!` 气泡,人在终端都能感觉到"被回应"

### 8 状态完整映射

| 状态 | 触发 | 持续 | 默认气泡 |
|------|------|------|---------|
| `extra1` | SessionStart(session 启动) | 2.5s | morning |
| `extra2` | SessionEnd(session 结束 + 自动 forget) | 2.5s | bye |
| `jump` | UserPromptSubmit(你发消息) | 1.5s | hey! |
| `failed` | PostToolUse 失败 / toolResult 含 error | 2s | oops |
| `wave` | MessageComplete(agent 答完一段) | 1s | done! |
| `run` | PreToolUse / PostToolUse 成功 | 持续 | — |
| `idle` | 30s 静默或无活动 session | 持续 | — |
| `review`(v0.4 留位) | 等用户决策 | — | your turn |

优先级:`failed > review > jump > extra1 > extra2 > wave > run > idle`。多 session 并行时按这个顺序聚合。

---

## 安装(macOS Apple Silicon)

前置:
- Node 18+
- Rust(选 A 时;选 B 不需要)
- mavis daemon 在跑(用过 mavis 都有)

### 选项 A — 完全自己 build(推荐)

```bash
git clone git@github.com:vinozhong33/mavis-pet.git ~/mavis-pet
cd ~/mavis-pet

# 1. broker(事件中枢,跑 38 个测试)
(cd packages/broker && npm install && npm run build && npm test)

# 2. cli(全局命令)
(cd packages/cli && npm install && npm run build && npm link)

# 3. floater(Tauri,首编大约 1-2 分钟)
(cd packages/floater && cargo build --release)

# 4. 装一只宠物 + 装 hook + 启动
mavis-pet install boba
mavis-pet hook install   # 一次性把 6 条 mavis hook 写入 daemon
mavis-pet start          # 起 broker + floater
```

完成后宠物会出现在屏幕中央,可以拖到任意位置。下次开机自动用上次位置启动。

### 选项 B — 用预编译 floater binary(不想等 cargo)

```bash
git clone git@github.com:vinozhong33/mavis-pet.git ~/mavis-pet
cd ~/mavis-pet

(cd packages/broker && npm install && npm run build)
(cd packages/cli    && npm install && npm run build && npm link)

# 下载预编译 floater
mkdir -p ~/.mavis/pet
curl -L -o /tmp/floater.zip \
  https://github.com/vinozhong33/mavis-pet/releases/download/v0.2.1/mavis-pet-floater-v0.2.1-darwin-arm64.zip
unzip -j /tmp/floater.zip -d /tmp/
mv /tmp/mavis-pet-floater ~/.mavis/pet/floater
chmod +x ~/.mavis/pet/floater

mavis-pet install boba && mavis-pet hook install && mavis-pet start
```

### 验证

```bash
mavis-pet status
# active pet : boba
# broker     : running (state: run)
# floater    : running (pid xxxxx)
# hooks      : 6 installed
```

发条消息给 mavis,看宠物是否跳一下并飘 `hey!`——通了就装好了。

---

## 换宠物

mavis-pet 复用 petdex 全宠物库。

```bash
# 浏览所有宠物(看 slug)
open https://petdex.crafter.run

# 装一只新的
mavis-pet install otter

# 看本机已有
mavis-pet list
# ★ active   boba                 ~/.mavis/pets
#            cat                  ~/.codex/pets   ← codex 装过的也能用

# 立刻切换(broker 通知 floater 热重载,无需重启)
mavis-pet switch otter
```

### 自定义/手画

```
~/.mavis/pets/<your-slug>/
├── pet.json            # { "frame_w":192, "frame_h":208, "rows":9, "cols":8, "frame_count":6, "frame_duration_ms":1100 }
└── spritesheet.webp    # 1536×1872(默认 192×208 × 8 列 × 9 行)
```

行序对应状态:idle / wave / run / failed / review / jump / extra1 / extra2(从上到下)。每行前 6 帧是动画。

---

## CLI 速查

```bash
mavis-pet install <slug>       # 从 petdex 装宠物
mavis-pet list                 # 已装宠物 + active 标记
mavis-pet switch <slug>        # 切 active(热重载)
mavis-pet start                # 启 broker + floater
mavis-pet stop                 # 关
mavis-pet status               # 看状态(broker/floater/hooks)
mavis-pet hook install         # 注册 6 条 mavis hook(幂等)
mavis-pet hook uninstall       # 删那 6 条
```

环境变量:
- `MAVIS_PET_BROKER_PORT`(默认 7857)
- `MAVIS_PET_FLOATER`(覆盖 floater binary 路径)
- `MAVIS_PET_MANIFEST`(覆盖 petdex manifest URL)

---

## 工作原理

```
       ┌────────────────────┐
       │   mavis daemon     │
       │  (你已经在用)     │
       └─────────┬──────────┘
                 │ 6 个 user-script hook
                 │ (PreToolUse / PostToolUse / MessageComplete /
                 │  UserPromptSubmit / SessionStart / SessionEnd)
                 ▼
       POST http://127.0.0.1:7857/event
                 │
       ┌─────────▼──────────┐
       │  broker (Node TS)  │  per-session 状态机 +
       │       :7857        │  全局聚合(8 状态,优先级)+
       │                    │  默认气泡映射
       └─────────┬──────────┘
                 │ WebSocket /ws
                 │ { type:"state", state, ts, bubble?, bubbleTtlMs? }
                 ▼
       ┌────────────────────┐
       │  floater (Tauri)   │  透明 always-on-top 窗口 +
       │     140 × 120      │  spritesheet 动画 + pill 气泡 +
       │                    │  跨 fullscreen Space
       └────────────────────┘
```

- **broker** 注入了 `Clock` 抽象,38/38 测试都用 `FakeClock` 跑,时间相关行为完全确定
- **floater** 用 `cocoa` 调原生 `NSWindowCollectionBehavior` 让窗口能跨别的 app 的 fullscreen Space(Tauri 自带的 `set_visible_on_all_workspaces` 不够)
- **hook** payload 走 stdin(mavis daemon 协议),script 自动用 `/usr/bin/jq` 解析

详细 broker 协议见 [`packages/broker/PROTOCOL.md`](./packages/broker/PROTOCOL.md)。

---

## 项目结构

```
mavis-pet/
├── packages/
│   ├── broker/      Node + TS 事件中枢:状态机 + HTTP /event/status/switch + WS /ws
│   │                38/38 测试,Clock 抽象,bubble 字段,8 状态优先级
│   ├── floater/     Tauri (Rust):透明 always-on-top sprite 窗口
│   │                pill 气泡 + brand 徽标 + cocoa 跨 fullscreen Space
│   └── cli/         npm 包 mavis-pet:install/list/switch/start/stop/status/hook
│
├── plan-mavis-pet.md           原始设计
├── roadmap-mavis-pet.md        v0.4+ 路线(R1-R11,标了哪些已做)
├── MAVIS-PET-V0-SUMMARY.md     完整功能 + 故障排查清单
└── release/                    每个 release 的 floater zip
```

---

## 跟 codex / petdex-desktop 的关系

| | mavis-pet | codex floater / petdex-desktop |
|---|---|---|
| 宠物素材 | petdex 开放格式 | 同上(完全兼容) |
| 状态来源 | mavis daemon 6 个 hook | codex 内部钩子 |
| 进程 | broker (Node) + floater (Tauri/Rust) | 单一 native app |
| 装法 | git clone + build,或 release zip | macOS app dmg |
| 气泡 | 8 状态全有默认文案 | 部分支持 |
| 跨别 app fullscreen | ✅ 跨过去 | 视实现 |
| 切宠物 | `mavis-pet switch` 命令 + 热重载 | 右键菜单 / app UI |

简短说:**素材 100% 兼容**,**状态机和 UI 框架不同**,**功能上 mavis-pet 多了气泡 + 跨 fullscreen**。

---

## 路线图

已做:R1 (jump) / R3 (extra1+extra2) / R11 (speech bubbles) — v0.2 完成。

未做(按优先级):

- **R2 review 状态** — broker polling daemon 看哪个 main session 等用户决策
- **R8 多宠物切换 UI** — 右键菜单换宠物,免命令行
- **打包成 npm 包** — `npx mavis-pet install boba` 一行起飞
- **R7 桌面通知** — 重要事件触发 macOS native notification
- **R5/R6 跨平台** — Linux / Windows
- **R4 PR broker 协议回上游 petdex**
- **R10 mavis 自有 brand 宠物素材**

完整描述 + 估算见 [`roadmap-mavis-pet.md`](./roadmap-mavis-pet.md)。

---

## License

MIT — 见 [LICENSE](./LICENSE)

## 致谢

- [petdex](https://github.com/crafter-station/petdex) — 开放 sprite 格式 + manifest API + 全部宠物素材
- [mavis](https://mavis.run) — 提供 hook 系统让我们能挂上去
- 内部 mavis 团队的早期反馈
