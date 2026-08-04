import { parseKeyEvent } from "./tui/input.js"
import { Screen } from "./tui/screen.js"


const screen = new Screen()

function draw(input: string, cursor: number, log: string[]): void {
  const lines: string[] = []
  lines.push(' MiniCode TUI Demo - 按 q 或 Ctrl+C 退出')
  lines.push('')
  const visibleLog = log.slice(-8)
  for (const entry of visibleLog) {
    lines.push(` ${entry}`)
  }
  while (lines.length < screen.rows - 3) {
    lines.push('')
  }

  const withCursor = input.slice(0, cursor) + "█" + input.slice(cursor)
  lines.push(` 你: ${withCursor}`)
  lines.push(' 状态: 正常')

  screen.render(lines)
}

async function main(): Promise<void> {
  screen.enter()
  let input = ''
  let cursor = 0
  const log: string[] = []

  draw(input, cursor, log)
  process.stdin.on('data', (chunk: Buffer) => {
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
        log.push(`你: ${input}`)
        log.push(`AI: 收到 "${input}"`)
        input = ''
        cursor = 0
      }
    }
    draw(input, cursor, log)
  })

}
main().catch(error => {
  screen.exit()
  console.error(error)
  process.exit(1)
})