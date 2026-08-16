# MiniCode 复刻完善方案（T5–T15）

> 生成时间：2026-08-15（基于 `D:\minicode` 与 `D:\MiniCode-main` 全量源码逐文件比对）
> 本文件只给出方案与步骤，不包含实现代码；由你自己按步骤实现。
> 前置状态：T1–T4 已完成（`npm run check` 0 error；`test/` 下有 6 个测试文件）。

---

## 0. 现状核对结论（实测，非旧文档）

### 0.1 已对齐参考版的文件（基本无需改动，仅微调）

| 当前文件 | 参考版文件 | 结论 |
| --- | --- | --- |
| `src/types.ts` | `src/types.ts` | 几乎一致；唯一差异：`context_summary` 字段当前为 `compressCount`，参考版为 `compressedCount`，需改 |
| `src/workspace.ts` | `src/workspace.ts` | 一致 |
| `src/file-review.ts` | `src/file-review.ts` | 一致（已含 ensureEdit 集成与无变化分支） |
| `src/utils/errors.ts` | `src/utils/errors.ts` | 一致 |
| `src/utils/model-context.ts` | `src/utils/model-context.ts` | 一致 |
| `src/mock-model.ts` | `src/mock-model.ts` | 一致 |
| `src/tools/*`（11 个） | `src/tools/*` | 逻辑基本一致；缺 `load_skill`；`web_search` 实现源不同（见 T7/T14）；`run-commands.ts` 缺后台任务注册（见 T13） |
| `src/permissions.ts` | `src/permissions.ts` | 逻辑一致；缺公开的 `whenReady()` / `beginTurn()` / `endTurn()`（当前只有内部 `ready` 与 `resetTurn()`） |
| `src/anthropic-adapter.ts` | `src/anthropic-adapter.ts` | 逻辑一致；差异：①构造函数参数顺序当前为 `(getRuntimeConfig, tools)`，参考版为 `(tools, getRuntimeConfig)`；②当前 max_tokens 固定 8192，参考版走 `resolveMaxOutputTokens()`；③当前 `snip_boundary` 直接跳过，参考版写入 `buildAnthropicSnipBoundaryText()` |
| `src/index.ts` | `src/index.ts` | 当前是中文 readline REPL；参考版含 `--resume/--fork`、管理命令分流、非 TTY REPL、TUI 分流（见 T14） |
| `src/tui/input.ts`、`src/tui/screen.ts` | `src/tui/input.ts`、`src/tui/screen.ts` | 当前为简易版（同步解析单 chunk、整屏重绘）；参考版是 `input-parser.ts`（分块缓冲）+ 增量渲染 `screen.ts`（见 T11/T12） |

### 0.2 部分实现（需要升级的文件）

| 当前文件 | 差距 |
| --- | --- |
| `src/tools.ts` | 缺 skills/mcpServers 元数据、`getSkills/getMcpServers/setMcpServers/addTools/addDisposer/dispose`、`ToolResult.backgroundTask`；文件名与参考版 `tool.ts` 不一致 |
| `src/agent-loop.ts` | 只有基础循环；缺 progress/final 协议、空响应重试、thinking 恢复、全部回调、ask_user 回合结束、maxSteps 提示写回、snip/microcompact/collapse/auto-compact 钩子；残留 `import OpenAI from 'openai'` |
| `src/config.ts` | 缺 mcpServers、McpConfigScope、mcp.json / mcp-tokens.json 读写、Claude settings 合并、authToken、MINI_CODE_MAX_OUTPUT_TOKENS、`MINI_CODE_*` 路径常量导出；默认模型/BaseURL 是本地适配值 |
| `src/session.ts` | 只有 JSONL 追加/恢复/列表；缺 uuid/parentUuid 事件模型、fork/rename/clear/cleanup/transcript、compact/snip/collapse 边界持久化、title 提取、`listAllProjects`；`saveSession` 用 `slice(saveCount+1)` 存在 off-by-one |
| `src/memory.ts` | 缺 `@include`、rules 目录、全局 scope、去重、8K/20K 预算、`MINI.local.md`、`scanRoot`、`discoverInstructionFiles/describeMemoryFiles`；`renderMemoryReport` 签名与参考版不一致 |
| `src/prompt.ts` | 当前同步 `buildSystemPrompt(cwd)`；参考版异步 `buildSystemPrompt(cwd, permissionSummary, extras{skills,mcpServers})`，含结构化响应协议与 skills/mcp 段 |
| `src/compact.ts` | 单文件最简 LLM 摘要；参考版是 `src/compact/` 目录 7 个文件（constants/prompt/compact/auto/manual/microcompact/snipCompact/context-collapse） |
| `src/utils/token-estimator.ts` | 缺 `CLEAR_MARKER`、`markProviderUsageStale`、`staleUsageReason`、`usageBoundary` 字段 |
| `src/utils/tool-result-storage.ts` | 只有 4000 字符阈值落盘；缺状态机、50K/200K 预算、会话子目录、`<persisted-output>` 标记、去重、空输出占位 |
| `src/utils/web.ts` | 有 `fetchWebPage`（接近一致）；缺 `searchDuckDuckGoLite` |
| `src/tui-app.ts` | 简易 TUI（输入+滚动+一个模态框）；参考版是 75K 的 `tty-app.ts`（见 T11/T12） |

### 0.3 完全缺失的文件（参考版有，当前没有）

