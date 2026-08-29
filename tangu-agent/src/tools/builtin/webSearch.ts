/**
 * 联网搜索工具:web_search(execute 体从 registry.ts 原样搬移)。经 deps().brain.search。
 */
import { deps } from '../../seams/runtime.js';
import { formatToolOutput } from '../outputPersist.js';
import type { ToolProvider } from '../toolRegistry.js';

const runSearch = (query: string, maxResults: number) => deps().brain.search.runSearch(query, maxResults);

export const webSearchProvider: ToolProvider = {
  id: 'builtin:web-search',
  tools: () => [
    {
      name: 'web_search',
      isEnabledFor: (profile) => profile.features.webSearch,
      definition: {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web and return summaries of relevant web pages. Use it to look up real-time or external information. ' +
            'When you then tell the user something you learned here, link the source inline as an ordinary markdown link — ' +
            '`[a short phrase from the result snippet](https://example.com/page)`. Prefer wording copied verbatim from the snippet as the link text: ' +
            'in the desktop app the page opens beside the conversation and scrolls straight to that phrase, highlighted. ' +
            'A phrase that is not on the page just opens it at the top, so never invent one — use a plain descriptive label when you have no verbatim wording.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search keywords' },
              max_results: { type: 'number', description: 'Number of results to return, default 5' },
            },
            required: ['query'],
          },
        },
      },
      execute: async (args, ctx) => {
        try {
          const r: any = await runSearch(String(args.query ?? ''), Number(args.max_results) || 5);
          // runSearch 返回 { provider, text, results }：落可读 text（而非盲 JSON dump）；超限则落盘+预览。
          const text = typeof r === 'string' ? r : (r?.text || JSON.stringify(r));
          // 引用锚点:与 read_file / read_document / web_fetch 同款「把可复制的具体形态印出来」——
          // 只在 description 里教,模型转述搜索结果时基本不会带链接(用户实报「经常看不到引用」)。
          // 放**头部**:大输出会溢出落盘,makePreview 只保头尾切片,footer 会丢。
          const head = 'Cite for the user: [<a short phrase from the snippet>](<the result URL>) — the link text is the exact sentence the reader gets scrolled to.\n\n';
          return formatToolOutput(ctx, 'web_search', head + String(text));
        } catch (e) {
          // 错误消息即提示词:降级链全败(或云不可达)时明示模型可用的退路,别反复重试同一工具。
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            `${msg}\nWeb search is currently unavailable. Do not retry web_search immediately — fall back to browser_search (if available) to search via the local browser, or fetch a known site directly with web_fetch.`,
          );
        }
      },
    },
  ],
};
