# MiniCode 复刻基线分析

> 对标参考版：`D:\MiniCode-main`（mini-code v0.1.0）
> 当前半成品：`D:\minicode`
> 生成时间：2026-08-05

## 结论摘要

参考版是一个“终端编码 agent”项目，核心是 `model -> tool -> model` 循环，外加全屏 TUI、权限审批、会话持久化、上下文压缩、Skills/MCP 扩展。半成品目前能跑通最简 readline 对话和一部分工具，但距离参考版还差：编译基线、配置体系、模型适配层、完整工具协议、权限系统、会话事件模型、上下文压缩体系、TUI 交互层、Skills/MCP、安装/初始化、测试体系。

参考版约 22 个功能域；半成品状态为：4 个已实现/接近实现、5 个部分实现、8 个缺失，并存在 3 个 TypeScript 编译错误和若干逻辑/参数问题。

---

## 1. 参考版架构与技术栈

### 1.1 技术栈

- TypeScript 5.9 + Node.js ESM（`"type": "module"`），用 `tsx` 直接运行 TS 源码。
- 运行时依赖只有 `zod`（工具入参校验）和 `diff`（文件 diff）。
- 模型接入不走 SDK，直接请求 Anthropic Messages API（`src/anthropic-adapter.ts`），并通过 `ModelAdapter` 接口支持 `MockModelAdapter` 离线调试。
- 工具协议是自研 `ToolRegistry`：统一 `{ name, description, inputSchema, schema, run }`。
- 测试用 Node 内置 `node:test` + `tsx`，由 `test/run-tests.mjs` 聚合执行。
- 数据全部落在 `~/.mini-code/` 下的 JSON/JSONL 文件，无数据库、无服务端。

### 1.2 目录结构

```text
MiniCode-main/
├─ bin/minicode                 # bash 启动器，内部 exec tsx src/index.ts
├─ docs/                        # 产品介绍页（index.html、logo.svg）
├─ external/                    # MiniCode-rs / Python / Go / Java 子模块
├─ src/
│  ├─ index.ts                  # CLI 入口：--resume/--fork、TTY 与非 TTY 分流
│  ├─ tty-app.ts                # 全屏 TUI 主应用（2469 行）
│  ├─ tui/                      # 渲染组件：chrome/transcript/input/input-parser/screen/markdown
│  ├─ agent-loop.ts             # 多步工具调用主循环
│  ├─ anthropic-adapter.ts      # Anthropic Messages API 适配器
│  ├─ mock-model.ts             # 离线 mock 模型
│  ├─ tool.ts                   # ToolRegistry + ToolResult
│  ├─ tools/                    # 12 个内置工具
│  ├─ permissions.ts            # 路径/命令/编辑三类权限
│  ├─ session.ts                # JSONL 会话事件持久化
│  ├─ memory.ts                 # 分层指令文件加载
│  ├─ skills.ts                 # SKILL.md 发现/加载/安装
│  ├─ mcp.ts                    # MCP stdio/HTTP 客户端
│  ├─ compact/                  # microcompact/snip/context-collapse/auto/manual
│  ├─ utils/                    # token 统计、工具结果落盘、web 请求
│  └─ init.ts / install.ts / manage-cli.ts / cli-commands.ts / history.ts
└─ test/                        # 25+ 个测试文件
```

### 1.3 依赖与脚本

参考版 `package.json`：

```json
{
  "dependencies": { "diff": "^8.0.4", "zod": "^4.1.5" },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "eslint": "9.39.1",
    "tsx": "^4.20.6",
    "typescript": "^5.9.2",
    "typescript-eslint": "8.46.4"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "check": "tsc --noEmit",
    "lint": "eslint src test",
    "test": "node test/run-tests.mjs",
    "install-local": "tsx src/install.ts"
  }
}
```

### 1.4 启动方式

```bash
cd MiniCode-main
npm install
npm run install-local      # 交互式配置模型/BaseURL/AuthToken，生成启动器
minicode                   # 安装后启动
npm run dev                # 开发模式
MINI_CODE_MODEL_MODE=mock npm run dev   # 离线演示
npm run check
npm test
```

