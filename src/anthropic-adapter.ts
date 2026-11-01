import { abortableDelay, throwIfAborted } from "./abort.js";
import { buildAnthropicSnipBoundaryText } from "./compact/snipCompact.js";
import { RuntimeConfig } from "./config.js";
import { ToolRegistry } from "./tool.js";
import { AgentStep, ChatMessage, ModelAdapter, ModelRequestOptions, ModelStreamEvents, ProviderThinkingBlock, ProviderUsage, StepDiagnostics, ToolCall } from "./types.js";
import { resolveMaxOutputTokens } from "./utils/context.js";


const DEFAULT_MAX_RETRIES = 4
const BASE_RETRY_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 8000



function getRetryLimit(): number {
  const value = Number(process.env.MINI_CODE_MAX_RETRIES)
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_RETRIES
  }
  return Math.floor(value)
}
type AnthropicUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

type AnthropicContentBlock =
  | { type: 'text', text: string }
  | { type: 'tool_use', id: string, name: string, input: string }
  | { type: 'tool_result', tool_use_id: string, content: string, is_error?: boolean }
  | { type: string, [key: string]: unknown }

type AnthropicMessage = {
  role: 'assistant' | 'user',
  content: AnthropicContentBlock[]
}

type StreamBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; block: ProviderThinkingBlock; buffer: string }
  // ★ 增加 parsedInput：content_block_stop 时解析出的工具入参
  | { kind: 'tool_use'; toolUseId: string; toolName: string; buffer: string; parsedInput?: unknown }

type StreamState = {
  blocks: Map<number, StreamBlock>       // key = 事件里的 index
  order: number[]                        // 保持块顺序
  inputTokens: number
  outputTokens: number
  // ★ 补缓存 token 字段：message_start 的 usage 里可能带
  cacheCreationTokens: number
  cacheReadTokens: number
  stopReason?: string
  blockTypes: string[]
  ignoredBlockTypes: Set<string>
}
// ★ SSE 事件的宽松类型（只用到的字段，避免 any）
type StreamDeltaPayload = {
  type: string
  text?: string
  thinking?: string
  partial_json?: string
  stop_reason: string
}

type AnthropicStreamEvent = {
  type: string
  index?: number
  message?: { usage?: AnthropicUsage }
  content_block?: AnthropicContentBlock
  delta?: StreamDeltaPayload
  usage?: { output_tokens?: number }
  error?: { message?: string }
}

function pushAnthropicMessage(
  messages: AnthropicMessage[],
  role: 'user' | 'assistant',
  block: AnthropicContentBlock
): void {
  const last = messages.at(-1)
  if (last?.role === role) {
    last.content.push(block)
    return
  }
  messages.push({ role, content: [block] })
}

function toAssistantText(message: Extract<ChatMessage, { role: 'assistant' | 'assistant_progress' }>)
  : string {
  if (message.role === 'assistant_progress') {
    return `<progress>\n${message.content}\n</progress>`
  }
  return message.content
}

function toTextBlock(text: string): AnthropicContentBlock {
  return { type: 'text', text }
}
// 将自定义的消息格式ChatMessage转变为Anthropic消息格式
function toAnthropicMessages(messages: ChatMessage[]): {
  system: string
  messages: AnthropicMessage[]
} {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n')
  const converted: AnthropicMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      pushAnthropicMessage(converted, 'user', toTextBlock(message.content))
      continue
    }
    if (message.role === 'assistant_thinking') {
      for (const block of message.blocks) {
        pushAnthropicMessage(converted, 'assistant', block)
      }
      continue
    }
    if (message.role === 'assistant' || message.role === 'assistant_progress') {
      pushAnthropicMessage(converted, 'assistant', toTextBlock(toAssistantText(message)))
      continue
    }
    if (message.role === 'assistant_tool_call') {
      pushAnthropicMessage(converted, 'assistant', {
        type: 'tool_use',
        id: message.toolUseId,
        name: message.toolName,
        input: message.input
      })
      continue
    }
    if (message.role === 'context_summary') {
      pushAnthropicMessage(converted, 'user', toTextBlock(
        `[Context Summary from earlier conversation]\n${message.content}`,
      ))
      continue
    }
    if (message.role === 'snip_boundary') {
      pushAnthropicMessage(converted, 'user', toTextBlock(
        buildAnthropicSnipBoundaryText(),
      ))
      continue
    }
    pushAnthropicMessage(converted, 'user', {
      type: 'tool_result',
      tool_use_id: message.toolUseId,
      content: message.content,
      is_error: message.isError,
    })
  }
  return { system, messages: converted }
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null
  const asSeconds = Number(retryAfter)
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return Math.floor(asSeconds * 1000)
  }

  const at = Date.parse(retryAfter)
  if (!Number.isFinite(at)) {
    return null
  }
  return Math.max(0, at - Date.now())

}


