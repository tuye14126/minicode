export const MAX_SUB_AGENTS = 3
export const MAX_SUB_AGENT_STEPS = 20

// 主 Agent 可以一次性启动最多 3 个子 Agent，每个子 Agent 最多跑 20 步；
// 调用`waitForSubAgents`函数等待所有子 Agent 结束，返回是否超时 + 全部子 Agent 快照，用于后续汇总结果
export type SubAgentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'closed'


// 子 Agent 运行快照（用于记录、持久化、展示）
export type SubAgentSnapshot = {
  id: string
  task: string
  status: SubAgentStatus
  startedAt: number
  finishedAt?: number
  result?: string
  error?: string
}
// 等待一批子 Agent 完成后的返回结果
export type WaitForSubAgentsResult = {
  timedOut: boolean
  agents: SubAgentSnapshot[]
}
