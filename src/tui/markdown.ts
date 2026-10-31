// ANSI 转义序列常量
const RESET = '\u001b[0m'    // 重置所有样式
const DIM = '\u001b[2m'     // 暗淡/灰度文字
const CYAN = '\u001b[36m'   // 青色前景
const YELLOW = '\u001b[33m' // 黄色前景
const MAGENTA = '\u001b[35m'// 品红前景
const BOLD = '\u001b[1m'    // 加粗

/**
 * 简易Markdown渲染，输出带ANSI颜色的字符串，用于终端打印
 * @param input Markdown文本
 * @returns 带ANSI转义码的字符串
 */
export function renderMarkdownish(input: string): string {
  // 按行分割
  const lines = input.split('\n')
  let inCodeBlock = false // 标记是否处于```代码块内

  return lines
    .map(line => {
      let formatted = line

      // 代码块起止标记 ```
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock
        return `${DIM}${line}${RESET}`
      }
      // 代码块内部所有行统一暗淡样式
      if (inCodeBlock) {
        return `${DIM}${line}${RESET}`
      }

      // -------- Markdown 表格处理 --------
      // 匹配表格分隔行：|---|---| 这类，把 | 替换成空格，暗淡显示
      if (/^\|(?:\s*:?-+:?\s*\|)+$/.test(line.trim())) {
        return `${DIM}${line.replace(/\|/g, ' ').trim()}${RESET}`
      }
      // 普通表格内容行 | cell1 | cell2 |
      if (/^\|.*\|$/.test(line.trim())) {
        const cells = line
          .split('|')
          .map(cell => cell.trim())
          .filter(Boolean) // 去掉空字符串
        return cells.join(` ${DIM}|${RESET} `)
      }

      // -------- 标题 --------
      if (line.startsWith('### ')) {
        return `${CYAN}${BOLD}${line.slice(4)}${RESET}`
      }
      if (line.startsWith('## ')) {
        return `${CYAN}${BOLD}${line.slice(3)}${RESET}`
      }
      if (line.startsWith('# ')) {
        return `${CYAN}${BOLD}${line.slice(2)}${RESET}`
      }

      // 引用块 > 开头
      if (line.startsWith('> ')) {
        return `${DIM}${line}${RESET}`
      }

      // 无序列表 - / * 替换成黄色圆点 •
      if (/^\s*[-*]\s+/.test(line)) {
        formatted = line.replace(/^\s*[-*]\s+/, `${YELLOW}•${RESET} `)
      }

      // -------- 行内语法（正则替换）--------
      // 行内代码 `code` → 品红色
      formatted = formatted.replace(/`([^`]+)`/g, `${MAGENTA}$1${RESET}`)
      // **粗体**
      formatted = formatted.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)

      return formatted
    })
    .join('\n')
}