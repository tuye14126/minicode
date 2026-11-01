import { charDisplayWidth, stringDisplayWidth, wrapPanelBodyLine } from "./chrome.js"
import { renderMarkdownish } from "./markdown.js"
import { TranscriptEntry } from "./types.js"

const RESET = '\u001b[0m'
const DIM = '\u001b[2m'
const CYAN = '\u001b[36m'
const GREEN = '\u001b[32m'
const YELLOW = '\u001b[33m'
const RED = '\u001b[31m'
const MAGENTA = '\u001b[35m'
const BOLD = '\u001b[1m'
const BLUE = '\u001b[34m'
const GRAY = '\u001b[90m' // 灰色（16色兼容版）
const REVERSE = '\u001b[7m' // 反转前景背景，用于选区高亮
const USER_MESSAGE_BG = '\u001b[48;5;236m' // 用户消息深色背景

// 逻辑行号 + 显示列号
export type TranscriptSelection = {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
}

// 正则剔除所有 ANSI 转义序列，拿到纯文本，用于提取选中文字
function stripAnsi(str: string): string {
  return str.replace(/\[[\d;]*[A-Za-z]/g, '')
}

// 按终端视觉列截取文本，不是字符串下标截取
function sliceByDisplayColumns(input: string, startCol: number, endCol: number): string {
  if (startCol >= endCol) return ''

  let result = ''
  let col = 0
  for (const char of input) {
    const width = charDisplayWidth(char)
    const nextCol = col + width
    if (nextCol <= startCol) {
      col = nextCol
      continue
    }
    if (col >= endCol) {
      break
    }
    result += char
    col = nextCol
  }
  return result
}

// 给一行带 ANSI 颜色的文本叠加选区反转高亮 REVERSE
function highlightRange(line: string, startCol: number, endCol: number): string {
  if (startCol >= endCol) return line

  let result = ''
  let visibleCol = 0
  let i = 0
  let highlighted = false

  while (i < line.length) {
    if (line[i] === '') {
      const escapeStart = i
      i++
      if (i < line.length && line[i] === '[') {
        i++
        while (i < line.length && (line[i] < '@' || line[i] > '~')) {
          i++
        }
        i++
      }
      const seq = line.slice(escapeStart, i)
      result += seq
      if (seq === '[0m' && highlighted) {
        result += REVERSE
      }
      continue
    }

    const char = line[i]
    const width = charDisplayWidth(char)

    if (!highlighted && visibleCol >= startCol) {
      result += REVERSE
      highlighted = true
    }

    if (!highlighted && visibleCol < startCol && visibleCol + width > startCol) {
      result += REVERSE
      highlighted = true
    }

    if (highlighted && visibleCol >= endCol) {
      result += RESET
      highlighted = false
    }

    result += char
    visibleCol += width
    i++

    if (highlighted && visibleCol >= endCol) {
      result += RESET
      highlighted = false
    }
  }

  if (highlighted) {
    result += RESET
  }

  return result
}

// 整段文本每一行前面增加缩进
function indentBlock(input: string, prefix = '  '): string {
  return input
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n')
}

// 渲染单行用户消息：填充背景色，末尾补空格撑满面板宽度
function renderUserBodyLine(line: string, width: number): string {
  const padding = Math.max(0, width - stringDisplayWidth(line))
  return `${USER_MESSAGE_BG}${line}${' '.repeat(padding)}${RESET}`
}

// 渲染用户消息块  每行前缀 `>`   调用 `wrapPanelBodyLine` 自动折行  填充背景色，补齐行尾空格，保证整行背景填充
function renderUserBody(body: string): string {
  const panelWidth = getTranscriptPanelWidth()
  const bodyWidth = Math.max(0, panelWidth - 4)
  return body
    .split('\n')
    .map(line => `> ${line}`)
    .flatMap(line => wrapPanelBodyLine(line, panelWidth))
    .map(line => renderUserBodyLine(line, bodyWidth))
    .join('\n')
}


// 工具输出截断预览
function previewToolBody(toolName: string, body: string): string {
  const maxChars = toolName === 'read_file' ? 1000 : 1800
  const maxLines = toolName === 'read_file' ? 20 : 36
  const lines = body.split('\n')
  const limitedLines = lines.length > maxLines ? lines.slice(0, maxLines) : lines
  let limited = limitedLines.join('\n')

  if (limited.length > maxChars) {
    limited = `${limited.slice(0, maxChars)}...`
  }

  if (limited !== body) {
    return `${limited}\n${DIM}... output truncated in transcript${RESET}`
  }

  return limited
}

// 渲染分隔行，展示本次思考耗时 `Worked for Xs`，靠右放置
function renderWorkedForDivider(seconds: number): string {
  const width = Math.max(60, process.stdout.columns ?? 100)
  const inner = Math.max(0, width - 4)
  const label = `Worked for ${Math.max(0, seconds)}s`
  const labelWidth = stringDisplayWidth(label)
  return `${' '.repeat(Math.max(0, inner - labelWidth))}${label}`
}

// 单个会话条目渲染分发器
function renderTranscriptEntry(entry: TranscriptEntry): string {
  // 青色加粗标题 `you`，渲染带背景的用户消息体
  if (entry.kind === 'user') {
    return `${CYAN}${BOLD}you${RESET}\n${renderUserBody(entry.body)}`
  }
  // 绿色加粗标题 `Minicode`，渲染简易 markdown 内容；如果有耗时，追加耗时分隔线
  if (entry.kind === 'assistant') {
    const header = `${GREEN}${BOLD}Minicode${RESET}\n${indentBlock(
      renderMarkdownish(entry.body),
    )}`
    return entry.workedForSeconds === undefined
      ? header
      : `${header}\n${renderWorkedForDivider(entry.workedForSeconds)}`
  }
  // 黄色加粗标题 `progress`，缩进渲染进度文本
  if (entry.kind === 'progress') {
    return `${YELLOW}${BOLD}progress${RESET}\n${indentBlock(
      renderMarkdownish(entry.body),
    )}`
  }

  if (entry.kind === 'thinking') {
    return `${GRAY}thinking${RESET}\n${indentBlock(
      renderMarkdownish(entry.body),
    )}`
  }
  // `tool`：品红加粗标题 `tool` + 工具名 + 状态标记
  const status =
    entry.status === 'running'
      ? `${YELLOW}running${RESET}`
      : entry.status === 'success'
        ? `${GREEN}ok${RESET}`
        : `${RED}err${RESET}`

  const body =
    entry.status === 'running'
      ? entry.body
      : entry.collapsed
        ? `${DIM}${entry.collapsedSummary ?? 'output collapsed'}${RESET}`
        : entry.collapsePhase
          ? `${DIM}collapsing${'.'.repeat(entry.collapsePhase)}${RESET}`
          : previewToolBody(entry.toolName, renderMarkdownish(entry.body))

  return `${MAGENTA}${BOLD}tool${RESET} ${entry.toolName} ${status}\n${indentBlock(body)}`
}

// 获取终端面板宽度
function getTranscriptPanelWidth(): number {
  return Math.max(60, process.stdout.columns ?? 100)
}
// 获取可视窗口行数（一页能显示多少行日志）
export function getTranscriptWindowSize(windowSize?: number): number {
  if (windowSize !== undefined) {
    return Math.max(4, windowSize)
  }
  const rows = process.stdout.rows ?? 40
  return Math.max(8, rows - 15)
}

// 把所有会话条目渲染，拆成逻辑行数组
export function renderTranscriptLines(entries: TranscriptEntry[]): string[] {
  const rendered = entries.map(renderTranscriptEntry)
  const separator = `${BLUE}${DIM}·${RESET}`
  const logicalLines: string[] = []

  rendered.forEach((block, index) => {
    if (index > 0) {
      logicalLines.push(separator)
    }

    logicalLines.push(...block.split('\n'))
  })

  const panelWidth = getTranscriptPanelWidth()
  return logicalLines.flatMap(line => wrapPanelBodyLine(line, panelWidth))
}

// 计算最大滚动偏移量：总渲染行数 − 可视窗口行数
export function getTranscriptMaxScrollOffset(
  entries: TranscriptEntry[],
  windowSize?: number,
): number {
  if (entries.length === 0) return 0
  const lines = renderTranscriptLines(entries)
  return Math.max(0, lines.length - getTranscriptWindowSize(windowSize))
}


export function renderTranscript(
  entries: TranscriptEntry[],
  scrollOffset: number, //已经向上滚动了多少行
  windowSize?: number,
  selection?: TranscriptSelection,
): string {

  // 无对话直接返回空串
  if (entries.length === 0) {
    return ''
  }

  let lines = renderTranscriptLines(entries)
  const pageSize = getTranscriptWindowSize(windowSize)
  const maxOffset = Math.max(0, lines.length - pageSize)
  const offset = Math.max(0, Math.min(scrollOffset, maxOffset))  //把传入的 scrollOffset 限制在 `0 ~ maxOffset`，防止滚超边界

  // 截取当前可视页面
  const end = lines.length - offset
  const start = Math.max(0, end - pageSize)

  if (selection) {
    lines = lines.map((line, index) => {
      // 当前行不在选区行范围：原样返回，不高亮
      if (index < selection.startLine || index > selection.endLine) {
        return line
      }
      if (index === selection.startLine && index === selection.endLine) {
        // 选区单行内（startLine === endLine）：只高亮 startCol → endCol
        return highlightRange(line, selection.startCol, selection.endCol)
      }
      // 选区起始行（多行选中第一行）：startCol → 行尾（Infinity）
      if (index === selection.startLine) {
        return highlightRange(line, selection.startCol, Infinity)
      }
      // 选区结束行（多行选中最后一行）：行首 → endCol
      if (index === selection.endLine) {
        return highlightRange(line, 0, selection.endCol)
      }
      // 选区中间行：整行全部高亮（0 到 Infinity）
      return highlightRange(line, 0, Infinity)
    })
  }
  // 当前视口可见内容
  const body = lines.slice(start, end).join('\n')

  if (offset === 0) {
    return body
  }

  return `${body}\n\n${DIM}scroll offset: ${offset}${RESET}`
}

// 提取用户选中的纯文本（剥离所有 ANSI 颜色）
export function extractSelectedText(
  entries: TranscriptEntry[],
  selection: TranscriptSelection,
): string {
  const lines = renderTranscriptLines(entries)
  const { startLine, startCol, endLine, endCol } = selection

  const result: string[] = []
  for (let i = startLine; i <= endLine && i < lines.length; i++) {
    const plainLine = stripAnsi(lines[i])
    if (i === startLine && i === endLine) {
      result.push(sliceByDisplayColumns(plainLine, startCol, endCol))
    } else if (i === startLine) {
      result.push(sliceByDisplayColumns(plainLine, startCol, Infinity))
    } else if (i === endLine) {
      result.push(sliceByDisplayColumns(plainLine, 0, endCol))
    } else {
      result.push(plainLine)
    }
  }
  return result.join('\n')
}