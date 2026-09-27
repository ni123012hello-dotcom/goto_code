# goto

## 应用是什么

一个跑在**本机**的编码 agent，界面是网页。你在浏览器里给它下指令，它在你的代码库上读文件、改文件、跑命令。

- **默认**只监听 `127.0.0.1`，不上云。默认**不联网**（除了你自己配的模型端点）；唯一的外连是可选、默认关闭的 `fetch` 工具
- 模型走**任意 OpenAI 兼容端点**：OpenAI / DeepSeek / Moonshot / 本地 Ollama / 自建代理都行，靠 `OPENAI_BASE_URL` 切
- 数据全在本地 `.data/` 目录
- 可以**选开**局域网双席位：一个人驱动 AI，另一个人只读检查代码。一旦绑到非回环地址，**所有接口自动要求访问令牌**（见下面「局域网共享」）

**给谁用**：想在自己机器上跑一个可控、可审计、不依赖外部服务的编码 agent 的人。

## 目标与功能

### 已实现

| 功能 | 说明 |
|---|---|
| **Agent 循环** | 最多 40 步，模型不再调工具就停；可随时中止 |
| **12 个工具** | `read` `write` `edit` `list` `grep` `bash` `memory` `ask` `note` `spawn_agents` `fetch` `skill` |
| **上下文压缩** | 三层：L1 工具输出剪枝 → L2 摘要折叠 → L3 硬截断；外加 provider 拒绝时的反应式恢复。触发按**即将发送的实际大小**估算，不用上一次 API 的滞后报告 |
| **长期记忆** | 会话级。来源分级（user/probe/tool/inferred）、probe 交叉验证、冲突自愈、未确认推断会过期 |
| **项目笔记** | **每个对话一份**、agent 写给自己后面几轮看的项目知识文档（是什么/怎么用/注意事项），别的对话看不到；可编辑、可导出 `.md`。面板是**可拖动的浮动窗口**，agent 写入时**实时更新** |
| **文件夹组织** | 纯 UI 分组，不影响 agent 能访问的范围。对话必须归属文件夹，每文件夹上限 50 |
| **多模态** | 粘贴/拖拽图片进输入框；`read` 也能读图片并让模型真的看到 |
| **提问** | agent 卡住时可以调 `ask` 工具向你提问，阻塞等回答后继续 |
| **重新编辑** | 已发出的消息可以改后重发。点 `edit` 时先停掉正在跑的任务，**发送时**才真正丢弃其后的消息（发送前完全可逆） |
| **模型切换** | 每个对话可以单独选模型，选「跟随设置」就用全局默认。列表从 provider 拉取并缓存 5 分钟 |
| **多提供商** | 保存多套 API 端点（baseURL / key / 默认模型），顶栏下拉即切换。切换会一并换掉默认模型；`apiKey` **不会**下发到浏览器 |
| **每模型上限** | 模型的 context / input / output 由你自己填（`.data/models.json`），留空用全局默认。填了 `output`，请求才会真的带上输出上限 |
| **权限门** | `bash` 每次执行都要你批准；支持"本次会话总是允许" |
| **会话持久化** | 重启服务端不丢对话 |
| **文件访问范围** | 默认限制在工作区；输入栏下方可切到「完全访问」 |
| **计划 / 执行模式** | **输入栏左侧的一个按钮**（快捷键 **Tab**）。**计划模式是只读的**：`write` / `edit` / `shell` / MCP 四类**全部禁用**，agent 只能读、搜、抓网页、载入 skill、记笔记、派子智能体（子智能体同样只读）；要改动必须先给方案。**执行模式**解锁全部。只能由用户切，agent 不能自己切 |
| **文件浏览器** | 左侧列出工作区。**双击**文件把路径插进输入框；**拖文件/文件夹进来**即导入工作区（先弹确认，可取消；重名自动改名、绝不覆盖、路径穿越被挡）；agent 动过的文件打上「新/改」标记，它工作时树自动刷新；悬停 `×` 可以把不想看的条目**从树上隐藏**（只影响显示，磁盘上的文件不动，可随时恢复） |
| **结构化日志** | JSONL 落盘 + 内存环形缓冲 + SSE 实时面板；默认不记 prompt 与工具输出原文 |
| **斜杠指令** | `/remember` `/forget` `/memory` `/help`，本地执行不经过 LLM |
| **Token 可视化** | 上下文构成分解 + 逐轮用量走势（压缩造成的断崖可见） |
| **思考过程** | 模型暴露推理时（DeepSeek reasoner、OpenRouter 等）按轮**折叠显示**思考内容。**只用于看，绝不回传给模型** |
| **子智能体** | agent 可以把一件事拆给最多 5 个**独立对话**去做。**创建前一定问你**（列出每个任务，可拒绝）；默认**串行**、可选并发（有冲突风险提示）；**只允许一层**；每个子对话有独立上下文和任务标签，双击卡片开浮动窗口看它的对话，跑完只把摘要交回主对话 |
| **Agent skill** | 按需加载的指令包（`SKILL.md` + 脚本/参考文档）。平时只把**名字和描述**放进 prompt，模型判断有用时才用 `skill` 工具载入正文。两个目录：**项目级** `<工作区>/.agents/skills/`（官方 `skills` CLI 的规范位置，随代码走）、**个人级** `.data/skills/`（本机所有工作区可用）；重名时项目覆盖个人。用 `gt skills add <仓库>` 安装 |
| **MCP** | 接外部工具生态（[Model Context Protocol](https://modelcontextprotocol.io)）。**stdio 传输**，手写 JSON-RPC（不引 SDK）；工具以 `mcp__<server>__<tool>` 注册，参数 schema 来自 server，输出截断到 `MAX_OUTPUT`。**一条命令从别的 agent 那儿导入**配置（opencode / Claude / Cursor / VS Code），但**默认全关**：新加的 server 必须显式确认一次才能跑，且确认被**指纹**钉死在具体命令行上（改了 command/args/cwd 就自动停跑）。常驻进程，不逐次弹窗 |
| **联网抓取** | 可选、**默认关闭**（设置面板里有「ai 联网访问」开关；`WEB_FETCH=true` 只是兜底）。给 URL 返回正文纯文本，只允许公网 http/https；抓回来的内容标注为**不可信输入**（网页可以写"忽略之前的指令"，那是数据不是命令） |
| **局域网双席位** | **默认关闭**。把 `HOST` 设成 `0.0.0.0` 才开启，启动时终端打印「控制席 / 检查席」两条带 `#t=` 的令牌链接。**控制席**驱动 AI、应答权限弹窗、改设置；**检查席**是一套**独立的只读界面**（文件树 + AI 刚写的代码 + 双击看文件全文），且只能看**被显式共享**的对话。令牌走 header 或 URL 片段（片段不发给服务端，所以不进访问日志）；鉴权开关只看**绑定地址**，不看请求来源 IP —— 反向代理下「回环即信任」会变成静默提权。没有 HTTPS，只在可信网络里开 |





### 未完成

以下是已知的缺口，没有排期，欢迎 PR：

- **会话删除撤销 / 回收站** —— `fs.rmSync` 不进回收站、没有备份；删文件夹会级联删掉里面的对话和记忆。最省事的改法是删到 `.data/trash/`
- `ask` 的更多形态、**成本统计（$）**、**LSP 集成**
- **局域网共享只有两席**（控制席 / 检查席），没有账号体系、没有 HTTPS、没有按人隔离；`bash` 仍直接跑在宿主机上，所以只在可信网络里开
- 沙箱隔离（`bash` 直接跑在宿主机上）
- **搜索**（`fetch` 只按 URL 抓公开网页，没有关键词搜索）
- **递归**的子智能体编排（子智能体不能再开子智能体，见上面「子智能体」那条）
- PDF / Office 文档读取（只支持图片）
## 使用指南

### 首次运行

```powershell
cd <这个目录>
pnpm install        # 注意：不要中途打断
pnpm dev
```

浏览器开 `http://localhost:5173`，界面会**自动弹出设置窗**，填：

| 字段 | 说明 |
|---|---|
| API Key | 必填 |
| Base URL | OpenAI 填 `https://api.openai.com/v1`，DeepSeek 填 `https://api.deepseek.com/v1` |
| 模型 | 例如 `gpt-4o-mini` |
| 工作区 | **要让 agent 操作的那个代码库的绝对路径** |

点 `[ 测试连接 ]` 验证后保存。

### 命令行入口（可选）

把 `bin/` 加进 PATH 后：

```powershell
gt          # 构建（如需）→ 起服务 → 自动开浏览器，端口 8787
gt dev      # vite + server 同时起，端口 5173
gt build    # 强制重建前端
gt skills add <仓库>   # 装 agent skill 进「工作区」的 .agents/skills
gt mcp ...             # MCP server（见下面「接入 MCP」）
gt help
```

**注意**：`goto` 这个名字在 cmd 里被内置命令占用，所以命令叫 `gt`。

### 安装 skill

```powershell
gt skills add vercel-labs/agent-skills                 # 整个仓库
gt skills add vercel-labs/agent-skills --skill web-design-guidelines
gt skills list                                         # 已装的
```

用的是官方的 [`skills`](https://github.com/vercel-labs/skills) CLI（`npx skills add ...`）。它的 agent 列表是**写死的**，没有 `goto`，所以直接 `... goto` 会报 `Invalid agents` —— `gt skills` 会自动补上 `-a universal`，那正好是 goto 读取的项目目录 `<工作区>/.agents/skills/`。**装完不用重启**：skill 目录每轮重读，当前对话的下一轮就能用。

要手动跑官方命令也可以，等价写法：

```powershell
cd <工作区>
npx skills add vercel-labs/agent-skills -a universal --copy
```

> 想让 `npx skills add <仓库> goto` 直接可用，得给上游 CLI 加一条 agent 映射（它没有自定义 agent 的扩展点）。

### 接入 MCP

MCP **没有界面**，用 `gt mcp`（需要 goto 在跑）：

```powershell
gt mcp list          # 已配置的 + 从别的 agent 那里发现、还没导入的
gt mcp import        # 从 opencode / Claude / Cursor / VS Code 的配置里导入
gt mcp confirm <id>  # 一次性确认：批准这条具体命令行
gt mcp off <id>      # 停跑，保留批准；gt mcp on <id> 再打开
gt mcp remove <id>   # 彻底删掉
```

`gt mcp import` 会读这些地方：opencode（`~/.config/opencode/opencode.json[c]` + 项目里的 `opencode.json`）、
Claude Desktop / Claude Code / Cursor / Windsurf（事实标准 `mcpServers`）、VS Code（`servers`）。

**导入不会自动获得批准** —— 「别的工具配过」不等于「你批准它在这儿跑」。导入进来的都停在「待确认」，
确认一次才会跑。两个会被明确标出来的问题：目标是 HTTP 的 remote server（goto 目前只有 stdio 传输）、
以及命令或 `env` 里指向**不存在的路径**（占位值、被删掉的目录）。

不想用命令行就直接调接口：`GET /api/mcp`（含 `status`）、`GET /api/mcp/discover`、
`POST /api/mcp/import`、`PUT /api/mcp`、`DELETE /api/mcp/:id`。

```powershell
# 手写配置也行，acknowledge:true 就是那次一次性确认
curl.exe -X PUT http://127.0.0.1:8787/api/mcp -H "content-type: application/json" -d "{\"name\":\"fs\",\"command\":\"npx\",\"args\":[\"-y\",\"@modelcontextprotocol/server-filesystem\",\"C:\\\\work\"],\"enabled\":true,\"acknowledge\":true}"
```

之后 `GET /api/mcp` 能看到它，`status` 是 `ready` / `failed` / `disabled`，失败原因也在里面。

**为什么手写 `trusted: true` 没有用**：批准被**指纹**（`command + args + cwd` 的哈希）钉死在一条具体命令行上。手改配置文件时指纹对不上，就自动当作未确认、不启动。好处是"确认一次"永远不能被用来偷渡一条你没看过的命令：

| 改动 | 结果 |
|---|---|
| 改 `command` / `args` / `cwd` | **自动撤回信任并停掉**，要重新确认 |
| 改 `env`（token 会轮换） | 不影响信任，故意不纳入指纹 |
| `enabled: false` | 停跑，但保留信任，再打开不用重新确认 |

重启后只启动 `enabled && trusted && 指纹匹配` 的 server。每个 server 可用 `tools: ["echo"]` 只暴露部分工具（一个 server 几十个工具会白烧上下文）；全局还有 `MCP_MAX_TOOLS` 封顶。server 挂了它的工具会从列表里消失（模型不会拿到一个调不通的工具）。

### 局域网共享（可选）

默认**关闭**，而且这是有意的：所有路由没有别的防线，把它暴露到局域网等于把这台机器的任意命令执行权限交出去（`bash` 只是过了个弹窗，别的地方没有任何东西挡着）。所以开启方式就是"绑到非回环地址"——**鉴权层随绑定地址一起自动打开**，不需要（也不能）单独关掉它：

```powershell
# 临时开。PowerShell 5.1 没有 &&，所以分两行
$env:HOST="0.0.0.0"
pnpm -C server start

# 长期开：在仓库根建 .env 写一行 HOST=0.0.0.0，之后直接 pnpm -C server start
```

启动时终端会打印两条链接：

```
[goto]   控制席（能下指令）: http://192.168.1.252:8787/#t=...
[goto]   检查席（只能查看）: http://192.168.1.252:8787/#t=...
```

首次会弹一次 Windows 防火墙授权，要点允许（专用网络）。然后：

1. **主机**用**控制席**链接打开 → 左侧导航「共享」→ 对要一起看的那个对话点「共享给检查席」
2. **对方**用**检查席**链接打开 → 独立的只读界面：左边文件树，右边「AI 刚写的代码」，**双击文件名看全文**。会话列表每 8 秒轮询一次，共享和取消共享都会自动跟上，不用手动刷新

两条链接里的令牌就是凭据，别贴到公开场合。检查席链接外泄了就在「共享」面板点「重新生成」——只作废检查席，控制席链接不受影响。

几个会绊到人的地方：

| 现象 | 原因 |
|---|---|
| 本机打开 `127.0.0.1:8787` 停在「需要访问链接」 | 鉴权开启后**人人**要令牌，包括主机自己。用带 `#t=` 的控制席链接，存成书签 |
| 同一个浏览器开不出两个席位 | 令牌存在 `localStorage`，同源共享。自测请用两个浏览器 / 隐私窗口 / 两台设备 |
| `pnpm dev` 下检查席从别的设备连不上 | vite 只绑本机。局域网两席要用构建产物（`pnpm build` 后由服务端托管） |
| 对方打开什么都没有 | 控制席还没在「共享」里共享那一个对话。检查席只看**被显式共享**的会话 |

关掉：删掉 `.env` 里那行（或改回 `127.0.0.1`）再重启，就回到单机、无令牌。令牌库在 `.data/access.json`（勿提交），删掉它下次开启会重新生成一对。

### 验证

```powershell
pnpm -C server check     # typecheck + 17 个测试套件
```

### 配置

`.env` 是**兜底**，优先级低于 Web UI 里保存的设置。全部开关见 [`.env.example`](./.env.example)，常用的：

```
CONTEXT_WINDOW=128000        # 模型窗口
COMPACTION_RESERVED=         # 预留缓冲，留空=20000
MEMORY_MAX_TOKENS=2000       # 记忆预算
MAX_SESSIONS_PER_FOLDER=50
MCP_MAX_TOOLS=32             # MCP 工具定义总上限（每个请求都带）
MCP_TIMEOUT_MS=30000         # 单个 MCP 请求超时
VISION=true                  # false 时附件换成文字占位
LOG_LEVEL=info
HOST=127.0.0.1               # 改成 0.0.0.0 就是开局域网共享，并强制所有接口要令牌
SHARE_AUTH=                  # 留空=按 HOST 判断；on=连回环也要令牌（测试用）。没有 off
```

## 架构与约定

### 目录

```
shared/protocol.ts      前后端唯一契约（事件、Part、类型）
server/
  src/index.ts          HTTP 路由 + SSE + 静态托管
  src/access.ts         席位令牌库 + 路由→席位分类表（启动时自检，未分类拒绝启动）
  src/agent/            loop / tools / compact / overflow / prompt / probe / tokens / llm / models / registry
  src/sessions.ts       会话状态与持久化
  src/memory.ts         长期记忆
  src/notes.ts          对话级项目笔记
  src/skills.ts         Agent skill（项目 + 个人两个根）
  src/folders.ts        文件夹树
  src/files.ts          上传文件存储
  src/tree.ts           工作区目录列举（每层一次）
  src/preview.ts        只读文件预览（永久锁在工作区内）
  src/questions.ts      提问阻塞
  src/permissions.ts    权限阻塞
  src/safety.ts         路径校验
  src/log.ts            结构化日志
  scripts/*-check.ts    测试套件
web/
  src/App.tsx           控制席主布局与全部接线
  src/ReviewApp.tsx     检查席的独立界面（文件树 + AI 改动 + 只读代码）
  src/useSession.ts     SSE 事件 → reducer → 状态
  src/api.ts            REST 客户端（令牌在这里注入所有请求）
  src/auth.ts           席位令牌的读取与携带
  src/changes.ts        从工具调用推出「AI 刚改了什么」（两个界面共用）
  src/bus.ts            跨窗口同步
  src/components/       29 个组件
```

### 席位模型

同一个进程最多两个角色，由客户端持有的令牌决定，**只看绑定地址不看来源 IP**：

| 席位 | 能做 | 不能做 |
|---|---|---|
| **控制席** | 驱动 AI、应答权限/提问/子智能体弹窗、改设置、MCP、文件夹、上传、切模式与访问范围 | — |
| **检查席** | 看被共享会话的实时事件流、文件树、工作区文件内容、笔记与记忆的读取接口 | 发指令、中止、重做、应答任何弹窗、改任何设置 |

实现上有两点是刻意的：

- **`index.ts` 的每条路由都必须在 `access.ts` 的 `ROUTE_SEATS` 里分类**，否则启动时直接抛错拒绝服务。默认值是 `control`（fail-closed），所以漏掉一条只会锁住检查席、不会放它进来；而表里写错一个路径会让启动失败，比日后收到"检查席莫名 403"的报告强。
- **控制席和检查席是两套界面，不是一套界面关掉几个按钮**。`App.tsx` 是控制席的，检查席走 `ReviewApp.tsx`。服务端才是边界，界面只负责不画死按钮。

### 数据（`.data/`）

| 路径 | 内容 |
|---|---|
| `settings.json` | API key、模型、工作区（勿提交） |
| `sessions/<id>.json` | 会话与消息 |
| `memory/<sessionID>.md` | 会话级记忆 |
| `notes/<sessionID>.md` | 对话级项目笔记 |
| `skills/<name>/SKILL.md` | 个人 skill。**项目 skill 不在 `.data` 里**，在工作区的 `.agents/skills/`（那才是官方 CLI 的规范位置，且应随代码提交） |
| `models.json` | 每模型的上限（context / input / output） |
| `providers.json` | 保存的 API 端点预设（含 key，勿提交） |
| `mcp.json` | MCP server 定义（command / args / env / **信任指纹**，**env 是密钥**，勿提交） |
| `access.json` | 局域网共享的两把席位令牌（只在开启共享后生成，**勿提交**） |
| `files/<fileID>` | 上传的图片 |
| `folders.json` | 文件夹树 |
| `logs/goto.jsonl` | 运行日志（自动轮转） |

### 关键设计决定

- **`shared/protocol.ts` 是唯一契约**。改它两端一起报类型错，不会静默失配。
- **记忆是会话级，文件夹是纯 UI 分组**。两者都不影响 agent 能访问什么——工作区才决定。
- **`read/write/edit/list/grep` 走路径校验，`bash` 不走**。所以"文件访问范围"开关约束的是文件工具，**不是安全边界**；`bash` 靠的是权限弹窗。
- **记忆有 probe 交叉验证兜底，摘要和笔记没有**。所以只有记忆会进「已确认」组，其余都标注"需自行核实"。
- **工具名 `bash` 与实际 shell 不一致**（Windows 上跑 PowerShell）。名字保留是为了不破坏 `PERMISSION_TOOLS=bash` 的权限匹配，靠工具描述讲清事实。
- **计划模式是白名单，不是黑名单**。`PLAN_MODE_TOOLS`（`tools.ts`）显式列出允许的工具，所以**将来新增的工具默认在计划模式下不可用**；改成"除 write/edit/bash 之外都放行"会让每一个新工具悄悄获得写权限。shell 在计划模式下**整个禁掉**而不是过滤"危险命令"——过滤永远能被绕过（别名、`cmd /c`、字符串拼接、base64），而禁掉是结构性的。
- **Tab 在输入框里有两个用途**：斜杠指令菜单开着时归补全（原行为），否则切换计划/执行模式。**Shift+Tab 故意不劫持** —— Tab 是标准的前进焦点键，全占掉会把键盘用户困在输入框里。
- **MCP 的批准在 server 级，并且被指纹钉死**。不逐次弹窗（那会变成噪声，用户学会一路点"总是允许"），而是确认一次；`command`/`args`/`cwd` 一变就自动撤回信任并停跑。手改配置文件无法自我授权——`trusted: true` 单独写不算数，必须有能对上的 `fingerprint`。见 `mcp.ts` 的 `runnableMcpServers()`。

## 注意事项

### 安全相关

1. **`bash` 是唯一的任意代码执行入口，且靠用户点批准**。凡是能让模型间接执行命令的地方都要当成同等危险对待——`grep` 曾经因为 `shell: true` 拼接参数而可注入（已修，见 `injection-check.ts`）。
2. **删除是永久的**。`fs.rmSync` 不进回收站，没有撤销。删文件夹会级联删掉里面的对话和记忆。
3. **`bash` 不受工作区限制**，`type %USERPROFILE%\.ssh\id_rsa` 只要批准就能读。
4. **MCP server 是第三方进程，会拿到完整权限**。工具调用本身**不逐次弹窗**（批准发生在 server 级），所以确认那一次必须看清 `command` 和 `args`。防护是：新 server 默认不跑、必须 `acknowledge: true`、定义一改就自动撤回信任。它读到的内容也标注为不可信输入——`mcp__*` 工具的返回值只当数据，不当指令。
5. **开局域网共享等于把上面几条一起交出去**，只是多了一层令牌。检查席确实读不了、写不了，但它共享的是**同一个工作区和同一个 shell**；令牌也没有 HTTPS 保护，同网段抓包就能拿到。只在可信网络里开，用完就把 `HOST` 改回来。

### 开发时容易踩的

| 坑 | 症状 |
|---|---|
| 批处理文件写成了 LF | 标签跳转错乱、输出丢失。**必须 CRLF** |
| 用 `shell: true` 拼动态参数 | 命令注入 |
| `deleteSession` 没取消 `scheduleSave` 的防抖定时器 | 删掉的文件被写回来，磁盘上留下"僵尸会话" |
| 缓存了 `index.html` | 重建后哈希变了，服务端还发旧 HTML，浏览器白屏 |
| 测试用固定 sessionID | `.data/` 跨运行持久，上一轮的数据污染本轮 |
| 用环境变量改模型端点做测试 | 会被 UI 保存的设置覆盖，测的其实是真 API |
| `pnpm install` 中途打断 | 嵌套依赖被写坏，只能删 `node_modules` 重来 |
| PowerShell 里 `&&` | Windows PowerShell 5.1 不支持，`pwsh` 7 才支持 |
| 在 cmd 里 `mkdir -p x` | 会建出两个目录：`-p` 和 `x` |
| 中文测试输出被控制台编码吞换行 | 断言计数不准，看 `FAIL=0` 而不是看 PASS 条数 |
| 改了 `server/` 却没重启进程 | 前端产物是现读的，于是变成「新界面 + 旧服务端」：界面有按钮，点下去只报 `404 Not Found`。现在启动时会自检并提示重启 |
| 新增路由没加进 `access.ts` 的 `ROUTE_SEATS` | 服务端**启动直接抛错**拒绝服务。这是故意的（fail-closed），不是 bug |
| 想用请求来源 IP 判断席位 | 别这么做。反向代理下所有请求都来自 `127.0.0.1`，「回环即信任」会静默提权。判据只有绑定地址 |
| 在 `App.tsx` 里写检查席的分支 | 检查席跑的是 `ReviewApp.tsx`，`App.tsx` 只服务控制席，那些判断都是死代码 |

### 依赖风格

依赖刻意压到最少：server 5 个运行时依赖（hono / @hono/node-server / openai / fast-glob / diff），web 4 个（react / react-dom / react-markdown / remark-gfm）。没有状态管理库、没有 UI 组件库、没有图表库（图形是手写 SVG）、没有 `zod`（工具 schema 直接写 JSON Schema）。

引新依赖前先想清楚能不能用几十行手写替代。

## 许可

**MIT** —— 见 [`LICENSE`](./LICENSE)。

本项目还包含两个上游的成果，均为 MIT，详见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)：

- 从 [opencode](https://github.com/anomalyco/opencode) 移植的代码
- 来自 [models.dev](https://github.com/anomalyco/models.dev) 的模型数据（`server/vendor/models.dev.json`，用 `pnpm -C server models:sync` 刷新）
