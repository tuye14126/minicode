import * as readline from 'node:readline/promises'

export type UserPromptFn = (promptText: string) => Promise<string>

let promptFn: UserPromptFn = async (promptText: string) => {
  console.log(promptText);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question("")).trim()
  } finally {
    rl.close()
  }

}

export function setUserPromptFn(fn: UserPromptFn): void {
  promptFn = fn
}

export function askUserPrompt(promptText: string): Promise<string> {
  return promptFn(promptText)
}