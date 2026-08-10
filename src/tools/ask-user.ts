import { z } from 'zod'
import type { ToolDefinition } from '../tools.js'

type Input = {
  question: string
}

export const askUserTool: ToolDefinition<Input> = {
  name: 'ask_user',
  description:
    '向用户提出一个澄清类问题，结束本轮交互，等待用户作出回复',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
    },
    required: ['question'],
  },
  schema: z.object({
    question: z.string().min(1),
  }),
  async run(input) {
    const question = input.question.trim()
    return {
      ok: true,
      output: question,
      awaitUser: true,
    }
  },
}