```text
src/skills.ts            src/mcp.ts            src/mcp-status.ts
src/history.ts           src/cli-commands.ts   src/manage-cli.ts
src/init.ts              src/install.ts        src/background-tasks.ts
src/local-tool-shortcuts.ts  src/ui.ts         src/tool.ts（当前是 tools.ts）
src/compact/ 整个目录    src/utils/context.ts
src/tui/chrome.ts        src/tui/transcript.ts src/tui/input-parser.ts
src/tui/markdown.ts      src/tui/types.ts      src/tui/index.ts
src/tty-app.ts           src/tools/load-skill.ts  src/tools/run-command.ts（当前是 run-commands.ts）
```

### 0.4 工程文件差异

| 项目 | 当前 | 参考版 |
| --- | --- | --- |
| `package.json` | 多 `openai`、`linkedom` 依赖（重写后应删除）；缺 `install-local` 脚本 | 仅 `diff` + `zod`；有 `install-local` |
| `tsconfig.json` | `rootDir: "."`，`include: ["src","test"]` | `rootDir: "src"`，`include: ["src"]`（测试不在 tsc 范围） |
| `test/` | 6 个文件 | 25 个文件 |
| `bin/minicode` | 一致 | 一致 |
| `eslint.config.js` | 有（可保留） | 只有 `eslint.config_bak.js` |

---

## 1. 总体策略与命名对齐决策

### 1.1 目标

功能与参考版完全一致，最终验收：

```bash
npm run check        # tsc --noEmit 0 error
npm test             # 全部测试通过（对齐参考版 25 个测试）
MINI_CODE_MODEL_MODE=mock npm run dev   # mock 模式可运行（TTY 走全屏 TUI）
minicode mcp list / skills list / --resume / --fork   # 管理命令与参数可用
```

### 1.2 关键决策：文件名与导出对齐参考版（强烈建议）

参考版测试直接 import 参考版文件名（如 `../src/tool.js`、`../src/tui/chrome.js`）。为了让参考版的 25 个测试能**原样移植并跑通**，请把下列文件改名并对齐导出（同步更新全部内部 import）：

| 当前 | 改为（参考版命名） | 同步修改的 import 方 |
| --- | --- | --- |
| `src/tools.ts` | `src/tool.ts` | `agent-loop.ts`、`file-review.ts`、`workspace.ts`、`tools/index.ts`、`tools/*`、`test/*` |
| `src/tools/run-commands.ts` | `src/tools/run-command.ts` | `tools/index.ts` |
| `src/compact.ts` | 删除，新建 `src/compact/` 目录 | `index.ts`、`tui-app.ts`（若引用） |
| `src/tui-app.ts` | `src/tty-app.ts`（或作为 tty-app 的过渡，最终以参考版为准） | `index.ts` |
| `src/tui/input.ts`、`src/tui/screen.ts` | 保留文件名，内容对齐参考版；另新增 `input-parser.ts` | `tty-app.ts` |

> 若你坚持保留当前命名，则所有参考版测试都要改 import 路径，工作量更大且容易引入偏差。推荐对齐命名。

### 1.3 实施顺序（一次只做一项，做完验收再进下一项）

```text
T5 Agent循环增强（先建好 T8/T9/T10 的接口占位，最后回填）
T6 会话持久化升级
T7 Memory 与 Skills（含 load_skill 工具）
T8 Token统计 / 上下文窗口 / microcompact
T9 上下文压缩全家桶
T10 工具结果落盘完整版
T11 TUI 第一阶段（input-parser / history / chrome 渲染 / slash 菜单 / 状态栏）
T12 TUI 第二阶段（transcript / 审批弹窗 / 会话选择器 / tty-app）
T13 init / install / manage-cli / background-tasks / cli-commands / local-tool-shortcuts
T14 MCP / Web 强化 / 非 TTY REPL（index.ts 对齐）
T15 收尾：移植测试、package.json / tsconfig / .gitignore 对齐、更新文档
```

依赖关系：T8 的 `utils/context.ts`（resolveMaxOutputTokens）先做，`anthropic-adapter` 和 T5 都要用它；T5 的压缩钩子依赖 T8/T9/T10，可先写空接口（`onSnipCompact?.(...)` 等可选回调不传即跳过），T9/T10 完成后自动生效。

---

## 2. 分步任务

### T5（P0）Agent 循环增强

**涉及文件**
- `src/agent-loop.ts`（重写为参考版逻辑）
- 依赖：`src/compact/microcompact.ts`、`src/compact/auto-compact.ts`、`src/compact/context-collapse.ts`、`src/compact/snipCompact.ts`、`src/utils/token-estimator.ts`、`src/utils/tool-result-storage.ts`（先建接口或占位）

**实现要点（对照参考版 `agent-loop.ts`）**
1. 完整签名：`runAgentTurn({model, tools, messages, cwd, permissions?, maxSteps?, modelName?, onToolStart?, onToolResult?, onAssistantMessage?, onProgressMessage?, onAutoCompact?, onSnipCompact?, onContextCollapse?, onContextStats?, contentReplacementState?, contextCollapseState?})`。
2. `<progress>/<final>` 协议：
   - `shouldTreatAssistantAsProgress()`：显式 `kind==='progress'` 视为进度；`final` 直接结束；无标记时若本回合没跑过工具则视为最终回复。
   - progress 时把消息记为 `assistant_progress`，并 `pushContinuationPrompt('Continue immediately from your <progress> update...')` 继续循环。
