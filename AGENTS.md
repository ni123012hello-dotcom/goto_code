# AGENTS.md

写给在这个代码库上工作的 AI agent。`README.md` 讲的是"这个项目是什么"，这里讲的是"动手前必须知道什么"。

## 1. 改完必须验证

```powershell
pnpm -C server check
```

这一条会跑 `typecheck` + 17 个测试套件。**判据是 `FAIL=0`，不是看 PASS 条数** —— 中文输出经过控制台编码会吞掉换行，导致 PASS 计数偏低，那是假象。

**先看链有没有断。** `check` 是一串 `&&`，任何一个套件挂掉后面的就全不跑了 ——
曾经有个套件中途崩了，导致 PASS 只有 88（正常 180）却没人察觉。看到 PASS 数明显偏低，
先确认跑到了最后一个套件（`check:sessions`）。

注意：`check` 脚本依赖 `node_modules` 已装好。没装先 `pnpm install`。

**没跑过这个命令，不要说"改好了"。**

## 2. 类型契约只有一份

`shared/protocol.ts` 是前后端唯一契约。改它两端会一起报类型错 —— 这是刻意设计的，让失配不可能静默发生。

- 新增事件 → 加进 `ServerEvent` 联合类型 → 前端 `useSession.ts` 的 reducer 加 case。
  **注意作用域**：`emit(session, ...)` 只发给那一个会话的订阅者。
  一个会话可能在多个窗口/标签页里开着（笔记窗口就是），所以"只发给拥有者"仍然是正确的——
  但要清楚**别的会话收不到**。历史上笔记曾经是文件夹级、需要广播给整个文件夹，
  后来改成了对话级，`emitToFolder` 也随之删掉了。加新事件前先想清楚它的作用域到底是什么
- 新增 Part 类型 → 加进 `Part` 联合 → 所有 `part.type === "..."` 分支都要考虑它（漏了会 `undefined` 运行时报错，不是类型错）

## 3. 安全敏感区（改动前停下来想清楚）

| 区域 | 要求 |
|---|---|
| **任何 `spawn` / `exec`** | **绝不** `shell: true` 拼动态参数。Node 不转义，只拼接 → 命令注入。`grep` 曾经就这么漏过。要用固定参数先解析出可执行文件全路径，再 `shell: false` |
| **路径处理** | 一律走 `safety.ts` 的 `resolveInside()`，不要自己 `path.join` 拼 |
| **删除** | `fs.rmSync` 不进回收站，无撤销。删文件夹会级联删对话和记忆 |
| **日志** | 不要把 prompt、工具输出原文、apiKey 写进日志。`LOG_LLM_PAYLOAD` / `LOG_TOOL_OUTPUT` 默认关闭是有原因的 |
| **权限** | 工具名改动会让 `PERMISSION_TOOLS` 失配 → **静默失去权限拦截**。改名前先想清楚 |
| **计划模式** | `PLAN_MODE_TOOLS`（`tools.ts`）是**白名单**：新增工具默认在 plan 下不可用，别改成黑名单。拦截必须在**两处**且都不多余 —— `toolSchemas(session.mode)` 不提供，`loop.ts` 执行前再查一次（模型可以调用没提供给它的工具）。加了新工具要判断它能不能改东西，能就别加进白名单。shell 是**整个禁掉**的：过滤"危险命令"没有意义（别名 / `cmd /c` / 拼接 / base64 都能绕） |
| **MCP** | 工具一律 `mcp__<server>__<tool>`（用 `mcp.ts` 的 `mcpToolName()` 构造，它同时管 64 字符上限）。**批准在 server 级、不逐次弹窗**，靠三样东西守住：新 server 默认 `enabled:false` + 确认只能靠 `acknowledge:true` + 确认被 `definitionFingerprint(command,args,cwd)` 钉死。**改 command/args/cwd 必须自动撤回信任**（`trusted` 落盘但读回时重新校验，所以手改文件无法自我授权）。**从别的 agent 导入（`mcp-import.ts`）也绝不授予信任** —— 「别的工具配过」不是本工具的批准。`env` 是密钥，绝不下发浏览器。spawn 一律 `shell:false`；只有 Windows 的 `.cmd/.bat` 走 `cmd.exe /d /s /c`，且每个 token 过 `quoteForCommandLine()`（拒绝 `" % \r \n`）。**模型给的参数永远不上命令行**，只走 stdin JSON |
| **压缩触发** | 判断必须基于 `projectedTokens()`（即将发送的实际大小），**不要退回 `lastUsage()`**。那是上一次 API 的实测值，滞后于本轮新增的工具输出 —— 这正是"上下文涨到 100% 而压缩从不触发"的成因。同理，不要再引入"裁剪后推迟摘要"之类把决定赌在下一次报告上的捷径 |
| **上下文经济** | 工具输出是上下文的最大消耗（实测一整轮 179KB，全是 `Get-Content <file> -Raw`）。读文件一律用 `read`（有分页和行号），**不要**在 `bash` 里 `cat`/`Get-Content` 整文件打印。每个工具都要有输出上界：`bash` 是 `BASH_MAX_OUTPUT`(8000)，文件类工具是 `MAX_OUTPUT`(20000)，`read` 还有 `READ_MAX_LINES`(400)。加新工具时先想清楚它的上界是多少 |
| **read / grep 的资源上界** | **输出**上界之外还有**资源**上界，两者不是一回事：`read` 是先把整个文件读进内存再分页，所以 `MAX_READ_BYTES`(8MB) + 首块 NUL 二进制嗅探防的是 **OOM**，不是上下文，别以"反正会截断"为由删掉。`grep` 的 JS 回退（`rg` 不在 PATH 时**本机就是这条**）**必须在子进程里跑**并带超时（`grep-fallback.mjs` + `GREP_TIMEOUT_MS`）：pattern 来自模型，灾难性回溯的 `RegExp.test` 无法中断，进程内跑会冻住整个事件循环，连中止的 UI 都按不动。别把它改回 `new RegExp(pattern)` 原地编译 |
| **思考内容（`reasoning` part）** | **绝不能出现在请求里** —— DeepSeek 的 reasoner 收到回传的思考会直接 400。目前 `toChatMessages` 只取 `text` / `tool` / `file` / `compaction`，所以天然排除；改它的时候别顺手把 `reasoning` 加进去。另外 `estimateMessages` 也必须排除它：它存了但不发，算进投影会让压缩白白提前触发（`context-check.ts` 有回归断言） |
| **拖入文件（`/api/workspace/upload`）** | 这是**唯一一个会把用户文件写进真实项目**的入口（其余上传都进 `.data/files/`）。目标目录 `dir` 和每个文件的 `path` **要区别对待**：`dir` 来自我们自己的树，含 `..` / 以 `/` 开头 / 带盘符就**直接拒**；`path` 来自操作系统的拖拽载荷（拖文件夹时是整棵结构），只能**清洗**——过 `safeRelativePath()` 丢掉每段里的 `.` / `..` 和非法字符，再 `resolveInside` 兜一次。另外绝不覆盖已存在的文件（自动加 ` (2)` 后缀），且**单个文件失败不能让整批 500** |
| **apiKey** | 只存在服务端。`publicSettings()` 和 `publicProviders()` 返回的都是**掩码**，浏览器永远拿不到原文。所以前端保存时的**空 key 必须解释成"保持原值"**，不能让 `updateSettings()` 把它当成"删除这个字段"——`activateProvider()` 里就是靠这个把空值过滤掉的 |

