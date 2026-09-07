import * as readline from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { runAgentTurn } from "./agent-loop.js"
import { listSessions, loadSession, saveSession } from "./session.js";
import { buildSystemPrompt } from "./prompt.js";
import { renderMemoryReport } from "./memory.js";
import { computeContextStats } from "./utils/token-estimator.js";
// import { compactConversation } from "./compact.js";
import { loadRuntimeConfig } from "./config.js";
import { createDefaultToolRegistry } from "./tools/index.js";
import { PermissionManager } from "./permissions.js";
import { AnthropicModelAdapter } from "./anthropic-adapter.js";
import { ChatMessage } from "./types.js";
import { MockModelAdapter } from "./mock-model.js";
import { createContextCollapseState } from "./compact/context-collapse.js";


const runtime = await loadRuntimeConfig()


const registry = await createDefaultToolRegistry({
  cwd: process.cwd(),
  runtime
})


const SLASHCOMMANDS = [
  { usage: '/help', description: '显示帮助' },
  { usage: '/tools', description: '列出可用工具' },
  { usage: '/memory', description: '显示加载的指令文件' },
  { usage: '/sessions', description: '列出已保存的会话' },
  { usage: '/resume <id>', description: '恢复指定会话' },
  { usage: '/new', description: '开始新会话' },
  { usage: '/exit', description: '退出程序' },
  { usage: '/compact', description: '手动压缩上下文' },
]

function handleLocalCommand(input: string): string | null {
  if (input === '/help') {
    return SLASHCOMMANDS.map(command => `${command.usage.padEnd(14)}  ${command.description}`).join('\n')
  }
  if (input === '/tools') {

    return registry.list()
      .map(t => {
        return `- ${t.name}: ${t.description}`
      })
      .join('\n')
  }
  if (input === '/memory') {
    return renderMemoryReport(process.cwd())
  }
  if (input === '/sessions') {
    const sessions = listSessions(process.cwd())
    if (sessions.length === 0) return '还没有保存的会话。'
    return sessions
      .map(s => `${s.id}  (${s.messageCount} 条消息)`)
      .join('\n')
  }

  return null
}

async function main() {

  const MODEL = runtime.model
  let sessionId = crypto.randomUUID().slice(0, 8)

  let messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(process.cwd()),
    },
  ]
  const cwd = process.cwd()
  const permissions = new PermissionManager(cwd, async () => ({ decision: 'allow_once' }))
  const model = runtime.modelMode === 'mock'
    ? new MockModelAdapter()
    : new AnthropicModelAdapter(registry, loadRuntimeConfig)
  const contextCollapseState = createContextCollapseState()


  while (true) {
    // console.log(messages);

    const rl = readline.createInterface({
      input: stdin,
      output: stdout
    })
    const input = (await rl.question("用户: ")).trim()
    rl.close()
    if (input === "exit" || input === "/exit") {
      saveSession(messages, sessionId, process.cwd())
      break
    }
    if (!input) continue
    // if (input.startsWith('/')) {
    //   if (input === '/new') {
    //     messages = [{ role: 'system', content: buildSystemPrompt(process.cwd()) }]
    //     sessionId = crypto.randomUUID().slice(0, 8)
    //     console.log('\n已开始新会话\n')
    //     continue
    //   }
    //   if (input.startsWith('/resume ')) {
    //     const id = input.slice('/resume '.length).trim()
    //     const target = loadSession(id, process.cwd())
    //     if (target) {
    //       messages = [{ "role": "system", "content": buildSystemPrompt(process.cwd()) }]
    //       messages.push(...target.filter(m => m.role !== 'system'))
    //       sessionId = id
    //       console.log(`\n已恢复会话 ${id}\n`)
    //     } else {
    //       console.log(`\n会话 ${id} 不存在\n`)
    //     }
    //     continue
    //   }

    //   // if (input === '/compact') {
    //   //   const stats = computeContextStats(messages, MODEL)
    //   //   console.log(`\n压缩前上下文: ${stats.totalTokens} tokens\n`)
    //   //   const compacted = await compactConversation(client, messages, MODEL)
    //   //   if (compacted) {
    //   //     messages = compacted
    //   //     const newStats = computeContextStats(messages, MODEL)
    //   //     console.log(`已压缩: ${stats.totalTokens} → ${newStats.totalTokens} tokens\n`)
    //   //   } else {
    //   //     console.log('没有可压缩的内容。\n')
    //   //   }
    //   //   continue
    //   // }

    //   const localResult = handleLocalCommand(input)
    //   if (localResult !== null) {
    //     console.log(`\n${localResult}\n`)
    //     continue
    //   }
    //   console.log(`\n未识别的命令: ${input}，输入 /help 查看\n`)
    //   continue
    // }
    messages.push({ "role": "user", "content": input })
    // 压缩上下文
    // const stats = computeContextStats(messages, MODEL)
    // if (stats.utilization > 0.7) {
    //   console.log(`\n上下文使用率 ${(stats.utilization * 100).toFixed(1)}%，自动压缩中...`)
    //   const compacted = await compactConversation(client, messages, MODEL)
    //   if (compacted) messages = compacted
    // }
    try {
      const startTime = Date.now()
      permissions.resetTurn()
      const reply = await runAgentTurn({
        messages,
        maxSteps: 15,
        model,
        modelName: runtime.model ?? "",
        tools: registry,
        permissions,
        cwd,
        contextCollapseState
      })
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const contextStats = computeContextStats(messages, MODEL)
      const pct = (contextStats.utilization * 100).toFixed(1)
      const level =
        contextStats.warningLevel === 'critical' ? '⚠️ 告警' :
          contextStats.warningLevel === 'warning' ? '注意' : '正常'
      saveSession(messages, sessionId, process.cwd())
      const last = reply.filter(m => m.role === 'assistant').at(-1)
      const replyText = last?.role === 'assistant' ? last.content : ''
      console.log(`\nAI: ${replyText}\n`)
      console.log(`  上下文: ${contextStats.totalTokens} / ${contextStats.contextWindow} tokens (${pct}%) [${level}]`)
      console.log(`  ⏱ 用时 ${elapsed}s`)
      console.log('')
    } catch (e: any) {
      console.log(`\n出错了：${e.message}\n`)
    }

  }

}

main().catch(console.error)
