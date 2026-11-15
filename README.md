# notion-desktop-panel

让 **Notion 桌面版** 右下角常驻一条 **AI 用量悬浮条**：不用点进设置页、不用记住入口在哪、也不怕 Notion 改版把它挪走。

> Windows 10/11 · Notion 桌面版 7.4x · Node.js 22+ · 零 npm 依赖 · **不涉及 MCP / 隧道 / 本地文件权限**

![悬浮条与展开卡片](docs/images/panel-card.png)

## 为什么要它

Notion **确实**给你看用量，问题是：

1. 得一层层点进设置页；
2. Notion 隔三差五就改这个入口的位置；
3. 一次只给一个笼统百分比，6h / 月度 / 标准积分 / 自选积分全混在一起。

这个面板把数字常驻在右下角，一眼就能看到。

## 显示什么

```
● 1.4% ｜ 8.1% ｜ business
  ↑      ↑      ↑
标准积分  月度   套餐
```

- 顺序：**6h 用量（仅账号受 6h 限速管时才出现）｜标准积分｜月度｜套餐**
- 鼠标悬停看真实数值，如 `21.69 / 1500`
- 圆点按最吃紧的那项变色：≥70% 黄、≥90% 红；取数失败变红
- 不适用的项**连同分隔线一起隐藏**，不会显示假的 0%

点开胶囊是完整卡片：6h 窗口与重置倒计时、月度用量与重置日期、标准积分（Auto）、自选积分（Select）、套餐名与订阅状态、本次打开消耗、最近变化记录。

## 怎么用

**详细图文步骤见 [docs/getting-started.md](docs/getting-started.md)**，这里是速览。

### 一键启动（两种，任选）

| 方式 | 操作 | 特点 |
|---|---|---|
| **bat** | 双击 `start.cmd` | 有日志窗口，**第一次排错推荐**；窗口别关 |
| **无窗口** | 双击 `start.vbs`，或给它建快捷方式 | 没有黑框、不占任务栏，**日常推荐** |

无窗口快捷方式的写法：

```
目标：C:\Windows\system32\wscript.exe
参数："<插件目录>\start.vbs"
```

### 开机自动启动

仓库**默认不注册任何自启**（多数人偶尔看看，没必要常驻）。想要的话：

把上面的无窗口快捷方式丢进 `shell:startup`（Win+R 输入 `shell:startup` 回车）即可。

> **建议直接用这个快捷方式代替原来的 Notion 图标。** Notion 是单实例，必须带调试端口启动才能注入；如果你先点原版 Notion 再点面板启动器，启动器会把 Notion 关掉重开一次。反过来（先启动器）就不会有这个问题。

### 手动

```powershell
git clone https://github.com/notbesttime/notion-desktop-panel.git
cd notion-desktop-panel
node launch.mjs
```

## 它做了什么

Notion 桌面版是 Electron，自带 Chrome DevTools 协议。本项目**不改安装目录、不碰 `app.asar`**：

1. 探测 Notion 安装位置（`%LOCALAPPDATA%\Programs\Notion\Notion.exe` 等，或 `NOTION_EXE` 指定）
2. 若 `127.0.0.1:9223` 上已有 Notion 在响应，**直接注入，不重启你的 Notion**
3. 否则结束所有 `Notion.exe`，带 `--remote-debugging-port=9223` 重新拉起
4. 连上 CDP，给所有 Notion 分页注入 `panel.js`，并注册 `Page.addScriptToEvaluateOnNewDocument` —— **Ctrl+R 刷新后也还在**
5. 监视 `panel.js`，改完保存即自动重新注入

所以 Notion 升级不会把它弄坏，重新跑一次启动器就行。

## 安全性

面板只做两件事：把自己画在页面上、调用 Notion **本来就给你自己看**的两个接口（`getCreditRateLimitStatus` / `getBillingData`）。

不读页面内容、不上传任何数据、不连第三方、不写注册表、不加启动项。卸载 = 关掉 Notion + 删文件夹。

## 配置项（全部可选）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `NOTION_EXE` | 自动探测 | Notion 可执行文件路径 |
| `NOTION_DEBUG_PORT` | `9223` | CDP 端口（9222 常被别的 Electron 应用占用） |

## 已知限制

- **拿不到单次对话的 token 数**。桌面版推理走 Electron 主进程，不经过页面网络栈，CDP 够不着，所以卡片用「额度增量」反映消耗。
- **6h 重置时间是近似值**。真实窗口是滑动的，接口不给固定结束时间，按「现在 + 6h」估算。
- **Notion 用 `--updated` 自重启后需要多跑一次启动器**。新进程不带调试端口，`launch.mjs` 会自动重新接管（最多 6 次）。

## 排错

日志：插件目录下的 `notion-panel.log`（已 gitignore）。

| 现象 | 原因 / 处理 |
|---|---|
| 双击后没反应 | 看日志最后几行；多半是 Node 版本低于 22 |
| 日志显示注入 ok 但没胶囊 | 当前分页不是 `app.notion.com`（比如设置页），切回笔记页 |
| 显示「未取到 spaceId」 | 该页面 URL 里没有 space 信息；切到有 `?spaceId=` 的页面 |
| 数字一直是 `—` | 登录态掉了，重新登录 Notion |

## 关于 MCP / Cloudflare 隧道

**本仓库不包含、也不需要它们。** 那套东西（本地 MCP 服务 + Cloudflare 隧道）解决的是「让 Notion 云端 AI 操作你电脑上的文件」，和看用量是两件完全不同的事；`launch.mjs` 默认完全不会去碰。

## 致谢 / 基于什么做的

- **注入思路**：[LeoHsxg/notion-bar-fix](https://github.com/LeoHsxg/notion-bar-fix) —— 原生 CDP 注入而非改 `app.asar`，升级不失效。`LICENSE` 沿用其 MIT 版权声明。
- **数据来源**：Notion 自身页面的同源接口，不逆向、不绕鉴权。

## License

MIT，见 [LICENSE](LICENSE)。
