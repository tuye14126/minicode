import * as readline from "node:readline/promises"
import { stdin, stdout } from "node:process"
import OpenAI from 'openai'
import { runAgentTurn } from "./agent-loop.js"
import { listSessions, loadSession, saveSession } from "./session.js";

const client = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
  baseURL: process.env['OPENAI_BASE_URL']
});
const argv = process.argv.slice(2)
let sessionId = crypto.randomUUID().slice(0, 8)

const resumeIndex = argv.indexOf('--resume')
if (resumeIndex !== -1) {
  const target = argv[resumeIndex + 1]
  if (target && !target.startsWith('-')) {
    sessionId = target
  } else {
    const sessions = listSessions(process.cwd())
    if (sessions.length === 0) {
      console.log('没有可恢复的会话，开始新会话。')
    } else {
      console.log('\n可用会话:')
      sessions.forEach((s, i) => {
        console.log(`${i + 1}. ${s.id}  (${s.messageCount} 条消息, ${new Date(s.updateAt).toLocaleString()})`)
      })
      const rl = readline.createInterface({ input: stdin, output: stdout })
      const pick = (await rl.question('输入序号恢复: ')).trim()
      rl.close()
      const selected = sessions[Number(pick) - 1]
      if (selected) sessionId = selected.id
    }
  }
}
const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
  {
    "role": "system",
    "content": [
      '你是 MiniCode，一个终端编码助手。',
      '你可以读写文件、搜索代码、执行命令。',
      '当用户让你做事时，直接做，不要只给建议。',
      '修改文件前先读取文件内容，不要凭空猜测。',
      '修改完后告诉用户你做了什么。',
      '如果你只需要改一行，用 edit_file。',
      '如果你需要改多处，用 patch_file。',
      '如果你需要大幅修改文件，用 modify_file。',
      '只有创建新文件时才用 write_file。',
    ].join('\n'),
  },
]

const saved = loadSession(sessionId, process.cwd())
if (saved) {
  messages.push(...saved.filter(m => m.role !== 'system'))
  console.log(`\n已恢复会话 ${sessionId}\n`)
}
async function main() {

  while (true) {
    console.log(messages);

    const rl = readline.createInterface({
      input: stdin,
      output: stdout
    })
    const input = (await rl.question("用户: ")).trim()
    rl.close()
    if (input === "exit") {
      saveSession(messages, sessionId, process.cwd())
      break
    }
    if (!input) continue
    messages.push({ "role": "user", "content": input })
    try {
      const startTime = Date.now()
      const reply = await runAgentTurn(client, messages, 15)
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      saveSession(messages, sessionId, process.cwd())
      console.log(`\nAI: ${reply}\n`)
      console.log(`  ⏱ 用时 ${elapsed}s`)
      console.log('')
    } catch (e: any) {
      console.log(`\n出错了：${e.message}\n`)
    }

  }

}

main().catch(console.error)
