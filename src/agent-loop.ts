import OpenAI from 'openai';
import { TOOL_DEFINITIONS } from './tools/definitions.js'
import { TOOL_HANDLERS } from './tools/handlers.js';
type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam[]
export async function runAgentTurn(
  client: OpenAI,
  messages: Message,
  maxTurns: 15
): Promise<string> {

  for (let turn = 0; turn < maxTurns; turn++) {
    const completion = await client.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: messages,
      tool_choice: 'auto',
      tools: TOOL_DEFINITIONS
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
      const toolName = toolCall.function.name
      let args: any
      try {
        args = JSON.parse(toolCall.function.arguments)
      } catch {
        args = {}
      }

      const handler = TOOL_HANDLERS[toolName]
      const result = handler ? handler(args) : { success: false, output: `未知工具${toolName}` }

      messages.push(
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        }
      )

    }


  }
  return '⚠️ 达到最大工具调用轮数限制，已自动停止。'
}