## 4. 数据结构改动要考虑旧文件

`.data/` 里的东西是持久化的：`sessions/*.json`、`memory/*.md`、`notes/*.md`、`folders.json`、`models.json`、`settings.json`、`providers.json`、`mcp.json`。

加字段时**必须**在读取处给旧文件兜底：

```ts
accessMode: raw.accessMode === "full" ? "full" : "workspace"
// 可选字段：旧文件里没有，读到就是 undefined
model: typeof raw.model === "string" && raw.model.trim() ? raw.model : undefined,
```

**并且注意 `persistSession` 是"挑字段写"的**（不能整对象序列化：`subscribers` 是 Set、
`abort` 是 AbortController）。所以新增一个字段要同时改**三处**：

| 位置 | 漏了会怎样 |
|---|---|
| `Session` / `SessionInfo` 类型 | 编译不过（这个会报） |
| `persistSession` 的 payload | **字段不落盘，重启就丢** |
| `loadPersistedSessions` 的还原 | **读不回来，静默变 undefined** |

中间和最后一项都不会报错。`model` 就这么漏过一次，被 `session-check` 的"模型会落盘"断言抓了出来。

启动时的迁移逻辑已经有先例（`assignOrphansToFolder` 修复悬空 `folderID`）。改完拿一个旧文件试一遍。

## 5. 测试约定

写在 `server/scripts/*-check.ts`，用 `tsx` 直接跑，不引测试框架。

**必须遵守的四条**：

1. **sessionID 必须每次运行唯一** —— `.data/` 跨运行持久，固定 ID 会被上一轮的数据污染
2. **不要动真实的 `.data/`** —— 要备份/还原，或用完后清掉自己创建的
3. **测 LLM 相关逻辑用假服务端**，不要打真实 API。注意**环境变量会被 UI 保存的设置覆盖**，所以要么改 `.data/settings.json`，要么用设置接口切换
4. **解析 `.data` 路径必须用 `path.dirname(dataFile)`，绝不用 `process.cwd()`** ——
   `config.ts` 的 `dataFile` 是**模块相对**的（`import.meta.url`），而 `pnpm -C server` 的
   cwd 是 `server/`。用 cwd 会指向 `server/.data/`，那是**另一个目录**：

   | 后果 | 说明 |
   |---|---|
   | 备份取到 `null` | 备份的文件从来不存在 |
   | 测试直接改真实数据 | 以为在改副本，其实在改 `.data/` |
   | 清理删不到东西 | 测试残留一直堆着 |
   | 断言在末尾抛错 | restore 那几行**永远执行不到** |

   `folders-check` 和 `files-check` 都栽在这上面，前者每次跑 `check` 都会把真实文件夹树
   留在测试中间状态。写新测试时照抄 `session-check.ts` 的 `path.dirname(dataFile)`。

