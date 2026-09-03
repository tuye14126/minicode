import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { ChatMessage } from "../types.js"
import { getMiniCodeDir } from "../config.js"
import { mkdir, writeFile } from "node:fs/promises"



export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'

export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000
export const MAX_TOOL_RESULTS_PER_BATCH_CHARS = 200_000

export const TOOL_RESULTS_SUBDIR = 'tool-results'
export const PREVIEW_SIZE_CHARS = 2_000

export type ToolResultReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}

export type PendingToolResult = Extract<ChatMessage, { role: 'tool_result' }>
// 全局工具结果落盘状态
export type ContentReplacementState = {
  seenIds: Set<string>  // 已落盘的工具调用toolUseId
  replacements: Map<string, string> // toolUseId 与 替换文本之间的映射
}

type ReplacementCandidate = {
  toolUseId: string
  content: string
  size: number
}


// 将工具结果转换为文本
export function normalizeToolResultContent(content: unknown): string {
  if (content == null) return ''
  return typeof content === 'string' ? content : String(content)
}
// 判断工具结果是否已经落盘替换
function isAlreadyPersistedOutput(content: string): boolean {
  return content.startsWith(PERSISTED_OUTPUT_TAG)
}


const sessionId = sanitizePathSegment(randomUUID())

function getToolResultsDir(): string {
  return path.join(getMiniCodeDir(), TOOL_RESULTS_SUBDIR, sessionId)
}

// 对文件路径中的非法字符进行过滤
function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '_')
  return sanitized.length > 0 ? sanitized : randomUUID()
}

// 获取落盘文件的路径
function getToolResultPath(toolUseId: string): string {
  const dir = getToolResultsDir()
  const filepath = path.resolve(dir, `${sanitizePathSegment(toolUseId)}.txt`)
  const relative = path.relative(dir, filepath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.join(dir, `${randomUUID()}.txt`)
  }
  return filepath
}
// 生成预览文本内容
function generatePreview(content: string): { preview: string; hasMore: boolean } {
  if (content.length <= PREVIEW_SIZE_CHARS) {
    return { preview: content, hasMore: false }
  }

  const truncated = content.slice(0, PREVIEW_SIZE_CHARS)
  // 确保切点不会从文本中间切开, 尽量保持前后逻辑
  const lastNewline = truncated.lastIndexOf('\n')
  const cutPoint = lastNewline > PREVIEW_SIZE_CHARS * 0.5
    ? lastNewline
    : PREVIEW_SIZE_CHARS

  return {
    preview: content.slice(0, cutPoint),
    hasMore: true,
  }
}

