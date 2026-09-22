import z from "zod"
import type { PermissionManager } from "./permissions.js"


export type ToolContext = {
  cwd: string
  permissions?: PermissionManager
}

export type ToolResult = {
  ok: boolean
  output: string
  awaitUser?: boolean
}

export type ToolDefinition<TInput> = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  schema: z.ZodType<TInput>
  run: (input: TInput, context: ToolContext) => Promise<ToolResult>
}

export class ToolRegistry {
  private readonly toolsStore: ToolDefinition<unknown>[]
  private readonly disposers: Array<() => Promise<void>> = []

  constructor(
    tools: ToolDefinition<any>[]
  ) {
    this.toolsStore = tools
  }
  list(): ToolDefinition<unknown>[] {
    return this.toolsStore
  }

  find(name: string): ToolDefinition<unknown> | undefined {
    return this.toolsStore.find(tool => tool.name === name)
  }
  async execute(
    toolName: string,
    input: unknown,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.find(toolName)
    if (!tool) {
      return {
        ok: false,
        output: `Unknown tool: ${toolName}`
      }
    }
    const parsed = tool.schema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        output: parsed.error.message,
      }
    }
    try {
      return await tool.run(parsed.data, context)
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(this.disposers.map(disposer => disposer()))
  }
}
