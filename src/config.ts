import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type MiniCodeSettings = {
  model?: string
  env?: Record<string, string>
  maxOutputTokens?: number
}

export type RuntimeConfig = {
  model: string
  baseUrl: string
  apiKey: string
  authToken?: string
  modelMode: string
  maxOutputTokens?: number
  sourceSummary: string
}

export function getMiniCodeDir(): string {
  return process.env.MINI_CODE_HOME
    ? path.resolve(process.env.MINI_CODE_HOME)
    : path.join(homedir(), '.mini-code')
}
export function getMiniCodeSettingsPath(): string {
  return path.join(getMiniCodeDir(), "settings.json")
}

export function readMiniCodeSettings(): MiniCodeSettings {
  try {
    const content = readFileSync(getMiniCodeSettingsPath(), 'utf-8')
    const jsonParse = JSON.parse(content)
    if (jsonParse && typeof jsonParse === 'object') {
      return jsonParse as MiniCodeSettings
    }
  } catch { }
  return {}
}

export function saveMiniCodeSettings(updates: MiniCodeSettings) {
  const exists = readMiniCodeSettings()
  const after = {
    ...exists,
    ...updates,
    env: {
      ...(exists.env ?? {}),
      ...(updates.env ?? {})
    }
  }
  mkdirSync(getMiniCodeDir(), { recursive: true })
  writeFileSync(getMiniCodeSettingsPath(), JSON.stringify(after, null, 2) + '\n', 'utf-8')
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

