# Mavis Pet — Roadmap (v0 不做但已讨论的事)

> 这份文档是 v0 启动时讨论过、但**故意排到 v0 之后**的功能清单。
> 后续想做哪个,直接跟 main 说"启动 mavis pet roadmap 第 X 项"或描述需求即可,
> main 会从这里捞背景、拿设计、再开 team plan。
>
> v0 设计本体在 `plan-mavis-pet.md`。

## 状态表

| ID | 标题 | 状态 | 触发条件 |
|----|------|------|----------|
| R1 | jump 动画(用户互动喜悦) | ✅ v0.2 已做 | UserPromptSubmit hook → jump 1.5s |
| R2 | review 动画(等用户决策) | 暂缓 | 用 team plan 频率上来后 |
| R3 | extra1/2 动画(SessionStart/End) | ✅ v0.2 已做 | SessionStart/End hook → extra1/extra2 2.5s |
| R4 | 把 broker 协议 PR 回上游 petdex | 暂缓 | v0 验证可行后 |
| R5 | Linux 支持 | 暂缓 | 用户切 Linux 时 |
| R6 | Windows 支持 | 暂缓 | 用户切 Windows 时 |
| R7 | 桌面端 IM 通知/弹窗 | 暂缓 | 飞书通道不够用时 |
| R8 | 多宠物切换 UI(右键菜单) | 暂缓 | 装了 ≥3 只宠物时 |
| R9 | Fork petdex-desktop 替换 Tauri | 不做 | 仅作为 R4 副产品考虑 |
| R10 | 自己造 mavis 专属宠物素材 | 暂缓 | 想 brand 化时 |
| R11 | speech bubble UI(气泡文案) | ✅ v0.2 已做 | codex 风 pill + brand 徽标 |

---

## 详细条目

### R1. jump 动画 — 用户互动喜悦  ✅ v0.2 已做

**已实装** — 2026-05-12 v0.2 完成。

mavis daemon 实际**已有** `UserPromptSubmit` hook event(v0.1 时漏调研),不需要给 mavis 加新事件。

实现:
- 安装的第 4 条 hook(`mavis-pet hook install`)在 UserPromptSubmit 时 POST 给 broker
- broker 状态机 → `jump` overlay,priority 6 > run/wave
- 1.5s 后自动降级
- 默认气泡 "hey!"

---

### R2. review 动画 — 等用户决策

**需求**:team plan cycle 跑完,broker 推 cycle report 给 main 等用户拍板时,宠物切 `review`(若有所思状),提示"等你呢"。

**为啥 v0 不做**:
- 你 team plan 用得还不算高频
- 当前 mavis-team CycleReport 是通过 `mavis communication send` 投递,broker 监听这个不简单(需要订阅 daemon 内部消息流)

**做的方式**:
- 选项 A:加一个 `CycleReportSent` hook event,broker 监听
- 选项 B:broker polling `mavis communication peers` 看有没有 main 是 `awaiting_decision` 状态

**估算**:选项 A 更优雅,~1 天;选项 B 半天但脏

---

### R3. extra1/2 动画 — SessionStart / SessionEnd  ✅ v0.2 已做

**已实装** — 2026-05-12 v0.2 完成。

绑定到 mavis 已有的 SessionStart / SessionEnd hook,而不是 cron。

实现:
- `mavis-pet hook install` 装的第 5、6 条 hook
- SessionStart → `extra1` overlay 2.5s,默认气泡 "morning"
- SessionEnd → `extra2` overlay 2.5s,然后 session 被 broker 自动 forget
- 优先级 5 / 4(在 wave 之上,在 jump 之下)

如果要做 cron 触发那种"自定义事件"动画,后续走"用户挂自己的 hook 直接 POST `/event`"的扩展性方案。

---

### R4. PR 回上游 petdex(broker 协议开放规范)

**需求**:把我们的 broker WS 协议(`{state: "run" | "wave" | ...}`)做成 README/SPEC,petdex-desktop roadmap 实装 file-watcher / HTTP endpoint 时可以直接采纳。

**为啥 v0 不做**:先把自己跑通再说,过早抽象成规范容易做错。

**做的方式**:
1. v0 跑稳 1-2 周
2. 抽出 `BROKER_PROTOCOL.md`
3. 在 petdex repo 提 issue/discussion 介绍方案
4. 看上游接不接;不接也无所谓,我们自己用

**估算**:文档 + 沟通 ≈ 1 天(写) + 看上游响应

