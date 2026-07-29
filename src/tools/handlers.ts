import { execSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"



type ToolResult = {
  success: boolean
  output: string
}

export const TOOL_HANDLERS: Record<string, (args: any) => ToolResult> = {
  read_file: (args) => {
    try {
      const content = readFileSync(args.path, 'utf-8')
      return { success: true, output: content }
    } catch (e: any) {
      return { success: false, output: `读取文件失败: ${e.message}` }
    }
  },
  write_file: (args) => {
    try {
      writeFileSync(args.path, args.content, 'utf-8')
      return { success: true, output: `文件${args.path}写入成功` }
    } catch (e: any) {
      return { success: false, output: `读取文件失败: ${e.message}` }
    }
  },
  run_command: (args) => {
    try {
      const output = execSync(args.command, {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: process.cwd(),
        shell: "bash.exe"
      })
      return { success: true, output: output || "命令执行完毕, 无输出" }
    } catch (e: any) {
      return { success: false, output: `命令执行失败: ${e.message}\n${e.stdout || ''}\n${e.stderr || ''}` }
    }
  },
  list_files: (args) => {
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
  grep_files: (args) => {
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
  }
}