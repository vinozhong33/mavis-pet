# mavis-pet — 总结(v0.2)

## 这是什么

屏幕上的动画宠物 floater,根据 mavis 的 lifecycle 事件实时反应,并在状态切换时飘出小气泡(codex/petdex 风格 pill bubble)。

## 状态映射(v0.2 — 8 状态,7 个已实装)

优先级:`failed > review > jump > extra1 > extra2 > wave > run > idle`

| 状态 | 触发 | TTL | 默认气泡 |
|------|------|-----|---------|
| `extra1` | SessionStart | 2.5s | morning |
| `extra2` | SessionEnd(然后 session 被 forget) | 2.5s | bye |
| `jump` | UserPromptSubmit(你发消息) | 1.5s | hey! |
| `failed` | PostToolUse exitCode≠0 / toolResult 含 error | 2s | oops |
| `wave` | MessageComplete(我答完一段) | 1s | done! |
| `run` | PreToolUse / PostToolUse 成功(base) | 持续 | — |
| `idle` | 30s 静默或无活动 session | 持续 | — |
| `review` | (留 v0.4 — 等用户决策时) | — | your turn |

## 项目位置

`~/mavis-pet/` — 已 push 到 [github.com/vinozhong33/mavis-pet](https://github.com/vinozhong33/mavis-pet)

```
mavis-pet/
├── packages/
│   ├── broker/      Node + TS,事件中枢 + 状态机 + WS server (38/38 测试)
│   ├── floater/     Tauri (Rust),透明窗口 + sprite 动画 + codex 风气泡
│   └── cli/         npm 包,顶层 mavis-pet 命令
├── plan-mavis-pet.md       初始设计
└── roadmap-mavis-pet.md    后续 roadmap(v0.4 待办)
```

## 怎么用

**已装好,直接用:**
```bash
mavis-pet status      # 看状态
mavis-pet switch <slug>  # 切宠物(先 install)
mavis-pet stop        # 关
```

**新机器装:**
```bash
git clone git@github.com:vinozhong33/mavis-pet.git
cd mavis-pet
# 装依赖 + build
(cd packages/broker && npm i && npm run build && npm test)
(cd packages/cli    && npm i && npm run build && npm link)
(cd packages/floater && cargo build --release)
# 装宠物 + 启动
mavis-pet install boba
mavis-pet hook install     # 装 6 条 mavis hook
mavis-pet start            # broker + floater 都起
```

## v0.2 已实现

### v0.1 基础(2026-05 中)
- [x] Broker:Node + TS,Clock 抽象保证时间确定
- [x] Floater:Tauri v2 透明 frameless always-on-top + 拖拽
- [x] CLI:install / list / switch / start / stop / status / hook install/uninstall
- [x] Petdex 兼容:能装它所有宠物
- [x] 切宠物热重载

### v0.2 新增(2026-05-12)
- [x] 8 状态(从 4 扩到 8,review 留 v0.4)
- [x] 3 个新 hook event:UserPromptSubmit / SessionStart / SessionEnd
- [x] **气泡 UI** — codex/petdex 风格 pill bubble + 紫色 brand 徽标
- [x] 6 条 mavis hook 自动装(原 3 条 + 新 3 条)
- [x] window 加大 70×76 → 140×120 容纳气泡
- [x] 38/38 测试全过(原 33 + v0.2 新 5 个)
- [x] 修复 v0.1 .gitignore 漏 `packages/floater/dist/` 的问题

## v0.4+ 待办(roadmap)

详见 `roadmap-mavis-pet.md`:

- **review 状态**(R2)— broker polling daemon 看哪个 main session 等用户决策
- **多宠物切换右键菜单**(R8)
- **打包成 npm 包**:`npx mavis-pet install boba` 一行起飞
- **Linux / Windows 跨平台**(R5/R6)
- **PR broker 协议回上游 petdex**(R4)
- **mavis brand 自有宠物素材**(R10)

## 故障排查

| 现象 | 处理 |
|---|---|
| 屏幕看不到宠物 | `mavis-pet status`;running 但看不到可能在屏幕角外,`stop && start` |
| 宠物在屏幕但不切动画 | `curl -XPOST http://127.0.0.1:7857/event -d '{"sessionId":"t","kind":"PreToolUse"}'` 验 broker;不变 → broker 状态机问题(`cd packages/broker && npm test`);state 变了但不切 → wsClients=0,floater 重启 |
| 我聊天时宠物不反应 | `mavis hook list \| grep mavis-pet` 应该 6 条;少了 `mavis-pet hook install` |
| broker 起不来 | 7857 占用 → `MAVIS_PET_BROKER_PORT=7858 mavis-pet start` |
| 气泡飘但太短 | 默认 TTL 2.5s,要改 broker 的 `bubbleTtlMs` 配置 |

## 接下来

随时说"启动 R2 review"/"做右键菜单"/"打包发布 npm",我从 roadmap 捞背景接着干。
