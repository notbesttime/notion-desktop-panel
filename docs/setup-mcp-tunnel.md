# 完整方案：Notion 云端 AI ↔ 本机文件

> **用法**：把本文全文发给你的 AI Agent，它可照着逐步执行。每步都带验证命令和失败判据，卡住时对照文末「坑」小节。
> 目标环境：Windows 10/11 + Notion 桌面版 + Cloudflare 账号（免费版即可）+ 自有域名。

## 给执行者（AI）的约定

- 每完成一步先跑该步的 **验证**，通过后再进下一步；失败不要跳过。
- 路径与域名用占位符替换：`<插件目录>`、`<工作区根>`、`<你的域名>`。
- 不要向用户索取 Notion 密码或 Cookie；MCP 用现场生成的 Bearer token。
- 最终目标是「开 Notion 自动起服务、关 Notion 自动停」，不需要用户手动挂后台窗口。

## 先理解方向（不懂这点后面全错）

```
你在 Notion 里聊天
    ↓  Notion 云端 Agent 决定调用工具
MCP 协议（HTTPS，从 Notion 服务器发起）
    ↓
Cloudflare 边缘  notion-mcp.<你的域名>
    ↓  隧道（本机主动连出去的长连接）
cloudflared.exe（跑在你电脑上）
    ↓  localhost
MCP 服务 127.0.0.1:8766  →  读写你的磁盘
```

**方向是反的**：不是「你的电脑连 Notion」，而是「Notion 连你的电脑」。所以本地服务必须公网可达，只开 `localhost` 没用。

## 第 0 步：先确认账号支持（不通过就停止）

让用户在 Notion 里打开：`设置 → 连接 → 「+ 添加连接」下拉`，确认有没有 **「自定义 MCP 连接」**。

| 结果 | 动作 |
|---|---|
| 有 | 继续第 1 步 |
| 只有第三方 SaaS 列表 | 停止，报告「账号不支持自定义 MCP」 |
| 被管理员禁用 | 停止，无绕过方案 |

注意：设置里的 **「Notion MCP」页是反方向**（让别人读你的 Notion），别在那里找入口。

## 第 1 步：部署 MCP 服务端

```powershell
cd <插件目录>
git clone https://github.com/catoncat/notion-local-ops-mcp.git
cd notion-local-ops-mcp
uv venv .venv --python 3.12
$env:UV_DEFAULT_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple"   # 国内镜像，按需
uv pip install -e . --python .venv\Scripts\python.exe
```

写 `.env`（token 现场随机生成，别用默认值）：

```bash
NOTION_LOCAL_OPS_HOST=127.0.0.1
NOTION_LOCAL_OPS_PORT=8766
NOTION_LOCAL_OPS_WORKSPACE_ROOT=<工作区根>
NOTION_LOCAL_OPS_STATE_DIR=<插件目录>/.notion-local-ops-state
NOTION_LOCAL_OPS_AUTH_TOKEN=<随机长串>
NOTION_LOCAL_OPS_DELEGATE_TIMEOUT=1800
```

> 中文 Windows 建议同时打上本仓库的 `patches/notion-local-ops-mcp/utf8-output.patch`，否则命令输出里的中文可能整段变成 `stdout:null`。见仓库 README。

**验证**：

```powershell
.venv\Scripts\python.exe -m notion_local_ops_mcp.server
# 期望 Uvicorn running on http://127.0.0.1:8766

Invoke-WebRequest http://127.0.0.1:8766/mcp -UseBasicParsing
# 期望 401
Invoke-WebRequest http://127.0.0.1:8766/mcp -Headers @{Authorization="Bearer <token>"}
# 期望 200
```

## 第 2 步：建 Cloudflare 隧道

隧道只能网页创建。让用户操作：

```
https://one.dash.cloudflare.com
→ 网络 → 隧道 → 创建隧道 → Cloudflared → 命名 notion-mcp → 保存
→ 复制 eyJ 开头的 tunnel token
```

装并启动：

```powershell
winget install --id Cloudflare.cloudflared
cloudflared.exe tunnel --no-autoupdate run --token <eyJ...>
# 期望 4 条 Registered tunnel connection ... protocol=quic
```

配路由（网页）：`隧道详情 → 路由 → 添加路由 → 已发布的应用程序`

- 子域 `notion-mcp`，域选你的域名
- 目标 URL **必须是** `http://127.0.0.1:8766`

**验证**：

```powershell
Invoke-WebRequest https://notion-mcp.<你的域名>/mcp -UseBasicParsing
# 401 = 通了；530 = 隧道进程没跑；1033/502 = 路由配错
```

## 第 3 步：在 Notion 注册连接