管理命令：

```bash
minicode mcp list|add|remove|login|logout [--project] ...
minicode skills list|add|remove [--project] ...
minicode --resume <session-id>          # 或 --resume 打开选择器
minicode --fork <session-id>
```

### 1.5 环境变量与配置

配置文件合并顺序（后者覆盖前者）：

```text
~/.claude/settings.json
  -> ~/.mini-code/mcp.json
  -> 项目根 .mcp.json
  -> ~/.mini-code/settings.json
  -> 运行进程环境变量 process.env
```

主要环境变量：

| 变量 | 作用 |
| --- | --- |
| `MINI_CODE_HOME` | 自定义 MiniCode 数据目录，默认 `~/.mini-code` |
| `MINI_CODE_BIN_DIR` | 安装启动器的目录，默认 `~/.local/bin` |
| `MINI_CODE_MODEL` | 覆盖模型名 |
| `MINI_CODE_MODEL_MODE=mock` | 使用离线 MockModelAdapter |
| `ANTHROPIC_BASE_URL` | 模型 API BaseURL，默认 `https://api.anthropic.com` |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | 鉴权 |
| `ANTHROPIC_MODEL` | 兼容 Claude Code 的模型名来源 |
| `MINI_CODE_MAX_OUTPUT_TOKENS` | 覆盖最大输出 token |
| `MINI_CODE_MAX_RETRIES` | 模型请求重试次数，默认 4 |
| `MINI_CODE_DEBUG_AUTOCOMPACT=1` | 输出自动压缩调试日志 |

关键文件：

```text
~/.mini-code/settings.json      # 模型、env、mcpServers
~/.mini-code/mcp.json           # 全局 MCP 配置
~/.mini-code/permissions.json   # 权限 allowlist/denylist
~/.mini-code/history.jsonl      # TUI 输入历史
~/.mini-code/projects/          # 按工作目录隔离的会话 JSONL
~/.mini-code/tool-results/      # 超大数据结果落盘
```

### 1.6 前置依赖服务

- Node.js（建议 20+，需要全局 `fetch`、`AbortSignal.timeout`、`node:test`）。
- npm（安装依赖）。
- 一个 Anthropic Messages 兼容 API 端点；或用 `MINI_CODE_MODEL_MODE=mock` 离线运行。
- `rg`（参考版 `grep_files` 默认调 ripgrep；缺失时该工具报错）。
- 可选：MCP server（stdio 或 streamable-http）。
- `web_search`/`web_fetch` 需要网络。

---

## 2. 功能模块清单

