import { ChatMessage } from "../types.js";
import { ContextStats, estimateMessagesTokens, markProviderUsageStale, tokenCountWithEstimation } from "../utils/token-estimator.js";
import { SNIP_COMPACT_THRESHOLD, SNIP_KEEP_RECENT_MESSAGES, SNIP_MIN_MESSAGES_TO_REMOVE, SNIP_MIN_TOKENS_TO_FREE, SNIP_TARGET_USAGE } from "./constants.js";
import { toolGroupIsClosed } from "./context-collapse.js";


export type LoggerLike = {
  debug?: (message: string) => void
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

export type SnipCompactResult = {
  messages: ChatMessage[]
  didSnip: boolean
  tokensBefore: number
  tokensAfter: number
  tokensFreed: number
  removedMessageIds: string[]
  boundaryMessage?: ChatMessage
  reason?: string
}

type SafeRun = {
  groups: MessageGroup[],
  start: number,
  end: number,
  messagesCount: number,
  tokens: number

}
const PROTECTED_TOOL_NAMES = new Set([
  'edit_file',
  'modify_file',
  'patch_file',
  'write_file',
  'apply_patch',
])

type MessageGroup = {
  start: number
  end: number
  messages: ChatMessage[]
  tokens: number
  protected: boolean
  reasons: string[]
}

const ERROR_MARKERS = [
  'error',
  'failed',
  'failure',
  'exception',
  'traceback',
  'permission denied',
]

function noSnipResult(
  messages: ChatMessage[],
  tokensBefore: number,
  reason: string
): SnipCompactResult {
  return {
    messages,
    didSnip: false,
    tokensBefore,
    tokensAfter: tokensBefore,
    tokensFreed: 0,
    removedMessageIds: [],
    reason
  }
}

function findCandidateRange(messages: ChatMessage[]): {
  start: number
  end: number
  reason?: string
} {
  if (messages.length <= SNIP_KEEP_RECENT_MESSAGES + SNIP_MIN_MESSAGES_TO_REMOVE) {
    return { start: 0, end: 0, reason: 'too_few_messages' }
  }
  const keepRecentStart = Math.max(0, messages.length - SNIP_KEEP_RECENT_MESSAGES)
  let lastSafeUserIndex = -1
  for (let i = keepRecentStart; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastSafeUserIndex = i
      break
    }
  }

  const end = lastSafeUserIndex > 0 ? lastSafeUserIndex : keepRecentStart
  if (end <= 0) {
    return { start: 0, end: 0, reason: 'no_middle_range' }
  }
  let start = 0
  for (let i = 0; i < end; i++) {
    if (isBoundaryMessage(messages[i]!)) {
      start = i + 1
    }
  }
  if (end - start < SNIP_MIN_MESSAGES_TO_REMOVE) {
    return { start, end, reason: 'candidate_range_too_small' }
  }
  return { start, end }

}


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
      const isToolOpen = hasToolCall && !toolGroupIsClosed(groupedMessages)
      groups.push({
        start: i,
        end: cursor,
        messages: groupedMessages,
        tokens: estimateMessagesTokens(groupedMessages),
        protected: isToolOpen,
        reasons: isToolOpen ? ['unclosed_tool_call'] : []
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
      const isToolOpen = !toolGroupIsClosed(groupedMessages)
      groups.push({
        start: i,
        end: cursor,
        messages: groupedMessages,
        tokens: estimateMessagesTokens(groupedMessages),
        protected: isToolOpen,
        reasons: isToolOpen ? ['unclosed_tool_call'] : []
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
        reasons: ['orphan_tool_result']
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
      reasons: []
    })
    i += 1
  }
  return groups

}

function addProtectedReason(group: MessageGroup, reason: string): void {
  group.protected = true
  if (!group.reasons.includes(reason)) {
    group.reasons.push(reason)
  }
}

function isBoundaryMessage(message: ChatMessage): boolean {
  return (
    message.role === 'system' ||
    message.role === 'context_summary' ||
    message.role === 'snip_boundary'
  )
}

function isProtectedTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase()

  return (
    PROTECTED_TOOL_NAMES.has(normalized) ||
    normalized.includes('patch') ||
    normalized.includes('write') ||
    normalized.includes('edit') ||
    normalized.includes('modify')
  )

}

function groupHasProtectedTool(group: MessageGroup): boolean {
  return group.messages.some(message => {
    if (message.role === 'assistant_tool_call') {
      return isProtectedTool(message.toolName)
    }
    if (message.role === 'tool_result') {
      return isProtectedTool(message.toolName)
    }

    return false
  })
}

