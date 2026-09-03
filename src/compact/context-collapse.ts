import { ChatMessage, ModelAdapter } from "../types.js"
import { computeContextStats, estimateMessagesTokens, markProviderUsageStale } from "../utils/token-estimator.js"
import { CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES, CONTEXT_COLLAPSE_MAX_FAILURES, CONTEXT_COLLAPSE_MAX_SPANS_PER_PASS, CONTEXT_COLLAPSE_MIN_TOKENS_TO_SAVE, CONTEXT_COLLAPSE_TARGET_USAGE, CONTEXT_COLLAPSE_UTILIZATION } from "./constants.js"
import { parseSummaryFromResponse } from "./prompt.js"


type MessageGroup = {
  start: number
  end: number
  messages: ChatMessage[]
  tokens: number
  protected: boolean
}
// 单次折叠的消息元数据
export type CollapseSpan = {
  id: string
  startMessageId: string
  endMessageId: string
  messageIds: string[]
  summary: string
  tokensBefore: number
  tokensAfter: number
  status: 'staged' | 'committed'
  createdAt: number
  reason: 'context_pressure' | 'manual' | 'overflow_recovery'
}
// 整个会话的折叠状态
export type ContextCollapseState = {
  spans: CollapseSpan[]
  enabled: boolean
  consecutiveFailures: number
}
// 折叠执行函数返回结果
export type ContextCollapseResult = {
  messages: ChatMessage[]
  state: ContextCollapseState
  collapsed: boolean
  span?: CollapseSpan
  spans: CollapseSpan[]
}

export type CollapseCandidate = {
  startIndex: number
  endIndex: number
  startMessageId: string
  endMessageId: string
  messageIds: string[]
  messages: ChatMessage[]
  tokensBefore: number
  estimatedTokensAfter: number
  estimatedTokensToSave: number
}

export type ContextCollapseOptions = {
  utilizationThreshold: number  //触发阈值
  targetUsage: number   //压缩后的目标利用率
  keepRecentMessages: number  //保留的最近消息数
  minTokensToSave: number  //最少要节省的token数
  currentTokens?: number   //当前投影视图内的token数
  effectiveInput?: number  //模型实际可用输入窗口 token 上限
  maxSpansPerPass: number   //单次运行最大的折叠块数
  maxFailures: number   // 最大连续失败次数
  reason: CollapseSpan['reason']
}

export type Model = string

const CONTEXT_COLLAPSE_STALE_REASON =
  'conversation was context-collapsed in the model-visible projection after this provider usage was recorded'


export function createContextCollapseState(): ContextCollapseState {
  return {
    spans: [],
    enabled: true,
    consecutiveFailures: 0,
  }
}

export function buildContextCollapseSummaryPrompt(conversationText: string): string {
  return `你是为一个 AI 编码会话生成本地上下文压缩摘要。

该摘要将仅替换模型可见上下文中较早的这段消息区间。原始对话记录在模型可见投影之外保持完整保留。

请在 <summary> 标签内输出最终摘要。

需保留的内容：

- 用户意图与当前进行中的目标
- 已完成的任务与当前状态
- 重要的决策与约束
- 仍有意义的工具调用及其结果
- 文件的读取 / 写入与代码变更（含路径、函数名、配置名与命令）
- 错误、失败、警告及其相关原文（如适用）
- 待办事项、不确定性、后续约束，以及后续仍相关的一切内容

规则：

- 不得虚构事实或结果
- 不得遗漏关键路径、函数名、配置键、文件路径或错误原文
- 保持简洁，但宁要具体，也不做模糊压缩
- 这不是完整对话压缩；仅总结所提供的那段消息区间

以下是待总结的文本：

${conversationText}`
}

// 查看工具调用的message是否成对闭合
export function toolGroupIsClosed(messages: ChatMessage[]): boolean {
  const calls = new Set(
    messages
      .filter((message): message is Extract<ChatMessage, { role: 'assistant_tool_call' }> => (
        message.role === 'assistant_tool_call'
      ))
      .map(message => message.toolUseId),
  )
  const results = new Set(
    messages
      .filter((message): message is Extract<ChatMessage, { role: 'tool_result' }> => (
        message.role === 'tool_result'
      ))
      .map(message => message.toolUseId),
  )

  if (calls.size === 0 && results.size === 0) return true
  if (calls.size === 0 || results.size === 0) return false
  for (const id of calls) {
    if (!results.has(id)) return false
  }
  for (const id of results) {
    if (!calls.has(id)) return false
  }
  return true
}


