import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { readMcpTokensFile } from './config.js'
import type { McpServerConfig } from './config.js'
import type { ToolDefinition, ToolResult } from './tool.js'
import { getErrorCode } from './utils/errors.js'

// 远程过程调用协议
type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number  // 请求标识
  method?: string   // 要调用的远程方法名
  params?: unknown   // 参数
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// MCP 返回的工具元信息：名字、描述、JSON Schema（入参）
type McpToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

// 资源以 URI 寻址，类似文件、文档
type McpResourceDescriptor = {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

// 可渲染的提示词模板，带参数列表
type McpPromptArgument = {
  name: string
  description?: string
  required?: boolean
}

type McpPromptDescriptor = {
  name: string
  description?: string
  arguments?: McpPromptArgument[]
}

// 发 JSON-RPC 请求时，把 Promise 的 resolve/reject + 超时定时器存起来，
// 等收到对应 id 的 response 再 resolve/reject；超时直接 reject。
type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

// 对外暴露的服务状态摘要，UI / 日志用：状态、工具数量、协议、错误信息。
export type McpServerSummary = {
  name: string
  command: string
  status: 'connecting' | 'connected' | 'error' | 'disabled'
  toolCount: number
  error?: string
  protocol?: JsonRpcProtocol
  resourceCount?: number
  promptCount?: number
}
// 支持的三种传输帧格式
type JsonRpcProtocol = 'content-length' | 'newline-json' | 'streamable-http'
// 正常初始化超时：10s
const MCP_INITIALIZE_TIMEOUT_MS = 10000
// 自动探测协议的快速试探超时：1.2s
const MCP_INITIALIZE_PROBE_TIMEOUT_MS = 1200
// 协议缓存文件路径：记住每个 MCP 服务上次协商成功的协议，下次不用反复探测
const MCP_PROTOCOL_CACHE_PATH = path.join(
  os.homedir(),
  '.mini-code',
  'mcp-protocol-cache.json',
)
// 缓存结构：`key => 协议名`
type ProtocolCache = Record<string, JsonRpcProtocol>

// 格式化子进程启动报错，区分 `ENOENT`（命令不存在），拼接 stderr 日志，方便排错
function formatChildProcessError(
  serverName: string,
  command: string,
  stderrLines: string[],
  error: unknown,
): Error {
  const code = getErrorCode(error) ?? undefined
  const detail =
    error instanceof Error ? error.message : String(error)

  const lines = [`Failed to start MCP server "${serverName}" using command "${command}".`]

  if (code === 'ENOENT') {
    lines.push(
      `Command not found: ${command}. Install it first and ensure it is available in PATH.`,
    )
  } else if (detail) {
    lines.push(detail)
  }

  if (detail && code === 'ENOENT') {
    lines.push(`Original error: ${detail}`)
  }

  if (stderrLines.length > 0) {
    lines.push(stderrLines.join('\n'))
  }

  return new Error(lines.join('\n'))
}

// 判断是不是初始化超时，用来实现「快速探测失败后重试一次」逻辑
function isInitializeTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('request timed out for initialize')
  )
}
// 清洗 MCP 服务名 / 工具名，生成安全内部工具名
function sanitizeToolSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'tool'
  )
}

// 如果 MCP 没返回合法 inputSchema，返回一个宽松 object schema，防止工具校验失败
function normalizeInputSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema
  }

  return {
    type: 'object',
    additionalProperties: true,
  }
}

// MCP `tools/call` 返回的 `content` 数组块格式化：text 块直接取 text，其他原样 JSON
function formatContentBlock(block: unknown): string {
  if (!block || typeof block !== 'object') {
    return JSON.stringify(block, null, 2)
  }

  if ('type' in block && block.type === 'text' && 'text' in block) {
    return String(block.text)
  }

  if ('type' in block && 'resource' in block) {
    return JSON.stringify(block, null, 2)
  }

  return JSON.stringify(block, null, 2)
}

// 标准化工具调用返回为内部统一 `ToolResult`：`{ok, output}`
function formatToolCallResult(result: unknown): ToolResult {
  if (!result || typeof result !== 'object') {
    return {
      ok: true,
      output: JSON.stringify(result, null, 2),
    }
  }

  const typedResult = result as {
    content?: unknown[]
    structuredContent?: unknown
    isError?: boolean
  }

  const parts: string[] = []

  if (Array.isArray(typedResult.content) && typedResult.content.length > 0) {
    parts.push(typedResult.content.map(formatContentBlock).join('\n\n'))
  }

  if (typedResult.structuredContent !== undefined) {
    parts.push(
      `STRUCTURED_CONTENT:\n${JSON.stringify(typedResult.structuredContent, null, 2)}`,
    )
  }

  if (parts.length === 0) {
    parts.push(JSON.stringify(result, null, 2))
  }

  return {
    ok: !typedResult.isError,
    output: parts.join('\n\n').trim(),
  }
}

