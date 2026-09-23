import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { isEnoentError } from "./utils/errors.js"

// skill的元数据
export type SkillSummary = {
  name: string
  description: string
  path: string
  source: 'project' | 'user' | 'compat_project' | 'compat_user'
}

// skill的完整信息
export type LoadedSkill = SkillSummary & {
  content: string
}

// skill根目录及来源信息
type SkillSourceRoot = {
  root: string
  source: SkillSummary['source']
}

type SkillScope = 'user' | 'project'

// 提取skill文件中的description
function extractDescription(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n')
  const paragraphs = normalized
    .split('\n\n')
    .map(block => block.trim())
    .filter(Boolean)

  for (const block of paragraphs) {
    if (block.startsWith('#')) {
      continue
    }

    const line = block
      .split('\n')
      .map(part => part.trim())
      .find(part => part.length > 0 && !part.startsWith('#'))

    if (line) {
      return line.replace(/`/g, '')
    }
  }

  return 'No description provided.'
}


// 读取单个技能根目录，扫描所有子文件夹
async function listSkillDirs(root: SkillSourceRoot): Promise<LoadedSkill[]> {
  try {
    // 读取根目录下的所有目录
    const entries = await readdir(root.root, { withFileTypes: true })
    const results: LoadedSkill[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      // 遍历这些目录，找到里面的所有skill.md文件
      const skillPath = path.join(root.root, entry.name, 'SKILL.md')

      try {
        const content = await readFile(skillPath, 'utf8')
        results.push({
          name: entry.name,
          description: extractDescription(content),
          path: skillPath,
          source: root.source,
          content,
        })
      } catch {
        // Ignore malformed or missing skills.
      }
    }

    return results
  } catch {
    return []
  }
}

// 根据skill的类型获取skill的根目录
function getManagedSkillRoot(scope: SkillScope, cwd: string): string {
  return scope === 'project'
    ? path.join(cwd, '.mini-code', 'skills')
    : path.join(homedir(), '.mini-code', 'skills')
}

// 返回skill的扫描目录
function getSkillRoots(cwd: string): SkillSourceRoot[] {
  return [
    {
      root: path.join(cwd, '.mini-code', 'skills'),
      source: 'project',
    },
    {
      root: path.join(homedir(), '.mini-code', 'skills'),
      source: 'user',
    },
    {
      root: path.join(cwd, '.claude', 'skills'),
      source: 'compat_project',
    },
    {
      root: path.join(homedir(), '.claude', 'skills'),
      source: 'compat_user',
    },
  ]
}

// 发现所有可用的skill的摘要
export async function discoverSkills(cwd: string): Promise<SkillSummary[]> {
  const byName = new Map<string, LoadedSkill>()

  for (const root of getSkillRoots(cwd)) {
    const skills = await listSkillDirs(root)
    for (const skill of skills) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill)
      }
    }
  }

  return [...byName.values()].map(skill => ({
    name: skill.name,
    description: skill.description,
    path: skill.path,
    source: skill.source,
  }))
}
// 按名称加载单个skill完整内容
export async function loadSkill(
  cwd: string,
  name: string,
): Promise<LoadedSkill | null> {
  const normalizedName = name.trim()
  if (!normalizedName) {
    return null
  }

  for (const root of getSkillRoots(cwd)) {
    const skillPath = path.join(root.root, normalizedName, 'SKILL.md')
    try {
      const content = await readFile(skillPath, 'utf8')
      return {
        name: normalizedName,
        description: extractDescription(content),
        path: skillPath,
        source: root.source,
        content,
      }
    } catch {
      // Keep searching lower-priority roots.
    }
  }

  return null
}

// 将本地的skill引入，放到skill根目录中生效
export async function installSkill(args: {
  cwd: string
  sourcePath: string
  name?: string
  scope?: SkillScope
}): Promise<{ name: string; targetPath: string }> {
  const scope = args.scope ?? 'user'
  const statPath = path.resolve(args.cwd, args.sourcePath)
  let content: string
  let inferredName: string

  try {
    const entries = await readdir(statPath, { withFileTypes: true })
    const skillFile = entries.find(entry => entry.isFile() && entry.name === 'SKILL.md')
    if (!skillFile) {
      throw new Error(`No SKILL.md found in ${statPath}`)
    }
    content = await readFile(path.join(statPath, 'SKILL.md'), 'utf8')
    inferredName = path.basename(statPath)
  } catch (error) {
    const filePath = statPath.endsWith('SKILL.md') ? statPath : path.join(statPath, 'SKILL.md')
    try {
      content = await readFile(filePath, 'utf8')
      inferredName = path.basename(path.dirname(filePath))
    } catch {
      throw error
    }
  }

  const skillName = (args.name ?? inferredName).trim()
  if (!skillName) {
    throw new Error('Skill name cannot be empty.')
  }

  const targetRoot = getManagedSkillRoot(scope, args.cwd)
  const targetDir = path.join(targetRoot, skillName)
  const targetPath = path.join(targetDir, 'SKILL.md')
  await mkdir(targetDir, { recursive: true })
  await writeFile(targetPath, content, 'utf8')

  return {
    name: skillName,
    targetPath,
  }
}

// 删除单个skill
export async function removeManagedSkill(args: {
  cwd: string
  name: string
  scope?: SkillScope
}): Promise<{ removed: boolean; targetPath: string }> {
  const scope = args.scope ?? 'user'
  const targetPath = path.join(getManagedSkillRoot(scope, args.cwd), args.name)
  try {
    await rm(targetPath, { recursive: true, force: false })
    return { removed: true, targetPath }
  } catch (error) {
    if (isEnoentError(error)) {
      return { removed: false, targetPath }
    }
    throw error
  }
}