import { createTwoFilesPatch } from "diff"
import { readFile, writeFile } from "node:fs/promises"
import { isEnoentError } from "./utils/errors.js"
import { ToolContext, ToolResult } from "./tools.js"
import { mkdir } from "node:fs/promises"
import path from "node:path"

export function buildUnifiedDiff(
  filePath: string,
  before: string,
  after: string
): string {
  if (before === after) {
    return `(no changes for ${filePath})`
  }

  const raw = createTwoFilesPatch(
    `a/${filePath}`,
    `b/${filePath}`,
    before,
    after,
    '',
    '',
    { context: 3 }
  )

  const lines = raw.split('\n')
  if (lines[0].startsWith('===')) {
    return lines.slice(1).join('\n')
  }
  return raw
}

export async function loadExistingFile(targetPath: string): Promise<string> {
  try {
    return await readFile(targetPath, 'utf-8')
  } catch (error) {
    if (isEnoentError(error)) {
      return ''
    }
    throw error
  }
}

export async function applyReviewedFileChange(
  context: ToolContext,
  filePath: string,
  targetPath: string,
  newContent: string
): Promise<ToolResult> {
  const oldContent = await loadExistingFile(targetPath)
  if (oldContent === newContent) {
    return {
      ok: true,
      output: `No changes needed for ${filePath}`
    }
  }

  const diff = buildUnifiedDiff(filePath, oldContent, newContent)
  await context.permissions?.ensureEdit(targetPath, diff)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, newContent, 'utf-8')
  return {
    ok: true,
    output: `Applied reviewed changes to ${filePath}`
  }
}


