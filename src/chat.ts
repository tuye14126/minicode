import * as readline from "node:readline"
import * as process from "node:process"
import { callAI } from "./llm.js"
import OpenAI from 'openai'
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})
const client = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
  baseURL: process.env['OPENAI_BASE_URL']
});

function askAI(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
) {
  rl.question("用户:", async input => {
    if (input === "exit") {
      rl.close()
      return
    }
    messages.push({ "role": "user", "content": input })
    const reply = await callAI(client, messages)
    console.log("AI:", reply);
    messages.push({ "role": "assistant", "content": reply })
    askAI(messages)
  })
}

askAI([{ "role": "system", "content": "你叫minicode, 是一个非常好的助手,可以帮助用户解决问题" }])