// 获取连续可折叠的消息分组
export function buildMessageGroups(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []

  for (let i = 0; i < messages.length;) {
    const message = messages[i]!

    if (message.role === 'assistant_thinking') {
      const groupedMessages: ChatMessage[] = [message]
      let cursor = i + 1
      while (messages[cursor]?.role === 'assistant_tool_call') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      while (messages[cursor]?.role === 'tool_result') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      const hasToolCall = groupedMessages.some(msg => msg.role === 'assistant_tool_call')
      groups.push({
        start: i,
        end: cursor,
        messages: groupedMessages,
        tokens: estimateMessagesTokens(groupedMessages),
        protected: hasToolCall && !toolGroupIsClosed(groupedMessages),
      })
      i = cursor
      continue
    }

    if (message.role === 'assistant_tool_call') {
      const groupedMessages: ChatMessage[] = []
      let cursor = i
      while (messages[cursor]?.role === 'assistant_tool_call') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      while (messages[cursor]?.role === 'tool_result') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      groups.push({
        start: i,
        end: cursor,
        messages: groupedMessages,
        tokens: estimateMessagesTokens(groupedMessages),
        protected: !toolGroupIsClosed(groupedMessages),
      })
      i = cursor
      continue
    }

    if (message.role === 'tool_result') {
      groups.push({
        start: i,
        end: i + 1,
        messages: [message],
        tokens: estimateMessagesTokens([message]),
        protected: true,
      })
      i += 1
      continue
    }

    groups.push({
      start: i,
      end: i + 1,
      messages: [message],
      tokens: estimateMessagesTokens([message]),
      protected: false,
    })
    i += 1
  }

  return groups
}

function withDefaultOptions(
  options: Partial<ContextCollapseOptions> = {},
): ContextCollapseOptions {
  return {
    utilizationThreshold:
      options.utilizationThreshold ?? CONTEXT_COLLAPSE_UTILIZATION,
    targetUsage: options.targetUsage ?? CONTEXT_COLLAPSE_TARGET_USAGE,
    keepRecentMessages:
      options.keepRecentMessages ?? CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES,
    minTokensToSave:
      options.minTokensToSave ?? CONTEXT_COLLAPSE_MIN_TOKENS_TO_SAVE,
    currentTokens: options.currentTokens,
    effectiveInput: options.effectiveInput,
    maxSpansPerPass:
      options.maxSpansPerPass ?? CONTEXT_COLLAPSE_MAX_SPANS_PER_PASS,
    maxFailures: options.maxFailures ?? CONTEXT_COLLAPSE_MAX_FAILURES,
    reason: options.reason ?? 'context_pressure',
  }
}

function normalizeContextCollapseState(state: ContextCollapseState): ContextCollapseState {
  return {
    spans: [...state.spans],
    enabled: state.enabled,
    consecutiveFailures: state.consecutiveFailures
  }
}


function unchangedCollapseResult(
  messages: ChatMessage[],
  state: ContextCollapseState,
): ContextCollapseResult {
  return {
    messages,
    state,
    collapsed: false,
    spans: [],
  }
}

function messageId(message: ChatMessage, index: number): string {
  return message.id ?? `message-${index}`
}

// 构造折叠的消息内容
function buildCollapsedSummaryContent(span: CollapseSpan): string {
  return [
    '[Collapsed context summary]',
    `This summary replaces messages ${span.startMessageId} through ${span.endMessageId} in the model-visible context only.`,
    'The original transcript is preserved in the session/UI.',
    '',
    span.summary,
  ].join('\n')
}

// 构造context_summary消息
function buildCollapsedSummaryMessage(
  span: CollapseSpan,
): Extract<ChatMessage, { role: 'context_summary' }> {
  return {
    id: `collapse-summary-${span.id}`,
    role: 'context_summary',
    content: buildCollapsedSummaryContent(span),
    compressedCount: span.messageIds.length,
    timestamp: span.createdAt,
  }
}

// 获取所有已折叠的消息的id
function committedCollapsedMessageIds(state: ContextCollapseState): Set<string> {
  const ids = new Set<string>()
  for (const span of state.spans) {
    if (span.status !== 'committed' && span.status !== 'staged') continue
    for (const id of span.messageIds) {
      ids.add(id)
    }
  }
  return ids
}

