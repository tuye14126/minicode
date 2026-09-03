import { ChatMessage, CompressionResult, ModelAdapter } from "../types.js";
import { estimateMessageTokens, markProviderUsageStale, tokenCountWithEstimation } from "../utils/token-estimator.js";
import { RETENTION } from "./constants.js";
import { buildCompactSummaryPrompt, parseSummaryFromResponse } from "./prompt.js";



// 对消息进行分组
function groupMessagesByApiRound(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = []

  for (let i = 0; i < messages.length;) {
    const group: ChatMessage[] = []
    let cursor = i

    if (messages[cursor]?.role === 'assistant_thinking') {
      group.push(messages[cursor])
      cursor += 1
    }

    while (messages[cursor]?.role === 'assistant_tool_call') {
      group.push(messages[cursor])
      cursor += 1
    }

    while (messages[cursor]?.role === 'tool_result') {
      group.push(messages[cursor])
      cursor += 1
    }

    if (group.some(msg => msg.role === 'assistant_tool_call' || msg.role === 'tool_result')) {
      groups.push(group)
      i = cursor
      continue
    }

    groups.push([messages[i]])
    i += 1
  }

  return groups
}

// 遍历消息分组，进行界限对齐，防止后续压缩破坏分组
function alignBoundaryToApiRound(messages: ChatMessage[], boundary: number): number {
  let start = 0
  for (const group of groupMessagesByApiRound(messages)) {
    const end = start + group.length
    if (boundary > start && boundary < end) {
      return start
    }
    start = end
  }
  return boundary
}


function findRetentionBoundary(messages: ChatMessage[]): number {
  let tokenSum = 0
  let boundary = messages.length

  for (let i = messages.length - 1; i >= 1; i--) {
    const msgTokens = estimateMessageTokens(messages[i])
    // 从后往前遍历，如果token总数大于阈值则停止，即找到了界限
    if (tokenSum + msgTokens > RETENTION.MAX_KEEP_TOKENS) {
      break
    }
    tokenSum += msgTokens
    boundary = i
  }
  // 防止单条消息过大的情况，强制设置最低界限
  const minBoundary = Math.max(1, messages.length - RETENTION.MIN_KEEP_MESSAGES)
  boundary = Math.min(boundary, minBoundary)
  // 如果所有非系统消息的token都不够阈值，则将界限设置为MIN_KEEP_MESSAGES
  if (boundary <= 1 && messages.length > RETENTION.MIN_KEEP_MESSAGES + 1) {
    boundary = Math.max(1, messages.length - RETENTION.MIN_KEEP_MESSAGES)
  }

  return alignBoundaryToApiRound(messages, boundary)

}
// 对需要压缩的消息转换为文字
function messagesToText(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
        parts.push(`[User]: ${msg.content}`)
        break
      case 'assistant':
      case 'assistant_progress':
        parts.push(`[Assistant]: ${msg.content}`)
        break
      case 'assistant_thinking':
        parts.push('[Assistant Thinking]: preserved provider reasoning block')
        break
      case 'assistant_tool_call':
        parts.push(`[Tool Call: ${msg.toolName}]: ${JSON.stringify(msg.input)}`)
        break
      case 'tool_result':
        const content = msg.content.length > 500
          ? `${msg.content.slice(0, 500)}... (truncated)`
          : msg.content
        parts.push(`[Tool Result: ${msg.toolName}${msg.isError ? ' ERROR' : ''}]: ${content}`)
        break
      case 'context_summary':
        parts.push(`[Previous Summary]: ${msg.content}`)
        break
      case 'snip_boundary':
        parts.push(`[Snipped Context Boundary]: ${msg.content}`)
        break
      default:
        break
    }
  }
  return parts.join('\n\n')
}

// 对于真实的消息进行全量的压缩
export async function compactConversation(
  messages: ChatMessage[],
  modelAdapter: ModelAdapter,
): Promise<CompressionResult | null> {
  if (messages.length <= 2) {
    return null
  }
  const tokensBefore = tokenCountWithEstimation(messages).totalTokens
  const systemMessages = messages.filter(m => m.role === 'system')
  const nonSystemMessages = messages.filter(m => m.role !== 'system')
  if (nonSystemMessages.length <= RETENTION.MIN_KEEP_MESSAGES) {
    return null
  }
  // 确定压缩界限
  const boundary = findRetentionBoundary(messages)
  // 确定需要压缩的消息
  const messagesToCompress = messages.slice(1, boundary)
  // 确定需要保留的消息, 同时进行消息token值过期标志
  const messagesToKeep = messages
    .slice(boundary)
    .map(message => markProviderUsageStale(
      message,
      'conversation was compacted after this provider usage was recorded',
    ))
  if (messagesToCompress.length === 0) {
    return null
  }
  // 对需要压缩的消息转换为文字
  const conversationText = messagesToText(messagesToCompress)
  const summaryPrompt = buildCompactSummaryPrompt(conversationText)
  const summaryRequestMessages: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant that summarizes conversations concisely.' },
    { role: 'user', content: summaryPrompt },
  ]
  try {
    // 调用LLM
    const response = await modelAdapter.next(summaryRequestMessages)
    if (response.type !== 'assistant' || !response.content.trim()) {
      return null
    }
    // 得到摘要消息
    const summaryContent = parseSummaryFromResponse(response.content)
    if (!summaryContent) {
      return null
    }
    // 构造message
    const summaryMessage: Extract<ChatMessage, { role: 'context_summary' }> = {
      role: 'context_summary',
      content: summaryContent,
      compressedCount: messagesToCompress.length,
      timestamp: Date.now(),
    }
    // 构造全新的历史消息
    const newMessages: ChatMessage[] = [
      ...systemMessages,
      summaryMessage,
      ...messagesToKeep,
    ]
    const tokensAfter = tokenCountWithEstimation(newMessages).totalTokens
    return {
      messages: newMessages,
      summary: summaryMessage,
      removedCount: messagesToCompress.length,
      tokensBefore,
      tokensAfter,
    }
  } catch {
    return null
  }


}