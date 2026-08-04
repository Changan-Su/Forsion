/**
 * 本地联网搜索(localSearch)+ multiBrain 搜索分发。
 * TANGU_HOME 临时目录写 config.json webSearch 段 + vi.stubGlobal('fetch') 模拟 provider。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadLocalWebSearchConfig, hasLocalSearchProvider, candidateOrder,
  runLocalSearch, parseDdgHtml, redactedLocalConfig,
} from '../src/adapters/standalone/localSearch.js';
import { createMultiBrain } from '../src/adapters/standalone/multiBrain.js';

let shared: string;

function writeWebSearchSection(section: any): void {
  writeFileSync(join(shared, 'config.json'), JSON.stringify({ webSearch: section }, null, 2), 'utf8');
}

/** 按 URL 前缀分发的 fetch 桩。 */
function stubFetch(routes: Array<[string, () => Response | Promise<Response>]>): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (input: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    for (const [prefix, make] of routes) {
      if (url.startsWith(prefix)) return make();
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', f);
  return f;
}

const jsonRes = (status: number, body: any): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  shared = mkdtempSync(join(tmpdir(), 'tangu-localsearch-'));
  mkdirSync(join(shared, 'tangu'), { recursive: true });
  process.env.TANGU_HOME = join(shared, 'tangu'); // forsionSharedDir = 其父目录 = shared
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANGU_HOME;
  rmSync(shared, { recursive: true, force: true });
});

describe('配置读取与归一化', () => {
  it('段缺失 → auto 全空,未视作已配置', () => {
    const cfg = loadLocalWebSearchConfig();
    expect(cfg).toEqual({ provider: 'auto', bochaApiKey: null, tavilyApiKey: null, zhipuApiKey: null, zhipuEngine: 'search_pro_quark' });
    expect(hasLocalSearchProvider(cfg)).toBe(false);
  });

  it('非法 provider 归一为 auto;空白 key 归 null;显式 duckduckgo 视作已配置', () => {
    writeWebSearchSection({ provider: 'bing', bochaApiKey: '  ' });
    expect(loadLocalWebSearchConfig().provider).toBe('auto');
    expect(loadLocalWebSearchConfig().bochaApiKey).toBeNull();

    writeWebSearchSection({ provider: 'duckduckgo' });
    expect(hasLocalSearchProvider(loadLocalWebSearchConfig())).toBe(true);
  });

  it('redactedLocalConfig 只回 hasKey 布尔与生效 provider,不回明文', () => {
    writeWebSearchSection({ provider: 'auto', tavilyApiKey: 'tvly-secret' });
    const red = redactedLocalConfig();
    expect(red).toEqual({
      provider: 'auto', bochaHasKey: false, tavilyHasKey: true, zhipuHasKey: false,
      zhipuEngine: 'search_pro_quark', effectiveProvider: 'tavily', configured: true,
    });
    expect(JSON.stringify(red)).not.toContain('tvly-secret');
  });
});

describe('zhipuEngine 档位', () => {
  it('缺失/非法归一为默认 quark,合法值原样保留', () => {
    writeWebSearchSection({ provider: 'zhipu', zhipuApiKey: 'z' });
    expect(loadLocalWebSearchConfig().zhipuEngine).toBe('search_pro_quark');
    writeWebSearchSection({ provider: 'zhipu', zhipuApiKey: 'z', zhipuEngine: 'search-std' }); // 旧连字符形式=非法
    expect(loadLocalWebSearchConfig().zhipuEngine).toBe('search_pro_quark');
    writeWebSearchSection({ provider: 'zhipu', zhipuApiKey: 'z', zhipuEngine: 'search_pro_sogou' });
    expect(loadLocalWebSearchConfig().zhipuEngine).toBe('search_pro_sogou');
  });

  it('搜索请求体携带配置的 search_engine', async () => {
    writeWebSearchSection({ provider: 'zhipu', zhipuApiKey: 'z', zhipuEngine: 'search_pro_sogou' });
    const f = stubFetch([
      ['https://open.bigmodel.cn', () => jsonRes(200, { search_result: [{ title: 'T', link: 'https://x.co', content: 'c' }] })],
    ]);
    await runLocalSearch('q', 3);
    const body = JSON.parse(String((f.mock.calls[0]![1] as any).body));
    expect(body.search_engine).toBe('search_pro_sogou');
  });
});

describe('candidateOrder 降级顺序', () => {
  it('显式 provider 打头,其余已配 key 随后,DDG 垫底', () => {
    expect(candidateOrder({ provider: 'tavily', bochaApiKey: 'b', tavilyApiKey: 't', zhipuApiKey: null, zhipuEngine: 'search_pro_quark' }))
      .toEqual(['tavily', 'bocha', 'duckduckgo']);
    expect(candidateOrder({ provider: 'auto', bochaApiKey: null, tavilyApiKey: null, zhipuApiKey: 'z', zhipuEngine: 'search_pro_quark' }))
      .toEqual(['zhipu', 'duckduckgo']);
    expect(candidateOrder({ provider: 'auto', bochaApiKey: null, tavilyApiKey: null, zhipuApiKey: null, zhipuEngine: 'search_pro_quark' }))
      .toEqual(['duckduckgo']);
  });
});