function protectNearbyGroups(groups: MessageGroup[], index: number, reason: string): void {
  for (let i = Math.max(0, index - 1); i <= Math.min(groups.length - 1, index + 1); i++) {
    addProtectedReason(groups[i]!, reason)
  }
}

function toolResultLooksImportantError(message: Extract<ChatMessage, {
  role: 'tool_result'
}>): boolean {
  // 判断工具调用是否出错
  if (message.isError) return true
  const content = message.content.toLowerCase()
  return ERROR_MARKERS.some(marker => content.includes(marker))
}


function messageTextLooksImportantError(message: ChatMessage): boolean {
  // 判断消息内容是否包含错误消息
  if (
    message.role !== 'user' &&
    message.role !== 'assistant' &&
    message.role !== 'assistant_progress' &&
    message.role !== 'context_summary' &&
    message.role !== 'snip_boundary'
  ) {
    return false
  }
  const content = message.content.toLowerCase()
  return ERROR_MARKERS.some(marker => content.includes(marker))
}

function groupHasImportantError(group: MessageGroup): boolean {
  return group.messages.some(message => (
    messageTextLooksImportantError(message) ||
    (message.role === 'tool_result' && toolResultLooksImportantError(message))
  ))
}



function markProtectedGroups(
  groups: MessageGroup[],
  candidateStart: number,
  candidateEnd: number,
): void {
  for (const group of groups) {
    // 超出范围需要保护

    if (group.start < candidateStart || group.end > candidateEnd) {
      addProtectedReason(group, 'outside_candidate_range')
    }

    // 特殊消息需要保护
    if (group.messages.some(isBoundaryMessage)) {
      addProtectedReason(group, 'boundary_message')
    }
  }

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    // 编辑工具需要前后加自身保护
    if (groupHasProtectedTool(group)) {
      protectNearbyGroups(groups, i, 'near_file_edit')
    }
    // 消息出错需要保护
    if (groupHasImportantError(group)) {
      protectNearbyGroups(groups, i, 'near_important_error')
    }

  }
}

function findSafeRuns(groups: MessageGroup[]): SafeRun[] {
  // 把一个个的组切割为一个个可删除的连续的runs
  const runs: SafeRun[] = []
  const current: MessageGroup[] = []
  const flush = () => {
    if (current.length === 0) return
    const first = current[0]!
    const last = current[current.length - 1]!
    runs.push({
      groups: current,
      start: first.start,
      end: last.end,
      messagesCount: last.end - first.start,
      tokens: current.reduce((sum, group) => sum + group.tokens, 0)
    })
  }
  for (const group of groups) {
    if (group.protected) {
      flush()
      continue
    }
    current.push(group)
  }
  flush()
  return runs
}

function compareRuns(a: SafeRun, b: SafeRun): number {
  const tokenDelta = b.tokens - a.tokens
  if (tokenDelta !== 0) return tokenDelta
  const messageDelta = b.messagesCount - a.messagesCount
  if (messageDelta !== 0) return messageDelta
  return a.start - b.start
}

function selectDeletionFromRun(run: SafeRun, desiredTokensToFree: number): {
  start: number
  end: number
  tokens: number
  messagesCount: number
} {
  // 选择需要删除的消息
  let endGroupIndex = -1
  let tokens = 0
  let messagesCount = 0
  for (let i = 0; i < run.groups.length - 1; i++) {
    const group = run.groups[i]!
    tokens += group.tokens
    messagesCount = group.end - run.start
    endGroupIndex = i

    if (
      tokens >= desiredTokensToFree &&
      messagesCount >= SNIP_MIN_MESSAGES_TO_REMOVE
    ) {
      break
    }
  }
  const endGroup = run.groups[Math.max(0, endGroupIndex)]
  return {
    start: run.start,
    end: endGroup.end,
    tokens,
    messagesCount,
  }
}

function messageId(message: ChatMessage, index: number): string {
  return message.id ?? `message-${index}`
}


export function buildSnipBoundaryContent(args: {
  removedCount: number
  tokensFreed: number
}): string {
  return [
    '[Snipped earlier conversation segment]',
    '',
    'A middle portion of the earlier conversation was removed to preserve context space.',
    '',
    'Removed range:',
    `- messages: ${args.removedCount}`,
    `- approximate tokens freed: ${Math.max(0, Math.round(args.tokensFreed))}`,
    '',
    'The recent conversation and active task context are preserved.',
  ].join('\n')
}

function buildBoundaryMessage(args: {
  removedMessageIds: string[]
  removedCount: number
  tokensFreed: number
}): Extract<ChatMessage, { role: 'snip_boundary' }> {
  const timestamp = Date.now()
  const firstRemoved = args.removedMessageIds[0] ?? 'none'
  return {
    id: `snip-${timestamp}-${firstRemoved}`,
    role: 'snip_boundary',
    content: buildSnipBoundaryContent({
      removedCount: args.removedCount,
      tokensFreed: args.tokensFreed,
    }),
    removedMessageIds: args.removedMessageIds,
    removedCount: args.removedCount,
    tokensFreed: args.tokensFreed,
    timestamp,
  }
}