3. 空响应重试：`isEmptyAssistantResponse`，重试上限 2 次，写回不同的 continuation prompt；仍为空则生成 fallback（区分是否刚跑过工具、是否报过错）并写回 `assistant` 后结束。
4. thinking 恢复：`isRecoverableThinkingStop`（stop_reason 为 `pause_turn`/`max_tokens` 且块含 thinking），重试上限 3 次，提示语区分两种原因。
5. 工具执行：
   - 每条调用先 `onToolStart`，执行后 `onToolResult`，统计 `toolErrorCount`、`sawToolResultThisTurn`。
   - 结果经 `replaceLargeToolResult(result, contentReplacementState)` 落盘替换，再经 `applyToolResultBudget` 做批量预算。
   - 消息按 `assistant_tool_call` + `tool_result` 顺序追加，最后一个 tool_call 挂 usage。
6. `ask_user` 回合结束：某工具返回 `awaitUser: true` 时，把问题写回 `assistant` 消息并 return。
7. maxSteps 耗尽：写回 `assistant` 提示"达到最大工具步数限制"后 return（当前版本漏了写回）。
8. 上下文钩子（仅当 `modelName` 非空时启用）：顺序为 snipCompact → microcompact → context-collapse →（第一步且 critical/blocked 时）autoCompact，每次变更后重算 `computeContextStats` 并 `onContextStats`。
9. `withProviderUsage`：仅 assistant/assistant_progress/assistant_tool_call 附加 usage。
10. 删除残留的 `import OpenAI from 'openai'`（参考版无此依赖）。

**验收**
```bash
npm run check
npx tsx --test test/provider-usage-ingestion.test.ts   # usage 摄入
npx tsx --test test/anthropic-thinking-roundtrip.test.ts
```
多步工具调用不断开；模型只发 progress 时循环继续；达到 maxSteps 有提示且写回 messages。

---

### T6（P1）会话持久化升级

**涉及文件**
- `src/session.ts`（重写为参考版）
- `src/config.ts`（先导出 `MINI_CODE_PROJECTS_DIR`）
- `src/compact/context-collapse.ts`（提供 `CollapseSpan`/`ContextCollapseState`/`createContextCollapseState`，T9 实现，可先占位类型）

**实现要点（对照参考版 `session.ts`）**
1. 事件模型：每行 JSONL 是一个 `SessionEvent { type, message?, uuid, timestamp, sessionId, cwd, parentUuid, logicalParentUuid?, subtype?, compactMetadata?, snipMetadata?, contextCollapseSpan?, title? }`；`type` 由 role 映射（`roleToType`）：system/user/assistant/thinking/progress/tool_call/tool_result/summary/snip_boundary，另有 `compact_boundary`/`context_collapse`/`rename` 事件。
2. `ensureMessageId`：给 ChatMessage 补 `id=randomUUID()`，事件 uuid 复用 message.id。
3. `saveSession(cwd, sessionId, messages, alreadySavedCount=0)`：读已存在 uuid 集合，只追加新消息；修复当前 off-by-one（不再用 `slice(saveCount+1)`，改为按 `message.id` 去重 + `alreadySavedCount` 兜底）；parentUuid 串成链。
4. 边界事件：`appendSnipBoundary`、`appendContextCollapseSpan`、`appendCompactBoundary`（boundary 事件 + 摘要 user 事件 + retainedMessages）。
5. 恢复：`loadSession` 找到最后一个 `compact_boundary` 之后的事件，`reconstructSnippedEvents`（把 snip_boundary 插回被删消息的位置）后还原 ChatMessage；`loadContextCollapseState` 恢复 committed spans。
6. 会话管理：`listSessions`（含 title 提取：优先 rename 事件，否则第一条 user 消息截断 60 字符）、`renameSession`（追加 rename 事件）、`forkSession`（load → 新 id → save → 命名 `title_forkN`）、`clearSession`、`cleanupExpiredSessions(maxAgeMs)`、`listAllProjects`、`loadTranscript`（user/assistant/progress/tool/summary/compact/snip 条目）。
7. 全部改异步 fs API。

**验收**
```bash
npx tsx --test test/session.test.ts
```
重启后 `--resume` 恢复；手动 compact 后有 boundary；fork 后原会话不变；恢复后 transcript 完整。

---

### T7（P1）Memory 与 Skills

**涉及文件**
- `src/memory.ts`（重写为参考版）
- 新增 `src/skills.ts`
- 新增 `src/tools/load-skill.ts`
- `src/tools/index.ts`（discoverSkills 注入元数据 + 注册 load_skill）
- `src/tool.ts`（ToolRegistry 加 skills 元数据与 `getSkills`）
- `src/prompt.ts`（system prompt 注入 skills 列表）
- `src/types.ts`（`context_summary.compressedCount` 改名）

**实现要点**
1. `memory.ts`：
   - `discoverInstructionFiles(cwd, homeDir?, scanRoot?)`：全局层（`~/.mini-code/MINI.md|CLAUDE.md` 只取一个 + `~/.mini-code/rules/*.md`）+ 每个祖先目录（`MINI.md`、`MINI.local.md`、`.mini-code/MINI.md`、`CLAUDE.md`、`CLAUDE.local.md`、`.claude/CLAUDE.md` + `.mini-code/rules/*.md`）。
   - `@include` 解析：`/^@([^\s]+)\s*$/`，拒绝绝对路径与 `..`，防循环（visited 集合），渲染 `<!-- included from ... -->` 包裹。
   - 去重：按内容 sha256，反向遍历让 cwd 侧优先。
   - 预算：每文件 8K、总计 20K（`loadMemory` 内 `truncateTo` + 超预算提示）。
   - `describeMemoryFiles`（scope: global/project/rules + 行数/字符数/首行预览）、`renderMemoryReport(files, cwd)` 新签名。
