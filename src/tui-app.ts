import OpenAI from "openai"
import { parseKeyEvent } from "./tui/input.js"
import { Screen } from "./tui/screen.js"
import { buildSystemPrompt } from "./prompt.js"
import { Message, runAgentTurn } from "./agent-loop.js"


const screen = new Screen()
type showMessage = { kind: 'ai' | 'user' | 'status', text: string }

const showMessages: showMessage[] = []

const client = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
  baseURL: process.env['OPENAI_BASE_URL']
});
const MODEL = 'deepseek-v4-flash'

function draw(input: string, cursor: number, busy: Boolean): void {
  const lines: string[] = []
  lines.push(' MiniCode TUI')
  lines.push('')

  // 对话区（只显示最近能放得下的行数）
  const maxLogLines = screen.rows - 4
  const renderedLog: string[] = []
  for (const message of showMessages) {
    const prefix = message.kind === 'user'
      ? "你" : message.kind === 'ai'
        ? 'AI' : '>'
    for (const line of message.text.split('\n')) {
      renderedLog.push(` ${prefix}: ${line}`)
    }
  }
  const visibleLog = renderedLog.slice(-maxLogLines)
  for (const entry of visibleLog) {
    lines.push(entry)
  }
  while (lines.length < screen.rows - 3) {
    lines.push('')
  }

  const withCursor = input.slice(0, cursor) + "█" + input.slice(cursor)
  lines.push(` 你: ${withCursor}`)
  lines.push(busy ? ' 状态: 思考中...' : ' 状态: 正常 (q 退出)')

  screen.render(lines)
}

async function main(): Promise<void> {

  screen.enter()
  let input = ''
  let cursor = 0
  let busy = false
  draw(input, cursor, busy)
  process.stdin.on('data', async (chunk: Buffer) => {
    if (busy) return
    const event = parseKeyEvent(chunk)
    if (event.type === 'ctrl_c' || (event.type === 'text' && event.text === 'q')) {
      screen.exit()
      process.exit(0)
    }

    if (event.type === 'text') {
      input = input.slice(0, cursor) + event.text + input.slice(cursor)
      cursor += event.text.length
    } else if (event.type === 'backspace' && cursor > 0) {
      input = input.slice(0, cursor - 1) + input.slice(cursor)
      cursor -= 1
    } else if (event.type === 'arrow' && event.direction === 'left' && cursor > 0) {
      cursor -= 1
    } else if (event.type === 'arrow' && event.direction === 'right' && cursor < input.length) {
      cursor += 1
    } else if (event.type === 'enter') {
      if (input.trim()) {
        const question = input.trim()
        input = ''
        cursor = 0
        busy = true
        showMessages.push({ kind: 'user', text: question })
        draw(input, cursor, busy)

        screen.exit()
        try {
          const messages: Message[] = [
            {
              "role": "system",
              "content": buildSystemPrompt(process.cwd()),
            },
          ]
          const reply = await runAgentTurn(client, messages, 15, MODEL)
          showMessages.push({ kind: 'ai', text: reply })
        } catch (e: any) {
          showMessages.push({ kind: 'status', text: `错误: ${e.message}` })
        } finally {
          busy = false
          screen.enter()
          draw(input, cursor, busy)
        }
      }
      return
    }
    draw(input, cursor, busy)
  })

}

main().catch(error => {
  screen.exit()
  console.error(error)
  process.exit(1)
})