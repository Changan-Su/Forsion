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
          description: 'Search the web and return summaries of relevant web pages. Use it to look up real-time or external information.',
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
          return formatToolOutput(ctx, 'web_search', String(text));
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
