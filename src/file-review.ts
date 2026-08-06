import { createTwoFilesPatch } from "diff"
import { askUserPrompt } from "./user-prompt.js"

export function buildUnifiedDiff(
  filePath: string,
  before: string,
  after: string
): string {
  if (before === after) {
    return ""
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

export async function confirmDiff(
  filePath: string,
  diff: string
): Promise<boolean> {
  const promptText = [
    '─'.repeat(50),
    `📝 修改预览: ${filePath}`,
    '─'.repeat(50),
    diff,
    '─'.repeat(50),
    '是否应用以上更改？(y/n): ',
  ].join('\n')
  const answer = (await askUserPrompt(promptText)).toLowerCase()
  return answer === 'y' || answer === 'yes'
}