| 模块 | 参考版文件 | 作用 | 输入 | 输出/交互 |
| --- | --- | --- | --- | --- |
| CLI 入口 | `src/index.ts` | 解析 `--resume/--fork`，管理命令分流，TTY/非 TTY 分流 | argv、stdin | 启动 TUI 或 readline REPL |
| 管理命令 | `src/manage-cli.ts` | `minicode mcp/skills` 子命令 | 命令行参数 | 读写 MCP/skills 配置 |
| 配置 | `src/config.ts` | 合并 Claude/MiniCode/项目配置与 env | 文件、env | RuntimeConfig |
| 模型适配 | `src/types.ts`, `anthropic-adapter.ts`, `mock-model.ts` | 统一模型协议 | ChatMessage[] | AgentStep（文本/工具调用/思考） |
| Agent 循环 | `src/agent-loop.ts` | 执行 `model -> tool -> model` 多步循环 | 用户消息 + 工具注册表 | 追加 assistant/tool 消息并返回最终 messages |
| 工具框架 | `src/tool.ts`, `src/tools/*` | 注册、zod 校验、执行 12 个内置工具 | 工具名 + 入参 + ToolContext | ToolResult `{ok, output}` |
| 权限 | `src/permissions.ts` | 路径/命令/编辑三类审批与持久化 | 目标、意图、diff | 放行或抛错，交互审批 |
| 文件 Review | `src/file-review.ts` | 写文件前生成 diff 并走审批 | 原内容/新内容 | 审批通过后落盘 |
| Skills | `src/skills.ts` | 扫描 4 个 SKILL.md 目录并加载 | cwd、skill 名 | SkillSummary/LoadedSkill |
| MCP | `src/mcp.ts`, `mcp-status.ts` | 启动 stdio/HTTP MCP client，把远端工具/资源/提示词接入 | mcpServers 配置 | 动态工具 + 状态摘要 |
| 会话 | `src/session.ts` | JSONL 事件持久化、恢复、fork、rename、清理 | cwd、sessionId、messages | 追加事件，重建会话与 transcript |
| Memory | `src/memory.ts` | 分层加载 MINI.md/CLAUDE.md/rules，支持 @include | cwd | 渲染进 system prompt 的文本 |
| 历史 | `src/history.ts` | TUI 输入历史持久化 | 输入记录 | history.jsonl（最多 500 条） |
| 压缩 | `src/compact/*` | microcompact、snip、context-collapse、auto/manual compact | messages + 模型 | 压缩后的 messages、boundary 事件 |
| Token 统计 | `src/utils/token-estimator.ts`, `model-context.ts`, `context.ts` | provider usage 优先、估算兜底、上下文窗口 | messages、model | ContextStats |
| 结果落盘 | `src/utils/tool-result-storage.ts` | 超大工具输出落盘并替换为预览 | tool_result | 替换后的消息 |
| Web 工具 | `src/utils/web.ts` | 带重试/超时的网页抓取与搜索 | URL/query | 纯文本、搜索结果 |
| TUI | `src/tui/*`, `src/tty-app.ts`, `src/ui.ts` | 全屏渲染、输入、审批弹窗、会话选择器 | 键盘/鼠标/模型事件 | 实时画面 |
| 初始化/安装 | `src/init.ts`, `src/install.ts` | `/init` 生成项目文件；install-local 写配置与启动器 | cwd、交互输入 | 文件产物 |
| 后台任务 | `src/background-tasks.ts` | 注册并查询后台 shell 任务 | pid | 任务状态 |
| 工具快捷键 | `src/local-tool-shortcuts.ts` | `/ls /read /write /edit /patch /cmd` 等直接映射到工具 | 文本命令 | ToolShortcut |
| 测试 | `test/*` | 覆盖压缩、会话、权限、TUI 渲染、token 等 | 单测 | 通过/失败 |

---

## 3. 半成品逐条对比

状态说明：`已实现` 表示行为基本对齐；`部分实现` 表示主链路存在但缺参数/缺分支；`缺失` 表示没有对应实现；`逻辑错误` 表示已有实现与预期行为不符。