// 读取资源结果格式化：区分 text /base64 blob，带上 URI、MIME 头
function formatReadResourceResult(result: unknown): ToolResult {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      output: JSON.stringify(result, null, 2),
    }
  }

  const typedResult = result as {
    contents?: Array<{
      uri?: string
      mimeType?: string
      text?: string
      blob?: string
    }>
  }

  const contents = typedResult.contents ?? []
  if (contents.length === 0) {
    return {
      ok: true,
      output: 'No resource contents returned.',
    }
  }

  return {
    ok: true,
    output: contents
      .map(item => {
        const headerLines = [`URI: ${item.uri ?? '(unknown)'}`]
        if (item.mimeType) {
          headerLines.push(`MIME: ${item.mimeType}`)
        }
        const header = `${headerLines.join('\n')}\n\n`

        if (typeof item.text === 'string') {
          return `${header}${item.text}`
        }

        if (typeof item.blob === 'string') {
          return `${header}BLOB:\n${item.blob}`
        }

        return `${header}${JSON.stringify(item, null, 2)}`
      })
      .join('\n\n'),
  }
}

// 渲染 prompt 返回：MCP prompt 返回是一组对话消息，按 role 排版输出。
function formatPromptResult(result: unknown): ToolResult {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      output: JSON.stringify(result, null, 2),
    }
  }

  const typedResult = result as {
    description?: string
    messages?: Array<{
      role?: string
      content?: unknown
    }>
  }

  const header = typedResult.description
    ? `DESCRIPTION: ${typedResult.description}\n\n`
    : ''
  const body = (typedResult.messages ?? [])
    .map(message => {
      const role = message.role ?? 'unknown'
      if (typeof message.content === 'string') {
        return `[${role}]\n${message.content}`
      }
      if (Array.isArray(message.content)) {
        return `[${role}]\n${message.content
          .map(part => {
            if (typeof part === 'string') return part
            if (part && typeof part === 'object' && 'text' in part) {
              return String(part.text)
            }
            return JSON.stringify(part, null, 2)
          })
          .join('\n')}`
      }
      return `[${role}]\n${JSON.stringify(message.content, null, 2)}`
    })
    .join('\n\n')

  return {
    ok: true,
    output: `${header}${body}`.trim() || JSON.stringify(result, null, 2),
  }
}

// 生成服务唯一标识字符串：http 用 url，stdio 用 cmd+args，用于协议缓存 key
function summarizeServerEndpoint(config: McpServerConfig): string {
  const remoteUrl = config.url?.trim()
  if (remoteUrl) return remoteUrl
  const command = config.command?.trim() ?? ''
  const args = config.args?.join(' ') ?? ''
  return `${command} ${args}`.trim()
}

// 把 header/env 里的数字转字符串，HTTP header 只能是 string
function toStringRecord(
  values: Record<string, string | number> | undefined,
): Record<string, string> {
  if (!values) return {}
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  )
}
// 环境变量插值：支持 `$VAR` 和 `${VAR}`，用于 header 里面写环境变量
function interpolateEnv(value: string): string {
  return value.replace(/\$(\w+)|\$\{([^}]+)\}/g, (_match, simple, braced) => {
    const key = String(simple ?? braced ?? '').trim()
    if (!key) return ''
    return process.env[key] ?? ''
  })
}


// 对 header 同时做：转 string + 环境变量替换
function resolveHeaderRecord(
  values: Record<string, string | number> | undefined,
): Record<string, string> {
  const raw = toStringRecord(values)
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, interpolateEnv(value)]),
  )
}

// 解析 `WWW-Authenticate` 响应头，提取 MCP streamable http 的 OAuth 授权提示，放到报错信息里。
function extractAuthHint(headers: Headers): string | null {
  const challenges = headers.get('www-authenticate')
  if (!challenges) return null
  const parts: string[] = [challenges]
  const resourceMetadata = /resource_metadata=\"([^\"]+)\"/i.exec(challenges)?.[1]
  const authorizationUri = /authorization_uri=\"([^\"]+)\"/i.exec(challenges)?.[1]
  if (resourceMetadata) {
    parts.push(`resource_metadata=${resourceMetadata}`)
  }
  if (authorizationUri) {
    parts.push(`authorization_uri=${authorizationUri}`)
  }
  return parts.join('\n')
}

