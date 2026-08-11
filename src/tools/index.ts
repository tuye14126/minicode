import { RuntimeConfig } from "../config.js"
import { ToolRegistry } from "../tools.js"
import { askUserTool } from "./ask-user.js"
import { editFileTool } from "./edit-file.js"
import { grepFilesTool } from "./grep-files.js"
import { listFilesTool } from "./list-files.js"
import { modifyFileTool } from "./modify-file.js"
import { patchFileTool } from "./patch-file.js"
import { readFileTool } from "./read-file.js"
import { runCommandTool } from "./run-commands.js"
import { webFetchTool } from "./web-fetch.js"
import { webSearchTool } from "./web-search.js"
import { writeFileTool } from "./write-file.js"


export async function createDefaultToolRegistry(args: {
  cwd: string
  runtime: RuntimeConfig | null
}): Promise<ToolRegistry> {
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
    webSearchTool
  ])
}