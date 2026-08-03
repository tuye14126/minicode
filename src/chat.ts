import * as readline from "node:readline/promises"
import { stdin, stdout } from "node:process"
import OpenAI from 'openai'
import { runAgentTurn } from "./agent-loop.js"
import { listSessions, loadSession, saveSession } from "./session.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { renderMemoryReport } from "./memory.js";
import { computeContextStats } from "./utils/token-estimator.js";
import { compactConversation } from "./compact.js";
const client = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
  baseURL: process.env['OPENAI_BASE_URL']
});
const MODEL = 'deepseek-v4-flash'
let sessionId = crypto.randomUUID().slice(0, 8)

let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
  {
    "role": "system",
    "content": buildSystemPrompt(process.cwd()),
  },
]

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
    return TOOL_DEFINITIONS
      .map(t => `- ${t.function.name}: ${t.function.description}`)
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
    if (input.startsWith('/')) {
      if (input === '/new') {
        messages = [{ role: 'system', content: buildSystemPrompt(process.cwd()) }]
        sessionId = crypto.randomUUID().slice(0, 8)
        console.log('\n已开始新会话\n')
        continue
      }
      if (input.startsWith('/resume ')) {
        const id = input.slice('/resume '.length).trim()
        const target = loadSession(id, process.cwd())
        if (target) {
          messages = [{ "role": "system", "content": buildSystemPrompt(process.cwd()) }]
          messages.push(...target.filter(m => m.role !== 'system'))
          sessionId = id
          console.log(`\n已恢复会话 ${id}\n`)
        } else {
          console.log(`\n会话 ${id} 不存在\n`)
        }
        continue
      }

      if (input === '/compact') {
        const stats = computeContextStats(messages, MODEL)
        console.log(`\n压缩前上下文: ${stats.totalTokens} tokens\n`)
        const compacted = await compactConversation(client, messages, MODEL)
        if (compacted) {
          messages = compacted
          const newStats = computeContextStats(messages, MODEL)
          console.log(`已压缩: ${stats.totalTokens} → ${newStats.totalTokens} tokens\n`)
        } else {
          console.log('没有可压缩的内容。\n')
        }
        continue
      }

      const localResult = handleLocalCommand(input)
      if (localResult !== null) {
        console.log(`\n${localResult}\n`)
        continue
      }
      console.log(`\n未识别的命令: ${input}，输入 /help 查看\n`)
      continue
    }
    messages.push({ "role": "user", "content": input })
    // 压缩上下文
    const stats = computeContextStats(messages, MODEL)
    if (stats.utilization > 0.7) {
      console.log(`\n上下文使用率 ${(stats.utilization * 100).toFixed(1)}%，自动压缩中...`)
      const compacted = await compactConversation(client, messages, MODEL)
      if (compacted) messages = compacted
    }
    try {
      const startTime = Date.now()
      const reply = await runAgentTurn(client, messages, 15, MODEL)
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const contextStats = computeContextStats(messages, MODEL)
      const pct = (contextStats.utilization * 100).toFixed(1)
      const level =
        contextStats.warningLevel === 'critical' ? '⚠️ 告警' :
          contextStats.warningLevel === 'warning' ? '注意' : '正常'
      saveSession(messages, sessionId, process.cwd())
      console.log(`\nAI: ${reply}\n`)
      console.log(`  上下文: ${contextStats.totalTokens} / ${contextStats.contextWindow} tokens (${pct}%) [${level}]`)
      console.log(`  ⏱ 用时 ${elapsed}s`)
      console.log('')
    } catch (e: any) {
      console.log(`\n出错了：${e.message}\n`)
    }

  }

}

main().catch(console.error)
