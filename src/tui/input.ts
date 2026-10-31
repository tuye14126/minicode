const RESET = '\u001b[0m'    // 重置所有颜色/样式
const DIM = '\u001b[2m'      // 暗淡（浅灰文字）
const GREEN = '\u001b[32m'   // 绿色前景
const BOLD = '\u001b[1m'     // 加粗
const REVERSE = '\u001b[7m'  // 反显：文字<->背景翻转，用来模拟光标

// 两条轮换提示文案，通过 hintFrame 取模切换
const INPUT_HINTS = [
  'Ask for code, files, tasks, or MCP tools',
  'Enter send; /help commands; Esc clear; Ctrl+C exit',
]

// 截断提示文本，超长末尾加 ...；保护边界：最大长度不足 3 时直接输出点号，防止负数切片报错
function truncateHint(input: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (input.length <= maxLength) return input
  if (maxLength <= 3) return '.'.repeat(maxLength)
  return `${input.slice(0, maxLength - 3)}...`
}

export function renderInputPrompt(
  input: string,
  cursorOffset: number,
  hintFrame = 0,
): string {
  // 边界钳位光标位置：0 ≤ offset ≤ input.length
  const offset = Math.max(0, Math.min(cursorOffset, input.length))
  const before = input.slice(0, offset)
  const current = input[offset] ?? ' '
  const after = input.slice(Math.min(offset + 1, input.length))

  // 前缀：mini-code prompt>
  const promptPrefix = 'mini-code prompt> '
  const visibleInput = `${promptPrefix}${before}${current}${after}`

  // 面板宽度：最小60，取终端列数-4
  const panelInnerWidth = Math.max(0, Math.max(60, process.stdout.columns ?? 100) - 4)
  // 提示文本可用长度 = 总面板宽度 - 整行输入内容长度 - 1空格
  const hintMaxLength = Math.max(0, panelInnerWidth - visibleInput.length - 1)

  // 轮询选取hint并截断
  const hintText = truncateHint(
    INPUT_HINTS[Math.max(0, hintFrame) % INPUT_HINTS.length] ?? INPUT_HINTS[0]!,
    hintMaxLength,
  )
  // 条件：输入框为空 && 有hintText，才展示淡色提示
  const hint = input || !hintText ? '' : ` ${DIM}${hintText}${RESET}`

  // 组装最终带ANSI样式的字符串
  return `${GREEN}${BOLD}mini-code prompt>${RESET} ${before}${REVERSE}${current}${RESET}${after}${hint}`
}