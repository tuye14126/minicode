import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { isEnoentError } from "./utils/errors.js"

export type MiniCodeSettings = {
  model?: string
  env?: Record<string, string>
  maxOutputTokens?: number
}

export type RuntimeConfig = {
  model: string
  baseUrl: string
  apiKey?: string
  authToken?: string
  modelMode?: string
  maxOutputTokens?: number
  sourceSummary: string
}

export function getMiniCodeDir(): string {
  return process.env.MINI_CODE_HOME
    ? path.resolve(process.env.MINI_CODE_HOME)
    : path.join(homedir(), '.mini-code')
}

export const MINI_CODE_PROJECTS_DIR = path.join(getMiniCodeDir(), 'projects')
export const MINI_CODE_PERMISSIONS_PATH = path.join(getMiniCodeDir(), 'permissions.json')
export const MINI_CODE_SETTINGS_PATH = path.join(getMiniCodeDir(), 'settings.json')
export const CLAUDE_SETTINGS_PATH = path.join(homedir(), '.claude', 'settings.json')


export function readMiniCodeSettings(): MiniCodeSettings {
  try {
    const content = readFileSync(MINI_CODE_SETTINGS_PATH, 'utf-8')
    const jsonParse = JSON.parse(content)
    if (jsonParse && typeof jsonParse === 'object') {
      return jsonParse as MiniCodeSettings
    }
  } catch { }
  return {}
}

async function readSettingsFile(filePath: string): Promise<MiniCodeSettings> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as MiniCodeSettings
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

function mergeSettings(
  base: MiniCodeSettings,
  override: MiniCodeSettings,
): MiniCodeSettings {
  // const mergedMcpServers = {
  //   ...(base.mcpServers ?? {}),
  // }

  // for (const [name, server] of Object.entries(override.mcpServers ?? {})) {
  //   mergedMcpServers[name] = {
  //     ...(mergedMcpServers[name] ?? {}),
  //     ...server,
  //     env: {
  //       ...(mergedMcpServers[name]?.env ?? {}),
  //       ...(server.env ?? {}),
  //     },
  //     headers: {
  //       ...(mergedMcpServers[name]?.headers ?? {}),
  //       ...(server.headers ?? {}),
  //     },
  //   }
  // }

  return {
    ...base,
    ...override,
    env: {
      ...(base.env ?? {}),
      ...(override.env ?? {}),
    },
    // mcpServers: mergedMcpServers,
  }
}

export async function saveMiniCodeSettings(
  updates: MiniCodeSettings,
): Promise<void> {
  await mkdir(getMiniCodeDir(), { recursive: true })
  const existing = await readSettingsFile(MINI_CODE_SETTINGS_PATH)
  const next = mergeSettings(existing, updates)
  await writeFile(
    MINI_CODE_SETTINGS_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8',
  )
}

export async function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<RuntimeConfig> {
  const settings = readMiniCodeSettings()
  const mergeEnv = {
    ...(settings.env ?? {}),
    ...env
  }
  const model =
    mergeEnv.MINI_CODE_MODEL?.trim() ||
    settings.model?.trim() ||
    mergeEnv.ANTHROPIC_MODEL?.trim() ||
    "deepseek-v4-flash"
  const baseUrl =
    mergeEnv.ANTHROPIC_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  const apiKey = mergeEnv.ANTHROPIC_API_KEY?.trim() || ''
  const modelMode = mergeEnv.MINI_CODE_MODEL_MODE?.trim() || ''
  if (!apiKey && modelMode !== 'mock') {
    throw new Error("缺少 ANTHROPIC_API_KEY:请在 .env 或 ~/.mini-code/settings.json 中配置")
  }
  return {
    model,
    baseUrl,
    apiKey,
    modelMode,
    sourceSummary: "env > ~/.mini-code/settings.json",
  }
}

