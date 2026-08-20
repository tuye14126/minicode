import { ChatMessage } from "../types.js"
import { estimateMessagesTokens } from "../utils/token-estimator.js"


type MessageGroup = {
  start: number
  end: number
  messages: ChatMessage[]
  tokens: number
  protected: boolean
}



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