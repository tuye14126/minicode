import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { askUserPrompt } from './user-prompt.js'

const PERMISSIONS_PATH = path.join(homedir(), '.mini-code', 'permissions.json')
type PermissionStore = {
  allowedCommands: string[],
  deniedCommands: string[],
  allowedDirectories: string[]
}
const INTERPRETERS = new Set([
  'node', 'node.exe',
  'python', 'python.exe', 'python3', 'python3.exe', 'py',
  'bash', 'sh', 'zsh', 'fish',
  'powershell', 'pwsh', 'pwsh.exe',
  'cmd', 'cmd.exe',
  'perl', 'ruby', 'php', 'bun',
])
/**
 * 把命令按 shell 运算符拆成多个命令段。
 * 引号和转义内的 | ; & 不会被拆分。
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | null = null
  let escaped = false
  let i = 0

  while (i < command.length) {
    const char = command[i]

    if (escaped) {
      current += char
      escaped = false
      i++
      continue
    }

    if (char === '\\') {
      escaped = true
      current += char
      i++
      continue
    }

    if (quote) {
      current += char
      if (char === quote) quote = null
      i++
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      current += char
      i++
      continue
    }

    // 引号外的 shell 分隔符
    if (char === ';' || char === '\n' || char === '|' || char === '&' || char === '(' || char === ')') {
      if (current.trim()) segments.push(current.trim())
      current = ''
      i++
      // 跳过连续的 | & （如 && 和 ||）
      while (i < command.length && (command[i] === '|' || command[i] === '&')) i++
      continue
    }

    current += char
    i++
  }

  if (current.trim()) segments.push(current.trim())
  return segments
}

/**
 * 把命令段解析成命令名 + 参数列表，同时去掉引号。
 */
function parseCommandSegment(segment: string): { name: string; args: string[] } {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  let escaped = false

  for (const char of segment) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) tokens.push(current)

  return { name: tokens[0] ?? '', args: tokens.slice(1) }
}

/**
 * 检查单个命令段，返回危险原因；安全返回 null。
 */
