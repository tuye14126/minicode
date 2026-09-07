import { ContentReplacementState, PendingToolResult, replaceLargeToolResult, createContentReplacementState, applyToolResultBudget } from './utils/tool-result-storage.js';
import { ToolRegistry } from './tool.js';
import { PermissionManager } from './permissions.js';
import { ChatMessage, CompressionResult, ModelAdapter, ProviderThinkingBlock, ProviderUsage } from './types.js';
import { OpenAI } from 'openai/client.js';
import { computeContextStats } from './utils/token-estimator.js';
import { snipCompactConversation, SnipCompactResult } from './compact/snipCompact.js';
import { microcompact } from './compact/microcompact.js';
import { applyContextCollapseIfNeeded, ContextCollapseResult, ContextCollapseState, createContextCollapseState } from './compact/context-collapse.js';
import { autoCompact } from './compact/auto-compact.js';
import { throwIfAborted } from './abort.js';
export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam
function isEmptyAssistantResponse(content: string): boolean {
  return content.trim().length === 0
}

function shouldTreatAssistantAsProgress(
  kind?: 'final' | 'progress'
): boolean {
  if (kind === 'progress') {
    return true
  }
  if (kind === 'final') {
    return false
  }
  return false
}
function isRecoverableThinkingStop(args: {
  isEmpty: boolean
  stopReason?: string
  blockTypes?: string[]
  ignoredBlockTypes?: string[]
}): boolean {
  if (!args.isEmpty) {
    return false
  }

  if (args.stopReason !== 'pause_turn' && args.stopReason !== 'max_tokens') {
    return false
  }

  return (
    (args.blockTypes ?? []).includes('thinking') ||
    (args.ignoredBlockTypes ?? []).includes('thinking')
  )
}

function formatDiagnostics(args: {
  stopReason?: string
  blockTypes?: string[]
  ignoredBlockTypes?: string[]
}): string {
  const parts: string[] = []

  if (args.stopReason) {
    parts.push(`stop_reason=${args.stopReason}`)
  }

  if ((args.blockTypes?.length ?? 0) > 0) {
    parts.push(`blocks=${args.blockTypes!.join(',')}`)
  }

  if ((args.ignoredBlockTypes?.length ?? 0) > 0) {
    parts.push(`ignored=${args.ignoredBlockTypes!.join(',')}`)
  }

  return parts.length > 0 ? ` 诊断信息: ${parts.join('; ')}。` : ''
}


function withProviderUsage(
  message: ChatMessage,
  usage: ProviderUsage | undefined
): ChatMessage {
  if (!usage) return message
  if (message.role === 'assistant'
    || message.role === 'assistant_tool_call'
    || message.role === 'assistant_progress'
  ) {
    return { ...message, providerUsage: usage }
  }
  return message
}


