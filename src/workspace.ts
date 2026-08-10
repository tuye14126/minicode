import path from "node:path";
import { ToolContext } from "./tools.js";


export async function resolveToolPath(
  context: ToolContext,
  targetPath: string,
  intent: 'read' | 'write' | 'list' | 'search'
): Promise<string> {
  const resolved = path.resolve(context.cwd, targetPath)
  if (!context.permissions) {
    const workspaceRoot = path.resolve(context.cwd)
    const relative = path.relative(workspaceRoot, resolved)

    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Path escapes workspace: ${targetPath}`)
    }

    return resolved
  }

  await context.permissions.ensurePathAccess(resolved, intent)
  return resolved
}