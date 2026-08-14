import OpenAI from 'openai';
import { replaceLargeToolResult } from './utils/tool-result-storage.js';
import { ToolRegistry } from './tools.js';
import { PermissionManager } from './permissions.js';
import { ChatMessage, ModelAdapter } from './types.js';
export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam
export async function runAgentTurn(args: {
  messages: ChatMessage[],
  maxSteps?: number,
  model: ModelAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
  cwd: string
}): Promise<ChatMessage[]> {
  const maxSteps = args.maxSteps ?? 15
  const messages = args.messages
  for (let turn = 0; turn < maxSteps; turn++) {
    const agentStep = await args.model.next(messages)
    if (agentStep.type === 'assistant') {
      return [...messages, {
        role: 'assistant',
        content: agentStep.content,
        providerUsage: agentStep.usage
      }]
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
      let input: any
      try {
        input = JSON.parse(String(toolCall.input))
      } catch {
        input = {}
      }
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