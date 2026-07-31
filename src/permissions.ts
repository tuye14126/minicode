import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const PERMISSIONS_PATH = path.join(homedir(), '.minicode', 'permissions.json')
type PermissionChoice = 'allow_once' | 'allow_always' | 'deny_once' | 'deny_always'
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
// 路径检查
export function isInsideWorkspace(targetPath: string, workspace: string): boolean {
  const relative = path.relative(workspace, path.resolve(targetPath))
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}
function classifyDangerousCommand(command: string): string | null {
  if (command.includes('git reset --hard')) {
    return 'git reset --hard 会丢弃本地未提交的修改'
  }
  if (command.includes('git clean')) {
    return 'git clean 会删除未跟踪的文件'
  }
  if (command.includes('git push --force') || command.includes('git push -f')) {
    return 'git push --force 会重写远程历史'
  }
  if (command.includes('git checkout --')) {
    return 'git checkout -- 会覆盖工作区文件'
  }
  // 删除操作
  if (/^rm\s+-rf?\s+/i.test(command.trim())) {
    return 'rm -rf 会永久删除文件'
  }

  // 发布操作
  if (command.includes('npm publish')) {
    return 'npm publish 会把包发布到公共仓库'
  }

  // 任意代码执行 — 按空格分隔后检查是否包含解释器
  const parts = command.trim().split(/\s+/)
  if (parts.some(part => INTERPRETERS.has(part))) {
    return '该命令可以执行任意代码'
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
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase()
    if (answer === 'a') return 'allow_always'
    if (answer === 'n') return 'deny_once'
    if (answer === 'd') return 'deny_always'
    return 'allow_once' // 默认 y / 其他都算允许一次
  } finally {
    rl.close()
  }
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
  console.log('')
  console.log('⚠️  危险命令检测:')
  console.log(`  命令: ${command}`)
  console.log(`  原因: ${reason}`)
  console.log('')

  const choice = await askPermission(
    '如何处理？(y=允许一次 / a=总是允许 / n=拒绝一次 / d=总是拒绝): ',
  )

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
  console.log('')
  console.log('⚠️  路径访问请求（工作目录外）')
  console.log(`  目标: ${resolved}`)
  console.log(`  工作目录: ${workspace}`)
  console.log('')

  const choice = await askPermission(
    '如何处理？(y=允许一次 / a=总是允许该目录 / n=拒绝): ',
  )

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
