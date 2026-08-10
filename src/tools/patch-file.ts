import z from "zod"
import { ToolDefinition } from "../tools.js"
import { resolveToolPath } from "../workspace.js"
import { readFile } from "node:fs/promises"
import { applyReviewedFileChange } from "../file-review.js"

type Replacement = {
  search: string
  replace: string
  replaceAll?: boolean
}
type Input = {
  path: string
  replacements: Replacement[]
}

export const patchFileTool: ToolDefinition<Input> = {
  name: 'patch_file',
  description: '只用一次文件操作，就对一个文件执行多处精确文本替换',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      replacements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            search: { type: 'string' },
            replace: { type: 'string' },
            replaceAll: { type: 'boolean' }
          },
          required: ['search', 'replace']
        }
      },
    },
    required: ['path', 'replacements']
  },
  schema: z.object({
    path: z.string().min(1),
    replacements: z.array(
      z.object({
        search: z.string().min(1),
        replace: z.string(),
        replaceAll: z.boolean().optional(),
      })
    ).min(1)
  }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'write')
    let content = await readFile(target, 'utf-8')
    const applied: string[] = []
    const failed: string[] = []
    //先全部替换项都校验一遍
    for (const replacement of input.replacements) {
      if (!content.includes(replacement.search)) {
        failed.push(replacement.search)
      }
    }
    if (failed.length !== 0) {
      return {
        ok: false,
        output: `Replacement ${failed.join(', ')} not found in ${input.path}`,
      }
    }
    for (const [index, replacement] of input.replacements.entries()) {
      content = replacement.replaceAll
        ? content.split(replacement.search).join(replacement.replace)
        : content.replace(replacement.search, replacement.replace)
      applied.push(
        replacement.replaceAll
          ? `#${index + 1} replaceAll`
          : `#${index + 1} replaceOnce`,
      )
    }


    const result = await applyReviewedFileChange(context, input.path, target, content)
    if (!result.ok) {
      return result
    }
    return {
      ok: true,
      output: `Patched ${input.path} with ${applied.length} replacement(s): ${applied.join(', ')}`,
    }
  },
}