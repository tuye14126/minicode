import assert from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach } from "node:test"

let homedir: string

beforeEach(() => {
  homedir = mkdtempSync(path.join(tmpdir(), 'minicode-test-'))
  process.env.MINI_CODE_HOME = homedir
})

afterEach(() => {
  delete process.env.MINI_CODE_HOME
  rmSync(homedir, { recursive: true, force: true })
})

test("settings.json合并与env覆盖", async () => {
  const config = await import('../src/config.js')
  writeFileSync(path.join(homedir, "settings.json"), JSON.stringify({
    model: 'from-settings',
    env: { ANTHROPIC_BASE_URL: 'https://from-settings.test', ANTHROPIC_API_KEY: 'settings-key' }
  }))
  const runtime = await config.loadRuntimeConfig({
    ...process.env,
    MINI_CODE_MODEL: 'from-env'
  })
  assert.equal(runtime.model, 'from-env')
  assert.equal(runtime.baseUrl, 'https://from-settings.test')
  assert.equal(runtime.apiKey, 'settings-key')
})