| 参考模块 | 半成品对应文件 | 状态 | 差距明细 |
| --- | --- | --- | --- |
| CLI 入口 | `src/index.ts`（0 行）、`src/chat.ts` | 缺失 | 入口文件为空；`package.json` 的 `dev` 指向 `chat.ts`；没有 `--resume/--fork`；没有非 TTY REPL；没有管理命令分流。 |
| 配置 | 无独立模块 | 缺失 | 模型名硬编码 `deepseek-v4-flash`；直接读 `OPENAI_API_KEY/OPENAI_BASE_URL`；没有 settings.json 合并、没有 `MINI_CODE_HOME`、没有运行时配置对象。 |
| 模型适配 | `src/agent-loop.ts` 内嵌 OpenAI SDK | 部分实现 | 用 Chat Completions + OpenAI SDK，参考版是 Anthropic Messages + `ModelAdapter`；没有 mock 模式；没有 usage/thinking/stop_reason 解析；没有重试与 `max_tokens` 推导。 |
| Agent 循环 | `src/agent-loop.ts` | 部分实现 | 有 `model -> tool -> model` 基础循环；缺 `<progress>/<final>` 协议、空响应重试、thinking 重试、tool 回调、`ask_user` 结束回合、自动压缩/snip/collapse 钩子；到达 maxTurns 时没有把提示语写回 messages。 |
| 工具框架 | `src/tools/definitions.ts` + `handlers.ts` | 部分实现 | 没有 `ToolRegistry`；没有 zod 校验（任意 JSON 直接进 handler）；没有 `load_skill`；没有统一 `ToolResult` 类型；`TOOL_DEFINITIONS` 的 `type` 被推断为 `string`，导致 `tsc` 报错。 |
| `read_file` | `handlers.ts` | 部分实现 | 缺 `offset/limit`、文件头（FILE/OFFSET/TRUNCATED）、行数上限；大文件只能整读。 |
| `write_file` | `handlers.ts` | 部分实现 | 已有 diff 确认；但旧文件为空时不展示 diff；不自动创建父目录；没有 `permissions.ensureEdit` 集成。 |
| `edit_file` | `handlers.ts` | 逻辑错误 | 按“行包含 search”再整行替换，只能替换单行且第一处命中；跨行/精确文本替换与参考版语义不一致；缺 `replaceAll` 参数。 |
| `patch_file` | `handlers.ts` | 部分实现 | 能批量替换；缺每项 `replaceAll`；中途失败时已替换内容不会回滚；没有 `permissions.ensureEdit`。 |
| `modify_file` | `handlers.ts` | 部分实现 | 语义基本一致，缺权限审批与“无变化”短输出。 |
| `run_command` | `handlers.ts` | 逻辑错误 | 用 `execSync` + shell 字符串，参数无法结构化；只有 30s 超时；没有命令 allowlist/args 模式；没有后台任务；权限检查基于完整字符串，易被绕过。 |
| `list_files` | `handlers.ts` | 逻辑错误 | `path` 缺省时 `checkPathAccess(undefined, ...)` 会抛错，`/ls` 无参不可用；没有 200 条上限；没有相对工作区路径约束输出。 |
| `grep_files` | `handlers.ts` | 部分实现 | 用 `findstr`/`grep` 拼字符串，引号易坏；`path` 缺省同样会传 `undefined`；没有 `rg` 默认实现与 1MB 输出上限。 |
| `ask_user` | `handlers.ts` | 部分实现 | 能提问；但没有 `awaitUser` 协议，Agent 循环不会在提问后结束回合。 |
| `web_fetch` | `handlers.ts` | 部分实现 | 用 `linkedom` 简单抽文本；缺重试/超时分类、HTML 跳转、`max_chars`、元信息头。 |
| `web_search` | `handlers.ts` | 部分实现 | 只抓 Bing 的 `li.b_algo`；缺 DuckDuckGo/Sogou 双源回退、域名过滤、结果摘要解析、重试。 |
| 权限 | `src/permissions.ts` | 部分实现 | 只有命令危险检测 + 路径放行；缺编辑审批、turn 级权限、allow/deny 目录模式、`getSummary`、非 TTY 拒绝逻辑；Ctrl+C 取消弹窗会被当成 `allow_once`，有安全隐患。 |
| 文件 Review | `src/file-review.ts` | 部分实现 | diff 生成和 y/n 确认可用；缺 `PermissionManager.ensureEdit` 集成与无变化分支。 |
| Skills | 无 | 缺失 | 没有 `skills.ts`，没有 `load_skill` 工具，system prompt 不会列出可用 skills。 |
| MCP | 无 | 缺失 | 没有 stdio/HTTP MCP client、协议协商、资源/提示词、`/mcp` 状态、`minicode mcp` 命令。 |
| 会话 | `src/session.ts` | 部分实现 | 有 JSONL 保存/恢复/列表；缺 uuid/parentUuid 事件模型、compact boundary、fork/rename、过期清理、transcript 重建、snip/collapse 持久化；且 `saveSession` 用 `messages.slice(saveCount + 1)` 存在 off-by-one，会漏存一条新用户消息。 |
| Memory | `src/memory.ts` | 部分实现 | 能沿目录向上找 `MINI.md/CLAUDE.md`；缺 `@include`、`.mini-code/rules`、全局 scope、内容去重、8K/20K 容量预算、`MINI.local.md`、`scanRoot`。 |
| 历史 | `src/tui-app.ts` 内存数组 | 缺失 | 没有 `history.ts`，重启后历史丢失；参考版持久化到 `history.jsonl`。 |
| 压缩 | `src/compact.ts` | 部分实现 | 只有最简单的 LLM 摘要 + 保留 8 条；缺 `snipCompact`、`context-collapse`、`microcompact`、结构化 `<summary>` 协议、token 预算边界、失败熔断、boundary 事件。 |
| Token 统计 | `src/utils/token-estimator.ts` | 部分实现 | 只有统一 `字符数/3.5` 估算；缺 provider usage 优先、角色级比例、模型上下文规则、output reserve、`blocked` 级别、usage stale 标记。 |
| 结果落盘 | `src/utils/tool-result-storage.ts` | 部分实现 | 有 4000 字符阈值落盘；缺 50K 默认阈值、批量 200K 预算、会话子目录、去重、`<persisted-output>` 标记、空输出处理。 |
| TUI | `src/tui-app.ts`、`src/tui/*` | 部分实现 | 有 alt screen、基础输入、对话滚动、ask_user 弹窗；缺 chrome/transcript 组件、鼠标选择与剪贴板、slash 菜单、审批弹窗、会话选择器、欢迎动画、背景任务面板、输入解析缓冲（分块 ESC 序列会识别失败）。 |
| 初始化/安装 | 无 | 缺失 | 没有 `/init`，没有 `install-local`，没有 `bin/minicode` 启动器。 |
| 后台任务 | 无 | 缺失 | 没有 `background-tasks.ts`，`run_command` 也没有后台 `&` 分支。 |
| 工具快捷键 | 仅 8 个 `/` 命令 | 缺失 | 只有 `/help /tools /memory /sessions /resume /new /exit /compact`；缺 `/ls /read /write /edit /patch /modify /cmd /grep /status /model /skills /mcp /init /rename /fork /permissions /collapse /snip`。 |
| 测试 | `package.json` 占位 | 缺失 | `npm test` 只是 `echo Error`；参考版有 25+ 测试文件，覆盖会话、压缩、权限、TUI、token 等。 |

