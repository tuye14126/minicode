import { SlashCommand } from "../cli-commands.js"
import { RuntimeConfig } from "../config.js"
import { PermissionRequest } from "../permissions.js"
import { BackgroundTaskResult } from "../tool.js"

// ANSI 颜色常量
const RESET = '\u001b[0m'
const DIM = '\u001b[2m'
const CYAN = '\u001b[36m'
const GREEN = '\u001b[32m'
const YELLOW = '\u001b[33m'
const RED = '\u001b[31m'
const BLUE = '\u001b[34m'
const MAGENTA = '\u001b[35m'
const BOLD = '\u001b[1m'
const REVERSE = '\u001b[7m'
const BRIGHT_GREEN = '\u001b[92m'
const BRIGHT_RED = '\u001b[91m'
const BRIGHT_CYAN = '\u001b[96m'
const BRIGHT_YELLOW = '\u001b[93m'
const BORDER = '\u001b[38;5;31m'

// 正则清除所有 \e[...m 样式转义码，只保留纯文本，用于计算真实显示宽度（ANSI 码不占终端屏幕宽度）
function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, '')
}

// 输入单个 Unicode 字符（字符串长度为 1），返回它在终端里占几列
// 检测 Unicode 码点，CJK 统一汉字、韩文谚文、日文假名、全角符号、部分 emoji → 返回宽度 2
export function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0)
  if (code === undefined) return 0

  if (
    code >= 0x1100 &&  //只有码点 ≥ 0x1100 才进入宽字符判断；所有小于 0x1100 的字符直接返回宽度 1
    (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faf6) ||
      (code >= 0x20000 && code <= 0x3fffd)
    )
  ) {
    return 2
  }

  return 1
}

// 累加每个字符的终端显示宽度，得到真实屏幕占用列数
export function stringDisplayWidth(input: string): number {
  return [...stripAnsi(input)].reduce((sum, char) => sum + charDisplayWidth(char), 0)
}

// 按显示宽度截断文本，超长末尾加 ...
function truncatePlain(input: string, width: number): string {
  if (width <= 0) return ''
  if (stringDisplayWidth(input) <= width) return input
  if (width <= 3) return input.slice(0, width)
  const target = width - 3
  let current = ''
  let used = 0
  for (const char of [...input]) {
    const next = charDisplayWidth(char)
    if (used + next > target) break
    current += char
    used += next
  }
  return `${current}...`
}


// 按显示宽度补齐空格，实现文本右对齐占位
function padPlain(input: string, width: number): string {
  const visible = stringDisplayWidth(input)
  return visible >= width ? input : `${input}${' '.repeat(width - visible)}`
}

// 生成 [label] value 彩色标签
function colorBadge(
  label: string,
  value: string,
  color: string,
): string {
  return `${color}[${label}]${RESET} ${BOLD}${value}${RESET}`
}

// 把一组彩色徽章横向拼接，在最大宽度内尽可能多放；放不下就末尾加 ...
function joinSegmentsWithinWidth(
  segments: string[],
  separator: string,
  maxWidth: number,
): string {
  if (maxWidth <= 0 || segments.length === 0) {
    return ''
  }

  let output = ''
  for (const segment of segments) {
    const candidate = output.length > 0 ? `${output}${separator}${segment}` : segment
    if (stringDisplayWidth(candidate) <= maxWidth) {
      output = candidate
      continue
    }

    if (!output) {
      return truncatePlain(stripAnsi(segment), maxWidth)
    }

    const withEllipsis = `${output}${separator}${DIM}...${RESET}`
    if (stringDisplayWidth(withEllipsis) <= maxWidth) {
      return withEllipsis
    }

    return output
  }

  return output
}

// 绘制顶部 / 底部边框线
function borderLine(kind: 'top' | 'bottom', width: number): string {
  const inner = Math.max(0, width - 2)
  if (kind === 'top') {
    return `${BORDER}╭${'─'.repeat(inner)}╮${RESET}`
  }
  return `${BORDER}╰${'─'.repeat(inner)}╯${RESET}`
}

