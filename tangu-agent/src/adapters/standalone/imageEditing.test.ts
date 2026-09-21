import { afterEach, expect, it, vi } from 'vitest';
import { createHttpBrain } from './httpBrain.js';
import { createMultiBrain } from './multiBrain.js';
const req = { model: 'image-model', prompt: 'Preserve the object; replace the background', images: [{ mime: 'image/png', b64: 'iVBORw0KGgo=' }], size: '3:2', n: 1, transparentBackground: true };
afterEach(() => vi.unstubAllGlobals());
it('managed edits forward source pixels, alpha request and cancellation to the edit endpoint', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'output' }] }))); vi.stubGlobal('fetch', fetcher);
  const ac = new AbortController(), brain = createHttpBrain({ cloudUrl: 'https://example.com', token: 'test' });
  expect(await brain.images!.edit!({ ...req, signal: ac.signal })).toEqual({ images: [{ b64: 'output', mime: 'image/png' }] });
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://example.com/v1/images/edits');
  expect(JSON.parse(init.body as string)).toMatchObject({ image: ['data:image/png;base64,iVBORw0KGgo='], transparent_background: true, size: '3:2' });
  ac.abort(); expect(init.signal?.aborted).toBe(true);
});
it('direct edits use multipart files without forwarding them to the managed service', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'output' }] }))); vi.stubGlobal('fetch', fetcher);
  const cloudEdit = vi.fn(), brain = createMultiBrain({ images: { edit: cloudEdit } } as any, { list: () => [{ providerId: 'custom', baseUrl: 'https://provider.example/v1/', apiKey: 'test', imageModelIds: ['image-model'] }] } as any);
  await brain.images!.edit!({ ...req, images: [...req.images, ...req.images] });
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://provider.example/v1/images/edits');
  const form = init.body as FormData;
  expect(form.get('size')).toBe('1536x1024'); expect(form.get('background')).toBe('transparent');
  expect(form.getAll('image[]')).toHaveLength(2); expect((form.get('image[]') as File).type).toBe('image/png');
  expect(cloudEdit).not.toHaveBeenCalled();
});
it('upstream rejection is an error, never a generation fallback or fabricated result', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unsupported edit', { status: 400 })));
  const brain = createHttpBrain({ cloudUrl: 'https://example.com', token: 'test' });
  await expect(brain.images!.edit!(req)).rejects.toThrow('unsupported edit');
});
