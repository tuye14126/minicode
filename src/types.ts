

export type ProviderUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  source: string
}


export type ProviderUsageMetadata = {
  providerUsage?: ProviderUsage
  usageStale?: boolean
  usageStaleReason?: string
}

export type ProviderThinkingBlock = {
  type: 'thinking' | 'redacted_thinking'
  [key: string]: unknown
}

export type MessageIdentity = {
  id?: string
}

/*中间抽象层, 将用户消息, 工具消息包装为ChatMessage格式传给模型服务商
模型服务商的消息再解析包装为ChatMessage传给agent*/
export type ChatMessage =
  | ({ role: 'system', content: string } & MessageIdentity)
  | ({ role: 'user', content: string } & MessageIdentity)
  | ({ role: 'assistant_thinking', blocks: ProviderThinkingBlock[] } & MessageIdentity)
  | ({ role: 'assistant', content: string } & ProviderUsageMetadata & MessageIdentity)
  | ({ role: 'assistant_progress', content: string } & ProviderUsageMetadata & MessageIdentity)
  | ({
    role: 'assistant_tool_call',
    toolUseId: string,
    toolName: string,
    input: unknown
  } & ProviderUsageMetadata & MessageIdentity)
  | ({
    role: 'tool_result',
    toolUseId: string,
    toolName: string,
    content: string,
    isError: boolean
  } & MessageIdentity)
  | ({
    role: 'context_summary',
    content: string,
    compressCount: number,
    timestamp: number
  } & MessageIdentity)
  | ({
    role: 'snip_boundary',
    content: string,
    removedMessageIds: string[],
    removedCount: number,
    tokensFreed: number,
    timestamp: number
  } & MessageIdentity)

export type ToolCall = {
  id: string,
  toolName: string,
  input: unknown
}

export type StepDiagnostics = {
  stopReason?: string,
  blockTypes?: string[],
  ignoredBlockTypes?: string[]
}


// 模型的单步输出类型AgentStep
export type AgentStep =
  | {
    type: 'assistant',
    content: string,
    kind?: 'final' | 'progress',
    thinkingBlocks?: ProviderThinkingBlock[],
    diagnostics?: StepDiagnostics,
    usage?: ProviderUsage
  }
  | {
    type: 'tool_calls',
    calls: ToolCall[],
    content?: string,
    contentKind?: 'progress'
    thinkingBlocks?: ProviderThinkingBlock[]
    diagnostics?: StepDiagnostics
    usage?: ProviderUsage
  }
/*模型消息协议适配接口, 接受ChatMessages抽象层组成的历史消息
转换为对应格式的消息发给模型, 接受模型的返回消息转换为AgentStep返回*/
export interface ModelAdapter {
  next(messages: ChatMessage[]): Promise<AgentStep>
}

export type CompressionResult = {
  messages: ChatMessage[]
  summary: Extract<ChatMessage, { role: 'context_summary' }>
  removedCount: number
  tokensBefore: number
  tokensAfter: number
}