2. `skills.ts`：4 个根目录（project/user/compat_project/compat_user），`discoverSkills`（同名按 project>user 优先级去重）、`loadSkill`、`installSkill`、`removeManagedSkill`；`extractDescription` 取首个非标题段落。
3. `tools/load-skill.ts`：`createLoadSkillTool(cwd)`，输出 `SKILL: / SOURCE: / PATH:` + 全文；未知 skill 返回 `ok:false`。
4. `tool.ts`：`ToolRegistry` 增加 `metadataStore.skills`、`getSkills()`。
5. `tools/index.ts`：`createDefaultToolRegistry` 先 `discoverSkills`，注册 `createLoadSkillTool(cwd)`。
6. `prompt.ts`：`Available skills:` 段（无则 `- none discovered`）。

**验收**
```bash
npx tsx --test test/memory.test.ts
```
`/memory` 显示 scope/行数/预览；同名 skill 按优先级去重；`load_skill` 返回完整 SKILL.md。

---

### T8（P1）Token 统计 / 上下文窗口 / microcompact

**涉及文件**
- 新增 `src/utils/context.ts`（`getModelMaxOutputTokens`、`resolveMaxOutputTokens`、`COMPACTABLE_TOOLS`）
- `src/utils/token-estimator.ts`（补齐）
- 新增 `src/compact/microcompact.ts`
- `src/anthropic-adapter.ts`（改用 `resolveMaxOutputTokens`）
- `src/utils/model-context.ts`（已一致，核对即可）

**实现要点**
1. `utils/context.ts`：按模型名规则返回 `{default, upperLimit}`；`resolveMaxOutputTokens(model, configured?)` 取配置与上限的较小值；`COMPACTABLE_TOOLS = {read_file, run_command, search_files, list_files, web_fetch}`。
2. `token-estimator.ts` 补齐：
   - `CLEAR_MARKER = '[Output cleared for context space]'` 并导出。
   - `tokenCountWithEstimation` 的 usage 分支加 `usageBoundary: {messageIndex, messageId}`（assistant_tool_call 取 toolUseId）；estimate_only 分支加 `stale`/`reason`（`staleUsageReason` 扫描被标 stale 的消息）。
   - 新增 `markProviderUsageStale(message, reason)`（置 `usageStale: true` + `usageStaleReason`）。
3. `compact/microcompact.ts`：利用率 ≥ 50%（`THRESHOLDS.MICROCOMPACT_UTILIZATION`）时，把旧的（保留最近 3 个）可压缩工具结果内容替换为 `CLEAR_MARKER`；无变化则返回原数组。
4. `anthropic-adapter.ts`：`max_tokens = resolveMaxOutputTokens(runtime.model, runtime.maxOutputTokens)`；构造函数参数顺序改为 `(tools, getRuntimeConfig)`。

**验收**
```bash
npx tsx --test test/token-estimator.test.ts
npx tsx --test test/model-context.test.ts
npx tsx --test test/microcompact.test.ts
```
有 provider usage 时以 usage 为账本；usage 过期后回退估算；`computeContextStats` 输出 normal/warning/critical/blocked。

---

### T9（P1）上下文压缩全家桶

**涉及文件（全部新增）**
- `src/compact/constants.ts`、`src/compact/prompt.ts`、`src/compact/compact.ts`、`src/compact/auto-compact.ts`、`src/compact/manual-compact.ts`、`src/compact/microcompact.ts`（T8 已建）、`src/compact/snipCompact.ts`、`src/compact/context-collapse.ts`

**实现要点**
1. `constants.ts`：`THRESHOLDS`（micro 0.50 / auto 0.85 / blocked 0.95）、`SNIP_*`（0.70/0.60/6/12/2000）、`CONTEXT_COLLAPSE_*`（0.75/0.65/12/2000/2/3）、`RETENTION`（3/6/10000/40000）、`LIMITS`（3/4096/2/20000）。
2. `prompt.ts`：`buildCompactSummaryPrompt`（六段式 <summary> 结构）；`parseSummaryFromResponse`（优先 `<summary>`，其次 `<analysis>`，最后原文兜底）。
3. `compact.ts`：`groupMessagesByApiRound`（thinking+tool_call+tool_result 归组）、`findRetentionBoundary`（从尾累计 token，不超 `MAX_KEEP_TOKENS`、至少 `MIN_KEEP_MESSAGES`、对齐 API 轮次）、`messagesToText`、`compactConversation(messages, modelAdapter)`（保留 system + 摘要 + 保留尾，`markProviderUsageStale` 标保留段 usage stale，返回 `CompressionResult`）。
4. `auto-compact.ts`：`shouldAutoCompact`（≥85%）、`autoCompact`（连续失败 3 次熔断 `disabled`，`MINI_CODE_DEBUG_AUTOCOMPACT=1` 输出调试日志）、`resetAutoCompactState`、`getAutoCompactState`。
5. `manual-compact.ts`：`manualCompact` = compactConversation + 成功后 reset auto 状态。
6. `snipCompact.ts`（确定性中段删除，不调模型）：`snipCompactConversation({messages, contextStats, modelContextWindow})`；保护最近 12 条、未闭合工具轮（assistant_tool_call 未配对 tool_result）、编辑类操作（write/edit/patch/modify 调用后）、错误工具结果；按 `SNIP_MIN_MESSAGES_TO_REMOVE`/`SNIP_MIN_TOKENS_TO_FREE` 决定是否执行；产出 `snip_boundary` 消息（removedMessageIds/removedCount/tokensFreed）；导出 `buildAnthropicSnipBoundaryText()` 供 adapter 使用。
7. `context-collapse.ts`（模型可见摘要投影，不丢 transcript）：`createContextCollapseState`、`applyContextCollapseIfNeeded(messages, model, modelAdapter, state, opts?)`；利用率 ≥75% 时选安全的旧 span（每轮最多 2 个，至少省 2000 token，保留最近 12 条）生成摘要替换为模型可见投影，spans 记录 committed 状态；连续失败 3 次禁用；`CollapseSpan` 类型供 session.ts 持久化。
8. 接线：`agent-loop.ts` 已预留钩子；TUI/REPL 中 `/compact`（manual）、`/snip`、`/collapse` 调用对应函数并持久化边界事件（session.ts 的 `appendCompactBoundary` 等）。