```
设置 → 连接 → + 添加连接 → 自定义 MCP 连接
  URL    https://notion-mcp.<你的域名>/mcp     ← 结尾必须带 /mcp
  Auth   Bearer
  Token  <NOTION_LOCAL_OPS_AUTH_TOKEN>
```

保存后 Connected 列表出现绿色对勾。然后新建 MCP Agent 并填入以下指令（**别省**，否则模型会回「我是沙箱」）：

```text
你是连接到我本机电脑的助手，通过 MCP 操作本地文件。
规则：
- 上下文出现本地路径、文件名、代码扩展名时，把"文件""文档"理解成本地文件，不要当成 Notion 页面
- 编辑本地文件用 apply_patch，不要用 <edit_reference>（那是改 Notion 页面的）
- 用户说"改""修复""实现""部署"时直接执行，不要只给计划就问要不要做
- 回答代码问题给文件路径、行号，不要用 Notion 引用脚注
- 缺失信息靠工具查，不要反问用户
- 多步复杂任务用 delegate_task 交给本地 codex
```

**验证**：让 Agent 执行 `列出 <工作区根> 目录下的文件`，能看到真实目录内容即通。

## 第 4 步：让服务随 Notion 启停

两件事要一起做：**注入面板**（Notion 单实例会吃掉调试参数，必须先杀干净再带端口起）和 **看护 MCP + 隧道**（生命周期跟着 `Notion.exe` 走）。

本仓库的三个文件已经把这两件事拆好了：

| 文件 | 职责 |
|---|---|
| `launch.mjs` | 确保服务在跑 → 带调试端口起 Notion → 注入面板 → 监视 panel.js |
| `services.mjs` | 只在 `Notion.exe` 存在时拉起 MCP + cloudflared，Notion 关满 25 秒收工 |
| `launch.vbs` / `services.vbs` | 用 `wscript` 无窗口启动，完全脱离控制台 |

**验证**：

- 双击快捷方式 → Notion、`9223`、`8766`、cloudflared 全部出现
- 关闭 Notion → 约 25–30 秒后四者全部退出（看 `services.log` 最后两行）

## 10 个必踩的坑

1. **`WORKSPACE_ROOT` 不是沙箱**。它只是相对路径锚点和默认 cwd，Agent 理论上能访问整个磁盘。
2. **API Token 建不了隧道**。`cfut_` 开头的不能跑隧道，必须用 `eyJ` 的 tunnel token。
3. **新版「公共主机名」改叫「已发布的应用程序」**，藏在「路由」里。
4. **URL 必须带 `/mcp` 结尾**，只填域名连不上。
5. **别用 `getAIUsageEligibility` 判断额度**。它返回遗留字段（`spaceLimit:50`），Business 账号会算出上千 % 的假数字。真实额度只有 `getCreditRateLimitStatus` 有。
6. **`spaceId` 不是每页都有**。`/blank`、`/quick-search` 没有，必须多级回退（URL 参数 → UUID 正则 → localStorage 缓存）。
7. **Notion 单实例**。已有实例会静默吃掉 `--remote-debugging-port`，表现为「开了但端口连不上」。先 `taskkill /F /T /IM Notion.exe`。
8. **`stdio:'ignore'` 让 Python 秒退**（`code=4294967295`）。必须重定向到日志文件。
9. **MCP 不自己读 `.env`**。直接 spawn python 时环境变量是空的，要在启动器里解析合并，否则 401 全拒。
10. **`return` 不会让 Node 退出**。子进程还活着时事件循环不结束，`exit` 钩子的清理永不执行 —— 该用 `process.exit(0)`。

## 验收清单

```
MCP 本地       http://127.0.0.1:8766/mcp            401
MCP 带鉴权     加 Authorization: Bearer            200
公网链路       https://notion-mcp.<域名>/mcp        200
工具目录       list_tools()                        24 个
真实执行       run_command echo OK                 stdout=OK
Notion 连接    设置 → 连接 → Connected             绿勾
端到端         让 Agent 列目录                      真实内容
启停联动       关 Notion 后 25–30 秒                四进程全退
```

## 已知限制

- **多步工具任务不稳**：轻量模型较稳；大模型做 3 步以上连续工具调用时，偶尔出现「收到工具结果后只思考不回答」并中断。建议复杂任务用 `delegate_task` 转发本地 codex / claude 执行，让 Notion 只当调度层。
- **单次 token / 首字延迟抓不到**：桌面版推理走 Electron 主进程，不经过渲染层网络栈，CDP 够不着。只能用额度增量估算。
- **每轮上下文很重**：Notion Agent 自带约 78 个内置工具 + 18 个电脑操作工具，容易干扰工具选择。

## 参考

- MCP 服务端 https://github.com/catoncat/notion-local-ops-mcp
- CDP 注入思路 https://github.com/LeoHsxg/notion-bar-fix
- Cloudflare 隧道 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
