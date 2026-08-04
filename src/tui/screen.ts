

const ESC = '\x1b'

// ANSI 控制序列
const ALT_SCREEN_IN = `${ESC}[?1049h`
const ALT_SCREEN_OUT = `${ESC}[?1049l`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const CLEAR = `${ESC}[2J`
const HOME = `${ESC}[H`
function moveTo(row: number, col: number): string {
  return `${ESC}[${row};${col}H`
}

export class Screen {
  rows = 24
  cols = 80
  enter(): void {
    this.rows = process.stdout.rows || 24
    this.cols = process.stdout.columns || 80
    process.stdout.write(ALT_SCREEN_IN + HIDE_CURSOR + CLEAR + HOME)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    process.stdin.resume()
  }
  exit(): void {
    process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OUT)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
  }
  render(lines: string[]): void {
    const out = [CLEAR + HOME]
    for (let i = 0; i < this.rows; i++) {
      const text = (lines[i] ?? " ").slice(0, this.cols)
      out.push(`${moveTo(i + 1, 1)}${text}${' '.repeat(this.cols - text.length)}`)
    }
    process.stdout.write(out.join(''))
  }
}