### 3.1 已证实的编译/运行问题

- `node node_modules\typescript\bin\tsc --noEmit` 当前报 3 个错误，全部在 `src/agent-loop.ts`：
  - 第 18 行：`TOOL_DEFINITIONS` 的 `type: "string"` 不满足 `ChatCompletionTool`；
  - 第 33/36 行：OpenAI 新版类型里 `toolCall.function` 不存在（`ChatCompletionMessageCustomToolCall`）。
- `src/index.ts` 是空文件，`npm run dev` 实际入口是 `src/chat.ts`，脚本与 bin 不一致。
- `.env` 里是明文 API key，虽被 `.gitignore` 忽略，但建议迁移到 `~/.mini-code/settings.json`。
- 半成品只有 `dev/test` 脚本，缺 `check/lint/install-local`。

---

## 4. 分步开发任务（一次只做一项）

优先级从高到低。每一轮只实现一项，完成并验收后再进入下一项。

### [完成] T1（P0）工程基线：入口、脚本、类型、配置目录

范围：

- 把入口收敛到 `src/index.ts`，`package.json` 的 `dev` 改为 `tsx --env-file=.env src/index.ts`（或直接 `tsx src/index.ts`）。
- 补齐 `check`、`test`、`lint` 脚本与 `bin/minicode` 启动器。
- 修复 `src/agent-loop.ts` 的 3 个类型错误。
- 新增 `src/config.ts`：`MINI_CODE_DIR`、`settings.json` 读写合并、`loadRuntimeConfig()`，支持 `MINI_CODE_MODEL` 等 env。

验收标准：

```bash
node node_modules\typescript\bin\tsc --noEmit   # 0 error
npm run dev                                      # 能启动并进入对话
```

对比原版：`/status` 应显示 `model/baseUrl/auth/mcp servers/source`；无模型或无鉴权时应给出明确错误。

