import crypto from 'node:crypto'
import process from 'node:process'
import { listBackgroundTasks } from './background-tasks.js'
import { runAgentTurn } from './agent-loop.js'
import {
  SLASH_COMMANDS,
  findMatchingSlashCommands,
  tryHandleLocalCommand,
} from './cli-commands.js'
import { loadHistoryEntries, saveHistoryEntries } from './history.js'
import { parseLocalToolShortcut } from './local-tool-shortcuts.js'
import { summarizeMcpServers } from './mcp-status.js'
import {
  PermissionManager,
  PermissionPromptResult,
  PermissionRequest,
} from './permissions.js'
import { buildSystemPrompt } from './prompt.js'
import { discoverInstructionFiles } from './memory.js'
import {
  saveSession,
  loadSession,
  clearSession,
  listSessions,
  renameSession,
  appendCompactBoundary,
  appendSnipBoundary,
  appendContextCollapseSpan,
  loadTranscript,
  loadContextCollapseState,
  forkSession,
  cleanupExpiredSessions,
  listAllProjects,
} from './session.js'
import type { SessionMeta, ProjectMeta } from './session.js'
import { spawn } from 'node:child_process'
import { parseInputChunk, type ParsedInputEvent } from './tui/input-parser.js'
import {
  enterAlternateScreen,
  exitAlternateScreen,
  getPermissionPromptMaxScrollOffset,
  hideCursor,
  renderBanner,
  renderFooterBar,
  renderInputPrompt,
  renderPanel,
  renderPermissionPrompt,
  renderPermissionSummaryLine,
  renderSlashMenu,
  renderStatusLine,
  renderTerminalFrame,
  renderToolPanel,
  renderTranscript,
  getTranscriptMaxScrollOffset,
  showCursor,
  extractSelectedText,
  renderTranscriptLines,
  getTranscriptWindowSize,
  type TranscriptEntry,
  type TranscriptSelection,
} from './ui.js'
import type { RuntimeConfig } from './config.js'
import type { ToolRegistry } from './tool.js'
import type { ChatMessage, CompressionResult, ModelAdapter } from './types.js'
import type { ContextStats } from './utils/token-estimator.js'
import type { SubAgentManager } from './agents/manager.js'
import { computeContextStats } from './utils/token-estimator.js'
import { manualCompact } from './compact/manual-compact.js'
import { snipCompactConversation } from './compact/snipCompact.js'
import {
  applyContextCollapseIfNeeded,
  createContextCollapseState,
  type ContextCollapseResult,
  type ContextCollapseState,
} from './compact/context-collapse.js'
import {
  createContentReplacementState,
  type ContentReplacementState,
} from './utils/tool-result-storage.js'

type TtyAppArgs = {
  runtime: RuntimeConfig | null        // 运行时配置（模型等）
  tools: ToolRegistry                  // 工具注册表，包含MCP服务
  model: ModelAdapter                  // LLM模型适配器
  subAgents: SubAgentManager           // 子Agent管理器
  messages: ChatMessage[]              // 底层对话消息数组（传给模型）
  cwd: string                          // 当前工作目录
  permissions: PermissionManager      // 权限管理器，用于工具审批弹窗
  contentReplacementState?: ContentReplacementState
  contextCollapseState?: ContextCollapseState
  sessionId: string                    // 当前会话ID
  alreadySavedCount: number            // 已经持久化保存的消息条数，用于增量保存
  resumeTarget?: string | 'picker'    // 启动时恢复会话：指定id或打开会话选择器
}

// 工具权限申请弹窗状态（选项、展开详情、滚动、反馈输入）
type PendingApproval = {
  request: PermissionRequest
  resolve: (result: PermissionPromptResult) => void
  detailsExpanded: boolean
  detailsScrollOffset: number
  selectedChoiceIndex: number
  feedbackMode: boolean
  feedbackInput: string
}

// 会话选择器，支持切换项目、删除会话
type SessionPicker = {
  sessions: SessionMeta[]
  selectedIndex: number
  resolve: (sessionId: string | null) => void
  deleteConfirmIndex: number | null
  allProjects: boolean
  projects: ProjectMeta[]
  projectSelectedIndex: number
}

// ASCII 兔子开场动画
type WelcomeAnimationMode = 'chew' | 'escape' | 'done'

type WelcomeAnimation = {
  entryId: number
  mode: WelcomeAnimationMode
  frameIndex: number
}

type ScreenState = {
  input: string;                // 输入框文本
  cursorOffset: number;         // 输入光标位置
  transcript: TranscriptEntry[] // 界面展示的对话记录（UI层，不等同底层messages）
  transcriptScrollOffset: number   // 已经向上滚动了多少行
  selectedSlashIndex: number    // / 斜杠命令下拉菜单选中项
  status: string | null         // 状态文本，例如 Thinking...
  activeTool: string | null     // 正在运行的工具
  recentTools: Array<{ name: string, status: 'success' | 'error' }>
  history: string[]             // 输入历史
  historyIndex: number          // 输入历史索引
  historyDraft: string          // 输入历史草稿，用来保存当前的输入
  nextEntryId: number           // transcript条目自增ID
  pendingApproval: PendingApproval | null  // 权限审批弹窗状态
  sessionPicker: SessionPicker | null      // 会话选择弹窗
  isBusy: boolean               // Agent正在执行（思考/跑工具），阻止新提交
  contextStats: ContextStats | null         // token统计
  compressionStatus: string | null          // 压缩提示文本
  statusAnimationFrame: number   //帧动画轮播索引
  inputHintFrame: number        // 轮询提示索引
  thinkingStartedAt: number | null
  selection: TranscriptSelection | null     // 鼠标选中文本
  mouseDown: { x: number; y: number } | null
  transcriptBodyStartY: number
  transcriptBodyLines: number
  welcomeAnimation: WelcomeAnimation | null // 开场兔子动画
}

type TranscriptEntryDraft =
  | Omit<Extract<TranscriptEntry, { kind: 'user' }>, 'id'>
  | Omit<Extract<TranscriptEntry, { kind: 'assistant' }>, 'id'>
  | Omit<Extract<TranscriptEntry, { kind: 'progress' }>, 'id'>
  | Omit<Extract<TranscriptEntry, { kind: 'tool' }>, 'id'>

export const WELCOME_CHEW_FRAMES = [
  String.raw`       (\__/)     
       (='.'=)    
       / >[cheese]`,
  String.raw`       (\__/)     
       (=-.-=)    
       / >[cheese]`,
  String.raw`       (\__/)     
       (='o'=)    
       / >>[heese]`,
  String.raw`       (\__/)    
       (='3'=) . 
       / >>[eese]`,
  String.raw`       (\__/)   
       (='o'=) .
       / >>[ese]`,
  String.raw`       (\__/)   
       (='3'=) *
       / >>[se] `,
  String.raw`       (\__/)   
       (='o'=) *
       / >>[e]  `,
  String.raw`       (\__/)   
       (=^.^=) *
       / >>[]   `,
  String.raw`       (\__/)   
       (=^.^=) *
       / >[]    `,
]

export const WELCOME_ESCAPE_FRAMES = [
  String.raw`       (\__/)   
       (='o'=) !
       / >[]    `,
  String.raw`       (\__/)    
       (='O'=) !!
       / \[]/    `,
  String.raw`       (\__/)  
      \(='O'=)/
        /  \   `,
  String.raw`       (\__/) 
       (='o'=)
      _/    \_`,
  String.raw`        \__/  
       (='o'=)
      _/    \_`,
  String.raw`        \_/   
       (='o'=)
      _/    \_`,
  String.raw`         _   
       _/ \_ 
      (_   _)`,
  String.raw`            
       _..-'
      '---. `,
  String.raw`        ... 
       .   .
            `,
  String.raw`         .  
            
            `,
  String.raw`            
            
            `,
]

const WELCOME_MESSAGE = 'Welcome back!~'

// 把时间戳转为人类可读相对时间
function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// 鼠标松开后保留文本选区对象
export function keepSelectionAfterMouseRelease(
  selection: TranscriptSelection | null,
): TranscriptSelection | null {
  return selection
}

// 聚合会话全局统计信息，用于顶部 Banner 展示
function getSessionStats(args: TtyAppArgs, state: ScreenState) {
  const mcpStatus = summarizeMcpServers(args.tools.getMcpServers())
  return {
    transcriptCount: state.transcript.length,
    messageCount: args.messages.length,
    skillCount: args.tools.getSkills().length,
    mcpTotalCount: mcpStatus.total,
    mcpConnectedCount: mcpStatus.connected,
    mcpConnectingCount: mcpStatus.connecting,
    mcpErrorCount: mcpStatus.error,
    contextStats: state.contextStats,
  }
}
// 将会话相关的全局信息渲染到顶部
function renderHeaderPanel(args: TtyAppArgs, state: ScreenState): string {
  return renderBanner(
    args.runtime,
    args.cwd,
    args.permissions.getSummary(),
    getSessionStats(args, state),
  )
}

// 渲染底部输入面板，包含输入框 + slash 命令下拉菜单
function renderPromptPanel(state: ScreenState): string {
  const commands = getVisibleCommands(state.input)
  const promptBody = [
    renderInputPrompt(state.input, state.cursorOffset, state.inputHintFrame),
    commands.length > 0
      ? `\n${renderSlashMenu(
        commands,
        Math.min(state.selectedSlashIndex, commands.length - 1),
      )}`
      : '',
  ].join('')
  return renderPanel('prompt', promptBody, { showTitle: false })
}

// 渲染权限摘要单行提示
function renderPermissionSummary(args: TtyAppArgs, state: ScreenState): string {
  return renderPermissionSummaryLine(
    args.permissions.getSummary(),
    state.inputHintFrame,
  )
}