// 统一客户端接口
type McpClientLike = {
  start(): Promise<void>
  getProtocol(): JsonRpcProtocol | null
  getServerName(): string
  listTools(): Promise<McpToolDescriptor[]>
  listResources(): Promise<McpResourceDescriptor[]>
  readResource(uri: string): Promise<ToolResult>
  listPrompts(): Promise<McpPromptDescriptor[]>
  getPrompt(name: string, args?: Record<string, string>): Promise<ToolResult>
  callTool(name: string, input: unknown): Promise<ToolResult>
  close(): Promise<void>
}
// 内存缓存 MCP Bearer token，避免反复读文件。
const mcpTokenCache = new Map<string, string>()
async function loadMcpToken(serverName: string): Promise<string | undefined> {
  if (mcpTokenCache.has(serverName)) {
    return mcpTokenCache.get(serverName)
  }
  const tokens = await readMcpTokensFile()
  const token = tokens[serverName]?.trim()
  if (token) {
    mcpTokenCache.set(serverName, token)
    return token
  }
  return undefined
}
// 读写本地 json 缓存，容错：文件损坏 / 不存在直接返回空对象；写的时候自动创建目录
async function readProtocolCache(): Promise<ProtocolCache> {
  try {
    const content = await readFile(MCP_PROTOCOL_CACHE_PATH, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    const cache: ProtocolCache = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value === 'content-length' ||
        value === 'newline-json' ||
        value === 'streamable-http'
      ) {
        cache[key] = value
      }
    }
    return cache
  } catch {
    return {}
  }
}

