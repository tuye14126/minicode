export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取文件的内容",
      parameters: {
        type: "object",
        properties: {
          path: { type: 'string', description: "文件路径" }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
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
    }
  },
  {
    type: 'function',
    function: {
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
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录下的文件和子目录',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，默认当前目录' },
        },
        required: [],
      },
    }
  },
  {
    type: 'function',
    function: {
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
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '在已有的文件中查找一段文本并替换。只替换第一处匹配。适合修改文件中的某一行或某段代码。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          search: { type: 'string', description: '要查找的原文，需要精确匹配' },
          replace: { type: 'string', description: '替换成什么内容' },
        },
        required: ['path', 'search', 'replace'],
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: '在一个文件中同时应用多处查找替换。所有替换同时生效，互不干扰。适合一次性改多个地方。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          replacements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string', description: '需要被替换的文本原文' },
                replace: { type: 'string', description: '替换为什么内容' }
              }
            }
          },
        },
        required: ['path', 'replacements'],
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'modify_file',
      description: '读取文件现有内容，用全新内容替换。适合要大改一个文件时使用。会展示 diff 给用户确认。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '新的完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '当你需要澄清需求、确认方案或获取关键信息时，向用户提问。问题要具体、一次只问一个。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取一个网页并返回纯文本内容。用于查阅文档、API 说明等。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的完整 URL' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网，返回前 5 条结果的标题和链接。用于查找最新资料、API 用法等。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
  },
]