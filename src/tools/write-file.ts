import z from "zod"
import { ToolDefinition } from "../tool.js"
import { resolveToolPath } from "../workspace.js"
import { applyReviewedFileChange } from "../file-review.js"


type Input = {
  path: string
  content: string
}

export const writeFileTool: ToolDefinition<Input> = {
  name: 'write_file',
  description: '向工作区根目录写入一份 UTF‑8 编码的文本文件',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['path', 'content'],
  },
  schema: z.object({
    path: z.string().min(1),
    content: z.string()
  }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'write')
    return applyReviewedFileChange(context, input.path, target, input.content)
  },
}