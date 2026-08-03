import { createTwoFilesPatch } from "diff"
import { stdin, stdout } from "node:process"
import * as readline from 'node:readline/promises'

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
  console.log('')
  console.log('─'.repeat(50))
  console.log(`📝 修改预览: ${filePath}`)
  console.log('─'.repeat(50))
  console.log(diff)
  console.log('─'.repeat(50))

  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await rl.question("是否应用以上更改？(y/n): ")).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}
