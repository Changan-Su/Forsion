import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { htmlToText, convertHtml, isLikelyJsShell, fetchPublic, readBodyCapped } from '../src/tools/builtin/webFetch.js';
import { isBlockedAddress, resolvePublicHttpUrl } from '../src/core/util/urlSafety.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const ARTICLE_PAGE = `<!doctype html><html><head><title>t</title><style>.x{}</style></head><body>
<nav><a href="/home">Home</a><a href="/about">About</a><a href="/pricing">Pricing</a></nav>
<dialog>We use cookies! <a href="/consent">Accept all</a></dialog>
<main><h1>Real Title</h1><p>${'Real body sentence. '.repeat(30)}</p><a href="/next">Next page</a></main>
<aside>Recommended: <a href="/spam1">spam1</a> <a href="/spam2">spam2</a></aside>
<footer>© 2026 Corp · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</body></html>`;

const ARTICLES_PAGE = `<html><body>
<article><p>short teaser</p></article>
<article><h2>Long one</h2><p>${'Main article text. '.repeat(40)}</p></article>
<footer><a href="/x">x</a></footer>
</body></html>`;

const SPA_SHELL = `<html><head><script>window.__DATA__=${'{"k":"v"},'.repeat(1500)}</script></head>
<body><div id="root"></div><main></main></body></html>`;

// ── convertHtml / htmlToText ─────────────────────────────────────────────────

describe('extraction', () => {
  it('prefers <main> and strips nav/footer/aside/dialog noise', () => {
    const text = htmlToText(ARTICLE_PAGE);
    expect(text).toContain('# Real Title');
    expect(text).toContain('Real body sentence.');
    expect(text).toContain('[Next page](/next)');
    for (const noise of ['Pricing', 'cookies', 'spam1', 'Privacy']) expect(text).not.toContain(noise);
  });

  it('falls back to the largest <article> when no <main>', () => {
    const text = htmlToText(ARTICLES_PAGE);
    expect(text).toContain('Main article text.');
    expect(text).not.toContain('short teaser');
  });

  it('largest article is judged by text length, not fragment count', () => {
    // 两个结构完全相同的 article:前者 216 字符(≥MIN_REGION),后者 700+ —— 必须选后者
    const html = `<html><body>