// 工具结果落盘
async function persistToolResult(
  content: string,
  toolUseId: string,
): Promise<{ filepath: string; originalSize: number; preview: string; hasMore: boolean } | null> {
  const filepath = getToolResultPath(toolUseId)
  try {
    await mkdir(path.dirname(filepath), { recursive: true })
    await writeFile(filepath, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (code !== 'EEXIST') {
      return null
    }
  }
  // preview为从切点截断后的内容
  const { preview, hasMore } = generatePreview(content)
  return {
    filepath,
    originalSize: content.length,
    preview,
    hasMore,
  }
}
// 构造替换的消息内容
function buildPersistedToolResultMessage(result: {
  filepath: string
  originalSize: number
  preview: string
  hasMore: boolean
}): string {
  const parts = [
    PERSISTED_OUTPUT_TAG,
    `Output too large (${formatChars(result.originalSize)}). Full output saved to: ${result.filepath}`,
    '',
    `Preview (first ${formatChars(PREVIEW_SIZE_CHARS)}):`,
    result.preview,
  ]

  if (result.hasMore) {
    parts.push('...')
  }

  parts.push(PERSISTED_OUTPUT_CLOSING_TAG)
  return parts.join('\n')
}

function formatChars(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M chars`
  if (chars >= 1_000) return `${Math.round(chars / 1_000)}K chars`
  return `${chars} chars`
}

export async function replaceLargeToolResult(
  result: Omit<PendingToolResult, 'content'> & { content: unknown },
  state: ContentReplacementState,
  maybeThreshold = DEFAULT_MAX_RESULT_SIZE_CHARS
): Promise<PendingToolResult> {
  const threshold = maybeThreshold
  // 将工具结果转换为文本
  const content = normalizeToolResultContent(result.content)
  // 得到内容文本化后的工具调用结果
  const normalizedResult: PendingToolResult = {
    ...result,
    content,
  }
  // 查看之前是否已经完成过替换
  const previousReplacement = state.replacements.get(result.toolUseId)
  // 如果有, 则直接利用
  if (previousReplacement !== undefined) {
    return {
      ...normalizedResult,
      content: previousReplacement,
    }
  }
  // 如果内容为空的情况
  if (content.trim().length === 0) {
    state.seenIds.add(result.toolUseId)
    return {
      ...normalizedResult,
      content: `(${result.toolName} completed with no output)`,
    }
  }
  // 如果内容已经完成落盘替换, 则直接用
  if (isAlreadyPersistedOutput(content)) {
    state.seenIds.add(result.toolUseId)
    state.replacements.set(result.toolUseId, content)
    return normalizedResult
  }
  // 未达到落盘阈值
  if (content.length <= threshold) {
    return normalizedResult
  }
  // 开始进行工具结果落盘
  const persisted = await persistToolResult(content, result.toolUseId)
  if (!persisted) {
    return normalizedResult
  }
  // 构造消息
  const replacement = buildPersistedToolResultMessage(persisted)
  state.seenIds.add(result.toolUseId)
  state.replacements.set(result.toolUseId, replacement)

  return {
    ...normalizedResult,
    content: replacement,
  }
}

// 批量处理多个工具调用结果

export async function applyToolResultBudget(
  results: PendingToolResult[],
  state: ContentReplacementState,
  limit = MAX_TOOL_RESULTS_PER_BATCH_CHARS,
): Promise<{
  results: PendingToolResult[]  // 最后替换的结果
  newlyReplaced: ToolResultReplacementRecord[]  // 本次新增的替换记录
}> {
  // 没有需要替换落盘的结果, 直接返回
  if (results.length === 0) {
    return { results, newlyReplaced: [] }
  }

  const replacementMap = new Map<string, string>()   // 本批: toolUseId → 替换文本
  const freshCandidates: ReplacementCandidate[] = []  // 本批"新面孔"候选
  let visibleSize = 0                                 // 本批可见内容总字符数（预算记账本）

  for (const result of results) {
    const content = normalizeToolResultContent(result.content)
    const previousReplacement = state.replacements.get(result.toolUseId)

    // 之前已经被替换过的情况
    if (previousReplacement !== undefined) {
      replacementMap.set(result.toolUseId, previousReplacement)
      visibleSize += previousReplacement.length
      continue
    }

    // 之前见过但是未进行替换的情况(内容为空或者长度过低)
    if (state.seenIds.has(result.toolUseId)) {
      visibleSize += content.length
      continue
    }

    // 内容为空的情况
    if (content.trim().length === 0) {
      state.seenIds.add(result.toolUseId)
      continue
    }

    // 内容已带持久化标记, 即内容已经被替换过
    if (isAlreadyPersistedOutput(content)) {
      state.seenIds.add(result.toolUseId)
      state.replacements.set(result.toolUseId, content)
      replacementMap.set(result.toolUseId, content)
      visibleSize += content.length
      continue
    }

    // 不是上述情况, 加入落盘候选
    visibleSize += content.length
    freshCandidates.push({
      toolUseId: result.toolUseId,
      content,
      size: content.length,
    })
  }

  const newlyReplaced: ToolResultReplacementRecord[] = []
  // 所有候选按照大小降序, 一样的话按id升序
  const sortedFreshCandidates = [...freshCandidates].sort((a, b) => {
    const sizeDelta = b.size - a.size
    return sizeDelta !== 0 ? sizeDelta : a.toolUseId.localeCompare(b.toolUseId)
  })

  for (const candidate of sortedFreshCandidates) {
    // 当达到可视文本限制内时停止
    if (visibleSize <= limit) break

    // 对候选进行落盘
    const persisted = await persistToolResult(candidate.content, candidate.toolUseId)
    state.seenIds.add(candidate.toolUseId)
    if (!persisted) {
      continue
    }
    // 成功落盘后进行记录
    const replacement = buildPersistedToolResultMessage(persisted)
    replacementMap.set(candidate.toolUseId, replacement)
    state.replacements.set(candidate.toolUseId, replacement)

    // 重新计算可视文本数量, 减去旧文本长度, 加上替换后的新文本长度
    visibleSize = visibleSize - candidate.size + replacement.length
    newlyReplaced.push({
      kind: 'tool-result',
      toolUseId: candidate.toolUseId,
      replacement,
    })
  }


  for (const candidate of freshCandidates) {
    state.seenIds.add(candidate.toolUseId)   // 所有候选（含未被替换的）都标记 seen
  }

  if (replacementMap.size === 0) {
    return { results, newlyReplaced }
  }

  return {
    results: results.map(result => {
      const replacement = replacementMap.get(result.toolUseId)
      return replacement === undefined
        ? result
        : { ...result, content: replacement }
    }),
    newlyReplaced
  }
}