export async function runAgentTurn(args: {
  messages: ChatMessage[],
  maxSteps?: number,
  model: ModelAdapter,
  modelName?: string,
  tools: ToolRegistry,
  permissions?: PermissionManager,
  cwd: string,
  onProgressMessage?: (content: string) => void,
  onAssistantMessage?: (content: string, metadata?: { final?: boolean }) => void,
  onToolStart?: (toolName: string, input: unknown) => void,
  onToolResult?: (toolName: string, output: string, isError: boolean) => void
  onSnipCompact?: (result: SnipCompactResult) => void | Promise<void>
  onContextStats?: (stats: import('./utils/token-estimator.js').ContextStats) => void,
  onContextCollapse?: (result: ContextCollapseResult) => void | Promise<void>,
  onAutoCompact?: (result: CompressionResult) => void | Promise<void>,
  contentReplacementState?: ContentReplacementState,
  contextCollapseState?: ContextCollapseState,
  signal?: AbortSignal


}): Promise<ChatMessage[]> {
  const maxSteps = args.maxSteps ?? 15
  let messages = args.messages
  let sawToolResultThisTurn = false
  let recoverableThinkingRetryCount = 0
  let toolErrorCount = 0
  let emptyResponseRetryCount = 0
  let snippedThisTurn = false

  const modelName = args.modelName ?? ''
  let contextCollapseState =
    args.contextCollapseState ?? createContextCollapseState()
  const contentReplacementState =
    args.contentReplacementState ?? createContentReplacementState()

  const appendThinkingBlocks = (blocks: ProviderThinkingBlock[] | undefined) => {
    if (!blocks || blocks.length === 0) return
    messages = [
      ...messages,
      {
        role: 'assistant_thinking',
        blocks
      }
    ]
  }

  const replaceContextCollapseState = (nextState: ContextCollapseState) => {
    contextCollapseState = nextState
    if (args.contextCollapseState) {
      args.contextCollapseState.spans = [...nextState.spans]
      args.contextCollapseState.enabled = nextState.enabled
      args.contextCollapseState.consecutiveFailures = nextState.consecutiveFailures
    }
  }

  const pushContinuationPrompt = (content: string) => {
    messages = [
      ...messages,
      {
        role: 'user',
        content,
      },
    ]
  }
  for (let turn = 0; turn < maxSteps; turn++) {
    throwIfAborted(args.signal)
    let latestStats: import('./utils/token-estimator.js').ContextStats | null = null
    // 专门为大模型提供的消息,可能包含折叠视图
    let modelMessages = messages
    if (modelName) {
      latestStats = computeContextStats(messages, modelName)
      // 滑动截断：保留开头和结尾 裁去中间
      if (!snippedThisTurn) {
        const snipResult = await snipCompactConversation({
          messages,
          contextStats: latestStats,
          modelContextWindow: latestStats.effectiveInput
        })
        if (snipResult.didSnip) {
          messages = snipResult.messages
          snippedThisTurn = true
          await args.onSnipCompact?.(snipResult)
          latestStats = computeContextStats(messages, modelName)
          args.onContextStats?.(latestStats)
        }
      }

      // 对部分工具的调用结果进行压缩
      const beforeMicrocompact = messages
      messages = microcompact(messages, modelName)
      if (messages !== beforeMicrocompact) {
        latestStats = computeContextStats(messages, modelName)
        args.onContextStats?.(latestStats)
      }

      // 利用大模型对历史消息进行摘要压缩, 不影响真实message, 会产生一个折叠后的视图
      const collapseResult = await applyContextCollapseIfNeeded(
        messages,
        modelName,
        args.model,
        contextCollapseState,
      )
      // 进行消息折叠后更新全局CollapseState
      replaceContextCollapseState(collapseResult.state)
      modelMessages = collapseResult.messages
      if (collapseResult.collapsed) {
        await args.onContextCollapse?.(collapseResult)
        latestStats = computeContextStats(modelMessages, modelName)
        args.onContextStats?.(latestStats)
      } else if (modelMessages !== messages) {
        latestStats = computeContextStats(modelMessages, modelName)
        args.onContextStats?.(latestStats)
      }

    }


    // 自动压缩, 直接压缩真实的消息, 仅在刚开始进行一次
    if (turn == 0 && modelName) {
      latestStats = latestStats ?? computeContextStats(modelMessages, modelName)
      args.onContextStats?.(latestStats)
      if (latestStats.warningLevel === 'critical' || latestStats.warningLevel === 'blocked') {
        const result = await autoCompact(modelMessages, modelName, args.model)
        if (result) {
          messages = result.messages
          modelMessages = messages
          replaceContextCollapseState(createContextCollapseState())
          await args.onAutoCompact?.(result)
          latestStats = computeContextStats(messages, modelName)
          args.onContextStats?.(latestStats)
        }
      }
    }

    const agentStep = await args.model.next(modelMessages, {
      tools: args.tools.list(),
      signal: args.signal,
    })

    if (agentStep.type === 'assistant') {
      const isEmpty = isEmptyAssistantResponse(agentStep.content)
      // 判断是否是过程性消息
      if (
        !isEmpty &&
        shouldTreatAssistantAsProgress(agentStep.kind)
      ) {
        args.onProgressMessage?.(agentStep.content)
        appendThinkingBlocks(agentStep.thinkingBlocks)
        messages = [
          ...messages,
          { role: 'assistant_progress', content: agentStep.content }
        ]
        pushContinuationPrompt(
          sawToolResultThisTurn
            ? "从你的进度更新继续执行。本轮已经调用过工具，请把普通状态文本视作进度，不要当做最终答案。请输出下一个具体工具调用、代码修改；只有任务真正完成时，才输出明确的 <final> 最终回答."
            : "立刻从你的 <progress> 更新继续执行，请输出具体工具调用、代码修改；只有任务真正完成时，才输出明确的 <final> 最终回答。"
        )
        continue
      }
      // 判断思考过程是否被截断, 如果是则重试
      if (isRecoverableThinkingStop({
        isEmpty,
        stopReason: agentStep.diagnostics?.stopReason,
        blockTypes: agentStep.diagnostics?.blockTypes,
        ignoredBlockTypes: agentStep.diagnostics?.ignoredBlockTypes,
      }) && recoverableThinkingRetryCount < 3) {
        recoverableThinkingRetryCount += 1
        const stopReason = agentStep.diagnostics?.stopReason
        const progressContent =
          stopReason === 'max_tokens'
            ? '模型在 thinking 阶段触发 max_tokens，正在继续请求后续步骤...'
            : '模型返回 pause_turn，正在继续请求后续步骤...'
        args.onProgressMessage?.(progressContent)
        messages = [
          ...messages,
          { role: 'assistant_progress', content: progressContent },
        ]
        pushContinuationPrompt(
          stopReason === 'max_tokens'
            ? '上一轮思考阶段触发最大token限制，尚未输出下一步可执行操作。请立刻恢复执行，直接输出下一个具体工具调用、代码修改；任务完成时才输出明确的 <final> 结束标记。禁止复述之前的方案。'
            : '从上一次暂停轮次继续任务，立刻往下执行。输出下一个具体工具调用、代码修改；任务完成时才输出明确的 <final> 结束标记。'
        )
        continue
      }

      // 返回为空, 则进行重试
      if (isEmpty && emptyResponseRetryCount < 2) {
        emptyResponseRetryCount += 1
        pushContinuationPrompt(
          sawToolResultThisTurn
            ? '刚刚获取工具返回结果后，你的上一轮输出为空。请立刻继续，执行下一步具体操作，处理工具返回的各类错误；仅当任务全部完成时，输出明确的 <final> 结束标记。'
            : '你的上一轮输出为空。请立刻继续，输出具体的工具调用、代码修改；仅当任务全部完成时，输出明确的 <final> 结束标记。'
        )
        continue
      }

      // 空回复达到上限

      if (isEmpty) {
        const diagnosticsSuffix = formatDiagnostics({
          stopReason: agentStep.diagnostics?.stopReason,
          blockTypes: agentStep.diagnostics?.blockTypes,
          ignoredBlockTypes: agentStep.diagnostics?.ignoredBlockTypes,
        })
        const fallbackContent =
          sawToolResultThisTurn
            ? toolErrorCount > 0
              ? `工具执行后模型返回空响应，已停止当前回合。最近有 ${toolErrorCount} 个工具报错；请重试、调整命令，或让模型改用其他方案。${diagnosticsSuffix}`
              : `工具执行后模型返回空响应，已停止当前回合。请重试，或要求模型继续完成剩余步骤。${diagnosticsSuffix}`
            : `模型返回空响应，已停止当前回合。请重试，或要求模型继续。${diagnosticsSuffix}`
        args.onAssistantMessage?.(fallbackContent, { final: true })
        appendThinkingBlocks(agentStep.thinkingBlocks)
        return [
          ...messages,
          {
            role: 'assistant',
            content: fallbackContent,
          },
        ]
      }
      // 正常非空 assistant 回复
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: agentStep.content,
      }
      appendThinkingBlocks(agentStep.thinkingBlocks)
      const withAssistant = [
        ...messages,
        withProviderUsage(assistantMessage, agentStep.usage)
      ]

      if (!isEmpty) {
        args.onAssistantMessage?.(agentStep.content, { final: true })
      }
      return withAssistant

    }
    // 如果模型需要调用工具, 即返回type值为assistant_tool_call
    appendThinkingBlocks(agentStep.thinkingBlocks)
    //如果有普通文本返回

    if (agentStep.content) {
      if (agentStep.contentKind === 'progress') {
        args.onProgressMessage?.(agentStep.content)
        messages = [
          ...messages,
          withProviderUsage({ role: 'assistant_progress', content: agentStep.content }, agentStep.usage)
        ]
        pushContinuationPrompt(
          '基于你刚刚输出的 <progress> 进度更新立即继续执行，输出具体的工具调用、代码修改；仅当任务全部完成时，输出明确的 <final> 结束标记。'
        )
      } else {
        args.onAssistantMessage?.(
          agentStep.content,
          (agentStep.calls?.length ?? 0) > 0 ? undefined : { final: true },
        )
        messages = [
          ...messages,
          withProviderUsage(
            { role: 'assistant', content: agentStep.content },
            (agentStep.calls?.length ?? 0) > 0 ? undefined : agentStep.usage,
          ),
        ]
      }

    }
    // 需要调用的工具为空, 且有普通文本且类型不是过程性消息, 则return
    if ((agentStep.calls?.length ?? 0) === 0 && agentStep.content && agentStep.contentKind !== 'progress') {
      return messages
    }

    // 需要调用工具的情况
    const executedToolResults: Array<{
      call: (typeof agentStep.calls)[number],
      result: Awaited<ReturnType<ToolRegistry['execute']>>,
      toolResult: PendingToolResult
    }> = []

    for (const call of agentStep.calls) {
      throwIfAborted(args.signal)
      args.onToolStart?.(call.toolName, call.input)
      const result = await args.tools.execute(
        call.toolName,
        call.input,
        {
          cwd: args.cwd,
          permissions: args.permissions
        }
      )
      sawToolResultThisTurn = true
      if (!result.ok) {
        toolErrorCount += 1
      }
      args.onToolResult?.(call.toolName, result.output, !result.ok)
      // 第一次落盘，处理特别大的工具结果
      const toolResult = await replaceLargeToolResult({
        role: 'tool_result',
        toolUseId: call.id,
        toolName: call.toolName,
        content: result.output,
        isError: !result.ok
      }, contentReplacementState)
      executedToolResults.push({
        call,
        result,
        toolResult
      })
    }
    // 第二次落盘，处理较小的工具结果，直到整体低于阈值
    const budgetedResults = await applyToolResultBudget(
      executedToolResults.map(entry => entry.toolResult),
      contentReplacementState,
    )

    const toolResultById = new Map(
      budgetedResults.results.map(result => [result.toolUseId, result]),
    )

    const toolCallMessages = executedToolResults.map((entry, i) => {
      const toolCallMessage: ChatMessage = {
        role: 'assistant_tool_call',
        toolUseId: entry.call.id,
        toolName: entry.call.toolName,
        input: entry.call.input,
      }
      return withProviderUsage(
        toolCallMessage,
        i === executedToolResults.length - 1 ? agentStep.usage : undefined,
      )
    })

    const toolResults = executedToolResults.map(entry =>
      toolResultById.get(entry.call.id) ?? entry.toolResult,
    )

    messages = [
      ...messages,
      ...toolCallMessages,
      ...toolResults
    ]
    // 如果模型有问用户问题, 则中断循环, 用户回答后重新执行runAgentTurn函数
    const awaitUserEntry = executedToolResults.find(entry => entry.result.awaitUser)
    if (awaitUserEntry) {
      const question = awaitUserEntry.result.output.trim()
      if (question.length > 0) {
        args.onAssistantMessage?.(question)
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: question,
          },
        ]
      }
      return messages
    }

  }
  const maxStepContent = `达到最大工具步数限制，已停止当前回合。`
  args.onAssistantMessage?.(maxStepContent, { final: true })
  return [
    ...messages,
    {
      role: 'assistant',
      content: maxStepContent,
    },
  ]
}