**验收**
```bash
npx tsx --test test/compact.test.ts
npx tsx --test test/snip-compact.test.ts
npx tsx --test test/context-collapse.test.ts
npx tsx --test test/auto-compact.test.ts
```
`/compact`、`/snip`、`/collapse` 可用；自动压缩 85% 触发；压缩后 provider usage 标 stale；boundary 持久化。

---

### T10（P1）工具结果落盘完整版

**涉及文件**
- `src/utils/tool-result-storage.ts`（重写为参考版）
- `src/agent-loop.ts`（已预留使用点）

**实现要点（对照参考版）**
1. 常量：`DEFAULT_MAX_RESULT_SIZE_CHARS=50_000`、`MAX_TOOL_RESULTS_PER_BATCH_CHARS=200_000`、`PREVIEW_SIZE_CHARS=2_000`、`PERSISTED_OUTPUT_TAG='<persisted-output>'`。
2. `createContentReplacementState()`：`{seenIds: Set, replacements: Map}`。
3. `replaceLargeToolResult(result, state?, threshold?)`：
   - 同 toolUseId 已有替换 → 直接复用；
   - 空输出 → `"(<toolName> completed with no output)"`；
   - 已含 persisted 标记 → 记入 state 后原样返回；
   - 超过阈值 → 落盘到 `~/.mini-code/tool-results/<会话子目录>/<sanitizedId>.txt`（`flag:'wx'` 防覆盖），返回 `<persisted-output>` 预览消息。
4. `applyToolResultBudget(results, state, limit?)`：批量预算 200K；新候选按大小降序，超预算的落盘替换；返回替换后的 results + `newlyReplaced` 记录。
5. `normalizeToolResultContent`：null → ''，非字符串 → String。
6. `agent-loop.ts`：结果先 `replaceLargeToolResult`，再 `applyToolResultBudget`，`toolResultById` 映射后写入 messages。

**验收**
```bash
npx tsx --test test/tool-result-storage.test.ts
```
`read_file` 大文件输出替换为预览+路径；同一轮重复 toolUseId 复用替换结果；空输出有占位文本。

---

### T11（P2）TUI 第一阶段：输入、历史、slash 菜单、状态

**涉及文件**
- 新增 `src/tui/input-parser.ts`（重写自参考版）
- 新增 `src/history.ts`
- `src/tui/screen.ts`（对齐参考版：增量渲染 + 鼠标追踪 + alt screen 管理）
- `src/tui/input.ts`（对齐参考版：renderInputPrompt）
- 新增 `src/tui/chrome.ts`（第一部分：宽度计算、panel、status、footer、slash 菜单、context badge、banner、tool panel、permission summary 行）
- 新增 `src/tui/index.ts`、`src/ui.ts`（re-export）
- 新增 `src/local-tool-shortcuts.ts`
- 新增 `src/cli-commands.ts`（`SLASH_COMMANDS`、`tryHandleLocalCommand`、`completeSlashCommand`、`findMatchingSlashCommands`）

**实现要点**
1. `input-parser.ts`：`parseInputChunk(chunk)` 返回 `{events, rest}`；分块缓冲（ESC 单独来 / CSI 前缀不完整时等下一块，`maybeNeedMoreForEscapeSequence`）；支持方向键/Home/End/Delete/PageUp/PageDown/Tab/Esc/Ctrl 键、多行粘贴（`isMultilinePasteChunk`）、滚轮与鼠标事件（`ParsedInputEvent` 联合类型）。
2. `history.ts`：`loadHistoryEntries` / `saveHistoryEntries(entries, cwd, sessionId)`，写 `~/.mini-code/history.jsonl`，上限 500 条（超限裁剪）。
3. `screen.ts`：函数式 API（`enterAlternateScreen/exitAlternateScreen/clearScreen/hideCursor/showCursor/resetTerminalFrame/renderTerminalFrame`）；增量渲染（只重画变化行，尺寸变化时全量）；启用/禁用鼠标追踪。
4. `chrome.ts` 第一部分：`charDisplayWidth/stringDisplayWidth`（CJK 宽度）、`wrapPanelBodyLine`、`renderPanel`、`renderContextBadge`（tokens/利用率/告警级）、`renderBanner`（模型/路径/权限/MCP 统计）、`renderPermissionSummaryLine`、`renderStatusLine`、`renderToolPanel`、`renderFooterBar`、`renderSlashMenu`。
5. `cli-commands.ts`：参考版全部 slash 命令（/help /tools /status /model /config-paths /skills /mcp /resume /rename /new /fork /permissions /exit /ls /grep /read /write /modify /edit /patch /cmd /compact /collapse /snip /init /memory）；`tryHandleLocalCommand` 处理 `/`、`/help`、`/config-paths`、`/permissions`、`/skills`、`/mcp`、`/status`、`/init`、`/memory`、`/model`；`completeSlashCommand` 供 readline completer。
6. `local-tool-shortcuts.ts`：`/ls /grep /read /write /modify /edit /cmd /patch` → 对应工具入参。

