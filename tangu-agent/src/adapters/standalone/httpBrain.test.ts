/**
 * 托管流看门狗契约（2026-07-25 挂死复盘的仪器）。
 *
 * server 的 brain/llm/stream 每 15s 发一个 `: ping` SSE 注释行防边缘代理判 504。那是**服务端自己**
 * 发的，上游挂死时照发不误 —— 若按帧续命，客户端会被这假活信号一路喂饱：零 token、零错误、
 * 永不超时，用户侧就是「模型一直没反应」。所以这里的 guard 只认 `data:` 帧。
 *
 * 跑：cd Forsion-Genesis/tangu-agent && npx vitest run src/adapters/standalone/httpBrain.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHttpBrain } from './httpBrain.js';

/**
 * 模拟 SSE 响应：按 gapMs 依次吐 frames。
 * closeAfter=true 还原正常收尾（路由 finally 里 res.end()）；false 还原「上游挂死、server 只剩心跳」——
 * 连接一直开着，交给看门狗裁决。signal 必须接上，否则 mock 的 reader 不会像真 fetch 那样抛 AbortError。
 */
function sseResponse(frames: string[], gapMs: number, signal?: AbortSignal, closeAfter = true): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      let i = 0;
      timer = setInterval(() => {
        try {
          if (i < frames.length) c.enqueue(enc.encode(frames[i++]));
          else if (closeAfter) { clearInterval(timer); c.close(); }
        } catch { /* already errored/closed */ }
      }, gapMs);
      signal?.addEventListener('abort', () => {
        clearInterval(timer);
        try { c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* noop */ }
      }, { once: true });
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function stubFetch(frames: string[], gapMs: number, closeAfter = true): void {
  vi.stubGlobal('fetch', (_url: any, init: any) =>
    Promise.resolve(sseResponse(frames, gapMs, init?.signal, closeAfter)));
}

const ping = ': ping\n\n';
const frame = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANGU_BRAIN_STREAM_IDLE_MS;
});

describe('httpBrain.streamProviderCompletion 空闲看门狗', () => {
  it('`: ping` 心跳不续命 —— 上游静默时按窗口判死', async () => {
    process.env.TANGU_BRAIN_STREAM_IDLE_MS = '150';
    stubFetch(Array(50).fill(ping), 20, false); // 每 20ms 一个心跳，远密于 150ms 窗口；连接不关
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });

    await expect(
      brain.llm.streamProviderCompletion({ payload: { __forsion_model_id: 'm' } } as any),
    ).rejects.toMatchObject({ status: 504 });
  });

  it('data 帧续命 —— 慢流累计远超窗口仍正常收完', async () => {
    process.env.TANGU_BRAIN_STREAM_IDLE_MS = '400';
    stubFetch(
      [
        frame({ t: 'token', d: 'he' }),
        ping, // 心跳夹在数据之间不影响
        frame({ t: 'token', d: 'llo' }),
        frame({ t: 'done', content: 'hello', toolCalls: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      ],
      120, // 数据间隔 120ms(含中间那个不续命的 ping 则是 240ms)，累计 480ms > 400ms 窗口
    );
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });

    const r = await brain.llm.streamProviderCompletion({ payload: { __forsion_model_id: 'm' } } as any);
    expect(r.content).toBe('hello');
    expect(r.usage.completion_tokens).toBe(2);
  });

  it('服务端迟迟不回响应头 → 也在窗口内判死（fetch 阶段不是裸奔）', async () => {
    process.env.TANGU_BRAIN_STREAM_IDLE_MS = '150';
    // guard 构造即开表（streamIdle.ts），所以这段等待也在看门狗覆盖内。
    // mock 必须像真 fetch 那样在 abort 时 reject，否则 promise 永挂、测不出东西。
    vi.stubGlobal('fetch', (_u: any, init: any) => new Promise((_res, rej) => {
      init?.signal?.addEventListener(
        'abort',
        () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    }));
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });

    await expect(
      brain.llm.streamProviderCompletion({ payload: { __forsion_model_id: 'm' } } as any),
    ).rejects.toMatchObject({ status: 504 });
  });

  it('服务端 error 帧原样上抛（上游真实错因不被本地 504 盖掉）', async () => {
    process.env.TANGU_BRAIN_STREAM_IDLE_MS = '5000';
    stubFetch([frame({ t: 'error', status: 502, message: 'upstream exploded' })], 10);
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });

    await expect(
      brain.llm.streamProviderCompletion({ payload: { __forsion_model_id: 'm' } } as any),
    ).rejects.toMatchObject({ status: 502, message: 'upstream exploded' });
  });

  it('服务端转达的 `t:\'alive\'` 帧续命 —— 上游只发 keepalive 的健康流不被误杀', async () => {
    process.env.TANGU_BRAIN_STREAM_IDLE_MS = '250';
    stubFetch(
      [
        frame({ t: 'alive' }), // 上游活着但还没有语义事件（长思考模型）
        frame({ t: 'alive' }),
        frame({ t: 'alive' }),
        frame({ t: 'token', d: '想好了' }),
        frame({ t: 'done', content: '想好了', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      ],
      100, // 累计 500ms > 250ms 窗口，全靠 alive 帧续命
    );
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });

    const r = await brain.llm.streamProviderCompletion({ payload: { __forsion_model_id: 'm' } } as any);
    expect(r.content).toBe('想好了');
  });

  it('run abort 语义不被误标成超时', async () => {
    process.env.TANGU_BRAIN_STREAM_IDLE_MS = '5000';
    stubFetch(Array(50).fill(ping), 20, false);
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });
    const ac = new AbortController();
    const p = brain.llm.streamProviderCompletion({ payload: { __forsion_model_id: 'm' }, signal: ac.signal } as any);
    setTimeout(() => ac.abort(), 50);

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/**
 * brain HTTP 的超时与错误面(2026-08-27 桌面端 2.8.1「请求超时」复盘的仪器)。
 *
 * 当时 view_image 把 1.7MB PNG 按 base64 塞进 messages,下一 leg 的 /llm/build-payload 要上传
 * ~2.3MB —— 撞上写死的 60s 超时,run 直接报废,用户只看到裸的
 * "The operation was aborted due to timeout"。三条契约:超时随 body 放大、run signal 与超时
 * **合并**而非互斥、错误带上端点与体积。
 *
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/adapters/standalone/httpBrain.test.ts
 */
