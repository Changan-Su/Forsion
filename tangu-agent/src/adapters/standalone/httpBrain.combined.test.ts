/**
 * F1 三次传输合一(报告 §五 F1)的契约:
 *   - buildProviderPayload 只造惰性描述符,零网络;整份上下文一轮只上传一次。
 *   - 新服务端 → 一次 POST /api/brain/llm/build-and-stream。
 *   - 老服务端(该路由 404,或反代把未知路径吞成非 SSE 的 200)→ 回落 build-payload + stream,
 *     且**本进程之后不再探测**(否则每轮都白传一次整份上下文)。这份负能力按 base URL 记在
 *     **模块级**:同进程重新装配 brain(worker 换 token / 断线重连)也不再探(评审 #7)。
 * ⚠️ 本文件每个用例用**各自的 cloudUrl**:负缓存是模块级的,共用一个 base 会让先跑的 404 用例
 *     污染后跑的用例(html 那条会少一次探测,F2 那几条会拿 SSE 去 JSON.parse)。
 *
 * 外加 F2(报告 §五 F2)的 usage 极性契约:托管 done 帧里 server 归一过的数字要在这里还原成
 * 「报了 / 没报」,否则 agentLoop 的 cached_tokens !== undefined 在托管链路恒为真。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/adapters/standalone/httpBrain.combined.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHttpBrain } from './httpBrain.js';

const doneFrame = `data: ${JSON.stringify({
  t: 'done', content: 'hi', toolCalls: [], usage: { prompt_tokens: 7, completion_tokens: 2 },
})}\n\n`;

const sse = (): Response =>
  new Response(doneFrame, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

/** 记录每次 fetch 的 (path, body);combined 决定合并端点回什么。 */
function stubFetch(combined: 'sse' | '404' | 'html'): Array<{ path: string; body: any }> {
  const calls: Array<{ path: string; body: any }> = [];
  vi.stubGlobal('fetch', (url: any, init: any) => {
    const path = String(url).replace(/^.*\/api\/brain\/llm\//, '');
    let body: any;
    try { body = JSON.parse(init?.body ?? '{}'); } catch { body = init?.body; }
    calls.push({ path, body });
    if (path === 'build-and-stream') {
      if (combined === 'sse') return Promise.resolve(sse());
      if (combined === '404') return Promise.resolve(new Response('Cannot POST', { status: 404, headers: { 'Content-Type': 'text/html' } }));
      return Promise.resolve(new Response('<html>portal</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    }
    if (path === 'build-payload') {
      return Promise.resolve(new Response(JSON.stringify({ payload: { __forsion_model_id: 'm', built: true } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return Promise.resolve(sse());
  });
  return calls;
}

const opts = {
  model: { id: 'm', name: 'M', provider: 'openai' } as any,
  apiModelId: 'm',
  messages: [{ role: 'user', content: 'hello' }] as any,
  projectSource: 'tangu',
  client: 'desktop/9.9.9',
  cacheKey: 'sess-1',
  signal: new AbortController().signal,
};

afterEach(() => vi.unstubAllGlobals());

describe('httpBrain F1 合并端点', () => {
  it('buildProviderPayload 不发网络请求,描述符可安全 JSON.stringify', async () => {
    const calls = stubFetch('sse');
    const brain = createHttpBrain({ cloudUrl: 'https://cloud-nonet.test', token: 't' });
    const payload = await brain.llm.buildProviderPayload(opts);
    expect(calls).toHaveLength(0);
    // agentLoop 用 JSON.stringify(payload) 量 requestBytes —— 描述符必须可序列化且不带 signal。
    const raw = JSON.stringify(payload);
    expect(JSON.parse(raw).signal).toBeUndefined();
    expect(raw).toContain('hello');
  });

  it('新服务端:整轮只有一次 POST,请求体带齐 build 字段', async () => {
    const calls = stubFetch('sse');
    const brain = createHttpBrain({ cloudUrl: 'https://cloud-sse.test', token: 't' });
    const payload = await brain.llm.buildProviderPayload(opts);
    let accepted = 0;
    const r = await brain.llm.streamProviderCompletion({
      apiKey: 'x', baseUrl: '', payload, onResponseStart: () => { accepted += 1; },
    });

    expect(calls.map((c) => c.path)).toEqual(['build-and-stream']);
    expect(accepted).toBe(1);
    expect(r.content).toBe('hi');
    expect(r.usage.prompt_tokens).toBe(7);
    const body = calls[0].body;
    expect(body.modelId).toBe('m');
    expect(body.client).toBe('desktop/9.9.9');
    expect(body.cacheKey).toBe('sess-1');
    expect(body.messages[0].content).toBe('hello');
    expect(body.__forsion_lazy_build).toBeUndefined(); // 标记不上 wire
  });

  it('老服务端:404 → 回落两步,同一实例之后不再探测合并端点', async () => {
    const calls = stubFetch('404');
    const brain = createHttpBrain({ cloudUrl: 'https://cloud-404.test', token: 't' });
    let accepted = 0;
    const onResponseStart = (): void => { accepted += 1; };

    const first = await brain.llm.streamProviderCompletion({
      apiKey: 'x', baseUrl: '', payload: await brain.llm.buildProviderPayload(opts), onResponseStart,
    });
    expect(calls.map((c) => c.path)).toEqual(['build-and-stream', 'build-payload', 'stream']);
    expect(first.content).toBe('hi');
    expect(accepted).toBe(1); // 探测那次白跑不算「已受理」,否则 uploadMs 定格在它上面

    calls.length = 0;
    await brain.llm.streamProviderCompletion({
      apiKey: 'x', baseUrl: '', payload: await brain.llm.buildProviderPayload(opts), onResponseStart,
    });
    expect(calls.map((c) => c.path)).toEqual(['build-payload', 'stream']);
    expect(calls[1].body.payload.built).toBe(true); // stream 收到的是服务端装配好的 payload
  });

  it('负能力记在模块级、按 base URL 分桶:同进程另起一个 brain 不再白传整份上下文去探测', async () => {
    const calls = stubFetch('404');
    const first = createHttpBrain({ cloudUrl: 'https://cloud-reuse.test', token: 't' });
    await first.llm.streamProviderCompletion({
      apiKey: 'x', baseUrl: '', payload: await first.llm.buildProviderPayload(opts),
    });
    expect(calls.map((c) => c.path)).toEqual(['build-and-stream', 'build-payload', 'stream']);

    // 同一个服务端、**另一个实例**(worker 换 token、断线重连即是此形态):实例内变量的旧写法
    // 会在这里再探一次 —— 那一次白跑要把整份上下文上传一遍,正是 F1 要省掉的那一腿。
    // cloudUrl 故意带尾斜杠:键按归一化后的 base 算,不是按调用方写法算。
    calls.length = 0;
    const second = createHttpBrain({ cloudUrl: 'https://cloud-reuse.test/', token: 't2' });
    await second.llm.streamProviderCompletion({
      apiKey: 'x', baseUrl: '', payload: await second.llm.buildProviderPayload(opts),
    });
    expect(calls.map((c) => c.path)).toEqual(['build-payload', 'stream']);

    // 负对照:换一个 base URL 仍要探 —— 记的是「这个服务端没有」,不是一个全局开关
    // (否则同进程连两个云端时,新服务端会被老服务端的探测结果连累成永久回落)。
    calls.length = 0;
    const other = createHttpBrain({ cloudUrl: 'https://cloud-other.test', token: 't' });
    await other.llm.streamProviderCompletion({
      apiKey: 'x', baseUrl: '', payload: await other.llm.buildProviderPayload(opts),
    });
    expect(calls.map((c) => c.path)).toEqual(['build-and-stream', 'build-payload', 'stream']);
  });

  it('反代把未知路径吞成非 SSE 的 200 也算「没有合并端点」', async () => {
    const calls = stubFetch('html');
    const brain = createHttpBrain({ cloudUrl: 'https://cloud-html.test', token: 't' });
    const r = await brain.llm.streamProviderCompletion({
      apiKey: 'x', baseUrl: '', payload: await brain.llm.buildProviderPayload(opts),
    });
    expect(calls.map((c) => c.path)).toEqual(['build-and-stream', 'build-payload', 'stream']);
    expect(r.content).toBe('hi'); // 没有静默返回空正文
  });

  it('非惰性 payload(存量调用方)直接走 /stream', async () => {
    const calls = stubFetch('sse');
    const brain = createHttpBrain({ cloudUrl: 'https://cloud-direct.test', token: 't' });
    await brain.llm.streamProviderCompletion({ apiKey: 'x', baseUrl: '', payload: { __forsion_model_id: 'm' } } as any);
    expect(calls.map((c) => c.path)).toEqual(['stream']);
    expect(calls[0].body.modelId).toBe('m');
  });
});


/** done 帧里塞一份指定的 usage(模拟 server 的 llmService 归一结果)。 */
function stubUsageFetch(usage: any): void {
  const frame = `data: ${JSON.stringify({ t: 'done', content: 'hi', toolCalls: [], usage })}\n\n`;
  vi.stubGlobal('fetch', () => Promise.resolve(
    new Response(frame, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  ));
}

const stream = async (): Promise<any> => {
  const brain = createHttpBrain({ cloudUrl: 'https://cloud-usage.test', token: 't' });
  return brain.llm.streamProviderCompletion({
    apiKey: 'x', baseUrl: '', payload: await brain.llm.buildProviderPayload(opts),
  });
};

describe('httpBrain F2 usage 极性', () => {
  it('server 说没报缓存 → cached_tokens 抹成 undefined(负对照:原样透传则托管链路恒判「报过」)', async () => {
    stubUsageFetch({ prompt_tokens: 100, completion_tokens: 2, cached_tokens: 0, cacheReported: false, reasoning_tokens: 0 });
    const r = await stream();
    expect(r.usage.cached_tokens).toBeUndefined();
    expect(r.usage.reasoning_tokens).toBeUndefined();
    expect(r.usage.prompt_tokens).toBe(100); // 其余字段原样
  });

  it('server 说报了 → 真 0 命中保持数字,非 0 原样', async () => {
    stubUsageFetch({ prompt_tokens: 100, completion_tokens: 2, cached_tokens: 0, cacheReported: true, reasoning_tokens: 12 });
    expect((await stream()).usage.cached_tokens).toBe(0);
    vi.unstubAllGlobals();
    stubUsageFetch({ prompt_tokens: 100, completion_tokens: 2, cached_tokens: 4096, cacheReported: true, reasoning_tokens: 12 });
    const r = await stream();
    expect(r.usage.cached_tokens).toBe(4096);
    expect(r.usage.reasoning_tokens).toBe(12);
  });

  it('老服务端没有 cacheReported:>0 反证报过,0 记「不知道」', async () => {
    stubUsageFetch({ prompt_tokens: 100, completion_tokens: 2, cached_tokens: 900 });
    expect((await stream()).usage.cached_tokens).toBe(900);
    vi.unstubAllGlobals();
    stubUsageFetch({ prompt_tokens: 100, completion_tokens: 2, cached_tokens: 0 });
    expect((await stream()).usage.cached_tokens).toBeUndefined();
  });
});


// ── 托管 done 帧的 outputItems 转运(engine2-src 评审 #3 的 engine 半边)────────────
//
// 写侧(historyReplay.stepLlmResponse)落库的原料就是 StreamResult.outputItems —— 直连
// provider(openaiResponses / anthropicMessages)自己填这个字段,托管面则只能靠 done 帧转运。
// 漏抄一行的后果是**静默的**:不报错、不崩,只是托管链路上 res.outputItems 恒空,
// 跨 run 的思考延续性永远为零,而端到端测试里的假 LLM 直接返回 outputItems,绕过了这条 HTTP 缝。

/** done 帧:server 的 doneFrameOf 形态(outputItems 只在非空时出现)。 */
const doneWith = (extra: Record<string, unknown>): Response =>
  new Response(
    `data: ${JSON.stringify({ t: 'done', content: 'hi', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, ...extra })}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

/** combinedOk=false → 合并端点 404,走老两步回退(build-payload + stream)。 */
function stubItemsFetch(combinedOk: boolean, extra: Record<string, unknown>): string[] {
  const paths: string[] = [];
  vi.stubGlobal('fetch', (url: any) => {
    const path = String(url).replace(/^.*\/api\/brain\/llm\//, '');
    paths.push(path);
    if (path === 'build-and-stream' && !combinedOk) {
      return Promise.resolve(new Response('Cannot POST', { status: 404, headers: { 'Content-Type': 'text/html' } }));
    }
    if (path === 'build-payload') {
      return Promise.resolve(new Response(JSON.stringify({ payload: { __forsion_model_id: 'm' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return Promise.resolve(doneWith(extra));
  });
  return paths;
}

/** 每个用例各自的 cloudUrl:合并端点的负能力缓存是模块级的(见文件头)。 */
const streamOn = async (cloudUrl: string): Promise<any> => {
  const brain = createHttpBrain({ cloudUrl, token: 't' });
  return brain.llm.streamProviderCompletion({
    apiKey: 'x', baseUrl: '', payload: await brain.llm.buildProviderPayload(opts),
  });
};

const ITEMS = [{ type: 'thinking', thinking: 'step two', signature: 'SIG' }];

describe('httpBrain done 帧的 outputItems', () => {
  it('合并端点:done.outputItems → StreamResult.outputItems(与直连 provider 同名字段)', async () => {
    const paths = stubItemsFetch(true, { outputItems: ITEMS });
    const r = await streamOn('https://cloud-items-combined.test');
    expect(paths).toEqual(['build-and-stream']);
    expect(r.outputItems).toEqual(ITEMS);
    expect(r.content).toBe('hi'); // 其余字段照旧
  });

  it('老两步回退链路同样转运(回退那条腿漏抄一行不会红)', async () => {
    const paths = stubItemsFetch(false, { outputItems: ITEMS });
    const r = await streamOn('https://cloud-items-fallback.test');
    expect(paths).toEqual(['build-and-stream', 'build-payload', 'stream']);
    expect(r.outputItems).toEqual(ITEMS);
  });

  it('负对照:done 帧没有这个字段(chat/completions 上游、老服务端)→ 保持 undefined,不造空数组', async () => {
    stubItemsFetch(true, {});
    const r = await streamOn('https://cloud-items-absent.test');
    expect(r.outputItems).toBeUndefined();
    // 空数组同理:写侧靠「有没有」判定是否落绑定,给成 [] 会把「没有原料」存成一条有效绑定
    vi.unstubAllGlobals();
    stubItemsFetch(true, { outputItems: [] });
    expect((await streamOn('https://cloud-items-empty.test')).outputItems).toBeUndefined();
  });
});
