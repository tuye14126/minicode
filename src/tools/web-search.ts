import z from "zod"
import { ToolDefinition } from "../tool.js"
import { parseHTML } from "linkedom"

type Input = {
  query: string
  max_results?: number
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export const webSearchTool: ToolDefinition<Input> = {
  name: 'web_search',
  description: '需要实时信息、外部文档、本地没有的资料时启用 being 全网搜索',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要搜索的问题' },
      max_results: { type: 'number', description: '最大返回的搜索结果数量, 默认为5个' },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: '白名单域名，仅返回来自这些网站的结果',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: '黑名单域名，过滤掉指定网站',
      },
    },
    required: ['query'],
  },
  schema: z.object({
    query: z.string().min(1),
    max_results: z.number().int().min(1).max(20).optional(),
    allowed_domains: z.array(z.string().min(1)).optional(),
    blocked_domains: z.array(z.string().min(1)).optional(),
  })
    .superRefine((value, ctx) => {
      if (
        (value.allowed_domains?.length ?? 0) > 0 &&
        (value.blocked_domains?.length ?? 0) > 0
      ) {
        ctx.addIssue({
          code: 'custom',
          message: '单次请求不能同时设置允许域名和屏蔽域名',
          path: ['allowed_domains']
        })
      }
    }),
  async run(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const query = encodeURIComponent(input.query);
      const url = `https://www.bing.com/search?q=${query}`;

      const response = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          ok: false,
          output: `搜索请求HTTP异常: ${response.status} ${response.statusText}`
        };
      }

      const html = await response.text();
      const { document } = parseHTML(html);
      const results: string[] = [];

      // 过滤域名的辅助函数
      const extractDomain = (url: string): string => {
        try {
          return new URL(url).hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      };

      const isDomainAllowed = (hostname: string): boolean => {
        if (input.allowed_domains?.length) {
          return input.allowed_domains.some(
            d => hostname === d || hostname.endsWith('.' + d)
          );
        }
        if (input.blocked_domains?.length) {
          return !input.blocked_domains.some(
            d => hostname === d || hostname.endsWith('.' + d)
          );
        }
        return true;
      };

      // 选取搜索结果条目
      const items = document.querySelectorAll('li.b_algo');
      for (const item of items) {
        if (results.length >= (input.max_results ?? 5)) break;
        const aTag = item.querySelector('h2 a');
        if (!aTag) continue;

        const link = aTag.getAttribute('href') || '';
        const title = aTag.textContent.trim();
        if (!link || !title) continue;

        const hostname = extractDomain(link);
        if (hostname && !isDomainAllowed(hostname)) continue;

        results.push(`${results.length + 1}. ${title}\n   ${link}`);
      }

      return {
        ok: true,
        output: results.length > 0
          ? results.join('\n')
          : `搜索完成但没有解析到结果，网页前 500 字符:\n${html.slice(0, 500)}`,
      };
    } catch (e: any) {
      let msg = e.message;
      if (e.name === 'AbortError') {
        msg = `请求超时(${15000 / 1000}s)`;
      }
      return { ok: false, output: `搜索失败: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  },
}

























