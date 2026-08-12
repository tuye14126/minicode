import assert from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { afterEach, beforeEach } from "node:test"

import { createDefaultToolRegistry } from "../src/tools/index.js"
import type { ToolContext, ToolRegistry } from "../src/tools.js"
import { PermissionManager } from "../src/permissions.js"

let workspace: string
let registry: ToolRegistry
let ctx: ToolContext
let homedir: string
let pm: PermissionManager

beforeEach(async () => {
  homedir = mkdtempSync(path.join(tmpdir(), "minicode-tools-home"))
  process.env.MINI_CODE_HOME = homedir
  workspace = mkdtempSync(path.join(tmpdir(), "minicode-tools-"))
  registry = await createDefaultToolRegistry({ cwd: workspace, runtime: null })
  pm = new PermissionManager(workspace, async () => ({ decision: 'allow_once' }))
  ctx = { cwd: workspace, permissions: pm }
})

afterEach(() => {
  delete process.env.MINI_CODE_HOME
  rmSync(homedir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

// ---------- T2 验收：未知工具 / 非法入参 / 越界路径 返回 ok:false ----------

test("未知工具返回 ok:false 且带可读原因", async () => {
  const result = await registry.execute("no_such_tool", {}, ctx)
  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown tool: no_such_tool/)
})

test("非法入参：read_file.offset 为负数", async () => {
  const result = await registry.execute("read_file", { path: "a.txt", offset: -1 }, ctx)
  assert.equal(result.ok, false)
  assert.match(result.output, /too_small/)
})

test("非法入参：read_file.limit 超过上限", async () => {
  const result = await registry.execute("read_file", { path: "a.txt", limit: 999999 }, ctx)
  assert.equal(result.ok, false)
  assert.match(result.output, /too_big/)
})

test("非法入参：web_search 同时指定 allowed_domains 与 blocked_domains", async () => {
  const result = await registry.execute(
    "web_search",
    {
      query: "test",
      allowed_domains: ["example.com"],
      blocked_domains: ["blocked.com"],
    },
    ctx,
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /allowed_domains/)
})

test("非法入参：web_search.max_results 为 0", async () => {
  const result = await registry.execute("web_search", { query: "x", max_results: 0 }, ctx)
  assert.equal(result.ok, false)
})

test("非法入参：web_fetch 非法 URL", async () => {
  const result = await registry.execute("web_fetch", { url: "not-a-url" }, ctx)
  assert.equal(result.ok, false)
  assert.match(result.output, /Invalid URL/)
})

test("越界路径：read_file 读取工作区外", async () => {
  const result = await registry.execute("read_file", { path: "../../secret.txt" }, { cwd: workspace })
  assert.equal(result.ok, false)
  assert.match(result.output, /Path escapes workspace/)
})

test("越界路径：write_file 写入工作区外", async () => {
  const result = await registry.execute("write_file", { path: "../../evil.txt", content: "x" }, { cwd: workspace })
  assert.equal(result.ok, false)
  assert.match(result.output, /Path escapes workspace/)
})

// ---------- 文件工具正向行为 ----------

test("write_file 创建新文件并自动创建父目录", async () => {
  const result = await registry.execute(
    "write_file",
    { path: "nested/deep/hello.txt", content: "hello\n" },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.equal(readFileSync(path.join(workspace, "nested", "deep", "hello.txt"), "utf-8"), "hello\n")
})

test("read_file 输出包含 FILE/OFFSET 头", async () => {
  writeFileSync(path.join(workspace, "a.txt"), "hello\nworld\n", "utf-8")
  const result = await registry.execute("read_file", { path: "a.txt" }, ctx)
  assert.equal(result.ok, true)
  assert.match(result.output, /FILE: a\.txt/)
  assert.match(result.output, /OFFSET: 0/)
  assert.match(result.output, /TOTAL_CHARS: 12/)
  assert.match(result.output, /hello/)
})

test("read_file offset/limit 分块读取", async () => {
  writeFileSync(path.join(workspace, "a.txt"), "hello\nworld\n", "utf-8")
  const result = await registry.execute("read_file", { path: "a.txt", offset: 6, limit: 5 }, ctx)
  assert.equal(result.ok, true)
  assert.match(result.output, /OFFSET: 6/)
  assert.match(result.output, /world/)
  assert.doesNotMatch(result.output, /hello/)
})

test("edit_file 精确文本替换（默认只替换第一处）", async () => {
  writeFileSync(path.join(workspace, "m.txt"), "foo bar foo\n", "utf-8")
  const result = await registry.execute(
    "edit_file",
    { path: "m.txt", search: "foo", replace: "baz" },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.equal(readFileSync(path.join(workspace, "m.txt"), "utf-8"), "baz bar foo\n")
})

test("edit_file replaceAll 替换所有匹配", async () => {
  writeFileSync(path.join(workspace, "m.txt"), "foo bar foo\n", "utf-8")
  const result = await registry.execute(
    "edit_file",
    { path: "m.txt", search: "foo", replace: "baz", replaceAll: true },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.equal(readFileSync(path.join(workspace, "m.txt"), "utf-8"), "baz bar baz\n")
})

test("edit_file 找不到文本返回 ok:false", async () => {
  writeFileSync(path.join(workspace, "m.txt"), "abc\n", "utf-8")
  const result = await registry.execute(
    "edit_file",
    { path: "m.txt", search: "MISSING", replace: "x" },
    ctx,
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /Text not found/)
})

test("patch_file 中途失败不落盘（原子性）", async () => {
  writeFileSync(path.join(workspace, "p.txt"), "a\nb\nc\n", "utf-8")
  const result = await registry.execute(
    "patch_file",
    {
      path: "p.txt",
      replacements: [
        { search: "a", replace: "A" },
        { search: "MISSING", replace: "X" },
      ],
    },
    ctx,
  )
  assert.equal(result.ok, false)
  assert.equal(readFileSync(path.join(workspace, "p.txt"), "utf-8"), "a\nb\nc\n")
})

test("patch_file 多项替换并支持每项 replaceAll", async () => {
  writeFileSync(path.join(workspace, "p.txt"), "foo x foo\ny\n", "utf-8")
  const result = await registry.execute(
    "patch_file",
    {
      path: "p.txt",
      replacements: [
        { search: "foo", replace: "baz", replaceAll: true },
        { search: "y", replace: "Y" },
      ],
    },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.equal(readFileSync(path.join(workspace, "p.txt"), "utf-8"), "baz x baz\nY\n")
})

test("list_files 缺省路径列出工作区", async () => {
  writeFileSync(path.join(workspace, "a.txt"), "", "utf-8")
  const result = await registry.execute("list_files", {}, ctx)
  assert.equal(result.ok, true)
  assert.match(result.output, /a\.txt/)
})

// ---------- 命令工具 ----------

test("grep_files 搜索文本（未安装 rg 时跳过）", async (t) => {
  const rg = spawnSync("rg", ["--version"], { stdio: "ignore" })
  if (rg.error || rg.status !== 0) {
    t.skip("环境未安装 ripgrep")
    return
  }
  writeFileSync(path.join(workspace, "g.txt"), "unique_token_abc\nother\n", "utf-8")
  const result = await registry.execute("grep_files", { pattern: "unique_token_abc" }, ctx)
  assert.equal(result.ok, true)
  assert.match(result.output, /unique_token_abc/)
})

test("run_command 结构化 args 执行", async () => {
  const result = await registry.execute(
    "run_command",
    { command: "node", args: ["-e", "console.log('minicode-test-ok')"] },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /minicode-test-ok/)
})

test("run_command 支持 cwd 参数", async () => {
  const result = await registry.execute(
    "run_command",
    { command: "node", args: ["-e", "console.log(process.cwd())"], cwd: "." },
    ctx,
  )
  assert.equal(result.ok, true)
  assert.match(result.output, /minicode-tools-/)
})

test("run_command 空命令返回 ok:false", async () => {
  const result = await registry.execute("run_command", { command: "" }, ctx)
  assert.equal(result.ok, false)
  assert.match(result.output, /empty command/)
})

// ---------- 交互与权限集成 ----------

test("ask_user 返回 awaitUser 标记", async () => {
  const result = await registry.execute("ask_user", { question: "确认执行?" }, ctx)
  assert.equal(result.ok, true)
  assert.equal(result.awaitUser, true)
})

test("编辑审批被拒绝时返回 ok:false 且不落盘", async () => {
  const pm = new PermissionManager(workspace, async () => ({ decision: 'deny_once' }))
  const permCtx = { cwd: workspace, permissions: pm }
  const result = await registry.execute("write_file", { path: "denied.txt", content: "x" }, permCtx)
  assert.equal(result.ok, false)
  assert.equal(existsSync(path.join(workspace, "denied.txt")), false)
})