describe('httpBrain 请求超时与错误面', () => {
  /** 永不返回、但像真 fetch 那样按 signal.reason 拒绝。 */
  function hangingFetch(): void {
    vi.stubGlobal('fetch', (_u: any, init: any) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init.signal.reason), { once: true });
    }));
  }
  const buildOpts = (chars: number, signal?: AbortSignal): any => ({
    model: { id: 'm' }, apiModelId: 'm',
    messages: [{ role: 'user', content: 'x'.repeat(chars) }],
    ...(signal ? { signal } : {}),
  });

  afterEach(() => {
    delete process.env.TANGU_BRAIN_HTTP_TIMEOUT_MS;
    delete process.env.TANGU_BRAIN_HTTP_TIMEOUT_PER_MB_MS;
    delete process.env.TANGU_IMAGE_HTTP_TIMEOUT_MS;
  });

  it('传了 run signal 也仍然有超时(负对照:退回 `s ?? timeout` 会永久挂起)', async () => {
    process.env.TANGU_BRAIN_HTTP_TIMEOUT_MS = '80';
    process.env.TANGU_BRAIN_HTTP_TIMEOUT_PER_MB_MS = '0';
    hangingFetch();
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });
    const runSignal = new AbortController().signal; // 用户没点停,只是把 run 的信号传了进去

    await expect(brain.llm.buildProviderPayload(buildOpts(10, runSignal)))
      .rejects.toThrow(/build-payload 超时/);
  });

  it('超时窗口随 body 放大', async () => {
    process.env.TANGU_BRAIN_HTTP_TIMEOUT_MS = '60';
    process.env.TANGU_BRAIN_HTTP_TIMEOUT_PER_MB_MS = '600';
    hangingFetch();
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });

    const timeOf = async (chars: number): Promise<number> => {
      const t0 = Date.now();
      await brain.llm.buildProviderPayload(buildOpts(chars)).catch(() => undefined);
      return Date.now() - t0;
    };
    const small = await timeOf(10);          // ≈60ms
    const big = await timeOf(1024 * 1024);   // ≈60+600ms
    expect(small).toBeLessThan(300);
    expect(big).toBeGreaterThan(300);
  });

  it('错误带上端点与体积,不再是裸的 undici 原文', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });
    await expect(brain.llm.buildProviderPayload(buildOpts(1024 * 1024)))
      .rejects.toThrow(/build-payload 连接失败.*body 1\.0MB.*cloud\.test/s);
  });

  it('生图窗口不被通用超时截断(负对照:把 floorMs 并进取消信号会把 180s 砍成 60s)', async () => {
    process.env.TANGU_BRAIN_HTTP_TIMEOUT_MS = '40';   // 通用基准:小 prompt 40ms 就该到点
    process.env.TANGU_BRAIN_HTTP_TIMEOUT_PER_MB_MS = '0';
    process.env.TANGU_IMAGE_HTTP_TIMEOUT_MS = '400';  // 生图下限:必须压过通用基准
    hangingFetch();
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });

    const t0 = Date.now();
    await brain.images.generate({ model: 'img', prompt: '一只猫' } as any).catch(() => undefined);
    expect(Date.now() - t0).toBeGreaterThan(250); // 走 40ms 通用窗口就是回归
  });

  it('超时按 UTF-8 字节算,中文不被低估 3 倍', async () => {
    process.env.TANGU_BRAIN_HTTP_TIMEOUT_MS = '40';
    process.env.TANGU_BRAIN_HTTP_TIMEOUT_PER_MB_MS = '800';
    hangingFetch();
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });

    const timeOf = async (text: string): Promise<number> => {
      const t0 = Date.now();
      await brain.llm.buildProviderPayload({
        model: { id: 'm' }, apiModelId: 'm', messages: [{ role: 'user', content: text }],
      } as any).catch(() => undefined);
      return Date.now() - t0;
    };
    const N = 350_000;
    const ascii = await timeOf('x'.repeat(N));    // 0.33MB → ≈307ms
    const cjk = await timeOf('中'.repeat(N));      // 1.05MB → ≈880ms(按 UTF-16 数则同为 ≈307ms)
    expect(ascii).toBeLessThan(600);
    expect(cjk).toBeGreaterThan(600);
  });

  it('signal 不进 JSON body(AbortSignal 会被 stringify 成 {} 白送上云)', async () => {
    let sentBody = '';
    vi.stubGlobal('fetch', (_u: any, init: any) => {
      sentBody = String(init?.body ?? '');
      return Promise.resolve(new Response(JSON.stringify({ payload: { ok: 1 } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    });
    const brain = createHttpBrain({ cloudUrl: 'https://cloud.test', token: 't' });
    await brain.llm.buildProviderPayload(buildOpts(10, new AbortController().signal));
    expect(Object.keys(JSON.parse(sentBody))).not.toContain('signal');
  });
});