// 设置全局状态栏文本。
function setStatus(state: ScreenState, status: string | null): void {
  state.status = status
  if (status === 'Thinking...') {
    state.thinkingStartedAt ??= Date.now()
  } else {
    state.thinkingStartedAt = null
  }
}

// 渲染底部状态栏文本
function renderFooterStatus(state: ScreenState): string {
  if (state.status === 'Thinking...') {
    const startedAt = state.thinkingStartedAt ?? Date.now()
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    return `\u001b[33m\u001b[1mThinking(${seconds}s)\u001b[0m`
  }
  return renderStatusLine(state.status, state.statusAnimationFrame)
}

// 动态计算转录日志区域可用行数，控制日志渲染窗口大小，实现终端自适应
function getTranscriptBodyLines(args: TtyAppArgs, state: ScreenState): number {
  const rows = Math.max(24, process.stdout.rows ?? 40)
  const headerLines = renderHeaderPanel(args, state).split('\n').length
  const permissionSummaryLines = renderPermissionSummary(args, state).split('\n').length
  const promptLines = renderPromptPanel(state).split('\n').length
  const footerLines = 1
  const gapsBetweenSections = 2
  const transcriptPanelFrameLines = 0
  const remaining =
    rows -
    headerLines -
    permissionSummaryLines -
    promptLines -
    footerLines -
    gapsBetweenSections -
    transcriptPanelFrameLines

  return Math.max(6, remaining)
}

// 计算日志面板最大滚动偏移量，防止滚动越界
function getMaxTranscriptScrollOffset(args: TtyAppArgs, state: ScreenState): number {
  return getTranscriptMaxScrollOffset(
    state.transcript,
    getTranscriptBodyLines(args, state),
  )
}

// 终端屏幕 Y 坐标 → transcript 日志绝对行索引转换
function screenToAbsoluteLineIndex(
  _args: TtyAppArgs,
  state: ScreenState,
  screenY: number,
): number {
  const bodyStartY = state.transcriptBodyStartY  //日志内容区域在整个屏幕上的起始 Y 坐标
  const bodyY = screenY - bodyStartY   //把全局屏幕 Y → 转换成日志面板内部的相对行号
  if (bodyY < 0) return -1   //点击位置在日志面板上方（标题栏区域），不属于日志内容，返回 -1（无效）

  const lines = renderTranscriptLines(state.transcript)   // 把所有会话条目渲染，拆成逻辑行数组
  const pageSize = getTranscriptWindowSize(state.transcriptBodyLines)  // 获取可视窗口行数（一页能显示多少行日志）
  const maxOffset = Math.max(0, lines.length - pageSize)  // 最大允许滚动偏移量
  const offset = Math.max(0, Math.min(state.transcriptScrollOffset, maxOffset))
  const end = lines.length - offset
  const start = Math.max(0, end - pageSize)  // 当前可视窗口，在全局日志中的起始绝对行号(随滚动变化）

  const lineIndex = start + bodyY
  if (lineIndex < 0) return -1
  if (lines.length === 0) return -1
  return Math.min(lineIndex, lines.length - 1)
}

// 跨平台剪贴板文本编码。Windows 剪贴板需要 UTF16-LE BOM 前缀；macOS/Linux 直接返回原字符串
export function encodeClipboardTextForPlatform(
  platform: NodeJS.Platform,
  text: string,
): string | Buffer {
  if (platform === 'win32') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  }
  return text
}

// 调用系统剪贴板命令复制文本：Windows `clip` / Mac `pbcopy` / Linux `xclip`
function copyToClipboard(text: string): void {
  try {
    const platform = process.platform
    const proc =
      platform === 'win32'
        ? spawn('clip', { stdio: ['pipe', 'inherit', 'inherit'] })
        : platform === 'darwin'
          ? spawn('pbcopy', { stdio: ['pipe', 'inherit', 'inherit'] })
          : spawn('xclip', ['-selection', 'clipboard'], {
            stdio: ['pipe', 'inherit', 'inherit'],
          })
    const payload = encodeClipboardTextForPlatform(platform, text)
    proc.stdin?.write(payload)
    proc.stdin?.end()
  } catch {
    // Silently fail if clipboard is unavailable
  }
}

// 日志面板相对滚动
// 返回 `true`：滚动发生；`false`：已到边界无变化
function scrollTranscriptBy(
  args: TtyAppArgs,
  state: ScreenState,
  delta: number,
): boolean {
  const nextOffset = Math.max(
    0,
    Math.min(
      getMaxTranscriptScrollOffset(args, state),
      state.transcriptScrollOffset + delta,
    ),
  )

  if (nextOffset === state.transcriptScrollOffset) {
    return false
  }

  state.transcriptScrollOffset = nextOffset
  return true
}

// 日志滚动跳转到顶部 / 底部。
function jumpTranscriptToEdge(
  args: TtyAppArgs,
  state: ScreenState,
  target: 'top' | 'bottom',
): boolean {
  const nextOffset =
    target === 'top' ? getMaxTranscriptScrollOffset(args, state) : 0
  if (nextOffset === state.transcriptScrollOffset) {
    return false
  }

  state.transcriptScrollOffset = nextOffset
  return true
}

// 权限审批弹窗详情面板最大滚动偏移
function getPendingApprovalMaxScrollOffset(state: ScreenState): number {
  const pending = state.pendingApproval
  if (!pending) return 0
  return getPermissionPromptMaxScrollOffset(pending.request, {
    expanded: pending.detailsExpanded,
  })
}

// 权限弹窗详情区域滚动；仅在详情展开时生效。返回是否滚动
function scrollPendingApprovalBy(state: ScreenState, delta: number): boolean {
  const pending = state.pendingApproval
  if (!pending || !pending.detailsExpanded) {
    return false
  }

  const maxOffset = getPendingApprovalMaxScrollOffset(state)
  const nextOffset = Math.max(
    0,
    Math.min(maxOffset, pending.detailsScrollOffset + delta),
  )
  if (nextOffset === pending.detailsScrollOffset) {
    return false
  }
  pending.detailsScrollOffset = nextOffset
  return true
}

// 切换权限审批弹窗详情展开 / 收起；仅编辑类权限请求支持。切换后重置滚动位置
function togglePendingApprovalExpand(state: ScreenState): boolean {
  const pending = state.pendingApproval
  if (!pending || pending.request.kind !== 'edit') {
    return false
  }
  pending.detailsExpanded = !pending.detailsExpanded
  pending.detailsScrollOffset = 0
  return true
}

// 权限弹窗选项上下切换选中项
function movePendingApprovalSelection(state: ScreenState, delta: number): boolean {
  const pending = state.pendingApproval
  if (!pending || pending.feedbackMode) {
    return false
  }
  const total = pending.request.choices.length
  if (total <= 0) return false
  pending.selectedChoiceIndex =
    (pending.selectedChoiceIndex + delta + total) % total
  return true
}

// 输入历史向上翻（Ctrl+P）
function historyUp(state: ScreenState): boolean {
  if (state.history.length === 0 || state.historyIndex <= 0) {
    return false
  }

  if (state.historyIndex === state.history.length) {
    state.historyDraft = state.input
  }

  state.historyIndex -= 1
  state.input = state.history[state.historyIndex] ?? ''
  state.cursorOffset = state.input.length
  return true
}

// 输入历史向下翻（Ctrl+N）
function historyDown(state: ScreenState): boolean {
  if (state.historyIndex >= state.history.length) {
    return false
  }

  state.historyIndex += 1
  state.input =
    state.historyIndex === state.history.length
      ? state.historyDraft
      : (state.history[state.historyIndex] ?? '')
  state.cursorOffset = state.input.length
  return true
}

// 解析输入框/开头的 slash 命令，获取候选下拉列表
function getVisibleCommands(input: string) {
  if (!input.startsWith('/')) return []
  if (input === '/') return SLASH_COMMANDS
  const matches = findMatchingSlashCommands(input)
  return SLASH_COMMANDS.filter(command => matches.includes(command.usage))
}

// 向 UI 日志 `transcript` 数组新增一条记录，自动分配自增 ID
function pushTranscriptEntry(
  state: ScreenState,
  entry: TranscriptEntryDraft,
): number {
  const id = state.nextEntryId++
  state.transcript.push({ id, ...entry })
  return id
}

// 兔子 ASCII 动画帧标准化：每行补齐空格，保证每一帧宽度一致，防止动画抖动
export function normalizeAsciiFrame(frame: string): string {
  const lines = frame.split('\n')
  const width = Math.max(...lines.map(line => line.length))
  return lines.map(line => line.padEnd(width, ' ')).join('\n')
}

// 拼接欢迎文字 + 标准化兔子 ASCII 帧，生成欢迎动画文本
export function renderWelcomeBody(frame: string): string {
  return `${WELCOME_MESSAGE}\n${normalizeAsciiFrame(frame)}`
}

// 找到指定 ID 的 assistant 类型日志条目，更新 body 内容
function updateAssistantEntryBody(
  state: ScreenState,
  entryId: number,
  body: string,
): void {
  const entry = state.transcript.find(
    item => item.id === entryId && item.kind === 'assistant',
  )
  if (!entry || entry.kind !== 'assistant') {
    return
  }
  entry.body = body
}

// 初始化欢迎兔子动画，往 transcript 插入 assistant 条目，初始化动画状态 `chew`（啃奶酪）
export function pushWelcomeAnimation(state: ScreenState): void {
  const entryId = pushTranscriptEntry(state, {
    kind: 'assistant',
    body: renderWelcomeBody(WELCOME_CHEW_FRAMES[0] ?? ''),
  })
  state.welcomeAnimation = {
    entryId,
    mode: 'chew',
    frameIndex: 0,
  }
}

