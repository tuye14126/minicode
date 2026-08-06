import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type MiniCodeSettings = {
  model?: string
  env?: Record<string, string>
  maxOutPutTokens?: number
}

export type RuntimeConfig = {
  model: string
  baseUrl: string
  apiKey: string
  sourceSummary: string
}

export const MINI_CODE_DIR = process.env.MINI_CODE_HOME
  ? path.resolve(process.env.MINI_CODE_HOME)
  : path.join(homedir(), '.mini-code')

export const MINI_CODE_SETTINGS_PATH = path.join(MINI_CODE_DIR, "settings.json")

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
  mkdirSync(MINI_CODE_DIR, { recursive: true })
  writeFileSync(MINI_CODE_SETTINGS_PATH, JSON.stringify(after, null, 2) + '\n', 'utf-8')
}

export function loadRuntimeConfig(): RuntimeConfig {
  const settings = readMiniCodeSettings()
  const mergeEnv = {
    ...(settings.env ?? {}),
    ...process.env
  }
  const model =
    mergeEnv.MINI_CODE_MODEL?.trim() ||
    settings.model?.trim() ||
    mergeEnv.OPENAI_MODEL?.trim() ||
    "deepseek-v4-flash"
  const baseUrl =
    mergeEnv.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  const apiKey = mergeEnv.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("缺少 OPENAI_API_KEY：请在 .env 或 ~/.mini-code/settings.json 中配置")
  }
  return {
    model,
    baseUrl,
    apiKey,
    sourceSummary: "env > ~/.mini-code/settings.json",
  }
}

