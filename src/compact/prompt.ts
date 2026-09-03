export function buildCompactSummaryPrompt(conversationText: string): string {
  return `你正在对一段对话进行上下文压缩摘要。
请输出一个结构化摘要，放在 <summary> 标签内。


章节：
1. 主要请求 —— 用户要求做什么
2. 关键决策 —— 做过的重要选择
3. 修改过的文件 —— 哪些文件被修改了，以及为什么
4. 遇到的错误 —— 遇到的问题以及如何解决的
5. 当前状态 —— 目前进展到哪里
6. 待办事项 —— 还需要做什么


规则：
- 保持简洁，但保留可操作的关键细节（文件路径、命令输出、错误信息）
- 先用 <analysis> 标签作为草稿，再输出最终的 <summary> 标签
- 摘要将替换最近尾部之前的所有消息


待摘要的对话：


${conversationText}`
}


export function parseSummaryFromResponse(response: string): string | null {
  const summaryMatch = response.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim()
  }

  const analysisMatch = response.match(/<analysis>([\s\S]*?)<\/analysis>/)
  if (!analysisMatch) {
    const trimmed = response.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }

  return null
}
