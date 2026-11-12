import { afterEach, expect, it, vi } from 'vitest';
import { hostedImages } from './hostedImages.js';
vi.mock('node:timers/promises', () => ({ setTimeout: async (_ms: number, _value: unknown, options?: { signal?: AbortSignal }) => { options?.signal?.throwIfAborted(); } }));
afterEach(() => vi.unstubAllGlobals());
const done = { id: '00000000-0000-0000-0000-000000000001', state: 'ready', receipt: 'hash', result: { data: [{ b64_json: 'R0lGODlh' }] } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const req = { model: 'image', prompt: 'wave', outputFormat: 'gif' as const, frameCount: 12 };

it('recovers a lost submission response by request key; never submits another paid generation', async () => {
  let key: string | undefined;
  const f = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/jobs') && init.method === 'POST') { key = JSON.parse(String(init.body)).request_id; throw new TypeError('socket lost'); }
    expect(url).toBe(`https://cloud.test/v1/images/jobs/request/${key}`); return json(done);
  });
  vi.stubGlobal('fetch', f);
  const result = await hostedImages('https://cloud.test', () => ({ Authorization: 'test' })).generate(req);
  expect(result.images[0].mime).toBe('image/gif'); expect(result.delivery?.id).toBe(done.id);
  expect(f.mock.calls.filter(c => c[1].method === 'POST')).toHaveLength(1);
});

it('retries an unaccepted upload with the same request key and polls through a transient disconnect', async () => {
  const bodies: any[] = []; let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) throw new TypeError('upload lost');
      return json({ id: done.id, state: 'running' });
    }
    if (url.includes('/request/')) return json({ error: 'not found' }, 404);
    if (reads++ === 0) throw new TypeError('connection reset');
    return json(done);
  }));
  await hostedImages('https://cloud.test', () => ({})).generate(req);
  expect(bodies).toHaveLength(2); expect(bodies[0]).toEqual(bodies[1]); expect(reads).toBe(2);
});

it('user stop leaves the job recoverable without ACK; a fresh adapter retrieves it after restart', async () => {
  const ac = new AbortController();
  const f = vi.fn(async () => { ac.abort(); return json({ id: done.id, state: 'running' }); }); vi.stubGlobal('fetch', f);
  await expect(hostedImages('https://cloud.test', () => ({})).generate({ ...req, signal: ac.signal })).rejects.toThrow();
  expect(f).toHaveBeenCalledTimes(1);
  f.mockImplementation(async () => json(done));
  const restored = await hostedImages('https://cloud.test', () => ({})).recover!(done.id);
  expect(restored.delivery?.id).toBe(done.id);
  expect(f.mock.calls.some(c => String((c as any)[0]).endsWith('/ack'))).toBe(false);
});

it('failed jobs and old servers fail explicitly without synchronous fallback or automatic regeneration', async () => {
  const f = vi.fn(async () => json({ ...done, state: 'failed', error: 'provider rejected' })); vi.stubGlobal('fetch', f);
  await expect(hostedImages('https://cloud.test', () => ({})).generate(req)).rejects.toThrow('provider rejected');
  f.mockImplementation(async () => json({}, 404));
  await expect(hostedImages('https://cloud.test', () => ({})).generate(req)).rejects.toThrow('recoverable image-task update');
  expect(f).toHaveBeenCalledTimes(2);
});

it('a lost delivery ACK is retried with the same receipt', async () => {
  const f = vi.fn().mockRejectedValueOnce(new TypeError('lost ACK')).mockResolvedValueOnce(json({ acknowledged: true })); vi.stubGlobal('fetch', f);
  await hostedImages('https://cloud.test', () => ({})).acknowledge!({ id: done.id, receipt: 'hash' });
  expect(f).toHaveBeenCalledTimes(2);
  expect(f.mock.calls[0][0]).toEqual(f.mock.calls[1][0]);
  expect(f.mock.calls[0][1].body).toEqual(f.mock.calls[1][1].body);
});