**验收**
```bash
npx tsx --test test/input-parser.test.ts
npx tsx --test test/input.test.ts
npx tsx --test test/status-line.test.ts
npx tsx --test test/context-badge.test.ts
npx tsx --test test/local-tool-shortcuts.test.ts
```
Windows 下连续按方向键不乱；重启后历史还在；输入 `/` 弹出菜单。

---

### T12（P2）TUI 第二阶段：Transcript、Chrome 完整、审批弹窗、会话选择器

**涉及文件**
- 新增 `src/tui/transcript.ts`、`src/tui/markdown.ts`、`src/tui/types.ts`
- `src/tui/chrome.ts` 补全（`getPermissionPromptMaxScrollOffset`、`renderPermissionPrompt`）
- 新增 `src/tty-app.ts`（参考版 `tty-app.ts`，约 75K，全功能主应用）

**实现要点**
1. `tui/types.ts`：`TranscriptEntry`（user/assistant/progress/tool，tool 含 running/success/error、collapsed、collapsePhase）。
2. `transcript.ts`：`renderTranscriptLines(entries)`（宽度感知换行、CJK 对齐）、`getTranscriptWindowSize`、`getTranscriptMaxScrollOffset`、`renderTranscript`（窗口滚动）、`extractSelectedText`（鼠标选择区间提取）、`TranscriptSelection` 类型。
3. `markdown.ts`：简化的 markdown → 终端行渲染（标题/列表/粗体/代码块降级）。
4. `tty-app.ts` 功能清单（对照参考版）：
   - 全屏布局：header panel（会话 stats + 模型 + context badge）、transcript 区、输入行、footer 状态、tool panel。
   - 输入：input-parser 事件驱动、历史上下翻、行内编辑（Home/End/Delete/方向键/Ctrl-U 等）、多行粘贴。
   - slash 菜单：输入 `/` 自动补全菜单（方向键选择）。
   - 审批弹窗：权限请求（path/command/edit）展开/滚动/1–7 选项选择（对应 PermissionManager choices）；Ctrl+C 取消不等于 allow。
   - 会话选择器：`--resume` 或 `/resume` 打开，↑↓ 切换、Enter 恢复、显示 title/时间/消息数。
   - 欢迎动画：`pushWelcomeAnimation`/`startWelcomeEscapeAnimation`/`advanceWelcomeAnimation`（chew/escape/done 三阶段）。
   - 工具面板：运行中工具条目、折叠长输出（`summarizeCollapsedToolBody`）、dangling running 工具收尾。
   - 鼠标：滚轮滚动、点击选择、`keepSelectionAfterMouseRelease`、`copyToClipboard`（`encodeClipboardTextForPlatform` 处理 Windows 剪贴板编码）。
   - 会话持久化：自动 `saveSession`（维护 `alreadySavedCount`）、compact/snip/collapse 结果持久化、`resumeSession` 恢复 transcript 与 messages。
   - 回调接线：`onToolStart/onToolResult/onAssistantMessage/onProgressMessage/onAutoCompact/onSnipCompact/onContextCollapse/onContextStats` 全部接到 TUI 渲染。
   - 权限：`createPermissionPromptHandler` 生成 TUI 审批弹窗。
5. `index.ts` TTY 分支调用 `runTtyApp({runtime, tools, model, messages, cwd, permissions, contentReplacementState, contextCollapseState, sessionId, alreadySavedCount, resumeTarget})`。

**验收**
```bash
npx tsx --test test/transcript-wrapping.test.ts
npx tsx --test test/transcript-cjk-selection.test.ts
npx tsx --test test/mouse-release-selection.test.ts
npx tsx --test test/welcome-animation.test.ts
npx tsx --test test/windows-clipboard-encoding.test.ts
```
diff 审批可在 TUI 内展开/滚动/选择 1–7 选项；选择会话可上下键切换；复制到剪贴板在 Windows 可用。

---

### T13（P2）init / install / manage-cli / background-tasks / cli-commands

**涉及文件（全部新增）**
- `src/init.ts`、`src/install.ts`、`src/manage-cli.ts`、`src/background-tasks.ts`、`src/cli-commands.ts`（T11 已建）、`src/local-tool-shortcuts.ts`（T11 已建）、`src/tools/run-command.ts`（改名 + 补后台任务）
- `package.json` 增加 `install-local` 脚本

**实现要点**
1. `init.ts`：`detectRepo`（TS/Python/Rust/React/Next/Vite/Nest/src/tests）、`renderInitMiniMd`（Detected stack / Verification / Repository shape / Framework notes / Working agreement）、`initializeRepo(cwd)`（幂等：`.mini-code/` 目录、`.gitignore` 追加 `# MiniCode local artifacts` + 两条目、`MINI.md` 仅 `flag:'wx'` 不覆盖）、`renderInitReport`。
2. `install.ts`：交互式询问 Model / ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN（默认值取自 `loadEffectiveSettings`），写入 `~/.mini-code/settings.json`，生成启动器到 `MINI_CODE_BIN_DIR`（默认 `~/.local/bin/minicode`），提示 PATH。
3. `manage-cli.ts`：`maybeHandleManagementCommand(cwd, argv)`；`minicode mcp list|add|remove|login|logout [--project]`、`minicode skills list|add|remove [--project]`；`--` 后接本地命令；协议参数 `--protocol`、`--url`、`--env K=V`、`--header K=V`；token 存 `mcp-tokens.json`。
4. `background-tasks.ts`：`registerBackgroundShellTask`（taskId `shell_<ts>_<rand>`）、`listBackgroundTasks`（`process.kill(pid,0)` 探测，ESRCH → completed，其他异常 → failed）、`getBackgroundTask`。
5. `tools/run-command.ts`：后台 `&` 分支调用 `registerBackgroundShellTask`，返回 `{ok:true, output: 'Background command started.\nTASK: ...\nPID: ...', backgroundTask}`。
6. `cli-commands.ts`：`tryHandleLocalCommand` 支持 `/init`（调 initializeRepo + renderInitReport）；`/status`、`/model`、`/model <name>`（persist 到 settings.json）、`/skills`、`/mcp`、`/permissions`、`/config-paths`、`/memory`。

