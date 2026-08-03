import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
const TOOL_RESULTS_DIR = path.join(homedir(), '.mini-code', 'tool-results')
const MAX_INLINE_CHARS = 4000

const PREVIEW_CHARS = 2000
export function replaceLargeToolResult(result: string): string {
  if (result.length <= MAX_INLINE_CHARS) {
    return result
  }
  const id = randomUUID().slice(0, 8)
  const filePath = path.join(TOOL_RESULTS_DIR, `${id}.txt`)
  mkdirSync(TOOL_RESULTS_DIR, { recursive: true })
  writeFileSync(filePath, result, 'utf-8')
  const contextPreview = result.slice(0, PREVIEW_CHARS)
  return [
    `[工具输出过大: ${result.length} 字符]`,
    `完整结果已保存到: ${filePath}`,
    '',
    '预览:',
    contextPreview,
    '...(已截断，完整内容见文件)',
  ].join('\n')
}