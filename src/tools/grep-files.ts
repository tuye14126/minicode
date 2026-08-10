import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ToolDefinition } from "../tools.js";
import z from "zod";
import { resolveToolPath } from "../workspace.js";


const execFileAsync = promisify(execFile)

type Input = {
  pattern: string
  path?: string
}

export const grepFilesTool: ToolDefinition<Input> = {
  name: 'grep_files',
  description: '利用ripgrep工具进行文本搜索',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' }
    },
    required: ['pattern']
  },
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional()
  }),
  async run(input, context) {
    const args = ['-n', '--no-heading', input.pattern]
    if (input.path) {
      args.push(await resolveToolPath(context, input.path, 'search'))
    } else {
      args.push('.')
    }
    const result = await execFileAsync('rg', args, {
      cwd: context.cwd,
      maxBuffer: 1024 * 1024
    })
    return {
      ok: true,
      output: (result.stdout || result.stderr || "").trim() || '(no matches)'
    }
  },
}