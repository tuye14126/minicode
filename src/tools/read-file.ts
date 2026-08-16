import z from "zod"
import { ToolDefinition } from "../tool.js"
import { resolveToolPath } from "../workspace.js"
import { readFile } from "node:fs/promises"


type Input = {
  path: string
  offset?: number
  limit?: number
}

const DEFAULT_READ_LIMIT = 8000
const MAX_READ_LIMIT = 20000

export const readFileTool: ToolDefinition<Input> = {
  name: 'read_file',
  description:
    '读取工作区根目录下的 UTF‑8 格式文本文件；可通过设置偏移量与读取上限，分块读取大型文件',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '读取文件的路径' },
      offset: { type: 'number', description: '读取文件的起始偏移量, 为可选参数, 不填默认从头开始读' },
      limit: { type: 'number', description: '读取的最大长度限制, 为可选参数' }
    },
    required: ['path']
  },
  schema: z.object({
    path: z.string(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional()
  }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'read')
    const content = await readFile(target, 'utf-8')
    const offset = Math.max(0, input.offset ?? 0)
    const limit = Math.min(MAX_READ_LIMIT, input.limit ?? DEFAULT_READ_LIMIT)
    const end = Math.min(content.length, offset + limit)
    const chunk = content.slice(offset, end)
    const truncated = end < content.length
    const header = [
      `FILE: ${input.path}`,
      `OFFSET: ${offset}`,
      `END: ${end}`,
      `TOTAL_CHARS: ${content.length}`,
      truncated
        ? `TRUNCATED: 被截断, 可以选择再次调用read_file工具从offset = ${end} 开始读`
        : `TRUNCATED: 未被截断`,
      ''
    ].join('\n')
    return {
      ok: true,
      output: header + chunk
    }
  }
}