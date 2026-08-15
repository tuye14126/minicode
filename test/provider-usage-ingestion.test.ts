import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { ChatMessage, ModelAdapter, AgentStep } from "../src/types.js";
import { runAgentTurn } from "../src/agent-loop.js";
import { ToolRegistry } from "../src/tools.js";
import { tokenCountWithEstimation } from "../src/utils/token-estimator.js";
import assert from "node:assert";

let workspace: string  // 模拟工作区

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'minicode-test'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})


test("测试模型返回的token消耗", async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Hello' },
  ]
  const adapter: ModelAdapter = {
    async next(): Promise<AgentStep> {
      return {
        type: 'assistant',
        content: 'Hi',
        usage: {
          inputTokens: 42,
          outputTokens: 8,
          totalTokens: 50,
          source: 'test',
        },
      }
    },
  }

  const result = await runAgentTurn({
    messages,
    tools: new ToolRegistry([]),
    model: adapter,
    cwd: workspace
  })
  let totalTokens = 0
  const lastMessage = result.at(-1)
  if (lastMessage?.role === 'assistant') {
    totalTokens = lastMessage.providerUsage?.totalTokens ?? 0
  }
  const accounting = tokenCountWithEstimation(result)
  assert.equal(result.at(-1)?.role, 'assistant')
  assert.equal(totalTokens, 50)
  assert.equal(accounting.source, 'provider_usage')
  assert.equal(accounting.totalTokens, 50)
})