**验收**
```bash
npx tsx --test test/init.test.ts
npx tsx --test test/cli-commands.test.ts
npm run install-local    # 交互式配置后生成启动器
./bin/minicode mcp list  # 管理命令可用
```
`/init` 重复执行不覆盖已有 MINI.md。

---

### T14（P3）MCP / Web 强化 / 非 TTY REPL

**涉及文件**
- 新增 `src/mcp.ts`（约 35K）、`src/mcp-status.ts`
- `src/config.ts` 补 MCP 配置（mcpServers、mcp.json、mcp-tokens.json、协议缓存）
- `src/tools/index.ts` 加 `hydrateMcpTools`
- `src/utils/web.ts` 补 `searchDuckDuckGoLite`
- `src/tools/web-search.ts` 改用 DuckDuckGo Lite
- `src/index.ts` 完整对齐（--resume/--fork、管理命令分流、非 TTY REPL、banner）
- `src/prompt.ts` 注入 MCP 状态段

**实现要点**
1. `mcp.ts`：
   - 协议协商：stdio 下先探测 `content-length` / `newline-json`（`MCP_INITIALIZE_PROBE_TIMEOUT_MS=1200`），HTTP 用 `streamable-http`；结果缓存到 `~/.mini-code/mcp-protocol-cache.json`。
   - JSON-RPC 2.0 请求/响应配对（PendingRequest + 超时）、`initialize`（`MCP_INITIALIZE_TIMEOUT_MS=10000`）、`tools/list`、`resources/list`、`prompts/list`。
   - `createMcpBackedTools({cwd, mcpServers})` → `{tools, servers: McpServerSummary[], dispose}`；动态工具名 `mcp__<server>__<tool>`，输入走 zod 宽松解析，执行失败返回 `ok:false`。
   - 提供 `list_mcp_resources/read_mcp_resource/list_mcp_prompts/get_mcp_prompt` 类工具（如有资源/提示词）。
   - `McpServerSummary`：name/command/status/toolCount/resourceCount/promptCount/protocol/error。
   - 启动失败（ENOENT 等）给出可读错误，不影响整体启动。
2. `mcp-status.ts`：`summarizeMcpServers` 汇总 total/connected/connecting/error/toolCount。
3. `config.ts`：`McpServerConfig`（command/args/env/url/headers/cwd/enabled/protocol）、`loadEffectiveSettings`（Claude settings → mcp.json → 项目 .mcp.json → mini-code settings 依次合并）、`readMcpTokensFile/saveMcpTokensFile`、`getMcpConfigPath/loadScopedMcpServers/saveScopedMcpServers`。
4. `utils/web.ts`：`searchDuckDuckGoLite({query, maxResults, allowedDomains?, blockedDomains?})` → `{organic: [{title, link, snippet}]}`；复用 `fetchWithRetry`。
5. `tools/web-search.ts`：改为调用 `searchDuckDuckGoLite`，输出 `QUERY:` + `[n] title / URL / snippet`。
6. `tools/index.ts`：`createDefaultToolRegistry` 注入 skills + connecting 状态的 MCP 摘要；`hydrateMcpTools` 在启动时异步连接并 `addTools/setMcpServers/addDisposer`。
7. `index.ts`：
   - 解析 `--resume <id>|picker`、`--fork <id>`；先 `maybeHandleManagementCommand`。
   - TTY → `runTtyApp`；非 TTY → readline REPL：`/tools`、`/collapse`、`tryHandleLocalCommand`、未知 `/` 命令给 `findMatchingSlashCommands` 提示、普通输入走 `runAgentTurn`（beginTurn/endTurn 包裹，错误写回 assistant）、`refreshSystemPrompt`、结束 `tools.dispose()` + `mcpHydration`。
   - banner 用 `renderBanner`（含 MCP 统计）。
8. `prompt.ts`：`Configured MCP servers:` 段（status/tools/resources/prompts/protocol）+ 能力提示（mcp__ 前缀工具、资源/提示词工具）。

**验收**
```bash
npx tsx --test test/context-collapse.test.ts   # 复用；index 相关用手动验证
./bin/minicode mcp add my-server -- npx @modelcontextprotocol/server-everything   # 配置一个 MCP
```
配置 MCP server 后 `/mcp` 显示连接状态且工具出现在 `/tools`；无 TTY 环境（`echo "hi" | minicode`）能逐行对话；`--resume` 无参数时打开选择器（TTY）。

---

### T15（P2）收尾：测试移植与工程对齐

**涉及文件**
- `test/`：移植参考版测试，覆盖当前缺失的用例
- `package.json`、`tsconfig.json`、`.gitignore`、`docs/`

