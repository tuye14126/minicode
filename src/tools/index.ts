import { RuntimeConfig } from "../config.js"
import { discoverSkills } from "../skills.js"
import { ToolRegistry } from "../tool.js"
import { askUserTool } from "./ask-user.js"
import { editFileTool } from "./edit-file.js"
import { grepFilesTool } from "./grep-files.js"
import { listFilesTool } from "./list-files.js"
import { createLoadSkillTool } from "./load-skill.js"
import { modifyFileTool } from "./modify-file.js"
import { patchFileTool } from "./patch-file.js"
import { readFileTool } from "./read-file.js"
import { runCommandTool } from "./run-command.js"
import { webFetchTool } from "./web-fetch.js"
import { webSearchTool } from "./web-search.js"
import { writeFileTool } from "./write-file.js"

export const SUB_AGENT_TOOL_NAMES = [
  'list_files',
  'grep_files',
  'read_file',
  'load_skill',
  'web_fetch',
  'web_search',
] as const


export async function createDefaultToolRegistry(args: {
  cwd: string
  runtime: RuntimeConfig | null
}): Promise<ToolRegistry> {

  const skills = await discoverSkills(args.cwd)

  return new ToolRegistry([
    askUserTool,
    listFilesTool,
    grepFilesTool,
    readFileTool,
    writeFileTool,
    modifyFileTool,
    editFileTool,
    patchFileTool,
    runCommandTool,
    webFetchTool,
    webSearchTool,
    createLoadSkillTool(args.cwd)
  ], {
    skills,
  }
  )
}