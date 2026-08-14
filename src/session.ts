import path from "node:path"
import { homedir } from "node:os"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { ChatMessage } from "./types.js"

const MINI_CODE_DIR = path.join(homedir(), '.mini-code')
const PROJECTS_DIR = path.join(MINI_CODE_DIR, 'projects')

function projectDirName(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, '-').replace(/^-+/, '')
}

function projectDir(cwd: string): string {
  return path.join(PROJECTS_DIR, projectDirName(cwd))
}

function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(projectDir(cwd), `${sessionId}.jsonl`)
}

export function saveSession(
  messages: ChatMessage[],
  sessionId: string,
  cwd: string
): void {
  const file = sessionFilePath(cwd, sessionId)
  const dir = path.dirname(file)

  mkdirSync(dir, { recursive: true })
  let saveCount = 0
  if (existsSync(file)) {
    saveCount = readFileSync(file, 'utf-8').trim()
      .split('\n').filter(Boolean).length
  }


  const toSave = messages.slice(saveCount + 1)
  if (toSave.length === 0) return

  appendFileSync(
    file,
    toSave.map(message => JSON.stringify(message)).join('\n') + '\n',
    'utf-8'
  )
}

export function loadSession(
  sessionId: string,
  cwd: string
): ChatMessage[] | null {
  const file = sessionFilePath(cwd, sessionId)
  if (!existsSync(file)) return null
  const lines = readFileSync(file, 'utf-8').trim()
    .split('\n').filter(Boolean)
  if (lines.length === 0) return null
  return lines.map(message => JSON.parse(message) as ChatMessage)
}

export function listSessions(cwd: string) {
  const dir = projectDir(cwd)
  if (!existsSync(dir)) return []

  const sessions = readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => {
      const id = name.slice(0, -6)
      const file = path.join(dir, name)
      const messageCount = readFileSync(file, 'utf-8').trim().split('\n')
        .filter(Boolean).length
      return { id, messageCount, updatedAt: statSync(file).mtimeMs }
    })
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}