**实现要点**
1. 移植参考版测试（已核对 import 路径，命名对齐后可直接使用）：
   - 压缩族：`compact.test.ts`、`snip-compact.test.ts`、`context-collapse.test.ts`、`auto-compact.test.ts`、`microcompact.test.ts`
   - 会话：`session.test.ts`（依赖 session/config/types/compact 全家桶）
   - TUI：`input-parser.test.ts`、`input.test.ts`、`status-line.test.ts`、`context-badge.test.ts`、`transcript-wrapping.test.ts`、`transcript-cjk-selection.test.ts`、`mouse-release-selection.test.ts`、`welcome-animation.test.ts`、`windows-clipboard-encoding.test.ts`
   - 其他：`cli-commands.test.ts`、`init.test.ts`、`local-tool-shortcuts.test.ts`、`model-context.test.ts`、`token-estimator.test.ts`、`tool-result-storage.test.ts`、`provider-usage-ingestion.test.ts`、`anthropic-thinking-roundtrip.test.ts`、`memory.test.ts`
   - 当前已有的 6 个测试保留；若与参考版重复（provider-usage-ingestion、anthropic-thinking-roundtrip）可保留参考版版本。
2. `package.json`：删除 `openai`、`linkedom`（重写后不再使用）；`dependencies` 收敛为 `diff` + `zod`；补充 `install-local` 脚本；`dev`/`check`/`lint`/`test` 保留。
3. `tsconfig.json`：二选一——(a) 对齐参考版 `rootDir: "src"`、`include: ["src"]`（推荐，测试不参与 tsc）；或 (b) 保持 `include: ["src","test"]`，但需保证移植的测试也编译通过（参考版测试用 `.ts` 相对导入，tsc 会检查，需处理）。
4. `.gitignore`：补充 `# MiniCode local artifacts` 段（`.mini-code/settings.local.json`、`.mini-code/sessions/`）。
5. `docs/replica-analysis.md`：把 T5–T14 标记 `[完成]`，记录每项验证结果；更新"当前下一轮任务"。

**最终验收**
```bash
npm run check     # 0 error
npm test          # 全部通过
npm run lint      # 无错误（可保留当前 eslint 配置）
MINI_CODE_MODEL_MODE=mock npm run dev   # TTY 全屏 TUI；无 TTY 走 REPL
./bin/minicode mcp list && ./bin/minicode skills list
```

---

## 3. 最终对齐检查清单

| 域 | 参考版文件 | 完成后核对点 |
| --- | --- | --- |
| CLI 入口 | `index.ts` | --resume/--fork、管理命令分流、TTY/非 TTY 分流、banner |
| 管理命令 | `manage-cli.ts` | mcp/skills 子命令全参数 |
| 配置 | `config.ts` | 五源合并、mcpServers、tokens、路径常量 |
| 模型适配 | `types.ts`+`anthropic-adapter.ts`+`mock-model.ts` | 构造参数顺序、resolveMaxOutputTokens、snip_boundary 文本 |
| Agent 循环 | `agent-loop.ts` | progress/final、空响应/thinking 重试、全部回调、压缩钩子、ask_user、maxSteps |
| 工具框架 | `tool.ts`+`tools/*`（12 个） | zod 校验、skills/MCP 元数据、dispose、load_skill、backgroundTask |
| 权限 | `permissions.ts` | whenReady/beginTurn/endTurn、三类审批、持久化、getSummary |
| 文件 Review | `file-review.ts` | 无变化分支、ensureEdit 集成 |
| Skills | `skills.ts`+`tools/load-skill.ts` | 4 根目录、优先级去重、install/remove |
| MCP | `mcp.ts`+`mcp-status.ts` | 协议协商、动态工具、/mcp 状态 |
| 会话 | `session.ts` | 事件模型、fork/rename/cleanup/transcript、三类边界 |
| Memory | `memory.ts` | @include、rules、全局、预算、去重 |
| 历史 | `history.ts` | history.jsonl、500 上限 |
| 压缩 | `compact/*`（7 文件） | micro/snip/collapse/auto/manual、常量、熔断 |
| Token | `token-estimator.ts`+`model-context.ts`+`utils/context.ts` | usage 优先、stale、CLEAR_MARKER、max_tokens 推导 |
| 落盘 | `utils/tool-result-storage.ts` | 50K/200K、会话子目录、去重、占位 |
| Web | `utils/web.ts`+`web-search.ts`+`web-fetch.ts` | DDG Lite、域名过滤、重试 |
| TUI | `tui/*`+`tty-app.ts`+`ui.ts` | 全屏、审批弹窗、选择器、欢迎动画、鼠标/剪贴板 |
| init/install | `init.ts`+`install.ts` | 幂等、启动器 |
| 后台任务 | `background-tasks.ts`+`run-command.ts` | `&` 分支、状态查询 |
| 快捷键 | `local-tool-shortcuts.ts`+`cli-commands.ts` | 全部 `/` 命令 |
| 测试 | `test/*`（25 个） | npm test 全绿 |
| 工程 | `package.json`/`tsconfig.json`/`.gitignore` | 依赖收敛、脚本齐全 |

---

## 4. 实施纪律（沿用原文档规则）

1. 一次只做一项（T5 → T6 → ... → T15）。
2. 每项交付三样东西：代码改动；部署/调试步骤（安装依赖、mock 模式、测试命令）；与参考版同一场景跑同一命令的行为对比。
3. 每项完成即在 `docs/replica-analysis.md` 任务标题前标记 `[完成]` 并记录验证结果。
4. 若某步依赖后续步骤（如 T5 依赖 T8/T9/T10），先留接口占位、后回填，避免阻塞。