function extractErrorMessage(data: unknown, status: number): string {
  if (typeof data === 'string' && data.trim()) {
    return data.trim()
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'object' &&
    data.error !== null &&
    'message' in data.error &&
    typeof data.error.message === 'string' &&
    data.error.message.trim()
  ) {
    return data.error.message.trim()
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'string' &&
    data.error.trim()
  ) {
    return data.error.trim()
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string' &&
    data.message.trim()
  ) {
    return data.message.trim()
  }

  return `Model request failed: ${status}`
}

function getRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return retryAfterMs
  }

  const base = Math.min(
    MAX_RETRY_DELAY_MS,
    BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1))
  )

  const jitter = Math.random() * 0.25 * base
  return Math.floor(base + jitter)


}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) {
    return {}
  }
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.trim() } }
  }
}

function isTextBlock(block: AnthropicContentBlock): block is Extract<AnthropicContentBlock, {
  type: 'text'
}> {
  return block.type === 'text' && typeof block.text === 'string'
}

function isToolUseBlock(block: AnthropicContentBlock): block is Extract<AnthropicContentBlock, {
  type: 'tool_use'
}> {
  return (
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    typeof block.name === 'string'
  )
}

function isThinkingBlock(block: AnthropicContentBlock): block is ProviderThinkingBlock {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

function parseAssistantText(content: string): {
  content: string
  kind?: 'final' | 'progress'
} {
  const trimmed = content.trim()
  if (!trimmed) {
    return { content: '' }
  }

  const markers: Array<{
    prefix: string
    kind: 'final' | 'progress'
  }> = [
      { prefix: '<final>', kind: 'final' },
      { prefix: '[FINAL]', kind: 'final' },
      { prefix: '<progress>', kind: 'progress' },
      { prefix: '[PROGRESS]', kind: 'progress' },
    ]

  for (const marker of markers) {
    if (trimmed.startsWith(marker.prefix)) {
      const rawContent = trimmed.slice(marker.prefix.length).trim()
      const closingTag =
        marker.kind === 'progress'
          ? /<\/progress>/gi
          : /<\/final>/gi
      return {
        content: rawContent.replace(closingTag, '').trim(),
        kind: marker.kind,
      }
    }
  }

  return { content: trimmed }
}

function normalizeAnthropicUsage(usage: AnthropicUsage | undefined): ProviderUsage | undefined {
  if (!usage) return undefined
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  const outputTokens = usage.output_tokens ?? 0
  const totalTokens = inputTokens + outputTokens
  if (totalTokens <= 0) return undefined
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    source: 'anthropic',
  }
}



