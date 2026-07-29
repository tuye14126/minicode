import * as readline from "node:readline"
import * as process from "node:process"
import OpenAI from 'openai'
import { runAgentTurn } from "./agent-loop.js"
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})
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
      '需要先读取文件内容再修改，不要凭空猜测文件内容。',
      '修改完文件后告诉用户你做了什么。',
    ].join('\n'),
  },
]

function askAI() {
  rl.question("用户:", async input => {
    if (input === "exit") {
      rl.close()
      return
    }
    messages.push({ "role": "user", "content": input })
    try {
      const reply = await runAgentTurn(client, messages, 15)
      console.log("AI:", reply)
    } catch (e: any) {
      console.log(`\n出错了：${e.message}\n`)
    }
    askAI()
  })
}

askAI()