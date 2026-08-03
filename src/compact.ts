import OpenAI from "openai";
import { Message } from "./agent-loop.js";

const MIN_KEEP_MESSAGES = 8
export async function compactConversation(
  client: OpenAI,
  messages: Message[],
  model: string
): Promise<Message[] | null> {
  const systemPrompt = messages.filter(m => m.role === 'system')
  const nonSystemPrompt = messages.filter(m => m.role !== 'system')
  if (nonSystemPrompt.length <= MIN_KEEP_MESSAGES + 1) return null
  const keep = nonSystemPrompt.slice(-MIN_KEEP_MESSAGES)
  const compact = nonSystemPrompt.slice(0, -MIN_KEEP_MESSAGES)

  const compactContent = compact.map(m => {
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content)
    return `[${m.role}]: ${content}`
  }).join('\n\n')

  const summaryResponse = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: [
          '你是对话摘要助手。把用户提供的对话压缩成简洁中文摘要。',
          '必须保留：关键决策、涉及的文件路径、函数名、已做的代码修改、执行过的命令、未完成的任务、用户偏好。',
          '不要编造没有出现过的内容。控制在 300 字以内。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `以下是需要摘要的对话:\n\n${compactContent}`,
      },
    ],
  })

  const summary = summaryResponse.choices[0].message.content?.trim()
  if (!summary) return null

  return [
    ...systemPrompt,
    {
      role: 'user',
      content: `[早期对话摘要，由 MiniCode 自动生成]\n${summary}\n\n请基于摘要继续工作，摘要之外的早期细节已不可见。`,
    },
    ...keep
  ]
}