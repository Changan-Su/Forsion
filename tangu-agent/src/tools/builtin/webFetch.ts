/**
 * web_fetch:抓取一个公网 URL 并转成可读文本(HTML 去标签,链接保留为 [text](href))。
 * SSRF 防护走 core/util/urlSafety,且连接层**钉住校验时解析到的 IP**(node http/https 的
 * lookup 钩子 —— 同时关死「公网 302→内网」与 DNS rebinding 两条通路);大小/时间双上限;
 * HTML→文本是**单遍线性 tokenizer**(convertHtml:indexOf 推进、不用正则解析结构 ——
 * 恶意页面塞几万个不闭合标签也不会把事件循环打成 O(n²));剥噪声区 + main/article 优先;
 * JS 壳页(脚本重、静态正文空)在输出尾注提示 browser_navigate;大输出经 outputPersist 落盘。
 */
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { createUnzip, createBrotliDecompress } from 'node:zlib';
import net from 'node:net';
import { resolvePublicHttpUrl } from '../../core/util/urlSafety.js';
import { formatToolOutput } from '../outputPersist.js';
import type { ToolProvider } from '../toolRegistry.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 20_000;
const HARD_MAX_CHARS = 60_000;
const MAX_REDIRECTS = 5;

export interface FetchPublicInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}
export interface FetchedPage {
  status: number;
  statusText: string;
  headers: IncomingMessage['headers'];
  /** 已按 content-encoding 解压的正文流。 */
  body: NodeJS.ReadableStream;
  /** 底层响应。不读正文(错误路径/读够了)必须调 destroy()。 */
  raw: IncomingMessage;
  /** 一把掐断解压器 + 底层 socket(只 destroy raw 拦不住解压器里已缓冲的膨胀)。 */
  destroy: () => void;
  finalUrl: URL;
}

type Resolver = typeof resolvePublicHttpUrl;

// 专用 Agent,不复用连接:① Node 22.21+ 的 NODE_USE_ENV_PROXY 让**全局** Agent 走
// HTTP_PROXY —— 代理连接不经 lookup 钩子,钉 IP 会被整个绕开,自建 Agent 不受该开关影响;
// ② keepAlive:false 保证不同 pin 之间不共享 socket 池。
const pinAgentHttp = new HttpAgent({ keepAlive: false });
const pinAgentHttps = new HttpsAgent({ keepAlive: false });

/** 单跳请求:连接一律用**校验时解析到的地址**(lookup 钩子),不做第二次 DNS —— 关死 rebinding;
 *  SNI/证书仍按主机名走,TLS 校验不受影响。lookup 回调必须异步调(同步回调撞上连接失败会把
 *  socket error 抛成未处理异常而不是 reject)。 */