async function writeProtocolCache(cache: ProtocolCache): Promise<void> {
  await mkdir(path.dirname(MCP_PROTOCOL_CACHE_PATH), { recursive: true })
  await writeFile(MCP_PROTOCOL_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
}
// stdio 子进程 MCP 客户端
class StdioMcpClient {
  private process: ChildProcessWithoutNullStreams | null = null  // 子进程对象  
  private nextId = 1
  private buffer = Buffer.alloc(0)   // content-length 模式的二进制缓冲区
  private lineBuffer = ''   // newline-json 模式的行字符串缓冲区
  private pending = new Map<number, PendingRequest>()  // 一个 Map，存放**已经发出去、正在等返回的 JSON-RPC 请求**
  private stderrLines: string[] = []
  private protocol: JsonRpcProtocol | null = null

  constructor(
    private readonly serverName: string,
    private readonly config: McpServerConfig,
    private readonly cwd: string,
    private readonly preferredProtocol?: JsonRpcProtocol, // 上次缓存的优先协议
  ) { }

  async start(): Promise<void> {
    if (this.process) {
      return
    }
    // 拿到候选协议列表
    const protocols = this.getProtocolCandidates()
    const autoProtocol =
      this.config.protocol === undefined || this.config.protocol === 'auto'
    let lastError: Error | null = null

    for (let index = 0; index < protocols.length; index += 1) {
      // 如果是自动模式、没有缓存优先协议、第一个候选：先用短超时 1.2s 试探
      const protocol = protocols[index]!
      const useProbeTimeout =
        autoProtocol && !this.preferredProtocol && index === 0
      const timeoutMs =
        useProbeTimeout
          ? MCP_INITIALIZE_PROBE_TIMEOUT_MS
          : MCP_INITIALIZE_TIMEOUT_MS
      try {
        await this.initializeWithProtocol(protocol, timeoutMs)
        return
      } catch (error) {
        // Fast probe can be too short on cold starts: retry the same protocol once
        // with full timeout before falling back to another framing format.
        // 如果试探超时，**不立刻切下一个协议，而是重试同协议、用完整 10s 超时**
        if (useProbeTimeout && isInitializeTimeoutError(error)) {
          await this.close()
          try {
            await this.initializeWithProtocol(protocol, MCP_INITIALIZE_TIMEOUT_MS)
            return
          } catch (retryError) {
            lastError =
              retryError instanceof Error
                ? retryError
                : new Error(String(retryError))
            await this.close()
            continue
          }
        }
        lastError = error instanceof Error ? error : new Error(String(error))
        await this.close()
      }
    }

    throw lastError ?? new Error(`Failed to connect MCP server "${this.serverName}".`)
  }

  getProtocol(): JsonRpcProtocol | null {
    return this.protocol
  }

  getServerName(): string {
    return this.serverName
  }
  // MCP 规范顺序：client → initialize → server 返回 → client 发 initialized 通知
  private async initializeWithProtocol(
    protocol: JsonRpcProtocol,
    timeoutMs: number,
  ): Promise<void> {
    // 拉起子进程
    await this.spawnProcess()
    // 标记当前使用的帧协议
    this.protocol = protocol
    // 发送 `initialize` 请求（MCP 握手第一步）
    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'mini-code',
          version: '0.1.0',
        },
      },
      timeoutMs,
    )
    // 握手成功后发 `notifications/initialized` 通知（MCP 规范：通知服务端客户端准备就绪）
    this.notify('notifications/initialized', {})
  }
  // 根据配置 / 缓存，生成协议尝试顺序
  private getProtocolCandidates(): JsonRpcProtocol[] {
    if (this.config.protocol === 'content-length') {
      return ['content-length']
    }
    if (this.config.protocol === 'newline-json') {
      return ['newline-json']
    }
    if (this.preferredProtocol === 'newline-json') {
      return ['newline-json', 'content-length']
    }
    return ['content-length', 'newline-json']
  }
  // spawn 启动子进程
  private async spawnProcess(): Promise<void> {
    const command = (this.config.command ?? '').trim()
    if (!command) {
      throw new Error(`MCP server "${this.serverName}" has no command configured.`)
    }

    this.buffer = Buffer.alloc(0)
    this.lineBuffer = ''
    this.stderrLines = []
    // MCP 是 JSON - RPC，一问一答，每个请求带 id，收到响应后去 pending 里找到对应 promise 唤醒。
    // 如果进程崩了，所有 pending 里的请求全部失败
    this.pending.clear()

    const child = spawn(command, this.config.args ?? [], {
      cwd: this.config.cwd ? path.resolve(this.cwd, this.config.cwd) : this.cwd,
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(this.config.env ?? {}).map(([key, value]) => [
            key,
            String(value),
          ]),
        ),
      },
      stdio: 'pipe',
    })

    this.process = child
    const handleProcessError = (error: unknown) => {
      // 格式化错误信息
      const wrapped = formatChildProcessError(
        this.serverName,
        command,
        this.stderrLines,
        error,
      )
      // 进程全局错误回调：子进程报错时，把所有 pending 请求全部 reject
      if (this.process === child) {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout)
          pending.reject(wrapped)
        }
        this.pending.clear()
        this.process = null
      }
    }

    child.stdout.on('data', chunk => {
      if (this.process !== child) {
        return
      }
      this.handleStdoutChunk(Buffer.from(chunk))
    })
    child.stderr.on('data', chunk => {
      if (this.process !== child) {
        return
      }
      this.stderrLines.push(String(chunk).trim())
      this.stderrLines = this.stderrLines.filter(Boolean).slice(-8)
    })
    // 子进程层面错误回调
    child.on('error', handleProcessError)
    // 子进程退出事件
    child.on('exit', code => {
      if (this.process !== child) {
        return
      }
      const error = new Error(
        `MCP server "${this.serverName}" exited with code ${code ?? 'unknown'}${this.stderrLines.length > 0
          ? `\n${this.stderrLines.join('\n')}`
          : ''
        }`,
      )
      for (const pending of this.pending.values()) {
        pending.reject(error)
      }
      this.pending.clear()
      this.process = null
    })

    await new Promise<void>((resolve, reject) => {
      // 删掉 error 监听，resolve，`spawnProcess` 函数返回，上层可以开始发 MCP 请求
      const onSpawn = () => {
        child.off('error', onInitialError)
        resolve()
      }
      // 触发 `error`（比如命令不存在）→ 删掉 spawn 监听，reject，上层捕获异常
      const onInitialError = (error: unknown) => {
        child.off('spawn', onSpawn)
        reject(
          formatChildProcessError(this.serverName, command, this.stderrLines, error),
        )
      }
      // 注册一次性监听
      // `spawn` 事件触发 = 进程成功创建、操作系统已经拉起这个程序了
      child.once('spawn', onSpawn)
      child.once('error', onInitialError)
    })
  }
  // 调用对应 MCP 方法，拿到结果后交给上面的格式化函数，统一返回 `ToolResult`
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: McpToolDescriptor[]
    }
    return result.tools ?? []
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    const result = (await this.request('resources/list', {}, 3000)) as {
      resources?: McpResourceDescriptor[]
    }
    return result.resources ?? []
  }

  async readResource(uri: string): Promise<ToolResult> {
    const result = await this.request('resources/read', { uri }, 5000)
    return formatReadResourceResult(result)
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    const result = (await this.request('prompts/list', {}, 3000)) as {
      prompts?: McpPromptDescriptor[]
    }
    return result.prompts ?? []
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<ToolResult> {
    const result = await this.request(
      'prompts/get',
      {
        name,
        arguments: args ?? {},
      },
      5000,
    )
    return formatPromptResult(result)
  }

  async callTool(name: string, input: unknown): Promise<ToolResult> {
    const result = await this.request('tools/call', {
      name,
      arguments: input ?? {},
    })
    return formatToolCallResult(result)
  }
  // 关闭客户端：清 pending、杀子进程、重置状态
  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(
        new Error(`MCP server "${this.serverName}" closed before completing the request.`),
      )
    }
    this.pending.clear()

    if (!this.process) {
      this.protocol = null
      return
    }

    this.process.kill()
    this.process = null
    this.protocol = null
  }
  // 通知：JSON-RPC 不带 id，不需要等待响应。
  private notify(method: string, params: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method,
      params,
    })
  }
  // 核心 JSON-RPC 请求
  private request(
    method: string,
    params: unknown,
    timeoutMs = 5000,
  ): Promise<unknown> {
    // 分配自增 id
    const id = this.nextId++
    // 构造 Promise，存入 pending map，绑定超时定时器
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `MCP ${this.serverName}: request timed out for ${method}${this.stderrLines.length > 0 ? `\n${this.stderrLines.join('\n')}` : ''
            }`,
          ),
        )
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      // 调用 send 发送消息
      this.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      })
    })
  }
  // 按协议打包发送
  private send(message: JsonRpcMessage): void {
    if (!this.process) {
      throw new Error(`MCP server "${this.serverName}" is not running.`)
    }

    const body = Buffer.from(JSON.stringify(message), 'utf8')
    // `newline-json`：`json + \n`
    if (this.protocol === 'newline-json') {
      this.process.stdin.write(`${body.toString('utf8')}\n`)
      return
    }
    // `content-length`：`Content-Length: N\r\n\r\n` + json 字节
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8')
    this.process.stdin.write(Buffer.concat([header, body]))
  }

  private handleStdoutChunk(chunk: Buffer): void {
    if (this.protocol === 'newline-json') {
      this.handleStdoutChunkAsLines(chunk)
      return
    }
    // content-length 帧解析循环
    this.buffer = Buffer.concat([this.buffer, chunk])

    while (true) {
      // 不断拼接 buffer,查找 `\r\n\r\n` 分隔头和 body
      const separatorIndex = this.buffer.indexOf('\r\n\r\n')
      if (separatorIndex === -1) {
        return
      }

      const headerText = this.buffer
        .subarray(0, separatorIndex)
        .toString('utf8')
      const headers = headerText.split('\r\n')
      const contentLengthHeader = headers.find(line =>
        line.toLowerCase().startsWith('content-length:'),
      )
      if (!contentLengthHeader) {
        this.buffer = this.buffer.subarray(separatorIndex + 4)
        continue
      }
      // 解析 Content-Length
      const contentLength = Number(contentLengthHeader.split(':')[1]?.trim() ?? 0)
      const bodyStart = separatorIndex + 4
      const bodyEnd = bodyStart + contentLength
      // 当前缓冲区不够长，还需要等下一次data事件
      if (this.buffer.length < bodyEnd) {
        return
      }
      // 缓冲区足够长就切出 payload，剩下放回 buffer
      const payload = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8')
      this.buffer = this.buffer.subarray(bodyEnd)
      this.handleMessage(JSON.parse(payload) as JsonRpcMessage)
    }
  }
  // newline json 解析：按换行切分，每行一条 json
  private handleStdoutChunkAsLines(chunk: Buffer): void {
    this.lineBuffer += chunk.toString('utf8')

    while (true) {
      const newlineIndex = this.lineBuffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }

      const rawLine = this.lineBuffer.slice(0, newlineIndex)
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1)
      const line = rawLine.trim()
      if (!line) {
        continue
      }

      this.handleMessage(JSON.parse(line) as JsonRpcMessage)
    }
  }
  // 收到 JSON-RPC 响应
  private handleMessage(message: JsonRpcMessage): void {
    // 没有 id → 通知，直接丢弃
    if (typeof message.id !== 'number') {
      return
    }
    // 找到对应 pending 请求，清除超时
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }

    this.pending.delete(message.id)
    clearTimeout(pending.timeout)
    // 有 error 则 reject，否则 resolve 返回 result
    if (message.error) {
      pending.reject(
        new Error(
          `MCP ${this.serverName}: ${message.error.message}${message.error.data ? `\n${JSON.stringify(message.error.data, null, 2)}` : ''
          }`,
        ),
      )
      return
    }

    pending.resolve(message.result)
  }
}
// HTTP 远程 MCP
class StreamableHttpMcpClient {
  private nextId = 1
  private bearerToken: string | null = null

