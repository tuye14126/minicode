import * as readline from "node:readline/promises"
import { stdin, stdout } from "node:process"
import OpenAI from 'openai'
import { runAgentTurn } from "./agent-loop.js"

const client = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
  baseURL: process.env['OPENAI_BASE_URL']
});

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
      rl.close()
      break
    }
    if (!input) continue
    messages.push({ "role": "user", "content": input })
    try {
      const startTime = Date.now()
      const reply = await runAgentTurn(client, messages, 15)
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`\nAI: ${reply}\n`)
      console.log(`  ⏱ 用时 ${elapsed}s`)
      console.log('')
    } catch (e: any) {
      console.log(`\n出错了：${e.message}\n`)
    }

  }

}

main().catch(console.error)
