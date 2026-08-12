import assert from "node:assert"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach } from "node:test"

import { PermissionManager } from "../src/permissions.js"
import type { PermissionPromptHandler, PermissionRequest } from "../src/permissions.js"

let homeDir: string    // 模拟 ~/.mini-code
let workspace: string  // 模拟工作区

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), "minicode-perm-home-"))
  workspace = mkdtempSync(path.join(tmpdir(), "minicode-perm-ws-"))
  process.env.MINI_CODE_HOME = homeDir
})

afterEach(() => {
  delete process.env.MINI_CODE_HOME
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

function createPromptCollector() {
  const requests: PermissionRequest[] = []
  const handler: PermissionPromptHandler = async (request) => {
    requests.push(request)
    return { decision: "allow_once" }
  }
  return { requests, handler }
}

// ---------- 路径审批 ----------

test("工作目录内路径放行，不触发弹窗", async () => {
  const { requests, handler } = createPromptCollector()
  const pm = new PermissionManager(workspace, handler)
  await pm.ensurePathAccess(path.join(workspace, "sub", "a.txt"), "read")
  await pm.ensurePathAccess(path.join(workspace, "a.txt"), "write")
  await pm.ensurePathAccess(workspace, "list")
  assert.equal(requests.length, 0)
})

test("工作区外路径触发弹窗，allow_once 后放行", async () => {
  const { requests, handler } = createPromptCollector()
  const pm = new PermissionManager(workspace, handler)
  const outside = path.join(workspace, "..", "outside-dir", "file.txt")
  await pm.ensurePathAccess(outside, "read")
  assert.equal(requests.length, 1)
  assert.equal(requests[0].kind, "path")
  assert.ok(requests[0].details.some((line) => line.includes(outside)))
})

test("allow_once 路径在同一会话内第二次访问不再弹窗", async () => {
  const { requests, handler } = createPromptCollector()
  const pm = new PermissionManager(workspace, handler)
  const target = path.join(workspace, "..", "d", "f.txt")
  await pm.ensurePathAccess(target, "read")
  await pm.ensurePathAccess(target, "read")
  assert.equal(requests.length, 1)
})

test("deny_once 拒绝路径访问", async () => {
  const pm = new PermissionManager(workspace, async () => ({ decision: "deny_once" }))
  await assert.rejects(
    pm.ensurePathAccess(path.join(workspace, "..", "x.txt"), "read"),
    /Access denied/,
  )
})

test("allow_always 持久化放行目录，新实例不弹窗", async () => {
  const outsideDir = path.join(workspace, "..", "allowed-dir")
  const pm1 = new PermissionManager(workspace, async () => ({ decision: "allow_always" }))
  await pm1.ensurePathAccess(path.join(outsideDir, "a.txt"), "read")

  let prompted = false
  const pm2 = new PermissionManager(workspace, async () => {
    prompted = true
    return { decision: "deny_once" }
  })
  await pm2.ensurePathAccess(path.join(outsideDir, "b.txt"), "read")
  assert.equal(prompted, false)
})

test("deny_always 持久化到 permissions.json，新实例直接拒绝", async () => {
  const target = path.join(workspace, "..", "denied-dir", "f.txt")
  const pm1 = new PermissionManager(workspace, async () => ({ decision: "deny_always" }))
  await assert.rejects(pm1.ensurePathAccess(target, "read"))

  const store = JSON.parse(readFileSync(path.join(homeDir, "permissions.json"), "utf-8"))
  assert.ok(store.deniedDirectoryPrefixes.includes(path.dirname(target)))

  let prompted = false
  const pm2 = new PermissionManager(workspace, async () => {
    prompted = true
    return { decision: "allow_once" }
  })
  await assert.rejects(pm2.ensurePathAccess(target, "read"), /Access denied/)
  assert.equal(prompted, false)
})

test("审批处理器抛错（用户取消）视为拒绝", async () => {
  const pm = new PermissionManager(workspace, async () => {
    throw new Error("user cancelled")
  })
  await assert.rejects(
    pm.ensurePathAccess(path.join(workspace, "..", "x"), "read"),
    /user cancelled/,
  )
})

// ---------- 命令审批 ----------

test("普通命令不弹窗", async () => {
  const { requests, handler } = createPromptCollector()
  const pm = new PermissionManager(workspace, handler)
  await pm.ensureCommand("pwd", [], workspace)
  await pm.ensureCommand("echo", ["hi"], workspace)
  assert.equal(requests.length, 0)
})

test("危险命令触发弹窗，allow_once 后放行", async () => {
  const { requests, handler } = createPromptCollector()
  const pm = new PermissionManager(workspace, handler)
  await pm.ensureCommand("git", ["reset", "--hard"], workspace)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].kind, "command")
  assert.match(requests[0].details.join("\n"), /git reset --hard/)
})