  constructor(
    private readonly serverName: string,
    private readonly config: McpServerConfig,
  ) { }

  async start(): Promise<void> {
    if (!this.config.url?.trim()) {
      throw new Error(`MCP server "${this.serverName}" has no URL configured.`)
    }

    this.bearerToken = (await loadMcpToken(this.serverName)) ?? null

    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'mini-code',
          version: '0.1.0',
        },
      },
      MCP_INITIALIZE_TIMEOUT_MS,
    )
    await this.notify('notifications/initialized', {})
  }

  getProtocol(): JsonRpcProtocol | null {
    return 'streamable-http'
  }

  getServerName(): string {
    return this.serverName
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: McpToolDescriptor[]
    }
    return result.tools ?? []
  }

  async listResources(): Promise<McpResourceDescriptor[]> {
    const result = (await this.request('resources/list', {}, 3000)) as {
      resources?: McpResourceDescriptor[]
    }
    return result.resources ?? []
  }

  async readResource(uri: string): Promise<ToolResult> {
    const result = await this.request('resources/read', { uri }, 5000)
    return formatReadResourceResult(result)
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    const result = (await this.request('prompts/list', {}, 3000)) as {
      prompts?: McpPromptDescriptor[]
    }
    return result.prompts ?? []
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<ToolResult> {
    const result = await this.request(
      'prompts/get',
      {
        name,
        arguments: args ?? {},
      },
      5000,
    )
    return formatPromptResult(result)
  }

  async callTool(name: string, input: unknown): Promise<ToolResult> {
    const result = await this.request('tools/call', {
      name,
      arguments: input ?? {},
    })
    return formatToolCallResult(result)
  }

  async close(): Promise<void> {
    return
  }

  private async notify(method: string, params: unknown): Promise<void> {
    try {
      await this.postJsonRpc({ jsonrpc: '2.0', method, params }, 2000)
    } catch {
      // Some servers ignore notifications over plain HTTP response mode.
    }
  }

  private async request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    const id = this.nextId++
    const payload = await this.postJsonRpc(
      {
        jsonrpc: '2.0',
        id,
        method,
        params,
      },
      timeoutMs,
    )

    if (!payload || typeof payload !== 'object') {
      throw new Error(`MCP ${this.serverName}: invalid response payload.`)
    }

    const message = payload as JsonRpcMessage
    if (message.error) {
      throw new Error(
        `MCP ${this.serverName}: ${message.error.message}${message.error.data ? `\n${JSON.stringify(message.error.data, null, 2)}` : ''
        }`,
      )
    }
    return message.result
  }

  private async postJsonRpc(message: JsonRpcMessage, timeoutMs: number): Promise<unknown> {
    const endpoint = this.config.url?.trim()
    if (!endpoint) {
      throw new Error(`MCP server "${this.serverName}" has no URL configured.`)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Align with MCP streamable HTTP content negotiation behavior.
          accept: 'application/json, text/event-stream',
          ...resolveHeaderRecord(this.config.headers),
          ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      })

      if (!response.ok) {
        const authHint = extractAuthHint(response.headers)
        const bodyText = await response.text().catch(() => '')
        const detail = bodyText.trim().slice(0, 600)
        const lines = [`HTTP ${response.status} ${response.statusText}`]
        if (authHint) {
          lines.push(`AUTH:\n${authHint}`)
        }
        if (detail) {
          lines.push(`BODY:\n${detail}`)
        }
        throw new Error(lines.join('\n'))
      }

      const responseText = await response.text()
      if (!responseText.trim()) {
        return {}
      }
      // SSE 响应模式：解析 data: 行，取 id 匹配的那条 JSON-RPC 消息
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) {
        const requestId = (message as { id?: unknown }).id
        for (const line of responseText.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          try {
            const parsed = JSON.parse(payload) as JsonRpcMessage
            if ('id' in parsed && parsed.id === requestId) {
              return parsed            // 复用下方原有的 error/result 处理逻辑
            }
          } catch {
            // 跳过非 JSON 的 data 行（心跳/注释等）
          }
        }
        throw new Error(
          `MCP ${this.serverName}: SSE stream contained no response for request id ${String(requestId)}.`,
        )
      }
      try {
        return JSON.parse(responseText) as unknown
      } catch {
        throw new Error(
          `MCP ${this.serverName}: expected JSON response but received non-JSON payload.`,
        )
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `MCP ${this.serverName}: request timed out for ${message.method ?? 'notification'}.`,
          { cause: error })
      }
      throw error instanceof Error
        ? error
        : new Error(`MCP ${this.serverName}: ${String(error)}`)
    } finally {
      clearTimeout(timeout)
    }
  }
}

