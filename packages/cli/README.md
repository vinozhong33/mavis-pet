# mavis-pet

> 给 [mavis](https://mavis.run) 用户的桌面任务浮窗 —— 透明、置顶、零打扰。眼角余光就能看到所有 agent 在干什么。

灵感来自 [petdex](https://petdex.crafter.run)(给 claude-code / codex / opencode 这些 cli agent 做的桌宠),但 petdex 没支持 MiniMax / mavis(GUI app + daemon 架构,跟 cli agent 完全不同),所以单独定制了一个。

## 安装

**前置**:已经在用 MiniMax(Test 或正式包都支持)。**仅 macOS Apple Silicon**。

```bash
npm install -g mavis-pet
mavis-pet install
```

`install` 是一键 wizard:bootstrap + 配置 launchd KeepAlive,**重启电脑也自动起**。

装完桌面右下角会出现宠物。下次 mavis 跑任务时,卡片会自动出现在宠物上方。

## 能干啥

- **🔗 0 延迟透传对话状态** — 订阅 daemon 的 SSE event stream,thinking / streaming / waiting / done 实时反映,不轮询不刷新
- **🪟 跨 fullscreen Space 置顶,常在但不挡事** — 透明 NSPanel,IDE 全屏 / 看视频 / 玩游戏都飘在上面
- **🖱️ 透明像素点击穿透** — boba 周围的透明区域不会"吃掉"你的点击,Finder / Trash / 桌面图标该响应都响应(v0.7.5 by [@yuyuaichicu](https://github.com/yuyuaichicu))
- **📚 多 session 自动堆叠** — 几个 agent 并发跑也清清楚楚,老卡上 / 新卡下 / 不互换位置,完成 30s 自动消失
- **🎯 点卡片一键跳回 MiniMax** — 余光瞄到要介入,一秒切过去
- **🐶 桌宠可以换** — 复用 [petdex](https://petdex.crafter.run) 几十只角色,boba / super-goku / doraemon... 谁都能装

## 换桌面宠物

mavis-pet 复用了 [petdex](https://petdex.crafter.run) 的角色库 —— 那边有几十只可挑。

```bash
# 1. 浏览所有宠物
open https://petdex.crafter.run

# 2. 装一只新的(slug 在 petdex 站上)
npx -y petdex install super-goku

# 3. 切到 mavis-pet
mavis-pet switch super-goku
```

`mavis-pet list` 能看本机已装哪些(也会自动扫 `~/.codex/pets/`,codex 装过的直接复用)。

## 常用命令

```bash
mavis-pet status         # 看 broker / floater 跑没跑
mavis-pet switch <slug>  # 换桌面宠物
mavis-pet stop / start   # 临时关 / 起
mavis-pet uninstall      # 完整卸载(launchd + binary + hooks 一并清)
```

## 项目地址 + 反馈

- **GitHub**: <https://github.com/vinozhong33/mavis-pet>
- **架构 / 协议 / hook 怎么挂**: 看 GitHub 主 README
- **bug / feature 请求**: 在 GitHub 开 issue,或飞书 ping vino

觉得有用就给个 ⭐ 🙏

## License

MIT