function checkSegment(segment: string): string | null {
  // 命令替换 / 子 shell：$(...) 或反引号，可执行任意代码
  if (/[$][(]/.test(segment) || /`/.test(segment)) {
    return '命令中包含命令替换 $(...) 或反引号，可执行任意代码'
  }

  const { name, args } = parseCommandSegment(segment)
  const commandName = name.toLowerCase().split(/[\\/]/).pop() ?? ''

  // 解释器：node/python/bash 等，参数无法静态判断是否安全
  if (INTERPRETERS.has(commandName)) {
    return `${name} 是解释器，可以执行任意代码`
  }

  // 提权
  if (commandName === 'sudo' || commandName === 'doas') {
    return 'sudo/doas 会以更高权限执行命令'
  }

  // git 危险操作
  if (commandName === 'git') {
    if (args.includes('reset') && args.includes('--hard')) {
      return 'git reset --hard 会丢弃本地未提交的修改'
    }
    if (args.includes('clean')) {
      return 'git clean 会删除未跟踪的文件'
    }
    if (args.includes('push') && (args.includes('--force') || args.includes('-f'))) {
      return 'git push --force 会重写远程历史'
    }
    if (args.includes('checkout') && args.includes('--')) {
      return 'git checkout -- 会覆盖工作区文件'
    }
    if (args.includes('restore') && args.some(a => a.startsWith('--source'))) {
      return 'git restore --source 会覆盖本地文件'
    }
  }

  // 删除
  if (commandName === 'rm') {
    const flags = args.filter(a => a.startsWith('-')).join('')
    if (flags.includes('r') || flags.includes('f') || args.length === 1) {
      return 'rm 会永久删除文件'
    }
  }
  if (commandName === 'del' || commandName === 'rd' || commandName === 'rmdir') {
    if (args.some(a => /^\/[sq]/i.test(a) || /^-[sq]/i.test(a))) {
      return `${name} 会递归/静默删除文件`
    }
  }

  // 发布
  if (commandName === 'npm' && args.includes('publish')) {
    return 'npm publish 会把包发布到公共仓库'
  }

  return null
}
// 路径检查
export function isInsideWorkspace(targetPath: string, workspace: string): boolean {
  const relative = path.relative(workspace, path.resolve(targetPath))
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}
export function classifyDangerousCommand(command: string): string | null {
  const segments = splitShellSegments(command)
  for (const segment of segments) {
    const reason = checkSegment(segment)
    if (reason) {
      return `${reason}\n  危险命令段: ${segment}`
    }
  }
  return null
}


function loadStore(): PermissionStore {
  try {
    if (existsSync(PERMISSIONS_PATH)) {
      return JSON.parse(readFileSync(PERMISSIONS_PATH, 'utf-8'))
    }
  } catch { }
  return { allowedCommands: [], deniedCommands: [], allowedDirectories: [] }
}
function saveStore(store: PermissionStore) {
  mkdirSync(path.dirname(PERMISSIONS_PATH), { recursive: true })
  writeFileSync(PERMISSIONS_PATH, JSON.stringify(store, null, 2), 'utf-8')
}
async function askPermission(prompt: string): Promise<string> {
  const answer = (await askUserPrompt(prompt)).trim().toLowerCase()
  if (answer === 'a') return 'allow_always'
  if (answer === 'n') return 'deny_once'
  if (answer === 'd') return 'deny_always'
  return 'allow_once'
}



export async function checkCommandPermission(command: string): Promise<{
  allowed: boolean
  output?: string
}> {
  const reason = classifyDangerousCommand(command)
  if (!reason) {
    return { allowed: true }
  }

  const devStore = loadStore()
  if (devStore.allowedCommands.includes(command)) {
    return { allowed: true }
  }
  if (devStore.deniedCommands.includes(command)) {
    return { allowed: false, output: `命令被永久拒绝: ${command}` }
  }


  const choice = await askPermission([
    '⚠️  危险命令检测',
    `  命令: ${command}`,
    `  原因: ${reason}`,
    '',
    '如何处理？(y=允许一次 / a=总是允许 / n=拒绝一次 / d=总是拒绝): ',
  ].join('\n'))

  if (choice === 'allow_once') {
    return { allowed: true }
  }
  if (choice === 'allow_always') {
    devStore.allowedCommands.push(command)
    saveStore(devStore)
    return { allowed: true }
  }
  if (choice === 'deny_always') {
    devStore.deniedCommands.push(command)
    saveStore(devStore)
    return { allowed: false, output: `命令已被永久拒绝: ${command}` }
  }

  return { allowed: false, output: '用户拒绝了命令执行' }
}

/*
 * 路径权限检查：
 * 1. 在工作目录内 → 放行
 * 2. 在工作目录外 → 查持久化允许目录 → 没有则问用户
 */

export async function checkPathAccess(
  targetPath: string,
  workspace: string
): Promise<{
  allowed: boolean
  output?: string
}> {
  const resolved = path.resolve(targetPath)
  if (isInsideWorkspace(resolved, workspace)) {
    return { allowed: true }
  }
  const store = loadStore()
  const allowed = store.allowedDirectories.some(dir =>
    isInsideWorkspace(resolved, dir),
  )
  if (allowed) {
    return { allowed: true }
  }


  const choice = await askPermission([
    '⚠️  路径访问请求（工作目录外）',
    `  目标: ${resolved}`,
    `  工作目录: ${workspace}`,
    '',
    '如何处理？(y=允许一次 / a=总是允许该目录 / n=拒绝): ',
  ].join('\n'))

  if (choice === 'allow_once') {
    return { allowed: true }
  }
  if (choice === 'allow_always') {
    store.allowedDirectories.push(path.dirname(resolved))
    saveStore(store)
    return { allowed: true }
  }

  return { allowed: false, output: `路径访问被拒绝: ${resolved}` }
}
