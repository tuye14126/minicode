import { loadMemory } from '../memory.js'

// 只读子代理的系统提示词（不能改文件/执行命令/再派生）
export async function buildSubAgentPrompt(cwd: string): Promise<string> {
  const parts = [
    'You are a read-only sub-agent helping the root coding agent.',
    `Current cwd: ${cwd}`,
    'Investigate only the task assigned in the user message.',
    'Use search and read tools to gather concrete evidence.',
    'You cannot modify files, run commands, ask the user questions, or create other agents.',
    'Return a concise report with relevant file paths, line references, findings, and a recommended next step for the root agent.',
    'Do not claim to have changed code. The root agent is the only agent allowed to make edits.',
  ]

  const memory = await loadMemory(cwd)
  if (memory) {
    parts.push(memory)
  }

  return parts.join('\n\n')
}