### [完成] T2（P0）工具框架：ToolRegistry + zod 校验 + 12 个内置工具

范围：

- 实现 `src/tool.ts` 的 `ToolRegistry`、`ToolDefinition`、`ToolResult`。
- 把 `src/tools/*` 全部改为 zod schema + `run(input, context)`。
- 对齐参数：`read_file.offset/limit`、`edit_file.replaceAll`、`patch_file.replacements[].replaceAll`、`run_command.args/cwd`、`web_fetch.max_chars`、`web_search.max_results/allowed_domains/blocked_domains`。
- `load_skill` 可在 T7 完成 Skills 后补上，先保留 11 个工具。

验收标准：`npm test` 有工具级测试；未知工具、非法入参、越界路径分别返回 `ok:false` 与可读原因。
> 验证结果：`npm run check` 0 error；`npm test` 通过（21 个工具级测试：未知工具/非法入参/越界路径返回 ok:false；read_file 分块、edit_file replaceAll、patch_file 原子性、run_command args/cwd 等）；旧 definitions.ts/handlers.ts 已删除。
### [完成] T3（P0）权限系统：PermissionManager

范围：

- 实现 `src/permissions.ts` 的路径/命令/编辑三类审批。
- 支持 `allow_once / allow_turn / allow_all_turn / allow_always / deny_once / deny_always / deny_with_feedback`。
- 支持 `permissions.json` 持久化与 `getSummary()`，非 TTY 无审批处理器时直接拒绝。

验收标准：工作目录内放行；工作目录外路径弹窗；危险命令弹窗；编辑 diff 弹窗；拒绝选择持久化；取消弹窗不等于允许。

### [完成] T4（P0）模型适配层：types + AnthropicAdapter + MockModel

范围：

- 新增 `src/types.ts`：`ChatMessage`、`AgentStep`、`ModelAdapter`、`ProviderUsage`。
- 新增 `src/anthropic-adapter.ts`：ChatMessage 与 Anthropic Messages 互转、thinking/tool_use/tool_result、usage 归一化、429/5xx 重试。
- 新增 `src/mock-model.ts`，支持 `MINI_CODE_MODEL_MODE=mock`。

验收标准：

```bash
MINI_CODE_MODEL_MODE=mock npm run dev   # 离线可演示 /ls /read /write /edit /cmd
npm test                                 # provider-usage-ingestion、anthropic-thinking 测试通过
```

### T5（P0）Agent 循环增强

范围：

- 支持 `<progress>/<final>` 协议、空响应重试、thinking 阶段 `pause_turn/max_tokens` 恢复。
- 支持 `ask_user` 的 `awaitUser` 结束回合。
- 支持 `onToolStart/onToolResult/onAssistantMessage/onContextStats` 回调。
- 把 snip/microcompact/context-collapse/auto-compact 钩子接到循环（依赖 T8/T9 的结果，可先留空接口）。

验收标准：多步工具调用不断开；模型只发 progress 不结束；达到 maxSteps 有明确提示且写回 messages。

### T6（P1）会话持久化升级

范围：

- 完整实现 `src/session.ts` 事件模型：uuid、parentUuid、compact boundary、snip/collapse 事件。
- 补齐 `listSessions/renameSession/forkSession/cleanupExpiredSessions/loadTranscript`。
- 修复当前 `saveSession` 的 off-by-one。
- TUI/REPL 接入 `/resume /rename /fork /new`。

验收标准：重启后 `--resume` 能恢复；手动 compact 后有 boundary；fork 后原会话不变；恢复后 transcript 完整。

### T7（P1）Memory 与 Skills

范围：

- 完整 `src/memory.ts`：全局/项目/rules 三层、`@include`、去重、8K/20K 预算、`MINI.local.md`。
- 新增 `src/skills.ts` + `load_skill` 工具，system prompt 注入 skills 列表。

验收标准：`/memory` 显示 scope/行数/预览；同名 skill 按 project > user 优先级去重；`load_skill` 能返回完整 SKILL.md。

### T8（P1）Token 统计与上下文窗口

范围：