// 一行面板内容，支持左侧主文本 + 右侧附属文本，自动截断溢出
function panelRow(left: string, width: number, right?: string): string {
  const inner = Math.max(0, width - 4)
  const rightText = right ?? ''
  const leftWidth = stringDisplayWidth(left)
  const rightWidth = stringDisplayWidth(rightText)
  const gap = rightText ? Math.max(1, inner - leftWidth - rightWidth) : 0
  const leftText =
    leftWidth + rightWidth + gap > inner
      ? truncatePlain(left, Math.max(0, inner - rightWidth - 1))
      : left
  return `${BORDER}│${RESET} ${leftText}${' '.repeat(
    Math.max(0, inner - stringDisplayWidth(leftText) - rightWidth),
  )}${rightText} ${BORDER}│${RESET}`
}

// 空行填充
function emptyPanelRow(width: number): string {
  return `${BORDER}│${RESET}${' '.repeat(Math.max(0, width - 2))}${BORDER}│${RESET}`
}


// 自动换行函数：输入单行长文本，按面板内部宽度拆分成多行，基于真实显示宽度
export function wrapPanelBodyLine(line: string, width: number): string[] {
  const inner = Math.max(0, width - 4)
  if (inner <= 0) return ['']
  const plain = stripAnsi(line)
  if (stringDisplayWidth(plain) <= inner) return [line]
  const parts: string[] = []
  let current = ''
  let currentWidth = 0
  for (const char of [...plain]) {
    const charWidth = charDisplayWidth(char)
    if (currentWidth + charWidth > inner) {
      parts.push(current)
      current = char
      currentWidth = charWidth
      continue
    }
    current += char
    currentWidth += charWidth
  }
  if (current.length > 0) {
    parts.push(current)
  }
  return parts
}

// 带边框面板组件，用来输出一块带标题、可选右上角副标题、自动换行、最小高度的方框文本
export function renderPanel(
  title: string,
  body: string,
  options: {
    rightTitle?: string
    minBodyLines?: number
    showTitle?: boolean
    frame?: boolean
  } = {},
): string {
  const width = Math.max(60, process.stdout.columns ?? 100)
  const bodyLines = body.length > 0 ? body.split('\n') : []
  const renderedLines = bodyLines.flatMap(line => wrapPanelBodyLine(line, width))
  const minBodyLines = options.minBodyLines ?? 0
  const showFrame = options.frame ?? true
  const showTitle = options.showTitle ?? true
  while (renderedLines.length < minBodyLines) {
    renderedLines.push('')
  }

  if (!showFrame) {
    return renderedLines.join('\n')
  }

  return [
    borderLine('top', width),
    ...(showTitle
      ? [
        panelRow(
          `${BRIGHT_CYAN}${BOLD}${title}${RESET}`,
          width,
          options.rightTitle
            ? `${DIM}${truncatePlain(options.rightTitle, Math.max(10, Math.floor(width * 0.3)))}${RESET}`
            : undefined,
        ),
        emptyPanelRow(width),
      ]
      : []),
    ...renderedLines.map(line => panelRow(line, width)),
    borderLine('bottom', width),
  ].join('\n')
}

export function renderContextBadge(stats: {
  utilization: number
  warningLevel: 'normal' | 'warning' | 'critical' | 'blocked'
  accounting?: {
    providerUsageTokens: number
    estimatedTokens: number
    source: 'provider_usage' | 'provider_usage_plus_estimate' | 'estimate_only'
  }
}): string {
  const { utilization, warningLevel, accounting } = stats
  const percent = Math.round(utilization * 100)

  const colorMap = {
    normal: GREEN,
    warning: YELLOW,
    critical: RED,
    blocked: BRIGHT_RED,
  }
  const color = colorMap[warningLevel]

  const filled = Math.round(utilization * 10)
  const bar = '\u2593'.repeat(filled) + '\u2591'.repeat(10 - filled)
  const sourceLabel =
    accounting?.source === 'provider_usage'
      ? 'usage'
      : accounting?.source === 'provider_usage_plus_estimate'
        ? 'usage+est'
        : accounting?.source === 'estimate_only'
          ? 'est'
          : ''
  const suffix = sourceLabel ? ` ${sourceLabel}` : ''

  return colorBadge('ctx', `${percent}% ${bar}${suffix}`, color)
}