function desiredTokensToSave(options: ContextCollapseOptions): number {
  if (
    options.currentTokens !== undefined &&
    options.effectiveInput !== undefined &&
    options.effectiveInput > 0
  ) {
    return Math.max(
      options.minTokensToSave,
      Math.ceil(options.currentTokens - options.effectiveInput * options.targetUsage),
    )
  }
  return options.minTokensToSave
}
function estimateCollapseSummaryTokens(tokensBefore: number): number {
  return Math.max(128, Math.ceil(tokensBefore * 0.15))
}

function buildCandidateFromGroups(
  messages: ChatMessage[],
  groups: MessageGroup[],
  options: ContextCollapseOptions,
): CollapseCandidate | null {
  // 计算目标节省token
  const desired = desiredTokensToSave(options)
  let tokens = 0
  let endGroupIndex = -1
  for (let i = 0; i < groups.length; i++) {
    tokens += groups[i]!.tokens
    // 估算折叠后的token
    const estimatedTokensAfter = estimateCollapseSummaryTokens(tokens)
    const estimatedTokensToSave = Math.max(0, tokens - estimatedTokensAfter)
    endGroupIndex = i
    // 达到目标token则结束
    if (estimatedTokensToSave >= desired) {
      break
    }
  }
  if (endGroupIndex < 0) return null
  const selectedGroups = groups.slice(0, endGroupIndex + 1)
  const first = selectedGroups[0]!
  const last = selectedGroups[selectedGroups.length - 1]!
  const selectedMessages = messages.slice(first.start, last.end)
  const messageIds = selectedMessages.map((message, offset) => (
    messageId(message, first.start + offset)
  ))
  const estimatedTokensAfter = estimateCollapseSummaryTokens(tokens)
  const estimatedTokensToSave = Math.max(0, tokens - estimatedTokensAfter)

  if (estimatedTokensToSave < options.minTokensToSave) {
    return null
  }
  return {
    startIndex: first.start,
    endIndex: last.end,
    startMessageId: messageIds[0]!,
    endMessageId: messageIds[messageIds.length - 1]!,
    messageIds,
    messages: selectedMessages,
    tokensBefore: tokens,
    estimatedTokensAfter,
    estimatedTokensToSave,
  }

}









function isCollapseBoundary(message: ChatMessage): boolean {
  return (
    message.role === 'system' ||
    message.role === 'context_summary' ||
    message.role === 'snip_boundary'
  )
}

export function findCollapseCandidate(
  messages: ChatMessage[],
  state: ContextCollapseState,
  rawOptions: Partial<ContextCollapseOptions> = {}
): CollapseCandidate | null {
  const options = withDefaultOptions(rawOptions)
  //找到最近一条用户的消息
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIndex = i
      break
    }
  }
  //获取保护的消息起点
  const keepRecentStart = Math.max(0, messages.length - options.keepRecentMessages)
  const protectedStart = Math.min(
    keepRecentStart,
    lastUserIndex >= 0 ? lastUserIndex : messages.length,
  )
  if (protectedStart <= 0) return null
  // 获取所有已折叠的消息的id
  const collapsedIds = committedCollapsedMessageIds(state)
  // 获取所有连续消息分组
  const groups = buildMessageGroups(messages)


  const safeRuns: MessageGroup[][] = []
  let currentRun: MessageGroup[] = []
  const flush = () => {
    if (currentRun.length > 0) {
      safeRuns.push(currentRun)
      currentRun = []
    }
  }

  for (const group of groups) {
    // 判断分组是否受保护
    const protectedGroup =
      group.protected ||
      group.start < 0 ||
      group.end > protectedStart ||
      group.messages.some(isCollapseBoundary) ||
      group.messages.some((message, offset) => (
        collapsedIds.has(messageId(message, group.start + offset))
      ))

    if (protectedGroup) {
      flush()
      continue
    }
    currentRun.push(group)
  }
  flush()

  for (const run of safeRuns) {
    const candidate = buildCandidateFromGroups(messages, run, options)
    if (candidate) {
      return candidate
    }
  }

  return null

}