<article><p>${'tease. '.repeat(31)}</p></article>
<article><p>${'real content here. '.repeat(40)}</p></article>
</body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('real content here.');
    expect(text).not.toContain('tease.');
  });

  it('nested <article> keeps the outer article tail (depth counting)', () => {
    const html = `<article><p>${'intro text. '.repeat(20)}</p><article><p>a comment</p></article>
<p>IMPORTANT CONCLUSION</p></article>`;
    const text = htmlToText(html);
    expect(text).toContain('IMPORTANT CONCLUSION');
  });

  it('truncated (unclosed) <main> beats an earlier small closed <article>', () => {
    // 模拟 2MB 截断:</main> 被切掉。teaser article 不该抢走正文。
    const html = `<article><p>${'teaser blurb. '.repeat(20)}</p></article>
<main><h1>Real</h1><p>${'the actual long content. '.repeat(50)}</p>`;
    const text = htmlToText(html);
    expect(text).toContain('the actual long content.');
    expect(text).not.toContain('teaser blurb');
  });

  it('tiny/empty <main> is not trusted — falls back to whole page', () => {
    const html = `<html><body><main></main><p>${'outside text. '.repeat(30)}</p></body></html>`;
    expect(htmlToText(html)).toContain('outside text.');
  });

  it('no main/article and malformed html → whole page, does not throw', () => {
    const html = '<body><p>hello <b>world</p><div>unclosed';
    expect(htmlToText(html)).toContain('hello world');
  });

  it('decodes hex and decimal entities', () => {
    expect(htmlToText('<p>&#x4f60;&#22909; &amp; bye</p>')).toBe('你好 & bye');
  });

  it('does not corrupt text whose lowercase changes UTF-16 length (Turkish İ)', () => {
    const text = htmlToText('<p>İstanbul Gezisi</p><p>TAIL MARKER</p>');
    expect(text).toContain('İstanbul Gezisi');
    expect(text).toContain('TAIL MARKER');
    expect(text).not.toContain('<'); // 索引错位的症状是标签渗进正文
  });

  it('finds uppercase </SCRIPT> closers without whole-doc lowercasing', () => {
    const text = htmlToText('<SCRIPT>var x = "<p>fake</p>";</SCRIPT><p>real</p>');
    expect(text).toBe('real');
  });

  it('unclosed <a> at EOF degrades to plain link, not lost text', () => {
    const text = htmlToText(`<p>before</p><a href="/x">trailing text`);
    expect(text).toContain('before');
    expect(text).toContain('trailing text');
  });

  it('adversarial unmatched tags stay linear (no regex backtracking blowup)', () => {
    const bomb = '<nav>'.repeat(80_000); // 400K 字符不闭合开标签,旧正则版在此二次方爆炸
    const t0 = performance.now();
    htmlToText(bomb + '<p>tail</p>');
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

// ── isLikelyJsShell ──────────────────────────────────────────────────────────

describe('isLikelyJsShell', () => {
  it('script-heavy page with no static text = shell', () => {
    expect(isLikelyJsShell(convertHtml(SPA_SHELL))).toBe(true);
  });
  it('small pages are never shells', () => {
    expect(isLikelyJsShell(convertHtml('<html><body>hi</body></html>'))).toBe(false);
  });
  it('short static page with huge inline CSS is not a shell (style not counted)', () => {
    const html = `<html><head><style>${'.c{color:red}'.repeat(2000)}</style></head><body><p>tiny message</p></body></html>`;
    expect(isLikelyJsShell(convertHtml(html))).toBe(false);
  });
  it('script-heavy but link-rich page is not a shell', () => {
    const html = `<html><head><script>${'x'.repeat(12_000)}</script></head><body>
<a href="/1">a</a><a href="/2">b</a><a href="/3">c</a></body></html>`;
    expect(isLikelyJsShell(convertHtml(html))).toBe(false);
  });
});

// ── urlSafety 段位补漏 ───────────────────────────────────────────────────────

describe('isBlockedAddress range gaps', () => {
  it.each([
    'fe90::1', 'febf::1', 'fec0::1', 'ff02::1', '100::1', '2001:db8::1',
    '198.18.0.1', '198.19.255.1', '192.0.2.5', '203.0.113.9', '192.88.99.1',
    // 未压缩/展开文本形式必须同判(字节级解析,文本前缀匹配会 fail-open)
    '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:ffff:a9fe:a9fe', 'FE80::0001',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each([
    'fe8::1', '2606:4700::1111', '2001:db9::1', '8.8.8.8', '198.20.0.1',
    '100:0:0:1::', // 100::/64 之外(精确 /64,不再整段 /16 误伤)
    '0:0:0:0:0:ffff:808:808', // v4-mapped 8.8.8.8,公网
  ])('allows public %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('resolvePublicHttpUrl ipv6 literals', () => {
  it('rejects bracketed private IPv6 literals (brackets stripped, not sent to DNS)', async () => {
    await expect(resolvePublicHttpUrl('http://[::1]/x')).rejects.toThrow(/Private|reserved/i);
    await expect(resolvePublicHttpUrl('http://[0:0:0:0:0:0:0:1]/x')).rejects.toThrow(/Private|reserved/i);
  });
  it('accepts bracketed public IPv6 literals without DNS', async () => {
    const r = await resolvePublicHttpUrl('http://[2606:4700::1111]/x');
    expect(r.addresses).toEqual(['2606:4700::1111']);
  });
});

// ── fetchPublic:真本地 server + 假解析器,离线验证钉 IP / 重定向链 ─────────────

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<{
  port: number;
  seen: Array<{ method: string; url: string; host: string; contentType?: string }>;
  close: () => Promise<void>;
}> {
  const seen: Array<{ method: string; url: string; host: string; contentType?: string }> = [];
  const srv = createServer((req, res) => {
    seen.push({
      method: req.method ?? '', url: req.url ?? '', host: String(req.headers.host ?? ''),
      contentType: req.headers['content-type'] as string | undefined,
    });
    handler(req, res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    port: (srv.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

// pin/pin2.test 是不存在的域名 —— 请求能到达本地 server 本身就证明连接走了钉住的地址
const fakeResolver = async (raw: string): Promise<{ url: URL; addresses: string[] }> => {
  const u = new URL(raw);
  if (u.hostname === 'private.test') throw new Error('Private or reserved IP addresses are not allowed');
  return { url: u, addresses: ['127.0.0.1'] };
};

const readAll = (s: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve, reject) => {
    const bufs: Buffer[] = [];
    s.on('data', (b: Buffer) => bufs.push(b));
    s.on('end', () => resolve(Buffer.concat(bufs).toString()));
    s.on('error', reject);
  });

describe('fetchPublic', () => {
  it('connects via the pinned validated address, not live DNS', async () => {
    const srv = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('pinned'); });
    try {
      const page = await fetchPublic(`http://pin.test:${srv.port}/x`, {}, fakeResolver);
      expect(page.status).toBe(200);
      expect(await readAll(page.body)).toBe('pinned');
      expect(srv.seen[0].host).toBe(`pin.test:${srv.port}`); // Host/SNI 仍按主机名
    } finally { await srv.close(); }
  });

  it('follows relative-Location redirects and reports the validated final URL', async () => {
    const srv = await serve((req, res) => {
      if (req.url === '/a') { res.writeHead(302, { location: '/b' }); res.end(); }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }
    });
    try {
      const page = await fetchPublic(`http://pin.test:${srv.port}/a`, {}, fakeResolver);
      expect(await readAll(page.body)).toBe('ok');
      expect(page.finalUrl.pathname).toBe('/b');
      expect(srv.seen.map((s) => s.url)).toEqual(['/a', '/b']);
    } finally { await srv.close(); }
  });

  it('rejects a redirect whose target fails validation, before connecting', async () => {
    const srv = await serve((_req, res) => { res.writeHead(302, { location: 'http://private.test/admin' }); res.end(); });
    try {
      await expect(fetchPublic(`http://pin.test:${srv.port}/`, {}, fakeResolver)).rejects.toThrow(/Private/);
      expect(srv.seen.length).toBe(1); // 第二跳死在校验,没发请求
    } finally { await srv.close(); }
  });

  it('303 rewrites POST to GET and strips body headers', async () => {
    const srv = await serve((req, res) => {
      if (req.url === '/submit') { res.writeHead(303, { location: '/done' }); res.end(); }
      else { res.writeHead(200); res.end('done'); }
    });
    try {
      await fetchPublic(`http://pin.test:${srv.port}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' } }, fakeResolver);
      expect(srv.seen[1].method).toBe('GET');
      expect(srv.seen[1].contentType).toBeUndefined();
    } finally { await srv.close(); }
  });

  it('HEAD survives a 303 unchanged (Fetch semantics)', async () => {
    const srv = await serve((req, res) => {
      if (req.url === '/h') { res.writeHead(303, { location: '/done' }); res.end(); }
      else { res.writeHead(200); res.end(); }
    });
    try {
      await fetchPublic(`http://pin.test:${srv.port}/h`, { method: 'HEAD' }, fakeResolver);
      expect(srv.seen[1].method).toBe('HEAD');
    } finally { await srv.close(); }
  });

  it('redirect without Location fails closed', async () => {
    const srv = await serve((_req, res) => { res.writeHead(302); res.end(); });
    try {
      await expect(fetchPublic(`http://pin.test:${srv.port}/`, {}, fakeResolver)).rejects.toThrow(/without Location/);
    } finally { await srv.close(); }
  });

  it('gives up after too many redirects', async () => {
    const srv = await serve((_req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); });
    try {
      await expect(fetchPublic(`http://pin.test:${srv.port}/`, {}, fakeResolver)).rejects.toThrow(/Too many redirects/);
      expect(srv.seen.length).toBe(6); // 首跳 + 5 次重定向
    } finally { await srv.close(); }
  });

  it('rejects a private initial URL before any request', async () => {
    await expect(fetchPublic('http://private.test/meta', {}, fakeResolver)).rejects.toThrow(/Private/);
  });

  it('decompresses gzip bodies (node http does not auto-decompress)', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gzipSync('<p>zipped body</p>'));
    });
    try {
      const page = await fetchPublic(`http://pin.test:${srv.port}/`, {}, fakeResolver);
      expect(await readAll(page.body)).toBe('<p>zipped body</p>');
    } finally { await srv.close(); }
  });

  it('connection refused rejects instead of crashing (async lookup callback)', async () => {
    const srv = await serve(() => {});
    await srv.close(); // 端口已释放 —— 连接必被拒
    await expect(fetchPublic(`http://pin.test:${srv.port}/`, {}, fakeResolver)).rejects.toThrow();
  });

  it('gzip bomb stops at the byte cap (decoder destroyed, chunks stop accruing)', async () => {
    // 16KB 线上流量 → 解压后 16MB。cap 512KB:必须截断在 cap 附近,不许整弹落地。
    const bomb = gzipSync(Buffer.alloc(16 * 1024 * 1024));
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(bomb);
    });
    try {
      const page = await fetchPublic(`http://pin.test:${srv.port}/`, {}, fakeResolver);
      const cap = 512 * 1024;
      const { buf, truncated } = await readBodyCapped(page, cap);
      expect(truncated).toBe(true);
      expect(buf.byteLength).toBeLessThan(cap + 1024 * 1024); // cap + 最多一块解压缓冲
    } finally { await srv.close(); }
  });

  it('compressed non-2xx body destroyed without an unhandled zlib error', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(Buffer.from('this is not gzip at all')); // 坏压缩体 + 错误状态码
    });
    try {
      const page = await fetchPublic(`http://pin.test:${srv.port}/`, {}, fakeResolver);
      expect(page.status).toBe(404);
      page.destroy(); // 错误路径不读体 —— 不许崩进程(vitest 会把未处理错误判失败)
      await new Promise((r) => setTimeout(r, 50));
    } finally { await srv.close(); }
  });

  it('corrupt gzip on a 200 rejects the read instead of crashing', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(Buffer.from('garbage garbage garbage'));
    });
    try {
      const page = await fetchPublic(`http://pin.test:${srv.port}/`, {}, fakeResolver);
      await expect(readBodyCapped(page, 1024 * 1024)).rejects.toThrow();
    } finally { await srv.close(); }
  });
});