function markRetainedUsageStale(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => markProviderUsageStale(
    message,
    'conversation was snip-compacted after this provider usage was recorded',
  ))
}



// 滑动截断：保留开头和结尾 裁去中间
export async function snipCompactConversation(params: {
  messages: ChatMessage[],
  contextStats: ContextStats,
  modelContextWindow: number,
  logger?: LoggerLike
}): Promise<SnipCompactResult> {

  // 判断利用率是否超过阈值
  const triggerTokens = params.contextStats.totalTokens
  const tokensBefore = estimateMessagesTokens(params.messages)
  const effectiveInput =
    params.contextStats.effectiveInput > 0
      ? params.contextStats.effectiveInput
      : params.modelContextWindow

  const utilization =
    effectiveInput > 0 ? triggerTokens / effectiveInput : params.contextStats.utilization
  if (utilization < SNIP_COMPACT_THRESHOLD) {
    return noSnipResult(params.messages, tokensBefore, 'below_threshold')
  }
  // 寻找需要删除的中间消息范围
  const range = findCandidateRange(params.messages)
  if (range.reason) {
    params.logger?.debug?.(`[snip-compact] ${range.reason}`)
    return noSnipResult(params.messages, tokensBefore, range.reason)
  }

  // 构建分组，标记保护
  const groups = buildMessageGroups(params.messages)
  markProtectedGroups(groups, range.start, range.end)

  // 找出连续可删除分组
  const safeRuns = findSafeRuns(groups)
    .filter(run => (
      run.messagesCount >= SNIP_MIN_MESSAGES_TO_REMOVE &&
      run.tokens >= SNIP_MIN_TOKENS_TO_FREE
    ))
    .sort(compareRuns)
  const bestRun = safeRuns[0]
  if (!bestRun) {
    return noSnipResult(params.messages, tokensBefore, 'no_safe_interval')
  }

  // 计算需要释放的tokens数
  const targetTokensAfterFree = Math.floor(effectiveInput * SNIP_TARGET_USAGE)
  const desiredTokensToFree = Math.max(
    SNIP_MIN_TOKENS_TO_FREE,
    triggerTokens - targetTokensAfterFree,
  )
  const deletion = selectDeletionFromRun(bestRun, desiredTokensToFree)
  if (deletion.messagesCount < SNIP_MIN_MESSAGES_TO_REMOVE) {
    return noSnipResult(params.messages, tokensBefore, 'below_min_messages')
  }
  const removedMessages = params.messages.slice(deletion.start, deletion.end)
  const removedMessageIds = removedMessages.map((message, offset) => (
    messageId(message, deletion.start + offset)
  ))
  // 构造boundary消息
  const boundaryMessage = buildBoundaryMessage({
    removedMessageIds,
    removedCount: removedMessages.length,
    tokensFreed: deletion.tokens,
  })
  // 除去boundary消息本身所占的token数, 计算出实际释放的token数
  const boundaryTokens = estimateMessagesTokens([boundaryMessage])
  const estimatedTokensFreed = Math.max(0, deletion.tokens - boundaryTokens)
  if (estimatedTokensFreed < SNIP_MIN_TOKENS_TO_FREE) {
    return noSnipResult(params.messages, tokensBefore, 'below_min_tokens')
  }
  // 组装新消息数组：[0‑start] + boundary + [end‑末尾]
  const messagesAfterSnip = markRetainedUsageStale([
    ...params.messages.slice(0, deletion.start),
    {
      ...boundaryMessage,
      content: buildSnipBoundaryContent({
        removedCount: removedMessages.length,
        tokensFreed: estimatedTokensFreed,
      }),
      tokensFreed: estimatedTokensFreed,
    },
    ...params.messages.slice(deletion.end),
  ])
  const tokensAfter = tokenCountWithEstimation(messagesAfterSnip).totalTokens
  const tokensFreed = Math.max(0, tokensBefore - tokensAfter)
  if (tokensAfter >= tokensBefore) {
    return noSnipResult(params.messages, tokensBefore, 'no_token_reduction')
  }
  const finalBoundaryMessage = messagesAfterSnip[deletion.start]
  return {
    messages: messagesAfterSnip,
    didSnip: true,
    tokensBefore,
    tokensAfter,
    tokensFreed,
    removedMessageIds,
    boundaryMessage: finalBoundaryMessage,
    reason: 'snipped_safe_middle_interval',
  }

}