// 自动扫描项目多层目录下的 MINI.md/ CLAUDE.md 规则文件，
// 支持 `@include` 嵌套引入其他 md 文件、防循环引用、去重、统计文件信息，
// 最后按字符上限截断，打包成一段大模型可用的指令上下文

import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { getMiniCodeDir } from "./config.js"

// 基础文件模型：存储文件路径 + 文件文本内容
export type ContextFile = {
  path: string
  content: string
}

// 记忆文件的详细信息
export type MemoryFileInfo = ContextFile & {
  scope: 'global' | 'project' | 'rules'
  lineCount: number
  charCount: number
  preview: string
}

const MINI_CODE_DIR = getMiniCodeDir()
const MAX_PER_FILE_CHARS = 8_000   // 单个文件最多保留字符
const MAX_TOTAL_CHARS = 20_000     // 所有文件合并总字符上限
const CANDIDATES_PER_DIR = [
  'MINI.md',
  'MINI.local.md',
  path.join('.mini-code', 'MINI.md'),
  'CLAUDE.md',
  'CLAUDE.local.md',
  path.join('.claude', 'CLAUDE.md'),
]   // 在每个目录下要查找的规则文件名列表

const INCLUDE_LINE_RE = /^@([^\s]+)\s*$/  // 匹配 @filename 引入语法

// 判断两份文件内容是否完全一样，用于去重
function contentHash(text: string): string {
  const normalized = text.trim()
  return createHash('sha256').update(normalized).digest('hex')
}

// 文本截断函数
function truncateTo(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return trimmed.slice(0, limit) + '\n\n[truncated]'
}

// 安全读取文件包装函数
async function tryRead(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf8')
    return content.trim() ? content : null
  } catch {
    return null
  }
}


// 扫描指定 rules 目录, 获取所有规则.md文件，按字母排序，返回路径数组
async function discoverRuleFiles(rulesDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rulesDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => path.join(rulesDir, entry.name))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

// 安全校验 `@include` 的路径
function isUnsafeIncludePath(includePath: string): boolean {
  if (!includePath || path.isAbsolute(includePath)) return true
  const parts = includePath.split(/[\\/]+/)
  return parts.some(part => part === '..')
}

// 文件内容去重
function dedupe(files: ContextFile[]): ContextFile[] {
  const result: ContextFile[] = []
  const seen = new Set<string>()
  // Walk in reverse so later (cwd) entries win
  for (let i = files.length - 1; i >= 0; i--) {
    const hash = contentHash(files[i].content)
    if (seen.has(hash)) continue
    seen.add(hash)
    result.unshift(files[i])
  }
  return result
}


// 对.md文件中对其他文件的@引用进行路径安全判断并展开，返回展开 include 之后完整合并后的文本
async function resolveIncludes(
  content: string,
  fromFile: string,
  visited: Set<string>,
): Promise<string> {
  const fromDir = path.dirname(fromFile)
  const lines = content.split('\n')
  const rendered: string[] = []

  for (const line of lines) {
    // 匹配@引用
    const match = line.trim().match(INCLUDE_LINE_RE)
    if (!match) {
      rendered.push(line)
      continue
    }
    // 得到引用的文件路径
    const includeRef = match[1]
    // 判断该路径是否为危险路径
    if (isUnsafeIncludePath(includeRef)) {
      rendered.push(`<!-- include skipped: unsafe path ${includeRef} -->`)
      continue
    }
    // 判断该路径是否被引用过，避免循环引用
    const includePath = path.resolve(fromDir, includeRef)
    if (visited.has(includePath)) {
      rendered.push(`<!-- include skipped: cycle detected ${includeRef} -->`)
      continue
    }
    // 读取文件内容
    const included = await tryRead(includePath)
    if (!included) {
      rendered.push(`<!-- include skipped: not found ${includeRef} -->`)
      continue
    }

    visited.add(includePath)

    // 递归获取文件引用内容
    const resolved = await resolveIncludes(included, includePath, visited)
    visited.delete(includePath)
    // 获取到内容后加入到结果中，最后整合为所有引用内容的结合
    rendered.push(
      `<!-- included from ${includeRef} -->`,
      resolved,
      `<!-- end include ${includeRef} -->`,
    )
  }

  return rendered.join('\n')
}

