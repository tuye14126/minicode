import { execSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { buildUnifiedDiff, confirmDiff } from "../file-review.js"
import { checkCommandPermission, checkPathAccess } from "../permissions.js"


type ToolResult = {
  success: boolean
  output: string
}

type ToolContext = {
  workspace: string
}

type ToolHandler = (args: any, ctx: ToolContext) => ToolResult | Promise<ToolResult>

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  read_file: async (args, ctx) => {
    const access = await checkPathAccess(args.path, ctx.workspace)
    if (!access.allowed) {
      return { success: false, output: access.output || '路径访问被拒绝' }
    }
    try {
      const content = readFileSync(args.path, 'utf-8')
      return { success: true, output: content }
    } catch (e: any) {
      return { success: false, output: `读取文件失败: ${e.message}` }
    }
  },
  write_file: async (args, ctx) => {
    const access = await checkPathAccess(args.path, ctx.workspace)
    if (!access.allowed) {
      return { success: false, output: access.output || '路径访问被拒绝' }
    }
    try {
      let oldContent = ''
      try { oldContent = readFileSync(args.path, 'utf-8') } catch { /* 新文件 */ }
      if (oldContent) {
        const diff = buildUnifiedDiff(args.path, oldContent, args.content)
        if (diff) {
          const ok = await confirmDiff(args.path, diff)
          if (!ok) return { success: false, output: '用户拒绝了写入' }
        }
      }
      writeFileSync(args.path, args.content, 'utf-8')
      return { success: true, output: `文件${args.path}写入成功` }
    } catch (e: any) {
      return { success: false, output: `读取文件失败: ${e.message}` }
    }
  },
  run_command: async (args, ctx) => {
    const permission = await checkCommandPermission(args.command)
    if (!permission.allowed) {
      return { success: false, output: permission.output || '用户拒绝了命令执行' }
    }
    try {
      console.log(`执行命令${args.command}`);

      const output = execSync(args.command, {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: ctx.workspace,
        shell: process.platform === 'win32' ? 'cmd.exe' : 'bash.exe'
      })
      return { success: true, output: output || "命令执行完毕, 无输出" }
    } catch (e: any) {
      return { success: false, output: `命令执行失败: ${e.message}\n${e.stdout || ''}\n${e.stderr || ''}` }
    }
  },
  list_files: async (args, ctx) => {
    const access = await checkPathAccess(args.path, ctx.workspace)
    if (!access.allowed) {
      return { success: false, output: access.output || '路径访问被拒绝' }
    }
    try {
      const dir = args.path || "."
      const items = readdirSync(dir, { withFileTypes: true })
      const file_list = items.map(item => {
        const type = item.isDirectory() ? '📁' : '📄'
        return `${type} ${item.name}`
      })
      return { success: true, output: file_list.join('\n') }
    } catch (e: any) {
      return { success: false, output: `列出目录失败: ${e.message}` }
    }
  },
  grep_files: async (args, ctx) => {
    const access = await checkPathAccess(args.path, ctx.workspace)
    if (!access.allowed) {
      return { success: false, output: access.output || '路径访问被拒绝' }
    }
    try {
      const pattern = args.pattern
      const searchPath = args.path || '.'
      const isWin = process.platform === 'win32'
      const cmd = isWin
        ? `findstr /s /n /c: "${pattern}" "${searchPath}\\*"`
        : `grep -rn "${pattern}" "${searchPath}"`
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 })
      return { success: true, output: output || "无匹配结果" }
    } catch (e: any) {
      if (e.status === 1) return { success: true, output: "无匹配结果" }
      return { success: false, output: `搜索失败:${e.message}` }
    }
  },
  edit_file: async (args, ctx) => {
    const access = await checkPathAccess(args.path, ctx.workspace)
    if (!access.allowed) {
      return { success: false, output: access.output || '路径访问被拒绝' }
    }
    try {
      const content = readFileSync(args.path, 'utf-8')
      const lines = content.split('\n')
      const matchIndex = lines.findIndex(line => line.includes(args.search))
      if (matchIndex === -1) {
        return {
          success: false,
          output: `在 ${args.path} 中未找到:\n  "${args.search}"`,
        }
      }
      lines[matchIndex] = lines[matchIndex].replace(args.search, args.replace)
      const newContent = lines.join('\n')

      const diff = buildUnifiedDiff(args.path, content, newContent)
      if (diff) {
        const ok = await confirmDiff(args.path, diff)
        if (!ok) return { success: false, output: '用户拒绝了修改' }
      }
      writeFileSync(args.path, newContent, 'utf-8')
      return {
        success: true,
        output: `已修改 ${args.path} (第 ${matchIndex + 1} 行)\n${diff}`,
      }
    } catch (e: any) {
      return { success: false, output: `编辑失败: ${e.message}` }
    }
  },
  patch_file: async (args, ctx) => {
    const access = await checkPathAccess(args.path, ctx.workspace)
    if (!access.allowed) {
      return { success: false, output: access.output || '路径访问被拒绝' }
    }
    try {
      const content = readFileSync(args.path, 'utf-8')
      let newContent = content

      for (const r of args.replacements) {
        if (!newContent.includes(r.search)) {
          return {
            success: false,
            output: `未找到要替换的文本:\n  "${r.search}"`,
          }
        }
        newContent = newContent.replace(r.search, r.replace)
      }

      const diff = buildUnifiedDiff(args.path, content, newContent)
      if (diff) {
        const ok = await confirmDiff(args.path, diff)
        if (!ok) return { success: false, output: '用户拒绝了修改' }
      }
      writeFileSync(args.path, newContent, 'utf-8')

      return {
        success: true,
        output: `已应用 ${args.replacements.length} 处替换:\n${diff}`,
      }
    } catch (e: any) {
      return { success: false, output: `批量替换失败: ${e.message}` }
    }
  },
  modify_file: async (args, ctx) => {
    const access = await checkPathAccess(args.path, ctx.workspace)
    if (!access.allowed) {
      return { success: false, output: access.output || '路径访问被拒绝' }
    }
    try {
      let oldContent = ''
      try {
        oldContent = readFileSync(args.path, 'utf-8')
      } catch { }
      const diff = buildUnifiedDiff(args.path, oldContent, args.content)
      if (diff) {
        const ok = await confirmDiff(args.path, diff)
        if (!ok) return { success: false, output: '用户拒绝了修改' }
      }
      writeFileSync(args.path, args.content, 'utf-8')
      return { success: true, output: `${args.path} 已更新` }
    } catch (e: any) {
      return { success: false, output: `修改失败: ${e.message}` }
    }
  }
}