// 切换兔子动画为 escape 逃跑模式；用户第一次提交输入时触发
export function startWelcomeEscapeAnimation(state: ScreenState): boolean {
  const animation = state.welcomeAnimation
  if (!animation || animation.mode === 'escape' || animation.mode === 'done') {
    return false
  }

  animation.mode = 'escape'
  animation.frameIndex = 0
  updateAssistantEntryBody(
    state,
    animation.entryId,
    renderWelcomeBody(WELCOME_ESCAPE_FRAMES[0] ?? ''),
  )
  return true
}

// 动画帧定时器回调：前进一帧
export function advanceWelcomeAnimation(state: ScreenState): boolean {
  const animation = state.welcomeAnimation
  if (!animation || animation.mode === 'done' || state.transcriptScrollOffset > 0) {
    return false
  }

  const frames =
    animation.mode === 'escape' ? WELCOME_ESCAPE_FRAMES : WELCOME_CHEW_FRAMES
  if (frames.length === 0) {
    animation.mode = 'done'
    return false
  }

  if (animation.mode === 'chew') {
    animation.frameIndex = (animation.frameIndex + 1) % frames.length
  } else if (animation.frameIndex < frames.length - 1) {
    animation.frameIndex += 1
  } else {
    state.welcomeAnimation = null
    return false
  }

  updateAssistantEntryBody(
    state,
    animation.entryId,
    renderWelcomeBody(frames[animation.frameIndex] ?? frames[0] ?? ''),
  )
  return true
}

// 更新 tool 类型 UI 日志条目：状态、内容；重置折叠标记。工具开始 / 结束时调用
function updateToolEntry(
  state: ScreenState,
  entryId: number,
  status: 'running' | 'success' | 'error',
  body: string,
): void {
  const entry = state.transcript.find(
    item => item.id === entryId && item.kind === 'tool',
  )

  if (!entry || entry.kind !== 'tool') {
    return
  }

  entry.status = status
  entry.body = body
  entry.collapsed = false
  entry.collapsedSummary = undefined
  entry.collapsePhase = undefined
}

// 工具执行完成后，将工具日志折叠，保存折叠摘要。running 状态工具不能折叠
function collapseToolEntry(
  state: ScreenState,
  entryId: number,
  summary: string,
): void {
  const entry = state.transcript.find(
    item => item.id === entryId && item.kind === 'tool',
  )
  if (!entry || entry.kind !== 'tool' || entry.status === 'running') {
    return
  }
  entry.collapsePhase = undefined
  entry.collapsed = true
  entry.collapsedSummary = summary
}

// 筛选所有状态为 `running` 的工具 UI 条目x`
function getRunningToolEntries(state: ScreenState): Array<Extract<TranscriptEntry, { kind: 'tool' }>> {
  return state.transcript.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> =>
      entry.kind === 'tool' && entry.status === 'running',
  )
}
// **清理孤立未结束工具**。Agent 一轮执行结束，还有标记 running 但没返回结果的工具，
// 统一标记 error，写入超时错误信息，更新最近工具列表
function finalizeDanglingRunningTools(state: ScreenState): void {
  const runningEntries = getRunningToolEntries(state)
  for (const entry of runningEntries) {
    entry.status = 'error'
    entry.body = `${entry.body}\n\nERROR: Tool did not report a final result before the turn ended. This usually means the command kept running in the background or the tool lifecycle got out of sync.`
    entry.collapsed = false
    entry.collapsedSummary = undefined
    entry.collapsePhase = undefined
    state.recentTools.push({
      name: entry.toolName,
      status: 'error',
    })
  }
  if (runningEntries.length > 0) {
    state.activeTool = null
    setStatus(state, `Previous turn ended with ${runningEntries.length} unfinished tool call(s).`)
  }
}

// 工具输出折叠摘要：取第一行非空文本，截断到 140 字符
function summarizeCollapsedToolBody(output: string): string {
  const line = output
    .split('\n')
    .map(item => item.trim())
    .find(Boolean)
  if (!line) {
    return 'output collapsed'
  }
  if (line.length > 140) {
    return `${line.slice(0, 140)}...`
  }
  return line
}

// 通用文本截断函数，超长文本末尾追加 `...`
function truncateForDisplay(text: string, max = 180): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

// **工具入参摘要**，针对内置工具做定制格式化
function summarizeToolInput(toolName: string, input: unknown): string {
  if (typeof input === 'string') {
    return truncateForDisplay(input.replace(/\s+/g, ' ').trim())
  }

  if (typeof input === 'object' && input !== null) {
    const maybePath = (input as { path?: unknown }).path
    const pathPart =
      typeof maybePath === 'string' && maybePath.trim()
        ? ` path=${maybePath}`
        : ''

    if (toolName === 'patch_file') {
      const count = Array.isArray((input as { replacements?: unknown }).replacements)
        ? (input as { replacements: unknown[] }).replacements.length
        : 0
      return `patch_file${pathPart} replacements=${count}`
    }

    if (toolName === 'edit_file') {
      return `edit_file${pathPart}`
    }

    if (toolName === 'read_file') {
      const offset = (input as { offset?: unknown }).offset
      const limit = (input as { limit?: unknown }).limit
      return `read_file${pathPart}${offset !== undefined ? ` offset=${String(offset)}` : ''}${limit !== undefined ? ` limit=${String(limit)}` : ''}`
    }

    if (toolName === 'run_command') {
      const command = (input as { command?: unknown }).command
      return `run_command${typeof command === 'string' ? ` ${truncateForDisplay(command, 120)}` : ''}`
    }
  }

  try {
    return truncateForDisplay(JSON.stringify(input))
  } catch {
    return truncateForDisplay(String(input))
  }
}

type AggregatedEditProgress = {
  entryId: number
  toolName: string
  path: string
  total: number
  completed: number
  errors: number
  lastOutput: string
}

// 判断工具是否属于文件编辑类
function isFileEditTool(toolName: string): boolean {
  return (
    toolName === 'edit_file' ||
    toolName === 'patch_file' ||
    toolName === 'modify_file' ||
    toolName === 'write_file'
  )
}

// 从工具入参对象提取 `path` 字符串,文件编辑工具用来聚合同文件操作
function extractPathFromToolInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }
  if (!('path' in input)) {
    return null
  }
  const value = (input as { path?: unknown }).path
  return typeof value === 'string' && value.trim() ? value : null
}

function renderScreen(args: TtyAppArgs, state: ScreenState): void {
  // 读取后台任务列表（正在运行的工具、子任务），用于底部状态栏展示 
  const backgroundTasks = listBackgroundTasks()
  // **屏幕缓冲区**，按行收集所有 UI 文本，最后用 `join('\n')` 拼成完整屏幕字符串
  const frame: string[] = []
  // 渲染顶部标题 / 状态栏面板，加入缓冲区，追加空行做间距
  const headerPanel = renderHeaderPanel(args, state)
  frame.push(headerPanel)
  frame.push('')
  // 记录对话记录区域在终端里的起始行号
  state.transcriptBodyStartY = headerPanel.split('\n').length + 4
  state.transcriptBodyLines = getTranscriptBodyLines(args, state)

  // 权限确认弹窗界面
  if (state.pendingApproval) {
    // 渲染权限审批面板
    frame.push(
      renderPanel('approval', renderPermissionPrompt(state.pendingApproval.request, {
        expanded: state.pendingApproval.detailsExpanded,
        scrollOffset: state.pendingApproval.detailsScrollOffset,
        selectedChoiceIndex: state.pendingApproval.selectedChoiceIndex,
        feedbackMode: state.pendingApproval.feedbackMode,
        feedbackInput: state.pendingApproval.feedbackInput,
      })),
    )
    frame.push('')
    // 活动面板，展示当前运行工具、最近工具、后台任务
    frame.push(renderPanel('activity', renderToolPanel(state.activeTool, state.recentTools, backgroundTasks)))
    frame.push('')
    // 底部状态栏
    frame.push(
      renderFooterBar(
        state.status,
        true,
        args.tools.getSkills().length > 0,
        summarizeMcpServers(args.tools.getMcpServers()),
        backgroundTasks,
        state.compressionStatus,
        state.statusAnimationFrame,
        undefined,
        renderSubAgentFooter(args.subAgents),
      ),
    )
    renderTerminalFrame(frame.join('\n'))
    return
  }
  // 会话选择器
  if (state.sessionPicker) {
    if (state.sessionPicker.allProjects) {
      const projects = state.sessionPicker.projects
      const lines = projects.map((p, i) => {
        const marker = i === state.sessionPicker!.projectSelectedIndex ? ' > ' : '   '
        const ago = formatRelativeTime(p.latestUpdatedAt)
        return `${marker}${p.dir}  ${p.sessionCount} sessions  ${ago}`
      })
      const body = `All projects:\n\n${lines.join('\n')}\n\nEnter to see info, Tab to go back, Esc to cancel`
      frame.push(renderPanel('projects', body))
    } else {
      const lines = state.sessionPicker.sessions.map((s, i) => {
        const marker = i === state.sessionPicker!.selectedIndex ? ' > ' : '   '
        const title = s.title ? `  ${s.title}` : ''
        const ago = formatRelativeTime(s.updatedAt)
        const deleteTag = state.sessionPicker!.deleteConfirmIndex === i ? '  [DELETE? Press d again to confirm]' : ''
        return `${marker}${s.id}${title}  ${s.messageCount} messages  ${ago}${deleteTag}`
      })
      const body = `Select a session to resume:\n\n${lines.join('\n')}\n\n↑/↓ to select, Enter to resume, d to delete, Tab for all projects, Esc to cancel`
      frame.push(renderPanel('sessions', body))
    }
    frame.push('')
    frame.push(
      renderFooterBar(
        state.status,
        true,
        args.tools.getSkills().length > 0,
        summarizeMcpServers(args.tools.getMcpServers()),
        backgroundTasks,
        state.compressionStatus,
        state.statusAnimationFrame,
        undefined,
        renderSubAgentFooter(args.subAgents),
      ),
    )
    renderTerminalFrame(frame.join('\n'))
    return
  }
  // 默认主界面
  // 对话记录面板 + 权限摘要 + 输入面板 + 底部状态栏
  frame.push(
    renderPanel(
      'session feed',
      state.transcript.length > 0
        ? renderTranscript(
          state.transcript,
          state.transcriptScrollOffset,
          getTranscriptBodyLines(args, state),
          state.selection ?? undefined,
        )
        : '',
      {
        minBodyLines: getTranscriptBodyLines(args, state),
        frame: false,
      },
    ),
  )
  frame.push(renderPermissionSummary(args, state))
  frame.push(renderPromptPanel(state))
  frame.push(
    renderFooterBar(
      state.status,
      true,
      args.tools.getSkills().length > 0,
      summarizeMcpServers(args.tools.getMcpServers()),
      backgroundTasks,
      state.compressionStatus,
      state.statusAnimationFrame,
      renderFooterStatus(state),
      renderSubAgentFooter(args.subAgents),
    ),
  )
  renderTerminalFrame(frame.join('\n'))
}
// 子 Agent 状态底部提示；有运行子 Agent 时返回紫色提示文字，无则返回 undefined
function renderSubAgentFooter(manager: SubAgentManager): string | undefined {
  if (manager.runningCount === 0) return undefined
  return `\x1b[1m\x1b[35m● SUB-AGENTS ${manager.runningCount}/${manager.maxConcurrent} RUNNING\x1b[0m`
}

