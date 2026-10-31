

const ENTER_ALT_SCREEN = '\x1B[?1049h'    // 开启备用屏幕
const EXIT_ALT_SCREEN = '\x1B[?1049l'     // 退出备用屏幕
const ERASE_SCREEN_AND_HOME = '\x1B[2J\x1B[H' // 清屏+光标回到左上角
const HOME = '\x1B[H'                     // 光标回到左上角(1,1)
const ERASE_TO_END = '\x1B[J'             // 从光标位置清到屏幕末尾
const ERASE_LINE = '\x1B[2K'              // 清空当前整行
// 鼠标追踪：1000=鼠标按下释放，1002=单元格追踪，1006=SGR扩展编码（现代终端）
const ENABLE_MOUSE_TRACKING = '\x1B[?1000h' + '\x1B[?1002h' + '\x1B[?1006h'
const DISABLE_MOUSE_TRACKING = '\x1B[?1006l' + '\x1B[?1002l' + '\x1B[?1000l'

// 上一帧按行分割的文本数组
let previousFrameLines: string[] | null = null
let previousColumns = 0
let previousRows = 0

// ?25l：隐藏终端光标；?25h：显示光标
export function hideCursor(): void {
  process.stdout.write('\x1B[?25l')
}
export function showCursor(): void {
  process.stdout.write('\x1B[?25h')
}

// 备用屏幕切换
export function enterAlternateScreen(): void {
  resetTerminalFrame()
  process.stdout.write(
    DISABLE_MOUSE_TRACKING + ENTER_ALT_SCREEN + ERASE_SCREEN_AND_HOME + ENABLE_MOUSE_TRACKING,
  )
}
export function exitAlternateScreen(): void {
  resetTerminalFrame()
  process.stdout.write(DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN)
}

// 软清屏：光标回到左上角，从光标清到屏幕末尾
export function clearScreen(): void {
  process.stdout.write('\x1B[H\x1B[J')
}

// 重置帧缓存，清空上一帧记录，下次渲染强制全刷
export function resetTerminalFrame(): void {
  previousFrameLines = null
  previousColumns = 0
  previousRows = 0
}
// 增量 diff 渲染：按行和上一帧比较，只重写变化的行（\u001b[行;1H[2K+内容
export function renderTerminalFrame(frame: string): void {
  const lines = frame.split('\n')
  const columns = process.stdout.columns ?? 0
  const rows = process.stdout.rows ?? 0
  // 判断是否强制整屏重绘
  const forceFullRender =
    previousFrameLines === null ||
    previousColumns !== columns ||
    previousRows !== rows

  if (forceFullRender) {
    // 全量渲染：光标回左上角，清除到末尾，输出完整frame
    process.stdout.write(HOME + ERASE_TO_END + frame)
  } else {
    // 增量局部diff渲染：只重绘发生变化的行
    const previous = previousFrameLines ?? []
    const maxLines = Math.max(previous.length, lines.length)
    let output = ''
    for (let index = 0; index < maxLines; index += 1) {
      const nextLine = lines[index] ?? ''
      const previousLine = previous[index] ?? ''
      if (nextLine === previousLine) continue // 行内容没变，跳过

      // ESC[行;1H 移动光标到该行第1列 → 清空整行 → 写入新行
      output += `\x1B[${index + 1};1H${ERASE_LINE}${nextLine}`
    }
    if (output.length > 0) {
      process.stdout.write(output)
    }
  }
  // 更新缓存为本帧
  previousFrameLines = lines
  previousColumns = columns
  previousRows = rows
}