test("解释器命令（node）触发弹窗", async () => {
  const { requests, handler } = createPromptCollector()
  const pm = new PermissionManager(workspace, handler)
  await pm.ensureCommand("node", ["-e", "1"], workspace)
  assert.equal(requests.length, 1)
  assert.match(requests[0].details.join("\n"), /node -e 1/)
})

test("命令 deny_always 持久化，新实例直接拒绝", async () => {
  const pm1 = new PermissionManager(workspace, async () => ({ decision: "deny_always" }))
  await assert.rejects(pm1.ensureCommand("git", ["reset", "--hard"], workspace))

  const store = JSON.parse(readFileSync(path.join(homeDir, "permissions.json"), "utf-8"))
  assert.ok(store.deniedCommandPatterns.includes("git reset --hard"))

  let prompted = false
  const pm2 = new PermissionManager(workspace, async () => {
    prompted = true
    return { decision: "allow_once" }
  })
  await assert.rejects(pm2.ensureCommand("git", ["reset", "--hard"], workspace), /Command denied/)
  assert.equal(prompted, false)
})

// ---------- 编辑审批 ----------

test("编辑审批弹窗包含 diff，allow_once 放行", async () => {
  const { requests, handler } = createPromptCollector()
  const pm = new PermissionManager(workspace, handler)
  await pm.ensureEdit(path.join(workspace, "a.txt"), "--- a/a.txt\n+++ b/a.txt\n+hello\n")
  assert.equal(requests.length, 1)
  assert.equal(requests[0].kind, "edit")
  assert.match(requests[0].details.join("\n"), /hello/)
})

test("allow_turn 仅在本 turn 生效，resetTurn 后重新弹窗", async () => {
  let count = 0
  const pm = new PermissionManager(workspace, async () => {
    count++
    return { decision: "allow_turn" }
  })
  const target = path.join(workspace, "a.txt")
  await pm.ensureEdit(target, "diff1")
  await pm.ensureEdit(target, "diff2")
  assert.equal(count, 1)
  pm.resetTurn()
  await pm.ensureEdit(target, "diff3")
  assert.equal(count, 2)
})

test("allow_all_turn 放行本轮所有编辑，resetTurn 后失效", async () => {
  let count = 0
  const pm = new PermissionManager(workspace, async () => {
    count++
    return { decision: "allow_all_turn" }
  })
  await pm.ensureEdit(path.join(workspace, "a.txt"), "d1")
  await pm.ensureEdit(path.join(workspace, "b.txt"), "d2")
  await pm.ensureEdit(path.join(workspace, "c.txt"), "d3")
  assert.equal(count, 1)
  pm.resetTurn()
  await pm.ensureEdit(path.join(workspace, "c.txt"), "d3")
  assert.equal(count, 2)
})

test("deny_with_feedback 拒绝并携带用户反馈", async () => {
  const pm = new PermissionManager(workspace, async () => ({
    decision: "deny_with_feedback",
    feedback: "不要修改这个文件",
  }))
  await assert.rejects(
    pm.ensureEdit(path.join(workspace, "a.txt"), "diff"),
    /User guidance: 不要修改这个文件/,
  )
})

test("编辑 deny_always 持久化，新实例直接拒绝", async () => {
  const target = path.join(workspace, "a.txt")
  const pm1 = new PermissionManager(workspace, async () => ({ decision: "deny_always" }))
  await assert.rejects(pm1.ensureEdit(target, "diff"))

  const store = JSON.parse(readFileSync(path.join(homeDir, "permissions.json"), "utf-8"))
  assert.ok(store.deniedEditPatterns.includes(target))

  let prompted = false
  const pm2 = new PermissionManager(workspace, async () => {
    prompted = true
    return { decision: "allow_once" }
  })
  await assert.rejects(pm2.ensureEdit(target, "diff"), /Edit denied/)
  assert.equal(prompted, false)
})

// ---------- 非 TTY 与汇总 ----------

test("无审批处理器（非 TTY）时直接拒绝", async () => {
  const pm = new PermissionManager(workspace)
  await assert.rejects(
    pm.ensurePathAccess(path.join(workspace, "..", "x"), "read"),
    /TTY/,
  )
  await assert.rejects(pm.ensureCommand("git", ["reset", "--hard"], workspace), /TTY/)
  await assert.rejects(pm.ensureEdit(path.join(workspace, "a.txt"), "diff"), /TTY/)
})

test("getSummary 汇总当前权限配置", async () => {
  const pm = new PermissionManager(workspace, async () => ({ decision: "allow_always" }))
  await pm.ensurePathAccess(path.join(workspace, "..", "extra-dir"), "read")
  const summary = pm.getSummary()
  assert.ok(summary.some((line) => line.includes("cwd:")))
  assert.ok(summary.some((line) => line.includes("allowed dirs")))
})