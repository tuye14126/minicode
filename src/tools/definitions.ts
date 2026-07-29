export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "read_file",
    description: "读取文件的内容",
    parameters: {
      type: "object",
      properties: {
        path: { type: 'string', description: "文件路径" }
      },
      required: ['path']
    }
  },
  {
    type: 'function',
    name: 'write_file',
    description: '写入一个文件。如果文件已存在会覆盖。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    type: 'function',
    name: 'run_command',
    description: '执行一个 shell 命令并获取输出',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        description: { type: 'string', description: '为什么要执行这个命令（可选）' },
      },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'list_files',
    description: '列出目录下的文件和子目录',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认当前目录' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'grep_files',
    description: '在文件中搜索文本模式',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的文本或正则' },
        path: { type: 'string', description: '搜索路径，默认当前目录（可选）' },
      },
      required: ['pattern'],
    },
  },
]