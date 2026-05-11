# Mavis Pet — 桌面动画宠物 (路径 3)

## Background

用户参考 [crafter-station/petdex](https://github.com/crafter-station/petdex)，希望 mavis 也能有一只屏幕上的动画宠物，根据 mavis 的活动反应（开始/思考/完成/失败/等审核 等）。

调研后发现 petdex-desktop v0 **只渲染 idle，无 agent 集成能力**（reactive states 在 roadmap 上还没实现）。所以选择路径 3：**自研 mavis 桌面宠物，复用 petdex 公开素材**。

## Scope

### In
- 桌面端 macOS floater：透明、frameless、always-on-top，渲染一只 spritesheet 动画宠物
- 接 mavis 事件流：在关键 lifecycle 事件触发时切换动画
- 一个 `mavis pet` 子命令族：install / list / switch / start / stop / status
- petdex 素材兼容：直接复用 petdex 的 pet 包格式（`pet.json` + `spritesheet.{webp,png}`），可以从 petdex manifest API 拉取
- v1 配置入口：通过 `~/.mavis/pet/config.json` 配置事件→动画映射

### Out（先不做）
- Linux/Windows 支持（v0 只 macOS，跟 petdex-desktop 一样）
- 自己造 pet 资源（用 petdex 的就行）
- 上 IM 通知/弹窗（用户已有飞书通道，宠物只做"视觉信号"）
- 多宠物切换 UI（命令行切，先不做右键菜单）
- 自己 fork petdex-desktop 做改造（独立项目，绕开 Zig）

## Recommended approach

### 架构（三个组件）

```
┌─────────────┐    hook script     ┌──────────────┐    WS/socket     ┌───────────────┐
│ mavis daemon│ ─────────────────► │ pet broker   │ ─────────────────► │ pet floater   │
│  (existing) │   每个 hook 调用    │ (Node 常驻)   │   推 state event  │  (Tauri 桌面)  │
└─────────────┘                    └──────────────┘                  └───────────────┘
                                          ▲
                                          │
                                       配置/状态机
                                  ~/.mavis/pet/config.json
```

**为什么这样切:**
- **broker 中间层** 是关键 — hook 是无状态的 fire-and-forget script，但宠物需要"会话级状态"（这个 session 还在跑就保持 run，所有 session idle 才回 idle）。Broker 维护这个状态，hook 只负责喂事件。
- Broker 用 Node + Unix socket，启动开销低，跟 mavis daemon 同生命周期或独立都行（v0 独立，由 `mavis pet start` 拉起）。
- 桌面端通过 WebSocket / Unix socket 订阅 broker 推过来的 `{state: "run"}` 事件。

### 桌面技术栈：**Tauri** (推荐)
- 体积：~5MB vs Electron ~100MB
- 原生窗口能力：transparent + frameless + always-on-top 支持完整
- Rust 后端跟 mavis daemon 风格一致；前端 HTML/CSS 渲染 spritesheet（可以直接抄 petdex-desktop 的 CSS `steps()` 动画方案）
- 替代方案：Electron 上手快但太重；不考虑 Zig（绕开复杂度）

### 事件 → 动画映射（v0 默认）

| Mavis 事件                      | Hook event             | Animation state | 说明                      |
|---------------------------------|------------------------|------------------|---------------------------|
| Tool 开始执行                    | PreToolUse             | `run`            | 宠物在干活                 |
| Tool 完成                       | PostToolUse            | `run` (continue) | 还在 session 里就保持 run |
| Message 完成（agent 出完整回复）  | MessageComplete        | `wave`（短）     | 完成一轮，挥个手          |
| Session 进入 finished/idle      | (broker 自己判)        | `idle`           | 没活了，回 idle           |
| Tool 报错 / hook block          | PostToolUse + matcher  | `failed`         | 出错切红色动画            |
| 用户发新消息                    | (后期，需要新 hook)    | `jump`           | 互动喜悦                  |
| Cycle report 等用户决策          | (team plan 才有)       | `review`         | 等审核                    |

**默认就这套，用户后期可以在 config.json 改。**

### `mavis pet` 子命令

```bash
mavis pet install <slug>     # 走 petdex 的 manifest API 下到 ~/.mavis/pets/<slug>/
mavis pet list               # 列已装的宠物 + 当前激活的
mavis pet switch <slug>      # 切当前宠物（broker 收到信号通知 floater 重渲染）
mavis pet start              # 启动 broker + floater
mavis pet stop               # 关掉
mavis pet status             # broker / floater 跑没跑、当前 state、最近 5 个事件
mavis pet hook install       # 一键写入需要的 PreToolUse/PostToolUse/MessageComplete hooks
mavis pet hook uninstall     # 反过来
```

### 验证方式
1. **单元**：broker 状态机（事件序列 → 期望 state 序列）— TS 单测
2. **集成**：mock daemon 喂事件，broker 推的 WS 消息 == 期望
3. **端到端（手测）**：起 mavis pet start，跑一个 mavis 任务，肉眼看宠物是不是按预期切动画

## 关键决策点（要用户拍板）

1. **桌面技术栈**：我推荐 **Tauri**。除非你有 Electron 强偏好或 Tauri 强阻碍，否则就 Tauri。
2. **broker 部署**：跟 mavis daemon 同进程 vs 独立 Node 进程。我倾向**独立**（解耦，daemon 不背宠物的锅；用户也能单独 `mavis pet stop` 而不影响 daemon）。
3. **事件映射默认值**：上面那张表，OK 还是要调？
4. **MVP 范围**：idle + run + wave + failed 四个状态够不够 v0？还是上来就把 jump/review 也接上？
5. **是否需要 PR 回上游 petdex**：可选。我们做完了，broker 协议做成开放规范，petdex-desktop roadmap 实装时可以接我们的 broker 而不用自己造 file-watcher。这是 stretch goal，不影响我们 v0。

## Out of scope / risk

- petdex 公开 manifest API 没有 SLA，理论上他们改 schema 我们要跟。**Mitigation**：抽象一个 PetSource 接口，manifest 只是一种来源，本地目录是另一种。
- Tauri macOS transparent + always-on-top 跟 petdex-desktop 用 Zig + zero-native fork 走的是不同路径，需要早验证一下 Tauri 能不能把 frameless + transparent + always-on-top + click-through 同时打开。**Mitigation**：第一天就出一个 spike，确认能行再往下走。
- mavis 的 SessionStart / SessionEnd 这种"高层"hook 当前不存在，broker 得自己从 PreToolUse 第一次出现+所有 PostToolUse 静默 N 秒来推断 session 边界。**Mitigation**：先用启发式，后续如果 mavis 加了 SessionLifecycle hook 再升级。

## Next Step

跟用户对齐 5 个决策点 → 写成 team plan YAML → `mavis team plan run` 跑起来。

Team plan 的初步切分（一旦决策定下来）:
- Worker A: Tauri spike（验证窗口能力可行性）
- Worker B: Broker（Node + 状态机 + 单测）
- Worker C: `mavis pet` 子命令族（嵌入 mavis CLI）
- Worker D: 文档 + skill（最后写 user-facing skill）
- Verifier: 端到端手测脚本 + 验收清单