// 顶部标题面板（MiniCode 主面板）：
// 收集会话信息：模型、服务商、消息数量、MCP 服务状态、上下文利用率，组装成一排彩色 badge，塞进renderPanel
export function renderBanner(
  runtime: RuntimeConfig | null,
  _cwd: string,
  _permissionSummary: string[],
  session: {
    transcriptCount: number
    messageCount: number
    skillCount: number
    mcpTotalCount: number
    mcpConnectedCount: number
    mcpConnectingCount: number
    mcpErrorCount: number
    contextStats?: {
      utilization: number
      warningLevel: 'normal' | 'warning' | 'critical' | 'blocked'
      accounting?: {
        providerUsageTokens: number
        estimatedTokens: number
        source: 'provider_usage' | 'provider_usage_plus_estimate' | 'estimate_only'
      }
    } | null
  },
): string {
  const panelWidth = Math.max(60, process.stdout.columns ?? 100)
  const panelInner = Math.max(0, panelWidth - 4)
  const model = runtime?.model ?? 'not-configured'
  const provider = runtime?.baseUrl
    ? runtime.baseUrl.replace(/^https?:\/\//, '').split('/')[0] || 'custom'
    : 'offline'
  const metaBadges = [
    colorBadge('session', 'local', BRIGHT_YELLOW),
    colorBadge('provider', provider, CYAN),
    colorBadge('model', model, GREEN),
    colorBadge('messages', String(session.messageCount), BRIGHT_CYAN),
    colorBadge('events', String(session.transcriptCount), BLUE),
    ...(session.contextStats ? [renderContextBadge(session.contextStats)] : []),
    colorBadge('skills', String(session.skillCount), BRIGHT_GREEN),
    colorBadge(
      'mcp',
      `${session.mcpConnectedCount}/${session.mcpTotalCount}`,
      MAGENTA,
    ),
    ...(session.mcpConnectingCount > 0
      ? [colorBadge('mcp-wait', String(session.mcpConnectingCount), YELLOW)]
      : []),
    ...(session.mcpErrorCount > 0
      ? [colorBadge('mcp-err', String(session.mcpErrorCount), BRIGHT_RED)]
      : []),
  ]
  const metaLine = joinSegmentsWithinWidth(metaBadges, '  ', panelInner)

  return renderPanel('MiniCode', metaLine)
}

// 权限摘要单行：提取允许目录、危险权限白名单，超长截断，灰色小字展示。
export function renderPermissionSummaryLine(
  permissionSummary: string[],
  _frame = 0,
): string {
  const width = Math.max(60, process.stdout.columns ?? 100)
  const summarizeList = (label: string, noneText: string): string => {
    const raw = permissionSummary.find(part => part.startsWith(`${label}: `))
    const value = raw?.slice(label.length + 2).trim() || 'none'
    if (value === 'none') return `${label}: ${noneText}`

    const values = value.split(',').map(part => part.trim()).filter(Boolean)
    const first = values[0] ?? 'none'
    return values.length > 1 ? `${label}: ${first}, ...` : `${label}: ${first}`
  }
  const lines = [
    summarizeList('extra allowed dirs', 'none'),
    summarizeList('dangerous allowlist', 'none'),
  ]
  const line = lines.join(' | ')
  return `${DIM}${truncatePlain(line, width)}${RESET}`
}

// 动画点，配合帧计数器做简易动画
function renderStatusDots(animationFrame = 0): string {
  return '.'.repeat((Math.max(0, animationFrame) % 3) + 1)
}
// 动画点，将状态逐个大写
function renderStatusUpper(status: string, upperFrame = 0): string {
  upperFrame = upperFrame % status.length
  return status.slice(0, upperFrame) + status.charAt(upperFrame).toUpperCase() + status.slice(upperFrame + 1)
}

// 主状态文本：Ready / Thinking / 自定义状态
export function renderStatusLine(status: string | null, animationFrame = 0): string {
  if (!status) return `${DIM}Ready${renderStatusDots(animationFrame)}${RESET}`
  if (status === 'Thinking...') {
    return `${YELLOW}${BOLD}Thinking${RESET}`
  }
  return `${YELLOW}${BOLD}${renderStatusUpper(status, animationFrame)}${RESET}`
}

// 工具执行状态面板
export function renderToolPanel(
  activeTool: string | null,
  recentTools: Array<{ name: string; status: 'success' | 'error' }>,
  backgroundTasks: BackgroundTaskResult[] = [],
): string {
  const items: string[] = []
  // 当前正在运行的工具
  if (activeTool) {
    items.push(`${YELLOW}running:${RESET} ${activeTool}`)
  }
  // 后台 shell 任务数量
  const runningBackground = backgroundTasks.filter(task => task.status === 'running')
  if (runningBackground.length > 0) {
    const label =
      runningBackground.length === 1
        ? `1 shell: ${truncatePlain(runningBackground[0]!.command, 48)}`
        : `${runningBackground.length} shells running`
    items.push(`${BRIGHT_CYAN}background:${RESET} ${label}`)
  }

  if (recentTools.length === 0 && runningBackground.length === 0) {
    items.push(`${DIM}recent: none${RESET}`)
    return `${DIM}tools${RESET}  ${items.join('  ')}`
  }
  // 最近 5 个工具调用结果（ok/err 带颜色）
  for (const tool of recentTools.slice(-5).reverse()) {
    const status = tool.status === 'success' ? `${GREEN}ok${RESET}` : `${RED}err${RESET}`
    items.push(`${status} ${tool.name}`)
  }

  return `${DIM}tools${RESET}  ${items.join('  ')}`
}


// 一行左右分栏布局：
// - 左侧：状态文字（Ready / Thinking）
// - 右侧：工具开关、技能开关、MCP 服务状态、后台 shell 数量、压缩状态
// 自动计算中间空格填充，左右文本不重叠
export function renderFooterBar(
  status: string | null,
  toolsEnabled: boolean,
  skillsEnabled: boolean,
  mcpStatus: {
    total: number
    connected: number
    connecting: number
    error: number
    toolCount: number
  },
  backgroundTasks: BackgroundTaskResult[] = [],
  compressionStatus?: string | null,
  statusAnimationFrame = 0,
  leftOverride?: string,
  rightPrefix?: string,
): string {
  const width = Math.max(60, process.stdout.columns ?? 100)
  const left = leftOverride ?? renderStatusLine(status, statusAnimationFrame)
  const runningBackground = backgroundTasks.filter(task => task.status === 'running')
  const backgroundSummary =
    runningBackground.length > 0
      ? `${DIM}|${RESET} ${DIM}shells${RESET} ${BRIGHT_CYAN}${runningBackground.length}${RESET}`
      : ''
  const mcpSummary =
    mcpStatus.total === 0
      ? `${DIM}mcp${RESET} ${DIM}none${RESET}`
      : mcpStatus.connecting > 0
        ? `${DIM}mcp srv${RESET} ${YELLOW}${mcpStatus.connected}/${mcpStatus.total} ready, ${mcpStatus.connecting} connecting${mcpStatus.toolCount > 0 ? `, ${mcpStatus.toolCount} tools` : ''}${RESET}`
        : mcpStatus.error > 0
          ? `${DIM}mcp srv${RESET} ${BRIGHT_RED}${mcpStatus.connected}/${mcpStatus.total} ready, ${mcpStatus.error} err${mcpStatus.toolCount > 0 ? `, ${mcpStatus.toolCount} tools` : ''}${RESET}`
          : `${DIM}mcp srv${RESET} ${GREEN}${mcpStatus.connected}/${mcpStatus.total} ready${mcpStatus.toolCount > 0 ? `, ${mcpStatus.toolCount} tools` : ''}${RESET}`
  const compressionPart = compressionStatus
    ? `${DIM}|${RESET} ${YELLOW}${compressionStatus}${RESET}`
    : ''
  const right = `${rightPrefix ? `${rightPrefix} ${DIM}|${RESET} ` : ''}${DIM}tools${RESET} ${toolsEnabled ? `${GREEN}on${RESET}` : `${RED}off${RESET}`} ${DIM}|${RESET} ${DIM}skills${RESET} ${skillsEnabled ? `${GREEN}on${RESET}` : `${RED}off${RESET}`} ${DIM}|${RESET} ${mcpSummary}${backgroundSummary}${compressionPart}`
  const gap = Math.max(1, width - stripAnsi(left).length - stripAnsi(right).length)
  return `${left}${' '.repeat(gap)}${right}`
}

// 命令列表，选中行使用 `REVERSE`反显高亮，展示命令用法 + 描述
export function renderSlashMenu(
  commands: SlashCommand[],
  selectedIndex: number,
): string {
  if (commands.length === 0) {
    return `${DIM}no matching slash commands${RESET}`
  }

  return [
    `${DIM}commands${RESET}`,
    ...commands.map((command, index) => {
      const usage = padPlain(command.usage, 24)
      const prefix =
        index === selectedIndex
          ? `${REVERSE} ${usage} ${RESET}`
          : ` ${usage} `
      return `${prefix} ${DIM}${truncatePlain(command.description, 60)}${RESET}`
    }),
  ].join('\n')
}

type PermissionPromptRenderOptions = {
  expanded?: boolean          // 是否展开完整diff
  scrollOffset?: number       // 滚动偏移行数（展开模式下）
  selectedChoiceIndex?: number// 当前选中选项下标
  feedbackMode?: boolean      // 是否进入「拒绝填写反馈」输入模式
  feedbackInput?: string     // 反馈框当前输入文本
}

// 把字符串数组（多个详情块）摊平成一维行数组，块与块之间插入空行分隔
function flattenDetailLines(details: string[]): string[] {
  const lines: string[] = []
  details.forEach((detail, index) => {
    if (index > 0) lines.push('')
    lines.push(...detail.split('\n'))
  })
  return lines
}

// 核心视图切片
function sliceVisibleDetails(
  detailLines: string[],
  expanded: boolean,
  scrollOffset: number,  // 滚动偏移  
): { lines: string[]; maxScroll: number; hiddenCount: number } {
  // 折叠模式
  if (!expanded) {
    // 最多展示前16行
    const collapsedLimit = 16
    if (detailLines.length <= collapsedLimit) {
      return { lines: detailLines, maxScroll: 0, hiddenCount: 0 }
    }
    return {
      lines: detailLines.slice(0, collapsedLimit),
      maxScroll: 0,
      hiddenCount: detailLines.length - collapsedLimit,  // 隐藏行数量
    }
  }

  const rows = process.stdout.rows ?? 40
  const expandedWindow = Math.max(8, rows - 20) //可视窗口高度
  const maxScroll = Math.max(0, detailLines.length - expandedWindow)  // 最大可滚动偏移
  const offset = Math.max(0, Math.min(scrollOffset, maxScroll))
  const start = offset
  const end = Math.min(detailLines.length, start + expandedWindow)
  return {
    lines: detailLines.slice(start, end),
    maxScroll,
    hiddenCount: 0,
  }
}

// 输出完整权限审批界面文本
export function renderPermissionPrompt(
  request: PermissionRequest,
  options: PermissionPromptRenderOptions = {},
): string {
  const details =
    request.kind === 'edit'
      ? colorizeEditPermissionDetails(request.details)
      : request.details
  const expanded = options.expanded ?? false
  const scrollOffset = options.scrollOffset ?? 0
  const selectedChoiceIndex = options.selectedChoiceIndex ?? 0
  const feedbackMode = options.feedbackMode ?? false
  const feedbackInput = options.feedbackInput ?? ''
  const detailLines = flattenDetailLines(details)
  const {
    lines: visibleDetailLines,
    maxScroll,
    hiddenCount,
  } = sliceVisibleDetails(detailLines, expanded, scrollOffset)
  // 头部：Approval Required + 请求摘要
  const promptLines = [
    `${YELLOW}${BOLD}Approval Required${RESET}`,
    `${BOLD}${request.summary}${RESET}`,
    ...visibleDetailLines,
  ]
  // diff 详情可视行
  if (request.kind === 'edit') {
    // 折叠且有隐藏行：追加提示
    if (!expanded && hiddenCount > 0) {
      promptLines.push(
        `${DIM}... ${hiddenCount} more line(s) hidden${RESET}`,
        `${DIM}Ctrl+O expand full diff${RESET}`,
      )
      // 展开模式：追加滚动状态提示
    } else if (expanded) {
      promptLines.push(
        `${DIM}Ctrl+O collapse | Wheel/PgUp/PgDn/Alt+Up/Alt+Down scroll (${Math.max(
          0,
          Math.min(scrollOffset, maxScroll),
        )}/${maxScroll})${RESET}`,
      )
    }
  }

  return [
    ...promptLines,
    '',
    // 底部区域二选一：
    // feedbackMode=true：进入拒绝备注输入框 > feedbackInput
    // 普通模式：渲染选项列表，选中项使用反显 REVERSE 标记 >
    ...(feedbackMode
      ? [
        `${YELLOW}${BOLD}Reject With Guidance${RESET}`,
        `${DIM}Type feedback for model, Enter submit, Esc back${RESET}`,
        `> ${feedbackInput}`,
      ]
      : request.choices.map((choice, index) => {
        const selected = index === selectedChoiceIndex
        const prefix = selected ? `${REVERSE}>${RESET}` : ' '
        return `${prefix} ${choice.label}`
      })),
    '',
    `${DIM}Use Up/Down to select, Enter confirm, Esc deny once${RESET}`,
  ].join('\n')
}


// 输入删除行文本、新增行文本，剔除公共前缀、公共后缀，只拿到中间不一样的部分
function computeChangedRange(
  removedText: string,
  addedText: string,
): { remove: { start: number; end: number }; add: { start: number; end: number } } | null {
  if (!removedText || !addedText) {
    return null
  }

  let prefix = 0
  const maxPrefix = Math.min(removedText.length, addedText.length)
  // 正向遍历，找到最长相同前缀
  while (
    prefix < maxPrefix &&
    removedText[prefix] === addedText[prefix]
  ) {
    prefix += 1
  }

  let removedSuffix = removedText.length - 1
  let addedSuffix = addedText.length - 1
  // 反向遍历，找到最长相同后缀
  while (
    removedSuffix >= prefix &&
    addedSuffix >= prefix &&
    removedText[removedSuffix] === addedText[addedSuffix]
  ) {
    removedSuffix -= 1
    addedSuffix -= 1
  }

  const removeRange = { start: prefix, end: removedSuffix + 1 }
  const addRange = { start: prefix, end: addedSuffix + 1 }
  if (removeRange.start >= removeRange.end || addRange.start >= addRange.end) {
    return null
  }

  return {
    remove: removeRange,
    add: addRange,
  }
}

type DiffLineKind = 'meta' | 'add' | 'remove' | 'context'

type StyledDiffLine = {
  raw: string
  kind: DiffLineKind
  emphasisRange?: { start: number; end: number }  // 行内需要加粗的区间
}

function isUnifiedDiffHeader(line: string): boolean {
  return (
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('@@ ')
  )
}

// 区分 diff 行类型
function classifyDiffLine(line: string): DiffLineKind {
  if (isUnifiedDiffHeader(line)) {
    return 'meta'
  }

  if (line.startsWith('+')) {
    return 'add'
  }

  if (line.startsWith('-')) {
    return 'remove'
  }

  return 'context'
}

// 把一行文本，按 emphasisRange，中间片段套 BOLD，其余部分保持原有颜色
function applyWordEmphasis(
  content: string,
  color: string,
  emphasisRange?: { start: number; end: number },
): string {
  if (!emphasisRange) {
    return `${color}${content}${RESET}`
  }

  const start = Math.max(0, Math.min(content.length, emphasisRange.start))
  const end = Math.max(start, Math.min(content.length, emphasisRange.end))
  if (start === end) {
    return `${color}${content}${RESET}`
  }

  const before = content.slice(0, start)
  const changed = content.slice(start, end)
  const after = content.slice(end)
  return [
    `${color}${before}`,
    `${BOLD}${changed}${RESET}`,
    `${color}${after}${RESET}`,
  ].join('')
}

// 根据 StyledDiffLine 渲染单行 diff：
// meta：青色加粗
// add/remove：保留 +/- 符号，内容里改动片段加粗
// context 行：灰色 DIM
function renderStyledDiffLine(line: StyledDiffLine): string {
  if (line.raw.trim() === '') {
    return line.raw
  }

  if (line.kind === 'meta') {
    return `${CYAN}${BOLD}${line.raw}${RESET}`
  }

  if (line.kind === 'add' || line.kind === 'remove') {
    const sign = line.raw.slice(0, 1)
    const content = line.raw.slice(1)
    const color = line.kind === 'add' ? BRIGHT_GREEN : BRIGHT_RED
    const emphasized = applyWordEmphasis(content, color, line.emphasisRange)
    return `${color}${sign}${RESET}${emphasized}`
  }

  if (line.raw.startsWith('... (')) {
    return `${DIM}${line.raw}${RESET}`
  }

  return `${DIM}${line.raw}${RESET}`
}


// 输入一段完整 unified diff 字符串，输出带 ANSI 颜色 + 行内单词级加粗高亮的 diff 文本。
function colorizeUnifiedDiffBlock(block: string): string {
  const lines = block.split('\n')
  const styled: StyledDiffLine[] = lines.map(raw => ({
    raw,
    kind: classifyDiffLine(raw),
  }))

  // Pair adjacent removed/added lines and emphasize changed word spans.
  for (let i = 0; i < styled.length; i += 1) {
    if (styled[i]?.kind !== 'remove') {
      continue
    }
    // 找到连续删除块的末尾下标
    let removeEnd = i
    while (removeEnd < styled.length && styled[removeEnd]?.kind === 'remove') {
      removeEnd += 1
    }
    // 扫描连续新增块
    let addEnd = removeEnd
    while (addEnd < styled.length && styled[addEnd]?.kind === 'add') {
      addEnd += 1
    }
    // 本次删除块一共有多少行
    const removeCount = removeEnd - i
    // 本次新增块一共有多少行
    const addCount = addEnd - removeEnd
    // 可两两配对行数，取两者较小值
    const pairCount = Math.min(removeCount, addCount)
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const removeLine = styled[i + pairIndex]
      const addLine = styled[removeEnd + pairIndex]
      if (!removeLine || !addLine) {
        continue
      }
      // 去掉行首 - / + 符号，只拿后面正文做对比
      const removedText = removeLine.raw.slice(1)
      const addedText = addLine.raw.slice(1)
      // 找出公共前缀 / 后缀，得到中间变化部分的字符起止下标
      const ranges = computeChangedRange(removedText, addedText)
      if (!ranges) {
        continue
      }
      // 找到需要加粗的区间
      removeLine.emphasisRange = ranges.remove
      addLine.emphasisRange = ranges.add
    }

    i = addEnd - 1
  }

  return styled.map(renderStyledDiffLine).join('\n')
}

// 遍历详情数组，识别内容是否是 unified diff
function looksLikeDiffBlock(detail: string): boolean {
  return (
    detail.includes('\n') &&
    (detail.includes('--- a/') ||
      detail.includes('+++ b/') ||
      detail.includes('@@ '))
  )
}


// 遍历详情数组，识别内容是否是 unified diff,是则做 diff 着色，原样返回普通文本
function colorizeEditPermissionDetails(details: string[]): string[] {
  return details.map(detail => {
    if (looksLikeDiffBlock(detail)) {
      return colorizeUnifiedDiffBlock(detail)
    }
    return detail
  })
}

export function getPermissionPromptMaxScrollOffset(
  request: PermissionRequest,
  options: PermissionPromptRenderOptions = {},
): number {
  const details =
    request.kind === 'edit'
      ? colorizeEditPermissionDetails(request.details)
      : request.details
  const detailLines = flattenDetailLines(details)
  const expanded = options.expanded ?? false
  if (!expanded) {
    return 0
  }
  const rows = process.stdout.rows ?? 40
  const expandedWindow = Math.max(8, rows - 20)
  return Math.max(0, detailLines.length - expandedWindow)
}