function requestPinned(url: URL, addresses: string[], method: string, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(url, {
      method,
      headers,
      signal,
      agent: isHttps ? pinAgentHttps : pinAgentHttp,
      lookup: (_host, options, cb) => {
        process.nextTick(() => {
          const list = addresses.map((a) => ({ address: a, family: net.isIP(a) }));
          if (options && (options as { all?: boolean }).all) (cb as (e: null, r: typeof list) => void)(null, list);
          else cb(null, list[0]!.address, list[0]!.family);
        });
      },
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

/** 手动跟随重定向,**每一跳重新解析+校验并钉住地址**;303(非 GET/HEAD)与 POST+301/302 按
 *  Fetch 语义改写 GET 并剥 body 头;重定向响应体立即 destroy 不占 socket。只支持无 body 请求
 *  (web_fetch 只发 GET;要带 body 的场景走 customTools.safeFetch)。
 *  resolver 参数是测试接缝(本地起真 http server + 假解析器即可离线验证钉 IP/重定向链)。 */
export async function fetchPublic(rawUrl: string, init: FetchPublicInit, resolver: Resolver = resolvePublicHttpUrl): Promise<FetchedPage> {
  let { url: current, addresses } = await resolver(rawUrl);
  let method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { 'accept-encoding': 'gzip, deflate, br', ...init.headers };
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await requestPinned(current, addresses, method, headers, init.signal);
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const loc = res.headers.location;
      res.destroy(); // 不读重定向响应体 —— 恶意慢流不许占着 socket
      if (!loc) throw new Error(`HTTP ${status} without Location header`);
      if (i === MAX_REDIRECTS) break; // 到限即停,不再浪费一次解析
      const next = await resolver(new URL(loc, current).toString());
      // 跨源跳转剥敏感头(web_fetch 自己不发这些;fetchPublic 是导出原语,按 Fetch 惯例守住)
      if (next.url.host !== current.host) {
        for (const k of Object.keys(headers)) if (/^(authorization|cookie|proxy-authorization)$/i.test(k)) delete headers[k];
      }
      ({ url: current, addresses } = next);
      if ((status === 303 && method !== 'GET' && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        for (const k of Object.keys(headers)) if (/^content-(type|length|encoding)$/i.test(k)) delete headers[k];
      }
      continue;
    }
    // 服务器压缩了就解(node http 不像 fetch 会自动解压)
    const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
    let body: NodeJS.ReadableStream = res;
    if (enc === 'gzip' || enc === 'x-gzip' || enc === 'deflate') body = res.pipe(createUnzip());
    else if (enc === 'br') body = res.pipe(createBrotliDecompress());
    const destroy = (): void => {
      if (body !== res) (body as unknown as { destroy: () => void }).destroy();
      res.destroy();
    };
    if (body !== res) {
      // pipe() 不传播两端错误:源错 → 带 error 掐解压器(消费方才会 reject 而不是挂死);
      // 解压器错(坏 gzip/被 destroy)→ 掐 socket。error 监听同时兜住「无消费方」的错误路径
      // (非 2xx 早退),坏压缩流不能变成进程级崩溃。
      res.on('error', (e) => (body as unknown as { destroy: (err?: Error) => void }).destroy(e));
      body.on('error', () => res.destroy());
    }
    return { status, statusText: res.statusMessage ?? '', headers: res.headers, body, raw: res, destroy, finalUrl: current };
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    });
}

// ── 单遍 HTML tokenizer ──────────────────────────────────────────────────────

/** 整块丢弃的噪声容器:导航/页脚/侧栏/表单/弹层/SVG/iframe —— cookie 横幅、推荐位不吃字符预算。 */
const NOISE_TAGS = new Set(['nav', 'footer', 'aside', 'form', 'dialog', 'template', 'svg', 'iframe']);
/** raw-text 元素:内容不是标记,扫到对应闭合标签为止(浏览器同款,不认自闭合)。 */
const RAWTEXT_TAGS = new Set(['script', 'style', 'noscript']);
/** 开标签转换行的块级元素(与旧正则版同一名单,保持输出稳定)。 */
const NEWLINE_TAGS = new Set(['p', 'div', 'section', 'article', 'li', 'tr', 'br', 'hr', 'ul', 'ol', 'table', 'blockquote', 'pre']);
/** 选中的 main/article 区至少这么多**成文字符**才可信(空 <main> 的 SPA 壳 → 退整页)。 */
const MIN_REGION = 200;

// 链接用 NUL 哨兵标记,后处理一次替换(哨兵字符类有界 → 线性;tokenizer 保证标记必配对)。
const L = (href: string): string => `\u0000L${href.replaceAll('\u0000', '')}\u0000`;
const E = '\u0000E\u0000';

export interface HtmlConvert {
  /** 选中正文区(main > 最大 article > 整页)的最终文本。 */
  text: string;
  /** 整页(剥噪声后)的文本长度 —— JS 壳判定用。 */
  docTextLen: number;
  /** 内联 <script> 字符总量 —— JS 壳判定用。 */
  scriptChars: number;
  /** 成功闭合的链接数。 */
  linkCount: number;
}

/** 哨兵→markdown 链接 + 清残留哨兵 + 实体解码 + 空白收敛。 */
function finalize(s: string): string {
  return decodeEntities(
    s
      .replace(/\u0000L([^\u0000]*)\u0000([^\u0000]*)\u0000E\u0000/g, (_, href, inner) => {
        const t = inner.replace(/\s+/g, ' ').trim();
        return t ? `[${t}](${href})` : href;
      })
      .replace(/\u0000L[^\u0000]*\u0000/g, '') // 跨区域被切开的孤儿标记
      .replace(/\u0000E\u0000/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ASCII 大小写不敏感 indexOf(needle 须全小写)。刻意不整文 toLowerCase —— 土耳其 İ 等字符
 *  lowercase 后 UTF-16 长度会变,拿 lower 的索引切原文会全体错位、损坏输出。
 *  线性:只用于 raw-text 元素找闭合标签,扫描起点单调前进。 */
function indexOfCI(hay: string, needle: string, from: number): number {
  const n = needle.length;
  outer: for (let i = from; i <= hay.length - n; i++) {
    for (let j = 0; j < n; j++) {
      let c = hay.charCodeAt(i + j);
      if (c >= 65 && c <= 90) c += 32;
      if (c !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/** 单遍线性扫描:剥 script/style/noscript/注释/噪声区,<a>→markdown,标题→#,块级→换行;
 *  同步记录 <main> 与最外层 <article> 的输出区间(深度计数 —— 嵌套 article 不丢外层结尾,
 *  截断的不闭合区按到 EOF 算,不会被前面的小 teaser 抢走)。
 *  ponytail: 引号里的 `>` 会提前断标签、怪结构退整页 —— 降级是多几行杂讯,不是丢正文。 */
export function convertHtml(html: string): HtmlConvert {
  const out: string[] = [];
  let i = 0;
  let noiseDepth = 0;
  let scriptChars = 0;
  let linkCount = 0;
  let linkOpen = false;
  let mainSpan: { start: number; end: number } | null = null;
  let mainDepth = 0;
  let articleDepth = 0;
  let articleStart = 0;
  const articles: Array<{ start: number; end: number }> = [];

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      if (!noiseDepth) out.push(html.slice(i).replaceAll('\u0000', ''));
      break;
    }
    if (lt > i && !noiseDepth) out.push(html.slice(i, lt).replaceAll('\u0000', ''));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt === -1) break; // 尾部残缺标签(2MB 截断)→ 丢弃
    const rawTag = html.slice(lt + 1, gt).toLowerCase(); // 只小写小段标签体,索引不回用原文
    i = gt + 1;
    const m = /^(\/?)[\s]*([a-z][a-z0-9-]*)/.exec(rawTag);
    if (!m) continue; // <!doctype>、<? 等
    const closing = m[1] === '/';
    const name = m[2];

    if (!closing && RAWTEXT_TAGS.has(name)) {
      const close = indexOfCI(html, `</${name}`, i);
      const contentEnd = close === -1 ? html.length : close;
      if (name === 'script') scriptChars += contentEnd - i;
      if (close === -1) { i = html.length; continue; }
      const closeGt = html.indexOf('>', close);
      i = closeGt === -1 ? html.length : closeGt + 1;
      continue;
    }
    if (NOISE_TAGS.has(name)) {
      if (closing) noiseDepth = Math.max(0, noiseDepth - 1);
      else if (!/\/\s*$/.test(rawTag)) noiseDepth++;
      continue;
    }
    if (noiseDepth) continue;

    if (name === 'main') {
      if (!closing) {
        if (mainDepth === 0 && !mainSpan) mainSpan = { start: out.length, end: -1 };
        mainDepth++;
      } else {
        mainDepth = Math.max(0, mainDepth - 1);
        if (mainDepth === 0 && mainSpan && mainSpan.end < 0) mainSpan.end = out.length;
      }
    } else if (name === 'article') {
      if (!closing) {
        if (articleDepth === 0) articleStart = out.length;
        articleDepth++;
      } else {
        articleDepth = Math.max(0, articleDepth - 1);
        if (articleDepth === 0) articles.push({ start: articleStart, end: out.length });
      }
    }

    if (name === 'a') {
      if (closing) {
        if (linkOpen) { out.push(E); linkCount++; linkOpen = false; }
      } else {
        if (linkOpen) { out.push(E); linkCount++; } // 嵌套/未闭合的上一个就地闭合
        linkOpen = false;
        const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html.slice(lt + 1, gt));
        const target = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
        if (target && !target.startsWith('#')) { out.push(L(target)); linkOpen = true; }
      }
      continue;
    }
    const h = /^h([1-6])$/.exec(name);
    if (h) {
      out.push(closing ? '\n' : `\n${'#'.repeat(Number(h[1]))} `);
      continue;
    }
    if (!closing && NEWLINE_TAGS.has(name)) out.push('\n');
  }
  if (linkOpen) { out.push(E); linkCount++; }
  // EOF 未闭合的区按到结尾算(截断的 <main> 不丢)
  if (mainSpan && mainSpan.end < 0) mainSpan.end = out.length;
  if (articleDepth > 0) articles.push({ start: articleStart, end: out.length });

  const wholeText = finalize(out.join(''));
  const regionText = (span: { start: number; end: number } | null): string | null => {
    if (!span) return null;
    const t = finalize(out.slice(span.start, span.end).join(''));
    return t.length >= MIN_REGION ? t : null;
  };
  // 最大 article 按**成文字符数**比(span 的 end-start 是片段数,结构相同内容悬殊会选错);
  // 最外层 span 两两不相交,总代价线性。
  let biggestText: string | null = null;
  for (const a of articles) {
    const t = regionText(a);
    if (t && (!biggestText || t.length > biggestText.length)) biggestText = t;
  }

  return {
    text: regionText(mainSpan) ?? biggestText ?? wholeText,
    docTextLen: wholeText.length,
    scriptChars,
    linkCount,
  };
}

/** 轻量 HTML→文本(convertHtml 的正文位)。 */
export function htmlToText(html: string): string {
  return convertHtml(html).text;
}

/** 读正文到字节上限(Content-Length 不可信);超限 page.destroy() **一把掐断解压器+socket**
 *  —— 只掐 socket 拦不住解压器里已缓冲的膨胀,gzip 炸弹会在 cap 后继续吐几十 MB。
 *  settled 后不再追加 chunk;destroy 无 error 收在 'close'(不挂死)。导出供测试。 */
export function readBodyCapped(page: FetchedPage, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve({ buf: Buffer.concat(chunks), truncated: total > maxBytes });
    };
    page.body.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      chunks.push(chunk);
      if (total > maxBytes) { page.destroy(); done(); }
    });
    page.body.on('end', () => done());
    page.body.on('close', () => done());
    page.body.on('error', (err: Error) => done(err));
  });
}