// 对将要进行折叠的span进行校验
function projectSpan(
  messages: ChatMessage[],
  span: CollapseSpan
): {
  start: number
  end: number
  message: Extract<ChatMessage, { role: 'context_summary' }>
} | null {
  if (span.status !== 'committed' || span.messageIds.length === 0) {
    return null
  }

  //将消息的id与索引号进行结合
  const indexById = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    indexById.set(messageId(messages[i]!, i), i)
  }
  // 遍历需要折叠的消息，判断是否有不存在的id
  const indices: number[] = []
  for (const id of span.messageIds) {
    const index = indexById.get(id)
    if (index === undefined) return null
    indices.push(index)
  }
  // 判断消息的索引是否连续
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1]! + 1) {
      return null
    }
  }
  const start = indices[0]!
  const end = indices[indices.length - 1]! + 1
  //二次校验
  if (
    messageId(messages[start]!, start) !== span.startMessageId ||
    messageId(messages[end - 1]!, end - 1) !== span.endMessageId
  ) {
    return null
  }
  // 返回该span区间的首尾索引以及占位消息
  return {
    start,
    end,
    message: buildCollapsedSummaryMessage(span),
  }
}

// 创建为LLM调用API的消息视图
export function projectCollapsedView(
  messages: ChatMessage[],
  state: ContextCollapseState,
): ChatMessage[] {


  // 折叠总开关关闭，或者没有任何折叠记录，直接返回原始消息
  if (!state.enabled || state.spans.length === 0) {
    return messages
  }

  // 过滤无效 span，按位置排序
  const projections = state.spans
    .map(span => projectSpan(messages, span))
    .filter((projection): projection is NonNullable<typeof projection> => Boolean(projection))
    .sort((a, b) => a.start - b.start)

  if (projections.length === 0) {
    return messages
  }

  const result: ChatMessage[] = []
  const occupiedIndices = new Set<number>()
  let cursor = 0

  for (const projection of projections) {
    let overlaps = false
    //查看是否有重叠, 有则直接跳过
    for (let i = projection.start; i < projection.end; i++) {
      if (occupiedIndices.has(i)) {
        overlaps = true
        break
      }
    }
    if (overlaps) {
      continue
    }
    // 将折叠区间前面的消息加入到结果中, 标记token失效
    while (cursor < projection.start) {
      result.push(markProviderUsageStale(messages[cursor]!, CONTEXT_COLLAPSE_STALE_REASON))
      cursor += 1
    }

    result.push(projection.message)
    for (let i = projection.start; i < projection.end; i++) {
      occupiedIndices.add(i)
    }
    cursor = projection.end

  }
  while (cursor < messages.length) {
    result.push(markProviderUsageStale(messages[cursor]!, CONTEXT_COLLAPSE_STALE_REASON))
    cursor += 1
  }

  return result


}

function messageToCollapseText(message: ChatMessage): string {
  switch (message.role) {
    case 'user':
      return `[User]: ${message.content}`
    case 'assistant':
    case 'assistant_progress':
      return `[Assistant]: ${message.content}`
    case 'assistant_thinking':
      return '[Assistant Thinking]: preserved provider reasoning block'
    case 'assistant_tool_call':
      return `[Tool Call: ${message.toolName} ${message.toolUseId}]: ${JSON.stringify(message.input)}`
    case 'tool_result':
      return `[Tool Result: ${message.toolName} ${message.toolUseId}${message.isError ? ' ERROR' : ''}]: ${message.content}`
    case 'context_summary':
      return `[Context Summary]: ${message.content}`
    case 'snip_boundary':
      return `[Snip Boundary]: ${message.content}`
    case 'system':
      return '[System]: protected system message'
  }
}

function messagesToCollapseText(messages: ChatMessage[]): string {
  return messages.map(messageToCollapseText).join('\n\n')
}



function failedCollapseResult(
  messages: ChatMessage[],
  state: ContextCollapseState,
  options: ContextCollapseOptions,
): ContextCollapseResult {
  const consecutiveFailures = state.consecutiveFailures + 1
  return {
    messages,
    state: {
      ...state,
      spans: [...state.spans],
      consecutiveFailures,
      enabled: consecutiveFailures >= options.maxFailures ? false : state.enabled,
    },
    collapsed: false,
    spans: [],
  }
}