---

### R5/R6. Linux / Windows 支持

**需求**:跨平台。

**为啥 v0 不做**:用户当前是 macOS,petdex-desktop 也只 macOS;先把一个平台做扎实。

**做的方式**:Tauri 本身跨平台,瓶颈在窗口能力(透明 + frameless + always-on-top + click-through)在 Linux/Windows 上的兼容。需要分别 spike。

**估算**:每个平台半天 spike + 1-2 天调试

---

### R7. 桌面端 IM 通知/弹窗

**需求**:除了宠物动画,也用 macOS 系统通知发"重要事件"(任务完成、CR 通过等)。

**为啥 v0 不做**:用户已经有飞书通道,宠物的角色是"环境光信号"(ambient)而非"打断式通知"。混在一起会吵。

**做的方式**:broker 增加通知策略,基于事件 priority 决定是否调 macOS `osascript display notification`。配置项控制阈值。

**估算**:~半天

---

### R8. 多宠物切换 UI(右键菜单)

**需求**:floater 右键菜单可以切宠物 / 隐藏 / 退出,而不用回终端敲 `mavis pet switch`。

**为啥 v0 不做**:v0 用户大概只装 1-2 只宠物,命令行够用。装到 3 只以上再做 UI。

**做的方式**:Tauri 原生支持 tray menu 和 webview context menu。

**估算**:~1 天

---

### R9. Fork petdex-desktop 替换 Tauri

**需求**:把渲染层从 Tauri 换成 petdex-desktop 的 Zig + zero-native fork,跟上游对齐。

**为啥不做**:
- 当前不做,因为 Zig 学习成本 + 上游 fork 还没合并 ≫ Tauri 收益
- **完成 R4 后**,我们的 broker 可以适配 petdex-desktop;那时让 petdex-desktop 当备用渲染器,而不是替代 Tauri
- 双渲染器并存即可,不必二选一

**结论**:**这条不做**,留做 R4 的副产品考虑

---

### R10. 自家 mavis 宠物素材

**需求**:不复用 petdex 的 boba/cat/etc,造一只 mavis 自己的宠物(有 mavis brand)。

**为啥 v0 不做**:
- petdex 已有 1.4k star、几十只宠物,够用
- 造一只好看的 sprite 需要专业美术(spritesheet 192×208 × 8×9 = 72 帧)

**做的方式**:
- 用 GenAI(SD/Flux + 后期)出 sprite — 已有公司在做(petdex 的 hatch-pet skill)
- 或者找美术外包
- 提交回 petdex gallery 也能给 mavis 引流

**估算**:不可估,看美术质量要求

---

### R11. speech bubble UI  ✅ v0.2 已做

**已实装** — 2026-05-12 v0.2 完成。

需求:状态切换时,在宠物旁边飘一个简短气泡(像 codex/petdex 的 "Thinking..." 那种)增加交互温度。

实现:
- broker `WsStateMessage` 加 `bubble?: string` + `bubbleTtlMs?: number` 字段
- 默认气泡映射:morning / hey! / done! / oops / your turn / bye
- floater 端 codex 风格 pill 气泡:
  - 超圆角 `border-radius: 999px`
  - 左侧紫色渐变圆形 brand 徽标(白色 "M" 字)
  - 双层柔和阴影
  - pet 在窗口右下,bubble 在左上,无尾巴
  - fade in/out 200ms
- 用户可通过 `bubbles` 配置项覆盖文案,通过 `bubbleTtlMs` 调时长

---

## 优先级建议(下次 v1 做哪个)

按"用户感知 / 实现难度"排序:

1. **R2 review**(team plan 用得多了之后必要;需要 broker polling daemon awaiting_decision)
2. **R8 多宠物切换 UI**(用户装第 3 只宠物时立刻想要)
3. **R7 桌面通知**(等到飞书通道满意度下降时)
4. **R4 PR 上游**(战略性,不紧急)
5. **R5/R6 跨平台**(等用户切平台)
6. **R10 自家素材**(brand 化时)

R1 / R3 / R11 已在 v0.2 完成,不再排队。

---

## 触发再次启动的方式

跟 main 说任意一种:
- "mavis pet roadmap R1 启动"
- "mavis pet 加上 jump 状态吧"
- "宠物现在不能右键切了 想加上"

main 会:
1. 从这里捞背景 + 设计草案
2. 跟你确认范围有没有变
3. 开 team plan / 直接动手(看复杂度)
