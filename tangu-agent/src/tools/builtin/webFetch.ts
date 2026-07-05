/**
 * web_fetch:抓取一个公网 URL 并转成可读文本(HTML 去标签,链接保留为 [text](href))。
 * SSRF 防护走 core/util/urlSafety(私网/回环/云元数据一律拒);大小/时间双上限;
 * 大输出经 outputPersist 落盘工作区,给模型留摘要。无新依赖(自带轻量 HTML→text)。
 */
import { assertPublicHttpUrl } from '../../core/util/urlSafety.js';
import { formatToolOutput } from '../outputPersist.js';
import type { ToolProvider } from '../toolRegistry.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 20_000;
const HARD_MAX_CHARS = 60_000;

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    });
}

/** 轻量 HTML→文本:剥 script/style/noscript,<a> 转 markdown 链接,块级标签转换行,余者去标签。 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // <a href="x">text</a> → [text](x)(相对链接保留原样,绝对化交给模型)
  s = s.replace(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    return text ? `[${text}](${href})` : href;
  });
  // 块级标签 → 换行;标题加 markdown 井号
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => `\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, '').trim()}\n`);
  s = s.replace(/<(?:p|div|section|article|li|tr|br|hr|ul|ol|table|blockquote|pre)\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // 收敛空白:行内空白合一,3+ 连续换行折成 2
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const webFetchProvider: ToolProvider = {
  id: 'builtin:web-fetch',
  tools: () => [
    {
      name: 'web_fetch',
      mode: 'both',
      definition: {
        type: 'function',
        function: {
          name: 'web_fetch',
          description:
            'Fetch the content of a public web page / text / JSON and convert it to readable text (HTML tags are stripped automatically, links are kept). ' +
            'Good for reading links found by web_search, documentation pages, or API responses. Only http/https public addresses.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The full URL to fetch (http/https)' },
              max_chars: { type: 'number', description: `Max number of characters to return (default ${DEFAULT_MAX_CHARS}, capped at ${HARD_MAX_CHARS})` },
            },
            required: ['url'],
          },
        },
      },
      execute: async (args, ctx) => {
        const raw = String(args.url ?? '').trim();
        if (!raw) return 'Error: url is required';
        let url: URL;
        try {
          url = await assertPublicHttpUrl(raw);
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
        const maxChars = Math.min(
          Number.isFinite(Number(args.max_chars)) && Number(args.max_chars) > 0 ? Number(args.max_chars) : DEFAULT_MAX_CHARS,
          HARD_MAX_CHARS,
        );

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        const onOuterAbort = (): void => ac.abort();
        ctx.signal?.addEventListener('abort', onOuterAbort, { once: true });
        try {
          const res = await fetch(url, {
            signal: ac.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TanguAgent/1.0)', Accept: 'text/html,application/json,text/*;q=0.9,*/*;q=0.5' },
          });
          if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;
          const ctype = (res.headers.get('content-type') || '').toLowerCase();
          if (!/text\/|json|xml|javascript|x-www-form/.test(ctype)) {
            return `Error: 不支持的内容类型 ${ctype || '(unknown)'}(只抓文本/HTML/JSON)`;
          }
          // 流式读 + 字节上限(Content-Length 不可信)
          const reader = res.body?.getReader();
          if (!reader) return 'Error: empty body';
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            chunks.push(value);
            if (total > MAX_BODY_BYTES) {
              void reader.cancel().catch(() => {});
              break;
            }
          }
          const body = Buffer.concat(chunks).toString('utf-8');
          const text = /html/.test(ctype) ? htmlToText(body) : body;
          const header = `[${url.href}${total > MAX_BODY_BYTES ? ' · body truncated at 2MB' : ''}]\n`;
          const clipped = text.length > maxChars ? text.slice(0, maxChars) + `\n…[truncated at ${maxChars} chars,需更多内容可调大 max_chars 或分段抓取]` : text;
          // 大输出落盘工作区(模型拿摘要 + 文件路径),小输出原样返回
          const label = `web_fetch-${url.hostname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
          return await formatToolOutput(ctx, label, header + clipped);
        } catch (e: any) {
          if (ac.signal.aborted && !ctx.signal?.aborted) return `Error: 抓取超时(${FETCH_TIMEOUT_MS / 1000}s)`;
          return `Error: ${e?.message || e}`;
        } finally {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onOuterAbort);
        }
      },
    },
  ],
};