describe('runLocalSearch 降级链', () => {
  it('主 provider 403 → 落到下一个已配 key,输出带降级注记', async () => {
    writeWebSearchSection({ provider: 'bocha', bochaApiKey: 'b', tavilyApiKey: 't' });
    stubFetch([
      ['https://api.bochaai.com', () => jsonRes(403, { message: 'no money' })],
      ['https://api.tavily.com', () => jsonRes(200, { results: [{ title: 'Hit', url: 'https://x.co', content: 's' }] })],
    ]);
    const out = await runLocalSearch('q', 3);
    expect(out.provider).toBe('tavily');
    expect(out.text).toContain('[web_search note] primary provider failed');
    expect(out.text).toContain('Bocha HTTP 403');
    expect(out.results).toHaveLength(1);
  });

  it('全部失败 → 抛聚合错误(逐 provider 明细)', async () => {
    writeWebSearchSection({ provider: 'bocha', bochaApiKey: 'b' });
    stubFetch([
      ['https://api.bochaai.com', () => jsonRes(500, {})],
      ['https://api.duckduckgo.com', () => { throw new Error('net down'); }],
      ['https://html.duckduckgo.com', () => { throw new Error('net down'); }],
    ]);
    await expect(runLocalSearch('q', 3)).rejects.toThrow(/All local search providers failed.*bocha.*duckduckgo/s);
  });

  it('DDG Instant Answer 空 → html 兜底解析出结果', async () => {
    writeWebSearchSection({ provider: 'duckduckgo' });
    const html = '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example <b>A</b></a>'
      + '<div class="result__snippet">Snippet &amp; text</div>';
    stubFetch([
      ['https://api.duckduckgo.com', () => jsonRes(200, {})],
      ['https://html.duckduckgo.com', () => new Response(html, { status: 200 })],
    ]);
    const out = await runLocalSearch('q', 3);
    expect(out.provider).toBe('duckduckgo_html');
    expect(out.results[0]).toEqual({ title: 'Example A', url: 'https://example.com/a', snippet: 'Snippet & text' });
  });
});

describe('parseDdgHtml', () => {
  it('uddg 跳转还原 + HTML 实体解码 + maxResults 截断', () => {
    const row = (n: number) =>
      `<a class="result__a" href="/l/?uddg=https%3A%2F%2Fe.com%2F${n}">T${n}</a><div class="result__snippet">s${n}</div>`;
    const hits = parseDdgHtml(row(1) + row(2) + row(3), 2);
    expect(hits).toHaveLength(2);
    expect(hits[1]).toEqual({ title: 'T2', url: 'https://e.com/2', snippet: 's2' });
  });
});

describe('multiBrain 搜索分发', () => {
  const fakeHttpBrain = (impl?: (q: string, n: number) => Promise<any>) => {
    const runSearch = vi.fn(impl ?? (async () => ({ provider: 'cloud', text: 'cloud result', results: [] })));
    return { brain: { search: { runSearch } } as any, runSearch };
  };
  const emptyRegistry = { list: () => [], has: () => false, resolve: () => null } as any;

  it('本地配置了 provider → 本地直搜,不碰云', async () => {
    writeWebSearchSection({ provider: 'auto', bochaApiKey: 'b' });
    stubFetch([
      ['https://api.bochaai.com', () => jsonRes(200, { data: { webPages: { value: [{ name: 'N', url: 'u' }] } } })],
    ]);
    const { brain, runSearch } = fakeHttpBrain();
    const mb = createMultiBrain(brain, emptyRegistry);
    const out = await mb.search.runSearch('q', 3);
    expect(out.provider).toBe('bocha');
    expect(runSearch).not.toHaveBeenCalled();
  });

  it('未配置本地 → 透传云 brain', async () => {
    const { brain, runSearch } = fakeHttpBrain();
    const mb = createMultiBrain(brain, emptyRegistry);
    const out = await mb.search.runSearch('q', 3);
    expect(out.provider).toBe('cloud');
    expect(runSearch).toHaveBeenCalledWith('q', 3);
  });

  it('云不可用 → 本地 DDG 免费兜底,注记云侧错误', async () => {
    const { brain } = fakeHttpBrain(async () => { throw new Error('401 not logged in'); });
    stubFetch([
      ['https://api.duckduckgo.com', () => jsonRes(200, { AbstractText: 'DDG says hi', AbstractURL: 'https://d.co' })],
    ]);
    const mb = createMultiBrain(brain, emptyRegistry);
    const out = await mb.search.runSearch('q', 3);
    expect(out.text).toContain('cloud search unavailable (401 not logged in)');
    expect(out.text).toContain('DDG says hi');
  });
});
