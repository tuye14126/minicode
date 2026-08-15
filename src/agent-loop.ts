import OpenAI from 'openai';
import { replaceLargeToolResult } from './utils/tool-result-storage.js';
import { ToolRegistry } from './tools.js';
import { PermissionManager } from './permissions.js';
import { ChatMessage, ModelAdapter, ProviderThinkingBlock } from './types.js';
export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam
export async function runAgentTurn(args: {
  messages: ChatMessage[],
  maxSteps?: number,
  model: ModelAdapter,
  tools: ToolRegistry,
  permissions?: PermissionManager,
  cwd: string
}): Promise<ChatMessage[]> {
  const maxSteps = args.maxSteps ?? 15
  let messages = args.messages
  const appendThinkingBlocks = (blocks: ProviderThinkingBlock[] | undefined) => {
    if (!blocks || blocks.length === 0) return
    messages = [
      ...messages,
      {
        role: 'assistant_thinking',
        blocks
      }
    ]
  }
  for (let turn = 0; turn < maxSteps; turn++) {
    const agentStep = await args.model.next(messages)
    appendThinkingBlocks(agentStep.thinkingBlocks)
    if (agentStep.type === 'assistant') {
      messages = [...messages, {
        role: 'assistant',
        content: agentStep.content,
        providerUsage: agentStep.usage
      }]
      return messages
    }
    const toolCalls = agentStep.calls
    for (const toolCall of toolCalls) {
      const toolName = toolCall.toolName
      const toolUseId = toolCall.id
      messages.push({
        role: 'assistant_tool_call',
        toolName,
        toolUseId,
        input: toolCall.input
      })
    }
    for (const toolCall of toolCalls) {
      const toolName = toolCall.toolName
      const toolUseId = toolCall.id

      const input = toolCall.input
      const result = await args.tools.execute(
        toolName,
        input,
        {
          cwd: args.cwd,
          permissions: args.permissions
        }
      )
      result.output = replaceLargeToolResult(result.output)
      messages.push(
        {
          role: 'tool_result',
          toolUseId,
          toolName,
          content: result.output,
          isError: !result.ok
        },
      )

    }


  }
  return messages
}