function committedCollapseResult(
  messages: ChatMessage[],
  state: ContextCollapseState,
  plannedSpans: CollapseSpan[],
): ContextCollapseResult {
  const committedSpans = plannedSpans.map(span => ({
    ...span,
    status: 'committed' as const,
  }))
  const nextState: ContextCollapseState = {
    ...state,
    spans: [...state.spans, ...committedSpans],
    consecutiveFailures: 0,
  }

  return {
    messages: projectCollapsedView(messages, nextState),
    state: nextState,
    collapsed: committedSpans.length > 0,
    span: committedSpans[0],
    spans: committedSpans,
  }
}


export async function applyContextCollapseIfNeeded(
  messages: ChatMessage[],
  model: Model,
  adapter: ModelAdapter,
  state: ContextCollapseState,
  rawOptions: Partial<ContextCollapseOptions> = {},
): Promise<ContextCollapseResult> {
  const options = withDefaultOptions(rawOptions)
  const currentState = normalizeContextCollapseState(state)

  // 折叠总开关关闭，或者没有任何折叠记录，直接返回原始消息
  if (!currentState.enabled) {
    return unchangedCollapseResult(messages, currentState)
  }
  //查看当前视图token是否达到阈值
  const currentProjected = projectCollapsedView(messages, currentState)
  let stats = computeContextStats(currentProjected, model)

  if (stats.utilization < options.utilizationThreshold) {
    return unchangedCollapseResult(currentProjected, currentState)
  }

  const plannedSpans: CollapseSpan[] = []
  const maxSpans = Math.max(1, Math.floor(options.maxSpansPerPass))
  for (let pass = 0; pass < maxSpans; pass++) {
    const selectionState: ContextCollapseState = {
      ...currentState,
      spans: [...currentState.spans, ...plannedSpans],
    }
    const projected = projectCollapsedView(messages, selectionState)
    stats = computeContextStats(projected, model)

    if (plannedSpans.length > 0 && stats.utilization <= options.targetUsage) {
      break
    }

    // 寻找合适折叠区间
    const candidate = findCollapseCandidate(messages, selectionState, {
      ...options,
      currentTokens: stats.totalTokens,
      effectiveInput: stats.effectiveInput
    })

    if (!candidate) {
      break
    }

    const summaryPrompt = buildContextCollapseSummaryPrompt(
      messagesToCollapseText(candidate.messages),
    )
    const summaryRequestMessages: ChatMessage[] = [
      {
        role: 'system',
        content: '你是一名精准的助手，负责在不虚构细节的前提下，总结较早的编码会话上下文',
      },
      {
        role: 'user',
        content: summaryPrompt,
      },
    ]

    try {
      // 利用大模型进行消息总结
      const response = await adapter.next(summaryRequestMessages)
      if (response.type !== 'assistant' || !response.content.trim()) {
        return failedCollapseResult(currentProjected, currentState, options)
      }

      const summary = parseSummaryFromResponse(response.content)
      if (!summary) {
        return failedCollapseResult(currentProjected, currentState, options)
      }
      const now = Date.now()
      // 生成折叠消息草稿
      const draftSpan: CollapseSpan = {
        id: `collapse-${now}-${pass}-${candidate.startMessageId}`,
        startMessageId: candidate.startMessageId,
        endMessageId: candidate.endMessageId,
        messageIds: candidate.messageIds,
        summary,
        tokensBefore: candidate.tokensBefore,
        tokensAfter: 0,
        status: 'staged',
        createdAt: now,
        reason: options.reason,
      }
      // 计算摘要token
      const summaryTokens = estimateMessagesTokens([buildCollapsedSummaryMessage(draftSpan)])
      // 计算节省token
      const tokensToSave = Math.max(0, candidate.tokensBefore - summaryTokens)
      // 节省token少于目标token时，若已有span则提交，避免越折叠token越多
      if (tokensToSave < options.minTokensToSave) {
        if (plannedSpans.length > 0) break
        return failedCollapseResult(currentProjected, currentState, options)
      }
      plannedSpans.push({
        ...draftSpan,
        tokensAfter: summaryTokens,
      })
    } catch {
      return failedCollapseResult(currentProjected, currentState, options)
    }
  }
  if (plannedSpans.length === 0) {
    return unchangedCollapseResult(currentProjected, currentState)
  }

  // 将草稿span合并到全局state中，生成新的消息视图
  return committedCollapseResult(messages, currentState, plannedSpans)



}