/** JS 壳启发:脚本很重、整页静态正文却极小且几乎没有链接。**脚本量**是关键信号 ——
 *  大段内联 CSS 的短静态页不会误报(style 不计入)。纯函数供测试。 */
export function isLikelyJsShell(c: HtmlConvert): boolean {
  return c.scriptChars > 10_000 && c.docTextLen < 400 && c.linkCount < 3;
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
        const maxChars = Math.min(
          Number.isFinite(Number(args.max_chars)) && Number(args.max_chars) > 0 ? Number(args.max_chars) : DEFAULT_MAX_CHARS,
          HARD_MAX_CHARS,
        );

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        const onOuterAbort = (): void => ac.abort();
        ctx.signal?.addEventListener('abort', onOuterAbort, { once: true });
        try {
          const page = await fetchPublic(raw, {
            signal: ac.signal,
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; TanguAgent/1.0)', accept: 'text/html,application/json,text/*;q=0.9,*/*;q=0.5' },
          });
          const { finalUrl } = page;
          if (page.status < 200 || page.status >= 300) {
            page.destroy(); // 不读的响应体必须掐断(含解压器)
            return `Error: HTTP ${page.status} ${page.statusText}`;
          }
          const ctype = String(page.headers['content-type'] ?? '').toLowerCase();
          if (!/text\/|json|xml|javascript|x-www-form/.test(ctype)) {
            page.destroy();
            return `Error: 不支持的内容类型 ${ctype || '(unknown)'}(只抓文本/HTML/JSON)`;
          }
          const { buf, truncated } = await readBodyCapped(page, MAX_BODY_BYTES);
          const body = buf.toString('utf-8');
          const isHtml = /html/.test(ctype);
          const conv = isHtml ? convertHtml(body) : null;
          const text = conv ? conv.text : body;
          const header = `[${finalUrl.href}${truncated ? ' · body truncated at 2MB' : ''}]\n`;
          let clipped = text.length > maxChars ? text.slice(0, maxChars) + `\n…[truncated at ${maxChars} chars,需更多内容可调大 max_chars 或分段抓取]` : text;
          // JS 壳提示:脚本重、静态正文空 → 提示模型可换 browser_navigate(措辞留余地,误报时不至于带偏)
          if (conv && isLikelyJsShell(conv)) {
            clipped += '\n\n[note] This page is script-heavy with almost no static text — it may be rendered by JavaScript. If the content above is insufficient, browser_navigate (if available) may reveal the rendered page.';
          }
          // 大输出落盘工作区(模型拿摘要 + 文件路径),小输出原样返回
          const label = `web_fetch-${finalUrl.hostname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
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
