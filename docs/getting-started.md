> **一句话**：双击一次，Notion 右下角就常驻一条用量胶囊；不用点进设置页，也不受 Notion 改版影响。
> 适用：Windows 10/11 · Notion 桌面版 7.4x · Node.js 22+

## 0. 前置

只需要 **Node.js 22 或更高**（用到内置 `WebSocket` 和 `fetch`，零 npm 依赖）。

检查：

```powershell
node -v      # 需要 v22.x 或更高
```

没有的话去 https://nodejs.org 装 LTS 版，装完重开终端。

## 1. 拿到文件

```powershell
git clone https://github.com/notbesttime/notion-desktop-panel.git
cd notion-desktop-panel
```

或者直接下 ZIP 解压到任意目录（**路径带空格、带中文都没问题**）。

## 2. 启动

### 方式 A —— 运行 install.ps1（最省事，推荐）

在文件夹里**右键 `install.ps1` → 使用 PowerShell 运行**。

它会：

- 检查 Node.js 是否 ≥ 22
- 在**桌面**创建一个「Notion 用量面板」快捷方式
- 自动套上 Notion 的图标（找得到的话）

之后**双击桌面那个快捷方式**就行，无黑框、不占任务栏。

> 想在开机时自动启动：`powershell -ExecutionPolicy Bypass -File install.ps1 -AutoStart`
> 会在「启动」文件夹里也放一份。不想用了直接删。

### 方式 B —— 双击 bat（第一次推荐，能看到日志）

直接双击 `start.cmd`。它会开一个窗口**在前台**跑，把每一步都打出来：

```
=== 啟動器開始 ===
啟動 Notion.exe --remote-debugging-port=9223
debug port 就緒（3.2s）: Notion/7.43.2
已連線 ws://127.0.0.1:9223/...
注入(attach) https://app.notion.com/... -> ok
```

看到 `注入 -> ok` 就成功了。**这个窗口别关**，关了注入器就退出（面板会消失）。确认好用之后再换成方式 A。

### 方式 C —— 命令行

```powershell
node launch.mjs
```

## 3. 验证成功

Notion 右下角出现一个胶囊：

```
● 1.4% ｜ 8.1% ｜ business
```

- **鼠标悬停**看真实数值（如「标准积分 (Auto) 用量：21.69 / 1500」）
- **点一下**展开完整卡片：6h 窗口、月度用量、标准积分、自选积分、套餐、本次打开消耗
- **点右上角 ×** 收起卡片

面板每 60 秒自动刷新；切走再切回 Notion 也会立刻刷一次。

## 4. 它跟你账号的关系

面板显示什么**完全取决于你的套餐**：

| 你的账号 | 胶囊长这样 |
|---|---|
| 有 6h 限速 | `● 12.3% ｜ 1.4% ｜ 8.1% ｜ business` |
| 无 6h 限速（如 Business） | `● 1.4% ｜ 8.1% ｜ business` |
| 没有标准积分（如个人免费） | `● 8.1% ｜ free` |

不适用的项会**连同分隔线一起隐藏**，不会显示假的 0%。

## 5. 常见问题

**Q：每次都要双击一次吗？能不能开 Notion 自动就有？**

可以，而且**建议你直接用方式 A 建的快捷方式代替原来的 Notion 图标**。原因：Notion 是单实例，必须带调试端口启动才能注入；如果你先点原版 Notion、再点面板快捷方式，面板会把当前 Notion 关掉重开一次。反过来（先点面板快捷方式）就没有这个问题，体验上就是「点一下，Notion 开了，面板也在」。

想让它在开机/登录时自动启动：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -AutoStart
```

仓库默认**不做任何自启注册**，加不加由你。

**Q：它安全吗？会不会读到我的笔记？**

不会。面板只做两件事：把自己画在页面上、调用 Notion **本来就给你自己看**的两个接口（`getCreditRateLimitStatus` / `getBillingData`）。不读取页面内容、不上传任何数据、不联网到第三方。

**Q：要装 MCP / Cloudflare 隧道吗？**

**不需要，跟看用量一点关系都没有。** 那套东西是让 Notion 云端 AI 去操作你电脑上的文件，属于完全独立的另一件事，本仓库默认根本不会去碰它。

**Q：Notion 升级后失效了？**

再双击一次快捷方式即可。本项目不改 `app.asar`，所以升级不会把它弄坏。

**Q：怎么彻底卸载？**

关掉 Notion，删掉文件夹。就这两步 —— 没装服务、没写注册表、没加启动项。

## 6. 出问题了看哪里

日志在插件目录的 `notion-panel.log`。

| 现象 | 原因 / 处理 |
|---|---|
| 双击后没反应，也没胶囊 | 先看日志最后几行；多半是 Node 版本低于 22 |
| 面板不显示，日志显示注入 ok | 当前分页不是 `app.notion.com`（比如设置页）；切回任意笔记页即可 |
| 显示「未取到 spaceId」 | 该页面 URL 里没有 space 信息；切到有 `?spaceId=` 的页面 |
| 数字一直是 `—` | 登录态掉了，重新登录 Notion |
| 每次双击都把 Notion 关掉重开 | 正常现象（见 Q5），用方式 A 的快捷方式就不会重复 |
