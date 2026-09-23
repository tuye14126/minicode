import * as readline from "node:readline/promises"
import { runAgentTurn } from "./agent-loop.js"
import { buildSystemPrompt } from "./prompt.js";
// import { compactConversation } from "./compact.js";
import { loadRuntimeConfig } from "./config.js";
import { createDefaultToolRegistry } from "./tools/index.js";
import { PermissionManager } from "./permissions.js";
import { AnthropicModelAdapter } from "./anthropic-adapter.js";
import { ChatMessage } from "./types.js";
import { MockModelAdapter } from "./mock-model.js";
import { applyContextCollapseIfNeeded, createContextCollapseState } from "./compact/context-collapse.js";
import { maybeHandleManagementCommand } from "./manage-cli.js";
import { createContentReplacementState } from "./utils/tool-result-storage.js";
import { completeSlashCommand, findMatchingSlashCommands, tryHandleLocalCommand } from "./cli-commands.js";



async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cwd = process.cwd()
  // 获取--resume的参数，如果没有参数则默认为picker， 弹出对话选择器
  let resumeTarget: string | 'picker' | undefined
  const resumeIndex = argv.indexOf('--resume')
  // 判断有没有resume参数
  if (resumeIndex !== -1) {
    argv.splice(resumeIndex, 1)
    const nextArg = argv[resumeIndex]
    if (nextArg && !nextArg.startsWith('-')) {
      resumeTarget = nextArg
      argv.splice(resumeIndex, 1)
    } else {
      // 没有则默认为picker
      resumeTarget = 'picker'
    }
  }

  // 判断有无fork参数，并获取
  let forkTarget: string | undefined
  const forkIndex = argv.indexOf('--fork')
  if (forkIndex !== -1) {
    argv.splice(forkIndex, 1)
    const nextArg = argv[forkIndex]
    if (nextArg && !nextArg.startsWith('-')) {
      forkTarget = nextArg
      argv.splice(forkIndex, 1)
    }
  }

  // 管理命令拦截，处理MCP，skill相关命令，无需与ai进行交互
  if (await maybeHandleManagementCommand(cwd, argv)) {
    return
  }
  // 判断是否是交互式终端
  const isInteractiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY)

  // 加载运行时配置文件
  let runtime = null
  try {
    runtime = await loadRuntimeConfig()
  } catch {
    runtime = null
  }

  // 加载工具
  const tools = await createDefaultToolRegistry({
    cwd,
    runtime,
  })
  // 权限管理
  const permissions = new PermissionManager(cwd)
  await permissions.whenReady()

  // 模型适配器
  const model =
    process.env.MINI_CODE_MODEL_MODE === 'mock'
      ? new MockModelAdapter()
      : new AnthropicModelAdapter(tools, loadRuntimeConfig)

  let messages: ChatMessage[] = [
    {
      role: 'system',
      content: await buildSystemPrompt(cwd, permissions.getSummary(), {
        skills: tools.getSkills(),
        mcpServers: tools.getMcpServers()
      }),
    },
  ]
  // 工具结果落盘全局状态
  const contentReplacementState = createContentReplacementState()
  // 全局会话折叠区间
  const contextCollapseState = createContextCollapseState()


  async function refreshSystemPrompt(): Promise<void> {
    messages[0] = {
      role: 'system',
      content: await buildSystemPrompt(cwd, permissions.getSummary(), {
        skills: tools.getSkills(),
        mcpServers: tools.getMcpServers()
      }),
    }
  }

  try {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: completeSlashCommand,
    })

    for await (const rawInput of rl) {
      const input = rawInput.trim()
      if (!input) {
        continue
      }
      if (input === '/exit') break
      try {
        if (input === '/tools') {
          console.log(
            `\n${tools.list().map(tool => `${tool.name}: ${tool.description}`).join('\n')}\n`,
          )
          continue
        }

        if (input === '/collapse') {
          if (!runtime?.model) {
            console.log('\nNo model configured. Cannot collapse context.\n')
            continue
          }

          const result = await applyContextCollapseIfNeeded(
            messages,
            runtime.model,
            model,
            contextCollapseState,
            {
              utilizationThreshold: 0,
              reason: 'manual',
            },
          )
          contextCollapseState.spans = [...result.state.spans]
          contextCollapseState.enabled = result.state.enabled
          contextCollapseState.consecutiveFailures = result.state.consecutiveFailures

          if (!result.collapsed) {
            console.log(
              result.state.enabled
                ? '\nNothing safe to collapse.\n'
                : '\nContext collapse is disabled after repeated summary failures.\n',
            )
            continue
          }

          const savedTokens = result.spans.reduce(
            (sum, span) => sum + Math.max(0, span.tokensBefore - span.tokensAfter),
            0,
          )
          console.log(
            `\nContext collapse projected ${result.spans.length} span${result.spans.length === 1 ? '' : 's'} into model-visible summaries, saving ~${Math.round(savedTokens)} tokens. Original transcript is preserved.\n`,
          )
          continue
        }

        // 处理本地命令
        const localCommandResult = await tryHandleLocalCommand(input, {
          cwd,
          tools,
          permissionSummary: permissions.getSummary(),
        })

        if (localCommandResult !== null) {
          console.log(`\n${localCommandResult}\n`)
          continue
        }

        if (input.startsWith('/')) {
          const matches = findMatchingSlashCommands(input)
          if (matches.length > 0) {
            console.log(`\n未识别命令。你是不是想输入：\n${matches.join('\n')}\n`)
          } else {
            console.log(`\n未识别命令。输入 /help 查看可用命令。\n`)
          }
          continue
        }
      } catch (error) {
        console.log(
          `\n${error instanceof Error ? error.message : String(error)}\n`,
        )
        continue
      }
      // 刷新 system prompt，把用户输入追加进消息列表
      await refreshSystemPrompt()
      messages = [...messages, { role: 'user', content: input }]
      permissions.beginTurn()
      // Agent 核心循环
      try {
        messages = await runAgentTurn({
          model,
          tools,
          messages,
          cwd,
          permissions,
          modelName: runtime?.model ?? '',
          contentReplacementState,
          contextCollapseState,
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: `请求失败: ${message}`,
          },
        ]
      } finally {
        permissions.endTurn()
      }
      // 拿到最新一条 assistant 消息，打印输出给用户
      const lastAssistant = [...messages]
        .reverse()
        .find(message => message.role === 'assistant')

      if (lastAssistant?.role === 'assistant') {
        console.log(`\n${lastAssistant.content}\n`)
      }
    }

    try {
      rl.close()
    } catch {
      // Ignore double-close during EOF teardown.
    }
  } finally {
    await tools.dispose()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