// 获取所有.md文件
export async function discoverInstructionFiles(
  cwd: string,
  homeDir?: string,
  scanRoot?: string,
): Promise<ContextFile[]> {
  // Collect ancestor directories from root → cwd
  const dirs: string[] = []
  let cursor: string | undefined = cwd
  const resolvedScanRoot = scanRoot ? path.resolve(scanRoot) : undefined
  // 向上获取所有父目录
  while (cursor) {
    dirs.push(cursor)
    if (resolvedScanRoot && path.resolve(cursor) === resolvedScanRoot) break
    cursor = path.dirname(cursor)
    if (cursor === dirs[dirs.length - 1]) break // reached root
  }
  dirs.reverse()

  const files: ContextFile[] = []

  // User global first
  const home = homeDir ?? MINI_CODE_DIR
  const globalCandidates = [
    path.join(home, 'MINI.md'),
    path.join(home, 'CLAUDE.md'),
  ]
  // 先查看顶层全局文件
  for (const candidate of globalCandidates) {
    const content = await tryRead(candidate)
    if (content) {
      files.push({ path: candidate, content: await resolveIncludes(content, candidate, new Set([candidate])) })
      break // only one global file
    }
  }

  for (const rulePath of await discoverRuleFiles(path.join(home, 'rules'))) {
    const content = await tryRead(rulePath)
    if (content) {
      files.push({ path: rulePath, content: await resolveIncludes(content, rulePath, new Set([rulePath])) })
    }
  }

  // 再从父目录向下查找
  for (const dir of dirs) {
    for (const name of CANDIDATES_PER_DIR) {
      const filePath = path.join(dir, name)
      const content = await tryRead(filePath)
      if (content) {
        files.push({ path: filePath, content: await resolveIncludes(content, filePath, new Set([filePath])) })
      }
    }

    for (const rulePath of await discoverRuleFiles(path.join(dir, '.mini-code', 'rules'))) {
      const content = await tryRead(rulePath)
      if (content) {
        files.push({ path: rulePath, content: await resolveIncludes(content, rulePath, new Set([rulePath])) })
      }
    }
  }

  return dedupe(files)
}

// 给文件数组生成可读元信息
export function describeMemoryFiles(files: ContextFile[], cwd = process.cwd()): MemoryFileInfo[] {
  return files.map(file => {
    const normalized = file.path.split(path.sep).join('/')
    const scope = normalized.includes('/rules/')
      ? 'rules'
      : path.resolve(file.path).startsWith(path.resolve(MINI_CODE_DIR))
        ? 'global'
        : 'project'
    const trimmed = file.content.trim()
    return {
      ...file,
      path: path.isAbsolute(file.path) ? path.relative(cwd, file.path) || file.path : file.path,
      scope,
      lineCount: trimmed ? trimmed.split('\n').length : 0,
      charCount: file.content.length,
      preview: trimmed.split('\n')[0] || '<empty>',
    }
  })
}

// 生成人类可读的扫描报告文本
export function renderMemoryReport(files: ContextFile[], cwd = process.cwd()): string {
  if (files.length === 0) return 'No memory files loaded.'

  const infos = describeMemoryFiles(files, cwd)
  return [
    `Memory files loaded: ${infos.length}`,
    '',
    ...infos.map((file, index) => [
      `${index + 1}. ${file.path}`,
      `   scope: ${file.scope}`,
      `   lines: ${file.lineCount}`,
      `   chars: ${file.charCount}`,
      `   preview: ${file.preview}`,
    ].join('\n')),
  ].join('\n\n')
}

function renderScope(filePath: string): string {
  const base = path.basename(filePath)
  const dir = path.dirname(filePath)
  return `${base} (scope: ${dir})`
}

export async function loadMemory(cwd: string, homeDir?: string, scanRoot?: string): Promise<string> {
  // 加载全部规则文件
  const files = await discoverInstructionFiles(cwd, homeDir, scanRoot)
  if (files.length === 0) return ''

  const sections: string[] = ['# Instructions']
  let remaining = MAX_TOTAL_CHARS
  // 逐文件获取内容，同时检验单文件内容长度以及整体内容长度不能朝向
  for (const file of files) {
    if (remaining <= 0) {
      sections.push('_Additional instruction content omitted after reaching the prompt budget._')
      break
    }

    const truncated = truncateTo(file.content, Math.min(MAX_PER_FILE_CHARS, remaining))
    sections.push(`## ${renderScope(file.path)}\n\n${truncated}`)
    remaining -= truncated.length
  }
  // 最后返回拼接好的完整指令字符串，直接喂给大模型作为系统提示词
  return sections.join('\n\n')
}