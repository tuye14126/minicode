import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"


const CANDIDATES = [
  'MINI.md',
  'CLAUDE.md',
  path.join('.mini-code', 'MINI.md'),
  path.join('.claude', 'CLAUDE.md'),
]

export type MemoryFile = {
  path: string
  content: string
}

export function discoverMemoryFiles(cwd: string): MemoryFile[] {
  const dirs: string[] = []
  let cursor = path.resolve(cwd)
  while (true) {
    dirs.push(cursor)
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  dirs.reverse()
  if (!dirs.includes(homedir())) {
    dirs.push(homedir())
  }
  const memoryFiles: MemoryFile[] = []

  for (const dir of dirs) {
    for (const name of CANDIDATES) {
      const filePath = path.join(dir, name)
      if (existsSync(filePath)) {
        memoryFiles.push({ path: filePath, content: readFileSync(filePath, 'utf-8') })
      }
    }
  }
  return memoryFiles
}

export function loadMemory(cwd: string): string {
  const memoryFiles = discoverMemoryFiles(cwd)
  if (memoryFiles.length === 0) return ""

  return memoryFiles.map(
    file => `## ${file.path}\n\n${file.content.trim()}`
  ).join('\n\n')
}


export function renderMemoryReport(cwd: string): string {
  const memoryFiles = discoverMemoryFiles(cwd)
  if (memoryFiles.length === 0) return "未发现指令文件"

  return memoryFiles.map((file, i) => {
    const linesCount = file.content.trim().split('\n').filter(Boolean).length
    return `${i + 1}. ${file.path}  (${linesCount} 行)`
  }).join('\n')
}