// 渲染防抖调度器, 短时间多次调用 `scheduleRender`，只会排队执行一次 `renderNow`，避免高频重绘刷屏
function createRenderScheduler(renderNow: () => void): () => void {
  let scheduled: NodeJS.Immediate | null = null

  return () => {
    if (scheduled) return

    scheduled = setImmediate(() => {
      scheduled = null
      renderNow()
    })
  }
}

// 重新构建并替换 messages 数组第 0 条 system 提示词
async function refreshSystemPrompt(args: TtyAppArgs): Promise<void> {
  args.messages[0] = {
    role: 'system',
    content: await buildSystemPrompt(args.cwd, args.permissions.getSummary(), {
      skills: args.tools.getSkills(),
      mcpServers: args.tools.getMcpServers(),
      subAgents: { maxConcurrent: args.subAgents.maxConcurrent },
    }),
  }
}

// compact 压缩完成后，过滤得到保留消息，剔除 system 消息和 summary 消息，用于持久化边界记录
function retainedMessagesAfterCompact(result: CompressionResult): ChatMessage[] {
  return result.messages.filter(message => (
    message.role !== 'system' && message !== result.summary
  ))
}

// 持久化 context-collapse（上下文折叠）的 span 记录到会话文件；统计本次压缩节省 token 总量并返回
async function persistContextCollapseResult(
  args: TtyAppArgs,
  result: ContextCollapseResult,
): Promise<number> {
  const spans = result.spans.length > 0
    ? result.spans
    : result.span
      ? [result.span]
      : []

  for (const span of spans) {
    await appendContextCollapseSpan(args.cwd, args.sessionId, span)
  }

  return spans.reduce(
    (sum, span) => sum + Math.max(0, span.tokensBefore - span.tokensAfter),
    0,
  )
}

// 执行本地工具快捷指令
async function executeToolShortcut(
  args: TtyAppArgs,
  state: ScreenState,
  toolName: string,
  input: unknown,
  rerender: () => void,
): Promise<void> {
  state.isBusy = true
  setStatus(state, `Running ${toolName}...`)
  state.activeTool = toolName
  const entryId = pushTranscriptEntry(state, {
    kind: 'tool',
    toolName,
    status: 'running',
    body: summarizeToolInput(toolName, input),
  })
  rerender()

  try {
    const result = await args.tools.execute(toolName, input, {
      cwd: args.cwd,
      permissions: args.permissions,
    })

    state.recentTools.push({
      name: toolName,
      status: result.ok ? 'success' : 'error',
    })
    updateToolEntry(
      state,
      entryId,
      result.ok ? 'success' : 'error',
      result.ok ? result.output : `ERROR: ${result.output}`,
    )
    collapseToolEntry(
      state,
      entryId,
      summarizeCollapsedToolBody(
        result.ok ? result.output : `ERROR: ${result.output}`,
      ),
    )
    state.transcriptScrollOffset = 0
  } finally {
    state.isBusy = false
    state.activeTool = null
    finalizeDanglingRunningTools(state)
    if (getRunningToolEntries(state).length === 0) {
      setStatus(state, null)
    }
  }
}

