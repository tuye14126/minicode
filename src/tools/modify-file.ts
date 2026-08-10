import { z } from 'zod'
import { applyReviewedFileChange } from '../file-review.js'
import type { ToolDefinition } from '../tools.js'
import { resolveToolPath } from '../workspace.js'

type Input = {
  path: string
  content: string
}

export const modifyFileTool: ToolDefinition<Input> = {
  name: 'modify_file',
  description: '使用审核后的新内容覆盖文件，支持用户先审阅文件差异再确认通过.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'write')
    return applyReviewedFileChange(context, input.path, target, input.content)
  },
}