export class AnthropicModelAdapter implements ModelAdapter {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly getRuntimeConfig: () => Promise<RuntimeConfig>,
  ) { }

  private buildAgentStep(args: {
    textParts: string[]
    toolCalls: ToolCall[]
    thinkingBlocks: ProviderThinkingBlock[]
    stopReason?: string
    blockTypes: string[]
    ignoredBlockTypes: Set<string>
    usage?: AnthropicUsage | undefined
  }): AgentStep {
    const parsedText = parseAssistantText(args.textParts.join('\n').trim())
    const diagnostics: StepDiagnostics = {
      stopReason: args.stopReason,
      blockTypes: args.blockTypes,
      ignoredBlockTypes: [...args.ignoredBlockTypes],
    }
    const usage = normalizeAnthropicUsage(args.usage)
    if (args.toolCalls.length > 0) {
      return {
        type: 'tool_calls' as const,
        calls: args.toolCalls,
        content: parsedText.content || undefined,
        contentKind: parsedText.kind === 'progress' ? ('progress' as const) : undefined,
        thinkingBlocks: args.thinkingBlocks,
        diagnostics,
        usage
      }
    }
    return {
      type: 'assistant',
      content: parsedText.content,
      kind: parsedText.kind,
      thinkingBlocks: args.thinkingBlocks,
      diagnostics,
      usage,
    }

  }
  // 流式输出请求入口
  private async nextStream(
    messages: ChatMessage[],
    url: string,
    headers: Record<string, string>,
    requestBody: Record<string, unknown>,
    events: ModelStreamEvents,
    signal: AbortSignal | undefined,
    maxRetries: number,
  ): Promise<AgentStep> {
    // ① 重试循环只包"建立连接"阶段（和非流式一样），拿到 ok 的 response 后不再重试
    let response: Response | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: signal
      })
      if (response.ok) {
        break
      }
      if (!shouldRetryStatus(response.status) || attempt >= maxRetries) {
        break
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      await abortableDelay(
        getRetryDelayMs(attempt + 1, retryAfterMs),
        signal,
      )
    }

    if (!response) {
      throw new Error('Model request failed before receiving a response')
    }

    if (!response.ok) {
      const data = await readJsonBody(response)
      throw new Error(extractErrorMessage(data, response.status))
    }
    throwIfAborted(signal)
    // ② 按 \n 切流、取 data: 行（和你在 mcp.ts 补的 SSE 解析同模式）
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const state: StreamState = {
      blocks: new Map<number, StreamBlock>(),
      order: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      blockTypes: [],
      ignoredBlockTypes: new Set<string>(),
    }
    try {
      while (true) {
        throwIfAborted(signal)                       // 每个 chunk 前检查中止
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''                   // 半行留到下一轮（SSE 行可能跨 chunk！）
        for (const line of lines) {
          if (!line.startsWith('data:')) continue    // 忽略 event:/注释/空行
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          // ★ 坏行容错：单行解析失败不打断整个流
          let parsed: AnthropicStreamEvent
          try {
            parsed = JSON.parse(payload) as AnthropicStreamEvent
          } catch {
            continue
          }
          this.handleStreamEvent(parsed, state, events)
        }
      }
      // ★ 冲刷 decoder 里可能残留的最后一个多字节字符，并处理无结尾换行的半行
      buffer += decoder.decode()
      if (buffer.startsWith('data:')) {
        const payload = buffer.slice(5).trim()
        if (payload && payload !== '[DONE]') {
          try {
            this.handleStreamEvent(JSON.parse(payload) as AnthropicStreamEvent, state, events)
          } catch {
            // 忽略坏行
          }
        }
      }
    } catch (error) {
      // ★ 中止/网络错误时释放底层连接，再把错误抛出去
      await reader.cancel().catch(() => { })
      throw error


    }
    // ③ message_stop 后聚合
    return this.aggregateStream(state)
  }

  private handleStreamEvent(
    event: AnthropicStreamEvent,
    state: StreamState,
    events: ModelStreamEvents,
  ): void {
    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage
        if (usage) {
          state.inputTokens = usage.input_tokens ?? 0
          state.cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
          state.cacheReadTokens = usage.cache_read_input_tokens ?? 0
        }
        return
      }

      case 'content_block_start': {
        const index = event.index
        const block = event.content_block
        if (index === undefined || !block) return
        state.order.push(index)
        state.blockTypes.push(block.type)

        if (isTextBlock(block)) {
          state.blocks.set(index, { kind: 'text', text: typeof block.text === 'string' ? block.text : '' })
          return
        }
        if (isToolUseBlock(block)) {
          state.blocks.set(index, {
            kind: 'tool_use',
            toolUseId: block.id,
            toolName: block.name,
            buffer: '',
          })
          events.onToolUseStart?.(block.id, block.name)
          return
        }
        if (isThinkingBlock(block)) {
          state.blocks.set(index, { kind: 'thinking', block, buffer: '' })
          return
        }
        state.ignoredBlockTypes.add(block.type)
        return
      }

      case 'content_block_delta': {
        const block = event.index === undefined ? undefined : state.blocks.get(event.index)
        const delta = event.delta
        if (!block || !delta) return

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (block.kind === 'text') {
            block.text += delta.text
            events.onTextDelta?.(delta.text)
          }
          return
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          if (block.kind === 'thinking') {
            block.buffer += delta.thinking
            events.onThinkingDelta?.(delta.thinking)
          }
          return
        }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (block.kind === 'tool_use') {
            // 字符串碎片只累不解析，等 content_block_stop 再 JSON.parse
            block.buffer += delta.partial_json
            events.onToolInputDelta?.(block.toolUseId, delta.partial_json)
          }
          return
        }
        return
      }

      case 'content_block_stop': {
        const block = event.index === undefined ? undefined : state.blocks.get(event.index)
        if (block?.kind === 'tool_use') {
          const trimmed = block.buffer.trim()
          if (!trimmed) {
            block.parsedInput = {}
          } else {
            try {
              block.parsedInput = JSON.parse(trimmed)
            } catch {
              // 入参 JSON 不完整时兜底，带上原始片段方便排查
              block.parsedInput = { _parseError: trimmed.slice(0, 500) }
            }
          }
        }
        return
      }

      case 'message_delta': {
        if (event.delta?.stop_reason === undefined && !('stop_reason' in (event.delta ?? {}))) {
          // message_delta 的 stop_reason 在 delta 字段里
        }
        const stopReason = (event.delta as { stop_reason?: string } | undefined)?.stop_reason
        if (stopReason) {
          state.stopReason = stopReason
        }
        if (event.usage?.output_tokens !== undefined) {
          state.outputTokens = event.usage.output_tokens
        }
        return
      }

      case 'message_stop':
      case 'ping':
        return

      case 'error': {
        throw new Error(
          `Model stream error: ${event.error?.message ?? 'unknown stream error'}`,
        )
      }

      default:
        // 未知事件类型：忽略，不打断流
        return
    }
  }
  // 流结束后的聚合（产出与非流式完全同构的 AgentStep）
  private aggregateStream(state: StreamState): AgentStep {
    const textParts: string[] = []
    const toolCalls: ToolCall[] = []
    const thinkingBlocks: ProviderThinkingBlock[] = []

    for (const index of state.order) {
      const block = state.blocks.get(index)
      if (!block) continue
      if (block.kind === 'text') {
        textParts.push(block.text)
        continue
      }
      if (block.kind === 'tool_use') {
        toolCalls.push({
          id: block.toolUseId,
          toolName: block.toolName,
          input: block.parsedInput ?? {},
        })
        continue
      }
      // thinking：把增量累积的文本写回块的 thinking 字段
      thinkingBlocks.push({
        ...block.block,
        thinking: block.buffer,
      })
    }

    return this.buildAgentStep({
      textParts,
      toolCalls,
      thinkingBlocks,
      stopReason: state.stopReason,
      blockTypes: state.blockTypes,
      ignoredBlockTypes: state.ignoredBlockTypes,
      usage: {
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens,
        cache_creation_input_tokens: state.cacheCreationTokens,
        cache_read_input_tokens: state.cacheReadTokens,
      },
    })
  }
  /*将自定义的Chatmessages格式的消息转换为Anthropic消息格式, 访问大模型, 得到response后
  再进行解析,得到两种AgentStep格式的返回值, 后续可再将AgentStep转换为ChatMessages格式
  放到messages历史消息中*/
  async next(
    messages: ChatMessage[],
    options: ModelRequestOptions = {}
  ): Promise<AgentStep> {
    throwIfAborted(options.signal)
    const runtime = await this.getRuntimeConfig()
    const payload = toAnthropicMessages(messages)
    const url = `${runtime.baseUrl.replace(/\/$/, '')}/v1/messages`
    const maxOutputTokens = resolveMaxOutputTokens(
      runtime.model,
      runtime.maxOutputTokens,
    )
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (runtime.authToken) {
      headers.Authorization = `Bearer ${runtime.authToken}`
    } else if (runtime.apiKey) {
      headers['x-api-key'] = runtime.apiKey
    }


    const requestBody = {
      model: runtime.model,
      system: payload.system,
      messages: payload.messages,
      tools: (options.tools ?? this.tools.list()).map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      })),
      max_tokens: maxOutputTokens,
      stream: false
    }
    const maxRetries = getRetryLimit()
    if (options.stream) {
      requestBody.stream = true
      return this.nextStream(
        messages,
        url,
        headers,
        requestBody,
        options.stream,
        options.signal,
        maxRetries
      )
    }
    let response: Response | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: options.signal
      })
      if (response.ok) {
        break
      }
      if (!shouldRetryStatus(response.status) || attempt >= maxRetries) {
        break
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      await abortableDelay(
        getRetryDelayMs(attempt + 1, retryAfterMs),
        options.signal,
      )
    }

    if (!response) {
      throw new Error('Model request failed before receiving a response')
    }

    const data = (await readJsonBody(response)) as {
      stop_reason?: string
      content?: AnthropicContentBlock[]
      usage?: AnthropicUsage
      error?: { message?: string }
    }

    if (!response.ok) {
      throw new Error(extractErrorMessage(data, response.status))
    }

    const toolCalls: ToolCall[] = []
    const textParts: string[] = []
    const thinkingBlocks: ProviderThinkingBlock[] = []
    const blockTypes: string[] = []
    const ignoredBlockTypes = new Set<string>()

    for (const block of data.content ?? []) {
      blockTypes.push(block.type)
      if (isTextBlock(block)) {
        textParts.push(block.text)
        continue
      }
      if (isToolUseBlock(block)) {
        toolCalls.push({
          id: block.id,
          toolName: block.name,
          input: block.input
        })
        continue
      }
      if (isThinkingBlock(block)) {
        thinkingBlocks.push(block)
        continue
      }
      ignoredBlockTypes.add(block.type)

    }
    return this.buildAgentStep({
      textParts,
      toolCalls,
      thinkingBlocks,
      stopReason: data.stop_reason,
      blockTypes,
      ignoredBlockTypes,
      usage: data.usage
    })

  }
}