import { Message } from "../agent-loop.js";
const CHARS_PER_TOKEN = 3.5

type contextStats = {
  totalTokens: number
  contextWindow: number
  utilization: number
  warningLevel: 'normal' | 'warning' | 'critical'
}
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-v4-flash': 65536,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'claude-sonnet-4-20250514': 200000,
}
function contentLength(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (typeof part === 'string') return sum + part.length
      if (part && typeof part === 'object' && 'text' in part) {
        return sum + String(part.text).length
      }
      return sum + 4
    }, 0)
  }
  return 4
}
export function getModelContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? 128000
}

export function estimateMessageTokens(message: Message): number {
  return Math.ceil(contentLength(message.content) / CHARS_PER_TOKEN)
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
}

export function computeContextStats(
  messages: Message[],
  model: string
): contextStats {
  const totalTokens = estimateMessagesTokens(messages)
  const contextWindow = getModelContextWindow(model)
  const utilization = totalTokens / contextWindow
  const warningLevel =
    utilization >= 0.85 ? 'critical'
      : utilization >= 0.5 ? 'warning'
        : 'normal'

  return { totalTokens, contextWindow, utilization, warningLevel }
}