// 恢复会话
async function resumeSession(
  args: TtyAppArgs,
  state: ScreenState,
  sessionId: string,
  loaded: ChatMessage[],
): Promise<void> {
  args.sessionId = sessionId
  await refreshSystemPrompt(args)
  const systemContent =
    args.messages[0]?.role === 'system' ? args.messages[0].content : ''
  args.messages.length = 0
  args.messages.push({ role: 'system', content: systemContent })
  args.messages.push(...loaded)
  state.transcript = []

  // 从保存的会话文件中构建
  const persistedTranscript = await loadTranscript(args.cwd, sessionId)
  if (persistedTranscript && persistedTranscript.length > 0) {
    for (const entry of persistedTranscript) {
      pushTranscriptEntry(state, entry)
    }
  } else {
    // 从历史对话消息中构建
    for (const msg of loaded) {
      if (msg.role === 'user') {
        pushTranscriptEntry(state, { kind: 'user', body: msg.content })
      } else if (msg.role === 'assistant') {
        pushTranscriptEntry(state, { kind: 'assistant', body: msg.content })
      } else if (msg.role === 'assistant_tool_call') {
        pushTranscriptEntry(state, {
          kind: 'tool',
          toolName: msg.toolName,
          status: 'success',
          body: summarizeToolInput(msg.toolName, msg.input),
        })
      } else if (msg.role === 'context_summary') {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `[Context summary: ${msg.compressedCount} messages compressed]`,
        })
      } else if (msg.role === 'snip_boundary') {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Snipped earlier context: removed ${msg.removedCount} messages, freed ~${Math.round(msg.tokensFreed)} tokens.`,
        })
      }
    }
  }
  pushTranscriptEntry(state, {
    kind: 'assistant',
    body: `Session ${sessionId} resumed (${loaded.length} messages loaded).`,
  })
  args.alreadySavedCount = loaded.length
  args.contextCollapseState =
    await loadContextCollapseState(args.cwd, sessionId) ??
    createContextCollapseState()
  state.transcriptScrollOffset = 0
}

async function handleInput(
  args: TtyAppArgs,                  // 运行时上下文（会被深度修改）
  state: ScreenState,                // UI 状态（会被深度修改）
  rerender: () => void,              // 防抖重绘（即 runTtyApp 里的 scheduleRender）
  submittedRawInput?: string,        // 可选：直接传入的输入（绕过 state.input）
): Promise<boolean> {

  // 回合进行中拒绝一切新输入，只刷新状态栏提示
  if (state.isBusy) {
    setStatus(
      state,
      state.activeTool
        ? `Running ${state.activeTool}...`
        : 'Current turn is still running...',
    )
    return false
  }

  const input = (submittedRawInput ?? state.input).trim()
  if (!input) return false
  if (input === '/exit') return true

  // 手动上下文折叠
  if (input === '/collapse') {
    const model = args.runtime?.model ?? ''
    if (!model) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'No model configured. Cannot collapse context.',
      })
      return false
    }

    state.isBusy = true
    setStatus(state, 'Collapsing context...')
    state.compressionStatus = 'collapsing...'
    rerender()
    try {
      const result = await applyContextCollapseIfNeeded(
        args.messages,
        model,
        args.model,
        args.contextCollapseState ?? createContextCollapseState(),
        {
          utilizationThreshold: 0,
          reason: 'manual',
        },
      )
      args.contextCollapseState = result.state
      state.contextStats = computeContextStats(result.messages, model)
      // 成功压缩
      if (result.collapsed) {
        const savedTokens = await persistContextCollapseResult(args, result)
        const spanCount = result.spans.length
        state.compressionStatus = `collapse saved ~${Math.round(savedTokens)} tokens`
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Context collapse projected ${spanCount} span${spanCount === 1 ? '' : 's'} into model-visible summaries. Original transcript is preserved.`,
        })
      } else {
        // 无需压缩或者不准压缩
        state.compressionStatus = result.state.enabled ? 'nothing safe to collapse' : 'collapse disabled'
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: result.state.enabled
            ? 'Nothing safe to collapse.'
            : 'Context collapse is disabled after repeated summary failures.',
        })
      }
    } catch (error) {
      // 压缩异常
      state.compressionStatus = null
      const message = error instanceof Error ? error.message : String(error)
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Context collapse failed: ${message}`,
      })
    } finally {
      state.isBusy = false
      setStatus(state, null)
      state.transcriptScrollOffset = 0
      setTimeout(() => {
        state.compressionStatus = null
        rerender()
      }, 5000)
    }
    return false
  }

  // /snip: deterministic middle-context removal without calling the model
  if (input === '/snip') {
    const model = args.runtime?.model ?? ''
    const stats = computeContextStats(args.messages, model)
    const result = await snipCompactConversation({
      messages: args.messages,
      contextStats: stats,
      modelContextWindow: stats.effectiveInput,
    })

    if (!result.didSnip || result.boundaryMessage?.role !== 'snip_boundary') {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'Nothing safe to snip.',
      })
      return false
    }

    await appendSnipBoundary(args.cwd, args.sessionId, result.boundaryMessage)
    args.messages.length = 0
    args.messages.push(...result.messages)
    args.alreadySavedCount = 0
    args.contextCollapseState = createContextCollapseState()
    state.contextStats = computeContextStats(args.messages, model)
    state.compressionStatus = `snip saved ~${Math.round(result.tokensFreed)} tokens`
    state.transcriptScrollOffset = 0
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: `Snipped earlier context: removed ${result.removedMessageIds.length} messages, freed ~${Math.round(result.tokensFreed)} tokens.`,
    })
    setTimeout(() => {
      state.compressionStatus = null
      rerender()
    }, 5000)
    return false
  }

  // /compact: manual context compression
  if (input === '/compact') {
    if (args.messages.length <= 2) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'Not enough conversation to compress.',
      })
      return false
    }
    const model = args.runtime?.model ?? ''
    if (!model) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'No model configured. Cannot compress.',
      })
      return false
    }
    state.isBusy = true
    setStatus(state, 'Compressing context...')
    state.compressionStatus = 'compressing...'
    rerender()
    try {
      const result = await manualCompact(args.messages, args.model)
      if (result) {
        const summaryText = typeof result.summary.content === 'string' ? result.summary.content : ''
        await appendCompactBoundary(
          args.cwd,
          args.sessionId,
          summaryText,
          'manual',
          result.tokensBefore,
          result.tokensAfter,
          retainedMessagesAfterCompact(result),
        )
        args.messages.length = 0
        args.messages.push(...result.messages)
        args.alreadySavedCount = args.messages.length - 1
        args.contextCollapseState = createContextCollapseState()
        const savedPct = Math.round((1 - result.tokensAfter / result.tokensBefore) * 100)
        const savedTokens = result.tokensBefore - result.tokensAfter
        state.compressionStatus = `ctx -${savedPct}% (saved ${savedTokens >= 1000 ? `${Math.round(savedTokens / 1000)}K` : savedTokens} tokens)`
        state.contextStats = computeContextStats(args.messages, model)
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Context compressed: ${result.removedCount} messages summarized. ${savedPct}% reduction (${savedTokens >= 1000 ? `${Math.round(savedTokens / 1000)}K` : savedTokens} tokens saved).`,
        })
      } else {
        state.compressionStatus = 'compression failed'
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: 'Could not compress further. The conversation may already be minimal.',
        })
      }
    } catch (error) {
      state.compressionStatus = null
      const message = error instanceof Error ? error.message : String(error)
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Compression failed: ${message}`,
      })
    } finally {
      state.isBusy = false
      setStatus(state, null)
      state.transcriptScrollOffset = 0
      // Clear compression status after a delay (will be reset on next render cycle)
      setTimeout(() => {
        state.compressionStatus = null
        rerender()
      }, 5000)
    }
    return false
  }

  if (input.startsWith('/rename ')) {
    const newName = input.slice('/rename '.length).trim()
    if (!newName) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'Usage: /rename <name>',
      })
      return false
    }
    const ok = await renameSession(args.cwd, args.sessionId, newName)
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: ok ? `Session renamed to "${newName}".` : 'No active session to rename.',
    })
    return false
  }

  if (input === '/resume' || input.startsWith('/resume ')) {
    const sessionIdArg = input.startsWith('/resume ') ? input.slice('/resume '.length).trim() : ''
    // 未携带session id
    if (!sessionIdArg) {
      // 列出当前项目会话
      const sessions = await listSessions(args.cwd)
      if (sessions.length === 0) {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: 'No saved sessions for this project.',
        })
        return false
      }
      // 异步挂起,渲染选择器界面
      const selectedId = await new Promise<string | null>(resolve => {
        state.sessionPicker = {
          sessions,
          selectedIndex: 0,
          resolve,
          deleteConfirmIndex: null,
          allProjects: false,
          projects: [],
          projectSelectedIndex: 0,
        }
        setStatus(state, 'Select a session to resume')
        rerender()
      })
      // 选择完毕之后,清掉 picker、恢复状态栏
      state.sessionPicker = null
      setStatus(state, null)
      rerender()

      if (!selectedId) return false

      const loaded = await loadSession(args.cwd, selectedId)
      if (!loaded || loaded.length === 0) {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Session ${selectedId} not found.`,
        })
        return false
      }
      await resumeSession(args, state, selectedId, loaded)
      return false
    }

    // resume直接给出了ID
    const loaded = await loadSession(args.cwd, sessionIdArg)
    if (!loaded || loaded.length === 0) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Session ${sessionIdArg} not found.`,
      })
      return false
    }
    await resumeSession(args, state, sessionIdArg, loaded)
    return false
  }

  if (input === '/new') {
    args.sessionId = crypto.randomUUID().slice(0, 8)
    args.alreadySavedCount = 0
    args.contextCollapseState = createContextCollapseState()
    state.transcript = []
    args.messages.length = 0
    await refreshSystemPrompt(args)
    state.transcriptScrollOffset = 0
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: 'Session cleared. Starting fresh.',
    })
    return false
  }

  if (input === '/fork') {
    const newId = await forkSession(args.cwd, args.sessionId)
    if (!newId) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'No current session to fork.',
      })
      return false
    }
    args.sessionId = newId
    args.alreadySavedCount = args.messages.length - 1
    args.contextCollapseState = createContextCollapseState()
    state.transcriptScrollOffset = 0
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: `Session forked. Now in session ${newId}. Original session preserved.`,
    })
    return false
  }
  // 历史消息入栈
  if (state.history.at(-1) !== input) {
    state.history.push(input)
    await saveHistoryEntries(state.history, args.cwd, args.sessionId)
  }
  state.historyIndex = state.history.length
  state.historyDraft = ''

  if (input === '/tools') {
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: args.tools
        .list()
        .map(tool => `${tool.name}: ${tool.description}`)
        .join('\n'),
    })
    return false
  }

  const localCommandResult = await tryHandleLocalCommand(input, {
    cwd: args.cwd,
    tools: args.tools,
    permissionSummary: args.permissions.getSummary(),
  })
  if (localCommandResult !== null) {
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: localCommandResult,
    })
    return false
  }

  const toolShortcut = parseLocalToolShortcut(input)
  if (toolShortcut) {
    await executeToolShortcut(
      args,
      state,
      toolShortcut.toolName,
      toolShortcut.input,
      rerender,
    )
    return false
  }

  if (input.startsWith('/')) {
    const matches = findMatchingSlashCommands(input)
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body:
        matches.length > 0
          ? `未识别命令。你是不是想输入：\n${matches.join('\n')}`
          : '未识别命令。输入 /help 查看可用命令。',
    })
    return false
  }

  await refreshSystemPrompt(args)            // ① 用最新权限/技能/MCP重建 system
  args.messages.push({ role: 'user', content: input })   // ② 底层轨道
  pushTranscriptEntry(state, { kind: 'user', body: input }) // ③ UI 轨道（双轨写入）
  state.transcriptScrollOffset = 0           // ④ 滚动贴底
  startWelcomeEscapeAnimation(state)         // ⑤ 兔子被吓跑
  setStatus(state, 'Thinking...')            // ⑥ 状态栏（同时记录计时起点）
  state.isBusy = true                        // ⑦ 锁输入
  rerender()

  const pendingToolEntries = new Map<string, number[]>()   // 同名工具的多个调用按开始顺序排队
  const aggregatedEditByKey = new Map<string, AggregatedEditProgress>()  // 同文件编辑工具的聚合索引
  const aggregatedEditByEntryId = new Map<number, AggregatedEditProgress>()
  const turnStartedAt = Date.now()

  args.permissions.beginTurn()
  try {
    const nextMessages = await runAgentTurn({
      model: args.model,
      tools: args.tools,
      messages: args.messages,
      cwd: args.cwd,
      permissions: args.permissions,
      modelName: args.runtime?.model ?? '',
      contentReplacementState: args.contentReplacementState,
      contextCollapseState: args.contextCollapseState,
      // 模型往返后更新 token 统计 + 重绘
      onContextStats(stats) {
        state.contextStats = stats
        rerender()
      },
      // 回合内自动压缩触发
      async onAutoCompact(result) {
        const savedPct = Math.round((1 - result.tokensAfter / result.tokensBefore) * 100)
        const savedTokens = result.tokensBefore - result.tokensAfter
        state.compressionStatus = `ctx -${savedPct}% (saved ${savedTokens >= 1000 ? `${Math.round(savedTokens / 1000)}K` : savedTokens} tokens)`
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Context auto-compressed: ${result.removedCount} messages summarized.`,
        })
        const summaryText = typeof result.summary.content === 'string' ? result.summary.content : ''
        await appendCompactBoundary(
          args.cwd,
          args.sessionId,
          summaryText,
          'auto',
          result.tokensBefore,
          result.tokensAfter,
          retainedMessagesAfterCompact(result),
        )
        args.alreadySavedCount = result.messages.length - 1
        state.transcriptScrollOffset = 0
        setTimeout(() => {
          state.compressionStatus = null
          rerender()
        }, 5000)
      },
      // 自动折叠成功
      async onContextCollapse(result) {
        if (result.collapsed) {
          const savedTokens = await persistContextCollapseResult(args, result)
          state.compressionStatus = `collapse saved ~${Math.round(savedTokens)} tokens`
          rerender()
          setTimeout(() => {
            state.compressionStatus = null
            rerender()
          }, 5000)
        }
      },
      // 自动 snip 触发
      async onSnipCompact(result) {
        if (result.boundaryMessage?.role === 'snip_boundary') {
          await appendSnipBoundary(args.cwd, args.sessionId, result.boundaryMessage)
        }
        args.alreadySavedCount = 0
        state.compressionStatus = `snip saved ~${Math.round(result.tokensFreed)} tokens`
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Snipped earlier context: removed ${result.removedMessageIds.length} messages, freed ~${Math.round(result.tokensFreed)} tokens.`,
        })
        state.transcriptScrollOffset = 0
        setTimeout(() => {
          state.compressionStatus = null
          rerender()
        }, 5000)
      },
      // 推 assistant 条目
      onAssistantMessage(content, metadata) {
        const workedForSeconds = metadata?.final
          ? Math.max(0, Math.floor((Date.now() - turnStartedAt) / 1000))
          : undefined
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: content,
          ...(workedForSeconds === undefined ? {} : { workedForSeconds }),
        })
        state.transcriptScrollOffset = 0
        rerender()
      },
      //  推 progress 类型条目
      onProgressMessage(content) {
        pushTranscriptEntry(state, {
          kind: 'progress',
          body: content,
        })
        state.transcriptScrollOffset = 0
        rerender()
      },

      // setStatus('Running <tool>...'), activeTool = toolName
      //  ├─ 是文件编辑工具 && 入参有 path？
      //  │    ├─ 是：key = `${toolName}:${path}`
      //  │    │    ├─ key 已存在 → 复用条目：total+1，更新 lastOutput，
      //  │    │    │   body 改为 "Aggregated ... Completed: n/total"
      //  │    │    └─ 新 key → pushTranscriptEntry 新工具条目 + 建进度对象
      //  │    │        （登记进 aggregatedEditByKey 和 aggregatedEditByEntryId）
      //  │    └─ 否：pushTranscriptEntry 普通工具条目（body = 入参摘要）
      //  └─ entryId 入队 pendingToolEntries[toolName]，贴底重绘
      onToolStart(toolName, toolInput) {
        setStatus(state, `Running ${toolName}...`)
        state.activeTool = toolName
        let entryId: number
        const targetPath = extractPathFromToolInput(toolInput)
        // 聚合效果
        // 模型对同一个文件连续 edit_file 十次，UI 上只有一个条目在原地刷新 Completed: 3/10，而不是十条记录刷屏
        const canAggregate = isFileEditTool(toolName) && targetPath !== null

        if (canAggregate) {
          const key = `${toolName}:${targetPath}`
          const existing = aggregatedEditByKey.get(key)
          if (existing) {
            existing.total += 1
            existing.lastOutput = summarizeToolInput(toolName, toolInput)
            entryId = existing.entryId
            updateToolEntry(
              state,
              entryId,
              existing.errors > 0 ? 'error' : 'running',
              `Aggregated ${toolName} for ${targetPath}\nCompleted: ${existing.completed}/${existing.total}`,
            )
          } else {
            entryId = pushTranscriptEntry(state, {
              kind: 'tool',
              toolName,
              status: 'running',
              body: summarizeToolInput(toolName, toolInput),
            })
            const progress: AggregatedEditProgress = {
              entryId,
              toolName,
              path: targetPath,
              total: 1,
              completed: 0,
              errors: 0,
              lastOutput: summarizeToolInput(toolName, toolInput),
            }
            aggregatedEditByKey.set(key, progress)
            aggregatedEditByEntryId.set(entryId, progress)
          }
        } else {
          entryId = pushTranscriptEntry(state, {
            kind: 'tool',
            toolName,
            status: 'running',
            body: summarizeToolInput(toolName, toolInput),
          })
        }
        // 同一个工具运行顺序列表
        const pending = pendingToolEntries.get(toolName) ?? []
        pending.push(entryId)
        pendingToolEntries.set(toolName, pending)
        state.transcriptScrollOffset = 0
        rerender()
      },
      onToolResult(toolName, output, isError) {
        // 运行完毕后，从列表中删除
        const pending = pendingToolEntries.get(toolName) ?? []
        const entryId = pending.shift()
        pendingToolEntries.set(toolName, pending)
        if (entryId !== undefined) {
          const aggregated = aggregatedEditByEntryId.get(entryId)
          if (aggregated && aggregated.toolName === toolName) {
            aggregated.completed += 1
            if (isError) {
              aggregated.errors += 1
            }
            aggregated.lastOutput = output
            const done = aggregated.completed >= aggregated.total
            if (done) {
              state.recentTools.push({
                name: `${toolName} x${aggregated.total}`,
                status: aggregated.errors > 0 ? 'error' : 'success',
              })
            }
            const aggregatedBody = done
              ? [
                `Aggregated ${toolName} for ${aggregated.path}`,
                `Operations: ${aggregated.total}, errors: ${aggregated.errors}`,
                `Last result: ${aggregated.lastOutput}`,
              ].join('\n')
              : `Aggregated ${toolName} for ${aggregated.path}\nCompleted: ${aggregated.completed}/${aggregated.total}`
            updateToolEntry(
              state,
              entryId,
              aggregated.errors > 0 ? 'error' : done ? 'success' : 'running',
              aggregatedBody,
            )
            if (done) {
              collapseToolEntry(
                state,
                entryId,
                summarizeCollapsedToolBody(aggregatedBody),
              )
              aggregatedEditByEntryId.delete(entryId)
              aggregatedEditByKey.delete(`${toolName}:${aggregated.path}`)
            }
          } else {
            state.recentTools.push({
              name: toolName,
              status: isError ? 'error' : 'success',
            })
            updateToolEntry(
              state,
              entryId,
              isError ? 'error' : 'success',
              isError ? `ERROR: ${output}` : output,
            )
            collapseToolEntry(
              state,
              entryId,
              summarizeCollapsedToolBody(
                isError ? `ERROR: ${output}` : output,
              ),
            )
          }
        } else {
          state.recentTools.push({
            name: toolName,
            status: isError ? 'error' : 'success',
          })
        }
        state.activeTool = null
        setStatus(state, 'Thinking...')
        rerender()
      },
    })
    args.messages.length = 0
    args.messages.push(...nextMessages)
    await saveSession(args.cwd, args.sessionId, args.messages, args.alreadySavedCount)
    args.alreadySavedCount = args.messages.length - 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    args.messages.push({
      role: 'assistant',
      content: `请求失败: ${message}`,
    })
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: `请求失败: ${message}`,
    })
    state.transcriptScrollOffset = 0
  } finally {
    args.permissions.endTurn()
    state.isBusy = false
  }

  finalizeDanglingRunningTools(state)
  if (getRunningToolEntries(state).length === 0) {
    setStatus(state, null)
  }
  return false
}

function createPermissionPromptHandler(
  state: ScreenState,
  rerender: () => void,
): (request: PermissionRequest) => Promise<PermissionPromptResult> {
  return request =>
    new Promise(resolve => {
      state.pendingApproval = {
        request,
        resolve,
        detailsExpanded: false,
        detailsScrollOffset: 0,
        selectedChoiceIndex: 0,
        feedbackMode: false,
        feedbackInput: '',
      }
      setStatus(state, 'Waiting for approval...')
      rerender()
    })
}

export async function runTtyApp(args: TtyAppArgs): Promise<void> {
  enterAlternateScreen()  // 切到备用屏幕
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)   //程序拿到每个原始字节 
  }
  hideCursor()

  const state: ScreenState = {
    input: '',
    cursorOffset: 0,
    transcript: [],
    transcriptScrollOffset: 0,
    selectedSlashIndex: 0,
    status: null,
    activeTool: null,
    recentTools: [],
    history: await loadHistoryEntries(),
    historyIndex: 0,
    historyDraft: '',
    nextEntryId: 1,
    pendingApproval: null,
    sessionPicker: null,
    isBusy: false,
    contextStats: null,
    compressionStatus: null,
    statusAnimationFrame: 0,
    inputHintFrame: 0,
    thinkingStartedAt: null,
    selection: null,
    mouseDown: null,
    transcriptBodyStartY: 0,
    transcriptBodyLines: 20,
    welcomeAnimation: null,
  }
  state.historyIndex = state.history.length

  const permissionArgs: TtyAppArgs = {
    ...args,
    contentReplacementState:
      args.contentReplacementState ?? createContentReplacementState(),
    contextCollapseState:
      args.contextCollapseState ?? createContextCollapseState(),
    permissions: new PermissionManager(
      args.cwd,
      createPermissionPromptHandler(state, () => scheduleRender()),
    ),
  }
  const renderNow = () => renderScreen(permissionArgs, state)   // 唯一的渲染入口
  let scheduleRender = renderNow                                 // 先指向直绘版
  scheduleRender = createRenderScheduler(renderNow)              // 再覆盖为防抖版
  // 把 scheduleRender 注册进子 Agent 管理器的监听器集合，子 Agent 状态一变就自动重绘
  const unsubscribeSubAgents = permissionArgs.subAgents.subscribe(scheduleRender)
  // 等权限规则从磁盘读完——保证第一个工具执行前“永久允许/拒绝”规则已生效，不会误弹窗
  await permissionArgs.permissions.whenReady()
  if (
    permissionArgs.messages.length === 0 ||
    permissionArgs.messages[0]?.role !== 'system'
  ) {
    await refreshSystemPrompt(permissionArgs)
  }
  // 插入啃奶酪的 ASCII 兔子
  pushWelcomeAnimation(state)

  // 检测到项目记忆文件（如 AGENTS.md）则在 transcript 里列出路径、行数、首行预览
  const memoryFiles = await discoverInstructionFiles(args.cwd)
  if (memoryFiles.length > 0) {
    const lines = [
      `Memory: ${memoryFiles.length} instruction file(s) loaded`,
      ...memoryFiles.map((f, i) => {
        const lineCount = f.content.split('\n').length
        const preview = f.content.trim().split('\n')[0] || '<empty>'
        return `  ${i + 1}. ${f.path}\n     lines=${lineCount} preview=${preview}`
      }),
    ]
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: lines.join('\n'),
    })
  }
  // 对应 CLI 的三种启动方式
  let deferredResumeInput: string | null = null
  if (permissionArgs.resumeTarget) {
    // 不立即执行，存 deferredResumeInput = '/resume'，等事件循环就绪后再模拟提交
    if (permissionArgs.resumeTarget === 'picker') {
      deferredResumeInput = '/resume'
    } else {
      // 指定 id 立即提交
      await handleInput(
        permissionArgs,
        state,
        scheduleRender,
        `/resume ${permissionArgs.resumeTarget}`,
      )
    }
  } else {
    // 清理过期会话
    const expired = await cleanupExpiredSessions(args.cwd, 30 * 24 * 60 * 60 * 1000)
    if (expired > 0) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Cleaned up ${expired} expired session(s) (>30 days old).`,
      })
    }
    // 有存档则提示“可用 /resume 恢复
    const sessions = await listSessions(args.cwd)
    if (sessions.length > 0) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Found ${sessions.length} saved session(s). Type /resume to continue one.`,
      })
    }
  }

  renderNow()

  await new Promise<void>(resolve => {
    let finished = false
    let inputRemainder = ''
    let eventChain = Promise.resolve()
    let submitInFlight = false
    //  定时器，0–2 轮播，驱动状态栏动画（如 Thinking 转圈帧）
    const statusAnimationTimer = setInterval(() => {
      state.statusAnimationFrame = state.statusAnimationFrame + 1
      scheduleRender()
    }, 1000)
    // 调 advanceWelcomeAnimation 推进兔子帧，返回 true（真的动了）才重绘
    const welcomeAnimationTimer = setInterval(() => {
      if (advanceWelcomeAnimation(state)) {
        scheduleRender()
      }
    }, 200)
    // 0–1 轮播，且输入框为空才重绘——输入框里的轮询提示文案
    const inputHintTimer = setInterval(() => {
      state.inputHintFrame = (state.inputHintFrame + 1) % 2
      if (!state.input) {
        scheduleRender()
      }
    }, 3000)
    // 现场恢复清单
    const cleanup = () => {
      clearInterval(statusAnimationTimer)
      clearInterval(welcomeAnimationTimer)
      clearInterval(inputHintTimer)
      unsubscribeSubAgents()
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('close', onClose)
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      showCursor()
      exitAlternateScreen()
      process.stdin.pause()
      process.stdout.write(`Session ${permissionArgs.sessionId} saved. To resume: minicode --resume ${permissionArgs.sessionId}\n`)
    }

    const finish = () => {
      if (finished) return
      finished = true
      cleanup()
      resolve()
    }

    const handleEvent = async (event: ParsedInputEvent) => {
      try {
        // 审批弹窗界面
        if (state.pendingApproval) {
          // trl + O 展开编辑 diff 详情
          if (event.kind === 'text' && event.ctrl && event.text === 'o') {
            if (togglePendingApprovalExpand(state)) {
              scheduleRender()
            }
            return
          }
          // Ctrl+C 退出程序
          if (event.kind === 'text' && event.ctrl && event.text === 'c') {
            finish()
            return
          }

          if (event.kind === 'wheel') {
            if (
              event.direction === 'up'
                ? scrollPendingApprovalBy(state, -3)
                : scrollPendingApprovalBy(state, 3)
            ) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'pageup') {
            if (scrollPendingApprovalBy(state, -8)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'pagedown') {
            if (scrollPendingApprovalBy(state, 8)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'up' && event.meta) {
            if (scrollPendingApprovalBy(state, -1)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'down' && event.meta) {
            if (scrollPendingApprovalBy(state, 1)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'up' && !event.meta) {
            if (movePendingApprovalSelection(state, -1)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'down' && !event.meta) {
            if (movePendingApprovalSelection(state, 1)) {
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'backspace') {
            const pending = state.pendingApproval
            if (pending.feedbackMode && pending.feedbackInput.length > 0) {
              pending.feedbackInput = pending.feedbackInput.slice(0, -1)
              scheduleRender()
            }
            return
          }

          if (event.kind === 'text' && !event.ctrl && !event.meta) {
            const pending = state.pendingApproval
            if (!pending.feedbackMode) {
              const pressed = event.text.trim().toLowerCase()
              const matched = pending.request.choices.find(
                choice => choice.key.toLowerCase() === pressed,
              )
              if (matched) {
                if (matched.decision === 'deny_with_feedback') {
                  pending.feedbackMode = true
                  pending.feedbackInput = ''
                  scheduleRender()
                  return
                }

                state.pendingApproval = null
                setStatus(state, null)
                pending.resolve({ decision: matched.decision })
                scheduleRender()
                return
              }
            }

            if (pending.feedbackMode) {
              pending.feedbackInput += event.text
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'return') {
            const pending = state.pendingApproval
            if (pending.feedbackMode) {
              const feedback = pending.feedbackInput.trim()
              state.pendingApproval = null
              setStatus(state, null)
              pending.resolve({
                decision: 'deny_with_feedback',
                feedback,
              })
              scheduleRender()
              return
            }

            const selected =
              pending.request.choices[
              Math.min(
                pending.selectedChoiceIndex,
                pending.request.choices.length - 1,
              )
              ]
            if (!selected) {
              return
            }

            if (selected.decision === 'deny_with_feedback') {
              pending.feedbackMode = true
              pending.feedbackInput = ''
              scheduleRender()
              return
            }

            state.pendingApproval = null
            setStatus(state, null)
            pending.resolve({ decision: selected.decision })
            scheduleRender()
            return
          }

          if (event.kind === 'key' && event.name === 'escape') {
            const pending = state.pendingApproval
            if (pending.feedbackMode) {
              pending.feedbackMode = false
              pending.feedbackInput = ''
              scheduleRender()
              return
            }

            state.pendingApproval = null
            setStatus(state, null)
            pending.resolve({ decision: 'deny_once' })
            scheduleRender()
            return
          }

          return
        }
        // 会话选择界面
        if (state.sessionPicker) {
          if (event.kind === 'text' && event.ctrl && event.text === 'c') {
            state.sessionPicker.resolve(null)
            state.sessionPicker = null
            setStatus(state, null)
            scheduleRender()
            return
          }

          // 项目列表界面
          if (state.sessionPicker.allProjects) {
            if (event.kind === 'key' && event.name === 'up') {
              if (state.sessionPicker.projectSelectedIndex > 0) {
                state.sessionPicker.projectSelectedIndex -= 1
                scheduleRender()
              }
              return
            }

            if (event.kind === 'key' && event.name === 'down') {
              if (state.sessionPicker.projectSelectedIndex < state.sessionPicker.projects.length - 1) {
                state.sessionPicker.projectSelectedIndex += 1
                scheduleRender()
              }
              return
            }

            if (event.kind === 'key' && event.name === 'return') {
              const proj = state.sessionPicker.projects[state.sessionPicker.projectSelectedIndex]
              if (proj && proj.sessionCount > 0) {
                state.sessionPicker = null
                setStatus(state, null)
                pushTranscriptEntry(state, {
                  kind: 'assistant',
                  body: `Project "${proj.dir}" has ${proj.sessionCount} session(s). Switch to it by exiting and running:\n\n  cd <project-path> && minicode --resume`,
                })
                scheduleRender()
              }
              return
            }

            if ((event.kind === 'key' && event.name === 'tab') || (event.kind === 'key' && event.name === 'escape')) {
              state.sessionPicker.allProjects = false
              scheduleRender()
              return
            }

            return
          }

          // 会话列表界面
          if (event.kind === 'key' && event.name === 'up') {
            const picker = state.sessionPicker
            if (picker.selectedIndex > 0) {
              picker.selectedIndex -= 1
              picker.deleteConfirmIndex = null
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'down') {
            const picker = state.sessionPicker
            if (picker.selectedIndex < picker.sessions.length - 1) {
              picker.selectedIndex += 1
              picker.deleteConfirmIndex = null
              scheduleRender()
            }
            return
          }

          if (event.kind === 'key' && event.name === 'return') {
            const picker = state.sessionPicker
            const selected = picker.sessions[picker.selectedIndex]
            const id = selected?.id ?? null
            state.sessionPicker = null
            setStatus(state, null)
            picker.resolve(id)
            scheduleRender()
            return
          }

          // 两次输入d进行会话删除
          if (event.kind === 'text' && !event.ctrl && !event.meta && event.text === 'd') {
            const picker = state.sessionPicker
            if (picker.deleteConfirmIndex === picker.selectedIndex) {
              // Second press — confirm delete
              const target = picker.sessions[picker.selectedIndex]
              if (target) {
                await clearSession(args.cwd, target.id)
                const sessions = await listSessions(args.cwd)
                if (sessions.length === 0) {
                  state.sessionPicker.resolve(null)
                  state.sessionPicker = null
                  setStatus(state, null)
                  scheduleRender()
                  return
                }
                picker.sessions = sessions
                picker.selectedIndex = Math.min(picker.selectedIndex, sessions.length - 1)
                picker.deleteConfirmIndex = null
              }
            } else {
              picker.deleteConfirmIndex = picker.selectedIndex
            }
            scheduleRender()
            return
          }

          // tab切换会话列表和项目列表
          if (event.kind === 'key' && event.name === 'tab') {
            state.sessionPicker.allProjects = true
            state.sessionPicker.projects = await listAllProjects()
            state.sessionPicker.projectSelectedIndex = 0
            scheduleRender()
            return
          }

          if (event.kind === 'key' && event.name === 'escape') {
            state.sessionPicker.resolve(null)
            state.sessionPicker = null
            setStatus(state, null)
            scheduleRender()
            return
          }

          return
        }
        // 主界面
        const visibleCommands = getVisibleCommands(state.input)
        // Ctrl+C
        if (event.kind === 'text' && event.ctrl && event.text === 'c') {
          finish()
          return
        }
        // 滚轮
        if (event.kind === 'wheel') {
          if (
            event.direction === 'up'
              ? scrollTranscriptBy(permissionArgs, state, 3)
              : scrollTranscriptBy(permissionArgs, state, -3)
          ) {
            scheduleRender()
          }
          return
        }
        // 拖拽画选区 → 松开时 extractSelectedText + copyToClipboard 选中即复制，选区保留高亮
        if (event.kind === 'mouse') {
          const screenX = event.x + 1
          const screenY = event.y + 1
          const lineIndex = screenToAbsoluteLineIndex(permissionArgs, state, screenY)
          if (lineIndex < 0) {
            state.mouseDown = null
            state.selection = null
            return
          }
          const col = Math.max(0, screenX - 3)  // panel border (2) + content starts after left padding space

          if (event.action === 'press' && event.button === 'left') {
            state.mouseDown = { x: col, y: lineIndex }
            state.selection = null
            scheduleRender()
            return
          }

          if (event.action === 'drag' && event.button === 'left' && state.mouseDown) {
            const startLine = Math.min(state.mouseDown.y, lineIndex)
            const endLine = Math.max(state.mouseDown.y, lineIndex)
            const startCol =
              startLine === state.mouseDown.y
                ? Math.min(state.mouseDown.x, col)
                : state.mouseDown.y < lineIndex
                  ? state.mouseDown.x
                  : col
            const endCol =
              endLine === state.mouseDown.y
                ? Math.max(state.mouseDown.x, col)
                : state.mouseDown.y > lineIndex
                  ? state.mouseDown.x
                  : col

            state.selection = {
              startLine,
              startCol,
              endLine,
              endCol,
            }
            scheduleRender()
            return
          }

          if (event.action === 'release' && state.mouseDown) {
            if (state.selection) {
              const text = extractSelectedText(state.transcript, state.selection)
              if (text) {
                copyToClipboard(text)
              }
            }
            state.mouseDown = null
            state.selection = keepSelectionAfterMouseRelease(state.selection)
            scheduleRender()
            return
          }

          return
        }

        // 回车
        if (event.kind === 'key' && event.name === 'return') {
          // busy 则仅提示
          if (state.isBusy) {
            setStatus(
              state,
              state.activeTool
                ? `Running ${state.activeTool}...`
                : 'Current turn is still running...',
            )
            scheduleRender()
            return
          }
          // 斜杠菜单有选中项且未输完则先补全
          if (visibleCommands.length > 0) {
            const selected =
              visibleCommands[
              Math.min(state.selectedSlashIndex, visibleCommands.length - 1)
              ]
            if (selected && state.input.trim() !== selected.usage) {
              state.input = selected.usage
              state.cursorOffset = state.input.length
              state.selectedSlashIndex = 0
              scheduleRender()
              return
            }
          }

          const submittedInput = state.input
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          scheduleRender()
          if (submitInFlight) {
            return
          }
          submitInFlight = true
          void (async () => {
            try {
              const shouldExit = await handleInput(
                permissionArgs,
                state,
                scheduleRender,
                submittedInput,
              )
              if (shouldExit) {
                finish()
                return
              }
              scheduleRender()
            } catch (error) {
              pushTranscriptEntry(state, {
                kind: 'assistant',
                body: error instanceof Error ? error.message : String(error),
              })
              state.input = ''
              state.cursorOffset = 0
              state.selectedSlashIndex = 0
              setStatus(state, null)
              scheduleRender()
            } finally {
              submitInFlight = false
            }
          })()
          return
        }

        if (event.kind === 'key' && event.name === 'backspace') {
          if (state.cursorOffset > 0) {
            state.input =
              state.input.slice(0, state.cursorOffset - 1) +
              state.input.slice(state.cursorOffset)
            state.cursorOffset -= 1
          }
          state.selectedSlashIndex = 0
          scheduleRender()
          return
        }
        // 删光标前 / 光标处字符
        if (event.kind === 'key' && event.name === 'delete') {
          state.input =
            state.input.slice(0, state.cursorOffset) +
            state.input.slice(state.cursorOffset + 1)
          state.selectedSlashIndex = 0
          scheduleRender()
          return
        }
        // 补全斜杠命令
        if (event.kind === 'key' && event.name === 'tab') {
          if (visibleCommands.length > 0) {
            const selected =
              visibleCommands[
              Math.min(state.selectedSlashIndex, visibleCommands.length - 1)
              ]
            if (selected) {
              state.input = selected.usage
              state.cursorOffset = state.input.length
              state.selectedSlashIndex = 0
              scheduleRender()
            }
          }
          return
        }
        // 输入历史上翻 / 下翻（draft 保护）
        if (event.kind === 'text' && event.ctrl && event.text === 'p') {
          if (historyUp(state)) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'n') {
          if (historyDown(state)) {
            scheduleRender()
          }
          return
        }
        // 斜杠菜单选中 > Alt 修饰（滚动 transcript ±1）> 输入历史
        if (event.kind === 'key' && event.name === 'up') {
          if (visibleCommands.length > 0) {
            state.selectedSlashIndex =
              (state.selectedSlashIndex - 1 + visibleCommands.length) %
              visibleCommands.length
            scheduleRender()
          } else if (event.meta) {
            if (scrollTranscriptBy(permissionArgs, state, 1)) {
              scheduleRender()
            }
          } else if (historyUp(state)) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'key' && event.name === 'down') {
          if (visibleCommands.length > 0) {
            state.selectedSlashIndex =
              (state.selectedSlashIndex + 1) % visibleCommands.length
            scheduleRender()
          } else if (event.meta) {
            if (scrollTranscriptBy(permissionArgs, state, -1)) {
              scheduleRender()
            }
          } else if (historyDown(state)) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'key' && event.name === 'pageup') {
          if (scrollTranscriptBy(permissionArgs, state, 8)) {
            scheduleRender()
          }
          return
        }

        if (event.kind === 'key' && event.name === 'pagedown') {
          if (scrollTranscriptBy(permissionArgs, state, -8)) {
            scheduleRender()
          }
          return
        }
        // 光标移动
        if (event.kind === 'key' && event.name === 'left') {
          state.cursorOffset = Math.max(0, state.cursorOffset - 1)
          scheduleRender()
          return
        }

        if (event.kind === 'key' && event.name === 'right') {
          state.cursorOffset = Math.min(state.input.length, state.cursorOffset + 1)
          scheduleRender()
          return
        }
        // 清空输入
        if (event.kind === 'text' && event.ctrl && event.text === 'u') {
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          scheduleRender()
          return
        }

        // 输入为空时跳到日志顶/底，否则光标到行首/行尾
        if (event.kind === 'text' && event.ctrl && event.text === 'a') {
          if (!state.input) {
            if (jumpTranscriptToEdge(permissionArgs, state, 'top')) {
              scheduleRender()
            }
            return
          }

          state.cursorOffset = 0
          scheduleRender()
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'e') {
          if (!state.input) {
            if (jumpTranscriptToEdge(permissionArgs, state, 'bottom')) {
              scheduleRender()
            }
            return
          }

          state.cursorOffset = state.input.length
          scheduleRender()
          return
        }
        // 清空输入
        if (event.kind === 'key' && event.name === 'escape') {
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          scheduleRender()
          return
        }
        // 按光标位置插入，历史指针归位
        if (event.kind === 'text' && !event.ctrl) {
          state.input =
            state.input.slice(0, state.cursorOffset) +
            event.text +
            state.input.slice(state.cursorOffset)
          state.cursorOffset += event.text.length
          state.selectedSlashIndex = 0
          state.historyIndex = state.history.length
          scheduleRender()
        }
      } catch (error) {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: error instanceof Error ? error.message : String(error),
        })
        state.input = ''
        state.cursorOffset = 0
        state.selectedSlashIndex = 0
        setStatus(state, null)
        scheduleRender()
      }
    }
    // 字节流入口
    const onData = (chunk: Buffer | string) => {
      // parseInputChunk 把原始字节（含 ANSI 转义序列）翻译成结构化事件（text/key/wheel/mouse）
      const parsed = parseInputChunk(inputRemainder, chunk)
      // 不完整序列存回 inputRemainder 跨 chunk 拼接
      inputRemainder = parsed.rest
      eventChain = eventChain.then(async () => {
        for (const event of parsed.events) {
          await handleEvent(event)
        }
      }).catch(error => {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: error instanceof Error ? error.message : String(error),
        })
        state.input = ''
        state.cursorOffset = 0
        state.selectedSlashIndex = 0
        setStatus(state, null)
        scheduleRender()
      })
    }

    const onEnd = () => finish()
    const onClose = () => finish()
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('close', onClose)

    // Handle deferred --resume (picker mode)
    if (deferredResumeInput) {
      const input = deferredResumeInput
      deferredResumeInput = null
      submitInFlight = true
      void (async () => {
        try {
          const shouldExit = await handleInput(
            permissionArgs,
            state,
            scheduleRender,
            input,
          )
          if (shouldExit) {
            finish()
            return
          }
          scheduleRender()
        } catch (error) {
          pushTranscriptEntry(state, {
            kind: 'assistant',
            body: error instanceof Error ? error.message : String(error),
          })
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          setStatus(state, null)
          scheduleRender()
        } finally {
          submitInFlight = false
        }
      })()
    }
  })
}
