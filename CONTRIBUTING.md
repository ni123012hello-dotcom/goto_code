# 参与开发

先读 [`AGENTS.md`](./AGENTS.md) —— 它是给改这个仓库的 agent 和人的规则，包含安全敏感区、测试约定
和几条"改了会静默失效"的三处同步点。这份文件只讲怎么把环境跑起来和提交前要做什么。

## 环境

| | |
|---|---|
| Node | 22+（用到了 `process.loadEnvFile`） |
| 包管理 | **pnpm**，版本由 `package.json` 的 `packageManager` 指定（`corepack enable` 或直接装对应版本） |
| 平台 | **Windows + PowerShell**。服务端本身跨平台，但 `shell-check` 等套件断言的是工具实际依赖的 PowerShell 行为，所以验证请在这个环境里做 |

```powershell
pnpm install        # 不要中途打断：嵌套依赖会被写坏，只能删 node_modules 重来
pnpm dev            # server + vite，界面在 http://localhost:5173
```

命令行入口（可选）：把 `bin/` 加进 PATH 后用 `gt`，见 README。注意 `goto` 在 cmd 里是内置命令，
所以叫 `gt`。

## 验证

**唯一的验证门是这一条**，它同时也是 CI 跑的东西：

```powershell
pnpm -C server check
```

两个必须知道的细节：

1. **判据是 `FAIL=0`，不是 PASS 条数。** 中文输出经控制台编码可能吞掉换行，PASS 计数会偏低，看起来像少跑了很多测试。
2. **这条链是 `&&` 串起来的。** 中途挂掉，后面的套件根本不会执行——所以看到 PASS 数明显偏低时，先确认它跑到了最后一个套件（`check:sessions` / `check:mode`）。

跑单个套件：`pnpm -C server check:mode`、`check:mcp`、`check:sessions`，脚本名见 `server/package.json`。

## 提交前

- **不要提交 `.data/`。** 里面有会话、记忆、笔记，以及 `settings.json` / `providers.json` / `mcp.json` / `access.json` —— 后四个是**明文密钥或令牌**。`.gitignore` 已经排除了，别绕过它。
- **不要提交 `node_modules/`、`web/dist/`、`*.log`。**
- 新增路由 → 必须加进 `server/src/access.ts` 的 `ROUTE_SEATS`，否则服务端启动时会直接抛错拒绝服务（这是故意的，fail-closed）。
- 改了会话的落盘字段 → 记得**三处**同步：类型、`persistSession` 的 payload、`loadPersistedSessions` 的还原。漏掉后两处不会报错，只会静默丢数据（见 AGENTS §4）。
- 加了依赖前先想清楚：能不能用几十行手写替代。这个项目刻意把依赖压到很少（见 README「依赖风格」）。

## 测试怎么写

测试就在 `server/scripts/*-check.ts`，用 `tsx` 直跑，**不引测试框架**。照现有套件的写法来：

- 每个用例打印一行 `PASS` / `FAIL`，结尾打印汇总；不要抛异常中断整条链。
- 用 `path.dirname(dataFile)` 定位 `.data`，**不要用 `process.cwd()`** —— 后者在 `pnpm -C server` 下是 `server/`，会写出一个谁都不认的平行目录。
- 临时数据用唯一 id，别用固定 sessionID：`.data/` 跨运行持久，上一轮的数据会污染本轮。
- 要改全局设置（apiKey、模型端点）的测试，**结束后必须还原** —— 否则之后的套件测的其实是真 API。

## CI

`.github/workflows/check.yml`，跑在 `windows-latest`：`pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm -C server check`。

## 文档与语言

- 用户可见的文档、界面文案、测试输出：**中文**
- 代码标识符、注释、日志字段：**英文**

改行为的时候顺手把 README 的「已实现 / 未完成」表对一下——它和代码不一致时，看的人会先信文档。