export async function createMcpBackedTools(args: {
  cwd: string
  mcpServers: Record<string, McpServerConfig>
}): Promise<{
  tools: ToolDefinition<unknown>[]
  servers: McpServerSummary[]
  dispose: () => Promise<void>
}> {
  const protocolCache = await readProtocolCache()
  let protocolCacheDirty = false
  const clients: McpClientLike[] = []
  const clientsByServer = new Map<string, McpClientLike>()
  const tools: ToolDefinition<unknown>[] = []
  const servers: McpServerSummary[] = []
  let hasPublishedResources = false
  let hasPublishedPrompts = false
  // 遍历所有配置的 MCP 服务；disabled 的直接标记 disabled，不启动
  for (const [serverName, config] of Object.entries(args.mcpServers)) {
    const endpointKey = `${serverName}::${summarizeServerEndpoint(config)}`
    if (config.enabled === false) {
      servers.push({
        name: serverName,
        command: summarizeServerEndpoint(config),
        status: 'disabled',
        toolCount: 0,
        protocol:
          config.protocol === 'auto' || config.protocol === undefined
            ? undefined
            : config.protocol,
      })
      continue
    }
    // 自动选择客户端类型：有 url 默认走 streamable-http，否则 stdio
    const protocolHint = config.protocol
    const remoteUrl = config.url?.trim()
    const selectedProtocol: JsonRpcProtocol =
      protocolHint === 'streamable-http'
        ? 'streamable-http'
        : protocolHint === 'content-length'
          ? 'content-length'
          : protocolHint === 'newline-json'
            ? 'newline-json'
            : remoteUrl
              ? 'streamable-http'
              : 'content-length'

    const client: McpClientLike =
      selectedProtocol === 'streamable-http'
        ? new StreamableHttpMcpClient(serverName, config)
        : new StdioMcpClient(
          serverName,
          config,
          args.cwd,
          protocolCache[endpointKey],
        )

    try {
      await client.start()
      const descriptors = await client.listTools()
      const [resourcesResult, promptsResult] = await Promise.allSettled([
        client.listResources(),
        client.listPrompts(),
      ])
      const resourceCount =
        resourcesResult.status === 'fulfilled'
          ? resourcesResult.value.length
          : undefined
      const promptCount =
        promptsResult.status === 'fulfilled'
          ? promptsResult.value.length
          : undefined
      hasPublishedResources = hasPublishedResources || (resourceCount ?? 0) > 0
      hasPublishedPrompts = hasPublishedPrompts || (promptCount ?? 0) > 0
      clients.push(client)
      clientsByServer.set(serverName, client)
      // 协商成功的 stdio 协议写入缓存标记 dirty，后面持久化
      const negotiated = client.getProtocol()
      if (
        negotiated &&
        negotiated !== 'streamable-http' &&
        protocolCache[endpointKey] !== negotiated
      ) {
        protocolCache[endpointKey] = negotiated
        protocolCacheDirty = true
      }
      // 把每个 MCP 原生 tool 包装成本系统内部 ToolDefinition，名字改成 `mcp__server__tool`
      for (const descriptor of descriptors) {
        const wrappedName = `mcp__${sanitizeToolSegment(serverName)}__${sanitizeToolSegment(
          descriptor.name,
        )}`
        const inputSchema = normalizeInputSchema(descriptor.inputSchema)
        tools.push({
          name: wrappedName,
          description:
            descriptor.description?.trim() ||
            `Call MCP tool ${descriptor.name} from server ${serverName}.`,
          inputSchema,
          schema: z.unknown(),
          async run(input) {
            return client.callTool(descriptor.name, input)
          },
        })
      }

      servers.push({
        name: serverName,
        command: summarizeServerEndpoint(config),
        status: 'connected',
        toolCount: descriptors.length,
        resourceCount,
        promptCount,
        protocol: client.getProtocol() ?? undefined,
      })
    } catch (error) {
      // 启动失败：close 客户端，标记 status=error，记录错误信息
      await client.close()
      servers.push({
        name: serverName,
        command: summarizeServerEndpoint(config),
        status: 'error',
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
        protocol:
          config.protocol === 'auto' || config.protocol === undefined
            ? undefined
            : config.protocol,
      })
    }
  }

  if (protocolCacheDirty) {
    await writeProtocolCache(protocolCache).catch(() => {
      // Ignore protocol cache persistence failures.
    })
  }
  // 当至少有一个服务暴露资源时，注入两个内置工具：`list_mcp_resources` / `read_mcp_resource`
  if (clientsByServer.size > 0 && hasPublishedResources) {
    tools.push({
      name: 'list_mcp_resources',
      description: 'List optional MCP resources exposed by connected MCP servers when a server actually publishes them.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
        },
      },
      schema: z.object({
        server: z.string().optional(),
      }),
      async run(input: { server?: string }) {
        const targetClients = input.server
          ? [clientsByServer.get(input.server)].filter(
            (client): client is McpClientLike => client !== undefined,
          )
          : [...clientsByServer.values()]
        const lines: string[] = []
        for (const client of targetClients) {
          try {
            const resources = await client.listResources()
            for (const resource of resources) {
              lines.push(
                `${client.getServerName()}: ${resource.uri}${resource.name ? ` (${resource.name})` : ''}${resource.description ? ` - ${resource.description}` : ''}`,
              )
            }
          } catch (error) {
            lines.push(
              `${client.getServerName()}: failed to list resources (${error instanceof Error ? error.message : String(error)})`,
            )
          }
        }
        return {
          ok: true,
          output:
            lines.length > 0
              ? lines.join('\n')
              : 'Connected MCP servers did not publish any MCP resources. This does not mean MCP tools are unavailable.',
        }
      },
    } satisfies ToolDefinition<{ server?: string }>)

    tools.push({
      name: 'read_mcp_resource',
      description: 'Read a specific optional MCP resource by server and URI.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          uri: { type: 'string' },
        },
        required: ['server', 'uri'],
      },
      schema: z.object({
        server: z.string().min(1),
        uri: z.string().min(1),
      }),
      async run(input: { server: string; uri: string }) {
        const client = clientsByServer.get(input.server)
        if (!client) {
          return {
            ok: false,
            output: `Unknown MCP server: ${input.server}`,
          }
        }
        return client.readResource(input.uri)
      },
    } satisfies ToolDefinition<{ server: string; uri: string }>)
  }

  if (clientsByServer.size > 0 && hasPublishedPrompts) {
    tools.push({
      name: 'list_mcp_prompts',
      description: 'List optional MCP prompts exposed by connected MCP servers when a server actually publishes them.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
        },
      },
      schema: z.object({
        server: z.string().optional(),
      }),
      async run(input: { server?: string }) {
        const targetClients = input.server
          ? [clientsByServer.get(input.server)].filter(
            (client): client is McpClientLike => client !== undefined,
          )
          : [...clientsByServer.values()]
        const lines: string[] = []
        for (const client of targetClients) {
          try {
            const prompts = await client.listPrompts()
            for (const prompt of prompts) {
              const argsSummary = (prompt.arguments ?? [])
                .map(arg => `${arg.name}${arg.required ? '*' : ''}`)
                .join(', ')
              lines.push(
                `${client.getServerName()}: ${prompt.name}${argsSummary ? ` args=[${argsSummary}]` : ''}${prompt.description ? ` - ${prompt.description}` : ''}`,
              )
            }
          } catch (error) {
            lines.push(
              `${client.getServerName()}: failed to list prompts (${error instanceof Error ? error.message : String(error)})`,
            )
          }
        }
        return {
          ok: true,
          output:
            lines.length > 0
              ? lines.join('\n')
              : 'Connected MCP servers did not publish any MCP prompts. This does not mean MCP tools are unavailable.',
        }
      },
    } satisfies ToolDefinition<{ server?: string }>)

    tools.push({
      name: 'get_mcp_prompt',
      description: 'Fetch a rendered optional MCP prompt by server, prompt name, and optional arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          name: { type: 'string' },
          arguments: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['server', 'name'],
      },
      schema: z.object({
        server: z.string().min(1),
        name: z.string().min(1),
        arguments: z.record(z.string(), z.string()).optional(),
      }),
      async run(input: {
        server: string
        name: string
        arguments?: Record<string, string>
      }) {
        const client = clientsByServer.get(input.server)
        if (!client) {
          return {
            ok: false,
            output: `Unknown MCP server: ${input.server}`,
          }
        }
        return client.getPrompt(input.name, input.arguments)
      },
    } satisfies ToolDefinition<{
      server: string
      name: string
      arguments?: Record<string, string>
    }>)
  }

  return {
    tools,
    servers,
    async dispose() {
      await Promise.all(clients.map(client => client.close()))
    },
  }
}