写完确认一遍：跑两次，第二次也应该是 `FAIL=0` 且**没有新增残留文件**。

## 6. 代码风格

- **注释只解释"为什么"，不复述代码**。上面那些安全决定都留了注释说明背景，照这个标准
- 标识符、注释、日志、工具描述用英文；给用户看的 UI 文案和文档用中文
- **不要加新依赖**。当前 server 5 个、web 4 个运行时依赖是刻意压的。手写几十行能替代就不要引包（图表、状态管理、schema 校验、UI 组件库都被明确排除了）
- **包管理器只有 pnpm**（`pnpm-lock.yaml` + `pnpm-workspace.yaml`，根 `package.json` 的脚本已全改成 `pnpm -C`，并写了 `packageManager`）。**不要跑 `npm install`** —— 会生成第二份 `package-lock.json`，然后两套解析结果开始漂移
- 前端没有测试，验证靠 `tsc --noEmit` + `vite build` + 人工看

## 7. Windows 特有的坑

这个项目在 Windows 上开发，以下都真实踩过：

| 坑 | 说明 |
|---|---|
| `.cmd` 文件必须 CRLF | LF 会让标签跳转错乱、输出丢失，而且症状极不一致 |
| cmd 内置命令会抢占 PATH | `goto` 是内置命令，PATH 上的同名文件永远轮不到执行 |
| `~` 在 cmd 里不展开 | 用 `%USERPROFILE%` |
| `mkdir -p x` 在 cmd 里 | 建出两个目录：`-p` 和 `x` |
| PowerShell 5.1 不支持 `&&` | 只有 PowerShell 7（`pwsh`）支持。工具描述里会按实际解析到的版本动态说明 |
| PowerShell 5.1 输出是控制台代码页 | 中文会乱码，`tools.ts` 里有 UTF-8 前置 |
| 用 PowerShell 写测试脚本 | 引号/反引号/数组遍历极易出错。**端到端测试用 Node 写** |

## 8. 端到端验证怎么做

纯单元测试覆盖不了 HTTP 路由和 agent 循环。做法（`server/scripts/` 之外，临时脚本）：

1. 起一个**假的 OpenAI 兼容服务端**（`node:http`，返回 SSE 格式的 chunk），按调用次数返回不同的 tool_call 或文本
2. 用不同的 `PORT` 起真实 goto server
3. 通过设置接口把端点指向假 LLM（**不是环境变量**，会被覆盖）
4. 走 HTTP 和 SSE 完成整个流程
5. 结束后还原设置、删掉创建的会话

`grep` 测试里的注入用例就是这么写的：**先复现漏洞，再证明修复**。

## 9. 当前状态

- `README.md` 的「未完成」一节是待办来源
- 没有 CI，没有 lint，验证就是第 1 节那条命令
- 前端构建产物在 `web/dist/`，服务端直接托管它。**重建前端不用重启服务端**（`index.html` 是每次现读的）
- **但改了 `server/` 下的代码，必须重启进程**。前端不用重启这一点很容易让人以为改了后端也不用，
  于是出现「新前端 + 旧服务端」：界面有按钮，点下去却是 `404 Not Found`。
  第一次遇到时排查了很久（服务端比前端产物老了一个小时，缺 4 个路由）。
  现在有 `GET /api/version` 握手：前端启动时会核对它需要的路由是否都注册了，
  缺了就在顶部打一条「服务端比前端旧，重启 gt」的横幅。加新接口时记得把它加进
  `web/src/api.ts` 的 `REQUIRED_ROUTES`
- 前端 `request()` 对「框架级的 404」（`text/plain` 的 `404 Not Found`，而不是我们自己的
  JSON 错误）会抛 `code: "STALE_SERVER"` 并给出人话提示，所以即使没看横幅也不会再看到裸的 404
- **skill 有两个根**，顺序即优先级：`<工作区>/.agents/skills`（项目级，官方
  [`skills`](https://github.com/vercel-labs/skills) CLI 里 `universal` 对应的目录，应该随代码提交）
  和 `.data/skills`（个人级，本机通用）。**不要把项目根搬进 `.data`** —— 那样 skill 就不跟代码走了。
  `npx skills add <仓库> goto` 报 `Invalid agents` 是**上游限制**（agent 列表写死在它的源码里，
  也没有自定义 agent 的扩展点），不是这边的缺陷；`gt skills` 会自动补 `-a universal`。
  prompt 注入只放名字和描述（`PROMPT_BUDGET_CHARS` 兜总量），正文由 `skill` 工具按需载入
