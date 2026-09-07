import { parseKeyEvent } from "./tui/input.js"
import { Screen } from "./tui/screen.js"
import { buildSystemPrompt } from "./prompt.js"
import { runAgentTurn } from "./agent-loop.js"
import { computeContextStats } from "./utils/token-estimator.js"
import { setUserPromptFn } from "./user-prompt.js"
import { createDefaultToolRegistry } from "./tools/index.js"
import { loadRuntimeConfig } from "./config.js"
import { PermissionManager } from "./permissions.js"
import { ChatMessage } from "./types.js"
import { MockModelAdapter } from "./mock-model.js"
import { AnthropicModelAdapter } from "./anthropic-adapter.js"


const screen = new Screen()
type showMessage = { kind: 'ai' | 'user' | 'status', text: string }

const showMessages: showMessage[] = []
const history: string[] = []
let historyIndex = 0
let tmpInput = ''


let lastElapsed = 0

const messages: ChatMessage[] = []



const MODEL = 'deepseek-v4-flash'

type Modal = { promptText: string, input: string, resolve: (v: string) => void }
let modal: Modal | null = null

let busy = false





function draw(input: string, cursor: number): void {
  const lines: string[] = []

  if (modal) {
    lines.push(' MiniCode TUI   [确认]')
    lines.push('')
    for (const line of modal.promptText.split('\n').slice(0, screen.rows - 4)) {
      lines.push(` ${line}`)
    }
    while (lines.length < screen.rows - 2) lines.push('')
    lines.push(` 输入: ${modal.input}█`)
    screen.render(lines)
    return
  }
  lines.push(` MiniCode TUI   [${MODEL}]`)
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

  const stats = computeContextStats(messages, MODEL)
  const tokenText = showMessages.length > 0
    ? `${stats.totalTokens} tokens`
    : '0 tokens'
  const elapsedText = lastElapsed > 0 ? ` ${lastElapsed}s` : ''
  const status = busy
    ? '思考中...'
    : `正常 (↑↓历史, q退出)`
  lines.push(` ${status}   ${tokenText}${elapsedText}`)

  screen.render(lines)
}


setUserPromptFn((promptText: string) => new Promise<string>(resolve => {
  modal = { promptText, input: "", resolve }
  draw("", 0)
}
))

function closeModal(value: string): void {
  const resolve = modal?.resolve
  modal = null
  resolve?.(value)
  draw("", 0)
}

async function main(): Promise<void> {
  const cwd = process.cwd()
  const permissions = new PermissionManager(cwd)
  screen.enter()
  let input = ''
  let cursor = 0
  messages.push({
    "role": "system",
    "content": buildSystemPrompt(cwd),
  })
  draw(input, cursor)
  const runtime = await loadRuntimeConfig()
  const registry = await createDefaultToolRegistry({ cwd, runtime })

  const model = runtime.modelMode === 'mock'
    ? new MockModelAdapter()
    : new AnthropicModelAdapter(registry, loadRuntimeConfig)

  process.stdin.on('data', async (chunk: Buffer) => {
    const event = parseKeyEvent(chunk)

    if (modal) {
      if (event.type === 'text') {
        modal.input += event.text
      } else if (event.type === 'backspace') {
        modal.input = modal.input.slice(0, -1)
      } else if (event.type === 'enter') {
        closeModal(modal.input)
      } else if (event.type === 'ctrl_c') {
        closeModal('') // 当作取消
      }
      draw("", 0)
      return
    }
    if (busy) return

    if (event.type === 'ctrl_c' || (event.type === 'text' && event.text === 'q')) {
      screen.exit()
      process.exit(0)
    }

    if (event.type === 'text') {
      input = input.slice(0, cursor) + event.text + input.slice(cursor)
      tmpInput = input
      cursor += event.text.length
    } else if (event.type === 'backspace' && cursor > 0) {
      input = input.slice(0, cursor - 1) + input.slice(cursor)
      tmpInput = input
      cursor -= 1
    } else if (event.type === 'arrow' && event.direction === 'left' && cursor > 0) {
      cursor -= 1
    } else if (event.type === 'arrow' && event.direction === 'up') {
      historyIndex = historyIndex === 0 ? 0 : historyIndex - 1
      if (history[historyIndex]) {
        input = history[historyIndex]
      }
      cursor = input.length
    } else if (event.type === 'arrow' && event.direction === 'down') {
      historyIndex = historyIndex === history.length ? history.length : historyIndex + 1
      if (historyIndex === history.length) {
        input = tmpInput
      } else {
        input = history[historyIndex]
      }
      cursor = input.length
    } else if (event.type === 'arrow' && event.direction === 'right' && cursor < input.length) {
      cursor += 1
    } else if (event.type === 'enter') {
      if (input.trim()) {
        const question = input.trim()
        history.push(question)
        historyIndex = history.length
        input = ''
        tmpInput = ''
        cursor = 0
        busy = true
        showMessages.push({ kind: 'user', text: question })
        messages.push({ role: 'user', content: question })
        draw(input, cursor)

        try {
          const startTime = Date.now()
          const reply = await runAgentTurn({
            messages,
            maxSteps: 15,
            model,
            tools: registry,
            permissions,
            cwd
          })
          lastElapsed = Number(((Date.now() - startTime) / 1000).toFixed(1))
          const lastMessage = reply[-1]
          showMessages.push({
            kind: 'ai', text: lastMessage.role === 'assistant'
              ? lastMessage.content
              : ''
          })
        } catch (e: any) {
          showMessages.push({ kind: 'status', text: `错误: ${e.message}` })
        } finally {
          busy = false
          screen.enter()
          draw(input, cursor)
        }
      }
      return
    }
    draw(input, cursor)
  })

}

main().catch(error => {
  screen.exit()
  console.error(error)
  process.exit(1)
})