/**
 * 搜索来源编号(借鉴 DeepSeek chat-demo 方案 ②A)的引擎半边:web_search / web_fetch 在工具结果上另存结构化来源
 * (ToolResult.metadata.sources),给模型的文字一字不变;收集器每次调用一份、只挂给这两个内置工具。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../services/checkpoints.js', () => ({ snapshotBeforeWrite: vi.fn(async () => null), recordPostWrite: vi.fn() }));
vi.mock('../services/userActivity.js', () => ({ appendActivityLine: vi.fn() }));
// web_fetch 的网络层:SSRF 闸不放行本机回环,这里直接给一页
const PAGE = `<!doctype html><html><head>
<title>Niseko beginner guide &amp; tips - Hokkaido Ski</title>
<meta property="og:title" content="二世谷新手指南：雪道、雪具与教学">
<meta name="description" content="格兰比洛雪场山脚有一条 1.2 公里的缓坡，坡度不超过 8 度。">
<meta property="article:published_time" content="2026-10-28T09:00:00+09:00">
</head><body><main><p>${'正文。'.repeat(80)}</p></main></body></html>`;
vi.mock('../core/util/publicHttp.js', () => ({
  httpDeadline: () => ({ signal: new AbortController().signal, timedOut: () => false, dispose: () => {} }),
  fetchPublic: vi.fn(async (raw: string) => ({
    finalUrl: new URL(raw.replace('/r/', '/niseko/')), status: 200, statusText: 'OK',
    headers: { 'content-type': 'text/html; charset=utf-8' }, destroy: () => {},
  })),
  readBodyCapped: vi.fn(async () => ({ buf: Buffer.from(PAGE), truncated: false })),
}));

import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/tangu.js';
import { executeTool } from './registry.js';
import type { ToolContext } from './toolTypes.js';
import { webSearchProvider } from './builtin/webSearch.js';
import { pageMeta, webFetchProvider } from './builtin/webFetch.js';
import { normalizeSourceDate, webSourcesOf } from './webSources.js';

const HITS = [
  { title: '二世谷新手指南：雪道、雪具与教学', url: 'https://www.hokkaido-ski.jp/niseko/beginner', snippet: '格兰比洛雪场山脚有一条 1.2 公里的缓坡，坡度不超过 8 度。', date: '2026-10-28' },
  { title: '留寿都度假村 · 冬季课程', url: 'https://www.rusutsu-resort.com/winter/lessons', snippet: '中文、英文教练全季可约。' },
]
const TEXT = 'Search results (Bocha):\n1. 二世谷新手指南：雪道、雪具与教学\n  https://www.hokkaido-ski.jp/niseko/beginner\n  格兰比洛雪场山脚有一条 1.2 公里的缓坡，坡度不超过 8 度。'
const runSearch = vi.fn(async (q: string) => q === 'second'
  ? { provider: 'bocha', text: 'second text', results: [{ title: 'B', url: 'https://b.example/x' }] }
  : { provider: 'bocha', text: TEXT, results: HITS })

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
let ctx: ToolContext
const probe = vi.fn((_a: any, c: ToolContext) => `probe:${typeof c.noteWebSources}`)

beforeAll(() => {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  profile.toolLoadout.providers = [webSearchProvider, webFetchProvider, { id: 'probe', tools: () => [{
    name: 'probe_tool', mode: 'both', capabilities: { sideEffect: 'none' },
    definition: { type: 'function', function: { name: 'probe_tool', description: '', parameters: {} } }, execute: probe,
  }] }];
  configureTangu({ host: stub, brain: { ...stub, search: { runSearch } }, billing: stub, profile });
  ctx = { userId: 'u', appId: 'tangu', sessionId: 's', runId: 'r', execMode: 'sandbox', profile } as ToolContext;
});
const call = (name: string, args: Record<string, unknown>, id = 'c1') => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('web_search keeps a structured copy of its results beside the model text', () => {
  it('model text is byte-for-byte what it was; sources ride on metadata', async () => {
    const r = await executeTool(call('web_search', { query: 'hokkaido' }), ctx);
    expect(r.isError).toBe(false);
    // 回放要求与当时一字不差:给模型的仍是「引用锚点头 + runSearch 的 text」,来源一个字都没进去
    expect(r.result).toBe(`Cite for the user: [<a short phrase from the snippet>](<the result URL>) — the link text is the exact sentence the reader gets scrolled to.\n\n${TEXT}`);
    expect(r.result).not.toContain('rusutsu');
    expect(r.metadata).toEqual({ sources: [
      { url: HITS[0].url, site: 'hokkaido-ski.jp', title: HITS[0].title, date: '2026-10-28', snippet: HITS[0].snippet },
      { url: HITS[1].url, site: 'rusutsu-resort.com', title: HITS[1].title, snippet: HITS[1].snippet },
    ] });
  });

  it('parallel searches each keep their own sources', async () => {
    const [a, b] = await Promise.all([
      executeTool(call('web_search', { query: 'first' }, 'a'), ctx),
      executeTool(call('web_search', { query: 'second' }, 'b'), ctx),
    ]);
    expect(a.metadata?.sources.map((s: any) => s.url)).toEqual(HITS.map((h) => h.url));
    expect(b.metadata?.sources).toEqual([{ url: 'https://b.example/x', site: 'b.example', title: 'B' }]);
  });

  it('a string result (old cloud) or a failed search carries no sources', async () => {
    runSearch.mockResolvedValueOnce('plain text' as any);
    expect((await executeTool(call('web_search', { query: 'x' }), ctx)).metadata).toBeUndefined();
    runSearch.mockRejectedValueOnce(new Error('down'));
    const failed = await executeTool(call('web_search', { query: 'x' }), ctx);
    expect(failed.isError).toBe(true);
    expect(failed.metadata).toBeUndefined();
  });

  it('only web_search / web_fetch get the collector', async () => {
    expect((await executeTool(call('probe_tool', {}), ctx)).result).toBe('probe:undefined');
  });
});

describe('web_fetch notes the page it read', () => {
  it('final URL + page title / description / date; model text unchanged in shape', async () => {
    const r = await executeTool(call('web_fetch', { url: 'https://www.hokkaido-ski.jp/r/beginner' }), ctx);
    expect(r.isError).toBe(false);
    expect(r.result.startsWith('[https://www.hokkaido-ski.jp/niseko/beginner]\nCite for the user: ')).toBe(true);
    expect(r.result).not.toContain('2026-10-28');
    expect(r.metadata).toEqual({ sources: [{
      url: 'https://www.hokkaido-ski.jp/niseko/beginner', site: 'hokkaido-ski.jp',
      title: '二世谷新手指南：雪道、雪具与教学', date: '2026-10-28', snippet: '格兰比洛雪场山脚有一条 1.2 公里的缓坡，坡度不超过 8 度。',
    }] });
  });

  it('pageMeta falls back to <title> and decodes entities', () => {
    expect(pageMeta('<html><head><title> A &amp; B </title><meta name=description content=\'x &lt; y\'></head><body>z</body></html>'))
      .toEqual({ title: 'A & B', description: 'x < y', date: undefined });
    expect(pageMeta('no head at all')).toEqual({ title: undefined, description: undefined, date: undefined });
  });

  it('pageMeta stays linear on hostile heads (no backtracking regex over untrusted HTML)', () => {
    for (const evil of ['<title'.repeat(43_680), '<meta '.repeat(43_680), `<meta ${'a'.repeat(250_000)}`, `<meta ${'a='.repeat(1999)}>`.repeat(60)]) {
      const t = performance.now();
      pageMeta(evil);
      expect(performance.now() - t).toBeLessThan(250);
    }
    expect(pageMeta('<head><meta content="x" name=description ><META NAME="og:title" CONTENT=\'Y\'></head>')).toMatchObject({ title: 'Y', description: 'x' });
  });
});

describe('webSourcesOf', () => {
  it('drops non-http, dedupes by URL, caps lengths, normalises dates', () => {
    const long = 'x'.repeat(900);
    const out = webSourcesOf([
      { url: 'javascript:alert(1)', title: 'bad' },
      { url: 'https://a.example/1', title: `  two\n lines `, snippet: long, published_date: 'Tue, 03 Nov 2026 10:00:00 GMT' },
      { url: 'https://a.example/1', title: 'dup' },
      { url: 'not a url' },
      null,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ url: 'https://a.example/1', site: 'a.example', title: 'two lines', date: '2026-11-03' });
    expect(out[0].snippet!.length).toBe(400);
    expect(webSourcesOf(Array.from({ length: 40 }, (_, i) => ({ url: `https://a.example/${i}` })))).toHaveLength(20);
    expect(webSourcesOf('nope')).toEqual([]);
  });

  it('normalizeSourceDate keeps plausible dates only', () => {
    expect(normalizeSourceDate('2026-10-28')).toBe('2026-10-28');
    expect(normalizeSourceDate('2026-10-28T23:00:00Z')).toBe('2026-10-28');
    expect(normalizeSourceDate('1870-01-01')).toBeUndefined();
    expect(normalizeSourceDate('yesterday')).toBeUndefined();
    expect(normalizeSourceDate(undefined)).toBeUndefined();
  });
});