- 完整 `token-estimator.ts`：provider usage 优先 + tail estimate + stale 标记。
- 完整 `model-context.ts`：Claude/GPT/Gemini/DeepSeek 上下文窗口与 output reserve。
- 新增 `microcompact.ts`：利用率 >=50% 时清空旧的可压缩 tool result。

验收标准：有 provider usage 时以 usage 为账本；usage 过期后回退估算；`computeContextStats` 输出 `normal/warning/critical/blocked`。

### T9（P1）上下文压缩全家桶

范围：

- `compact/constants.ts`、`compact/prompt.ts`、`compact/compact.ts`、`auto-compact.ts`、`manual-compact.ts`。
- `snipCompact.ts`（确定性中段删除，保护编辑/报错/未闭合工具轮）。
- `context-collapse.ts`（模型可见摘要投影，不丢 transcript）。

验收标准：`/compact`、`/snip`、`/collapse` 可用；自动压缩在 85% 触发；压缩后 provider usage 标 stale；boundary 持久化。

### T10（P2）工具结果落盘

范围：

- 完整 `tool-result-storage.ts`：50K 单结果阈值、200K 批量预算、会话子目录、`<persisted-output>` 标记、去重。

验收标准：`read_file` 大文件输出会替换为预览 + 路径；同一轮内重复 toolUseId 复用替换结果；空输出有占位文本。

### T11（P2）TUI 第一阶段：输入、历史、slash 菜单、状态

范围：

- 完整 `input-parser.ts`（分块 ESC 序列、多行粘贴、方向键/Home/End/Delete/Ctrl 键）。
- 接入 `history.ts` 持久化。
- slash 自动补全菜单、`/help`、底部状态栏、context badge。

验收标准：Windows 下连续按方向键不乱；重启后历史还在；输入 `/` 弹出菜单。

### T12（P2）TUI 第二阶段：Transcript、Chrome、审批弹窗、会话选择器

范围：

- `transcript.ts`：消息块渲染、滚动、CJK 宽度、鼠标选择复制。
- `chrome.ts`：面板、footer、权限审批弹窗、slash 菜单。
- `tty-app.ts`：审批 handler、session picker、欢迎动画、后台任务状态。

验收标准：diff 审批可在 TUI 内展开/滚动/选择 1-7 选项；选择会话可上下键切换；复制到剪贴板在 Windows 可用。

### T13（P2）初始化、安装、管理 CLI

范围：

- `init.ts`：`/init` 幂等生成 `.mini-code/`、`.gitignore` 条目、`MINI.md`。
- `install.ts`：`npm run install-local` 写 `~/.mini-code/settings.json` 并生成启动器。
- `manage-cli.ts`：`minicode mcp/skills` 子命令。
- `background-tasks.ts` 接入 `run_command` 的 `&` 分支。

验收标准：`npm run install-local` 后 `minicode` 可直接启动；`/init` 重复执行不覆盖已有 MINI.md。

### T14（P3）MCP、Web 强化、非 TTY REPL

范围：

- `mcp.ts`：stdio/HTTP client、协议协商、动态工具/资源/提示词、`/mcp`。
- `utils/web.ts`：重试、DuckDuckGo Lite + Sogou 回退、域名过滤、HTML 跳转与可读文本提取。
- `index.ts` 非 TTY REPL 与 `--resume/--fork` 完整对齐。

验收标准：配置一个 MCP server 后 `/mcp` 显示连接状态且工具出现在 `/tools`；无 TTY 环境启动后能逐行对话。

---

## 5. 后续迭代规则

1. 每轮只做上表的一项（T1 -> T2 -> ... -> T14）。
2. 每轮交付三样东西：
   - 代码改动；
   - 部署/调试步骤（安装依赖、启动命令、mock 模式、测试命令）；
   - 对比原版校验标准（与参考版同一场景跑同一命令，比较行为差异）。
3. 每轮结束更新本文档状态：在任务标题前标记 `[完成]` 或 `[进行中]`，并记录验证结果。
4. 当前下一轮任务：T1 工程基线。
