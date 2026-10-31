import process from 'node:process'
import type { BackgroundTaskResult } from './tool.js'
import { getErrorCode } from './utils/errors.js'

type BackgroundTaskRecord = BackgroundTaskResult & {
  cwd: string
}

const tasks = new Map<string, BackgroundTaskRecord>()

// makeTaskId () 生成任务唯一 ID
function makeTaskId(): string {
  return `shell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// 任务状态更新
// 任务状态只有在查询的时候才更新，不是子进程退出瞬间立刻回调更新
function refreshRecord(record: BackgroundTaskRecord): BackgroundTaskRecord {
  if (record.status !== 'running') {
    return record
  }

  try {
    process.kill(record.pid, 0)  // 检查 PID 是否存在
    return record
  } catch (error) {
    // 如果进程不存在，则更改进程状态
    const code = getErrorCode(error)
    if (code === 'ESRCH') {
      const next = {
        ...record,
        status: 'completed' as const,
      }
      tasks.set(record.taskId, next)
      return next
    }

    const next = {
      ...record,
      status: 'failed' as const,
    }
    tasks.set(record.taskId, next)
    return next
  }
}


// 注册新建后台 shell 任务
// 这个函数只负责注册记录，不负责 spawn 启动 shell 进程；
// 上层代码已经 fork 出子进程拿到 pid 之后，才调用这个函数注册
export function registerBackgroundShellTask(args: {
  command: string
  pid: number
  cwd: string
}): BackgroundTaskResult {
  const task: BackgroundTaskRecord = {
    taskId: makeTaskId(),
    type: 'local_bash',
    command: args.command,
    pid: args.pid,
    cwd: args.cwd,
    status: 'running',
    startedAt: Date.now(),
  }
  tasks.set(task.taskId, task)
  return task
}
// 列出全部后台任务，逐个执行`refreshRecord`刷新状态
export function listBackgroundTasks(): BackgroundTaskResult[] {
  return [...tasks.values()].map(refreshRecord)
}

// 按 taskId 查询单个任务
export function getBackgroundTask(taskId: string): BackgroundTaskResult | null {
  const task = tasks.get(taskId)
  if (!task) {
    return null
  }
  return refreshRecord(task)
}
