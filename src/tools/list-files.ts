import { readdir } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../tools.js'
import { resolveToolPath } from '../workspace.js'

type Input = {
  path?: string
}

export const listFilesTool: ToolDefinition<Input> = {
  name: 'list_files',
  description: '基于工作区根目录，列出文件夹内的文件',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
  },
  schema: z.object({
    path: z.string().optional(),
  }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path ?? '.', 'list')
    const entries = await readdir(target, { withFileTypes: true })
    const lines = entries
      .slice(0, 200)
      .map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)

    return {
      ok: true,
      output: lines.join('\n') || '(empty)',
    }
  },
}
