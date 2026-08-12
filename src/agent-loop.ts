import OpenAI from 'openai';
import { replaceLargeToolResult } from './utils/tool-result-storage.js';
import { ToolRegistry } from './tools.js';
import { PermissionManager } from './permissions.js';
export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam
export async function runAgentTurn(
  client: OpenAI,
  messages: Message[],
  maxTurns = 15,
  model = 'deepseek-v4-flash',
  registry: ToolRegistry,
  permissions: PermissionManager,
  cwd: string
): Promise<string> {
  const toolStore = registry.list()
  for (let turn = 0; turn < maxTurns; turn++) {
    const completion = await client.chat.completions.create({
      model: model,
      messages: messages,
      tool_choice: 'auto',
      tools: toolStore.map(tool => {
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        }
      })
    });
    const replyMessage = completion.choices[0].message
    const toolCalls = replyMessage.tool_calls

    if (!toolCalls || toolCalls.length == 0) {
      const content = replyMessage.content || ''
      if (content.trim()) {
        messages.push({ role: 'assistant', content: content })
      }
      return content
    }
    messages.push(replyMessage)

    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'function') continue
      const toolName = toolCall.function.name
      let args: any
      try {
        args = JSON.parse(toolCall.function.arguments)
      } catch {
        args = {}
      }
      const result = await registry.execute(
        toolName,
        args,
        {
          cwd,
          permissions
        }
      )
      result.output = replaceLargeToolResult(result.output)
      messages.push(
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        },

      )

    }


  }
  return '⚠️ 达到最大工具调用轮数限制，已自动停止。'
}