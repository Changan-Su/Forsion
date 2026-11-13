import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureTangu } from '../../seams/runtime.js';
import { createTanguProfile } from '../../profiles/index.js';
import { deliverImages, recoverImageTool, retryImageDeliveries } from './imageDelivery.js';

const result = { images: [{ b64: 'R0lGODlh', mime: 'image/gif' }], delivery: { id: '00000000-0000-0000-0000-000000000001', receipt: 'hash' } };
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-delivery-')); dirs.push(dir);
  const acknowledge = vi.fn(async () => {}), recover = vi.fn(async () => result), listPending = vi.fn(async () => [{ id: result.delivery.id, state: 'ready' }]);
  configureTangu({ host: {} as any, billing: {} as any, brain: { images: { acknowledge, recover, listPending } } as any, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
  const ctx = { cwd: dir, execMode: 'host', displayFile: vi.fn() } as any;
  ctx.persistImageFiles = vi.fn(async (files) => { for (const file of files) await ctx.displayFile(file); });
  return { dir, acknowledge, recover, ctx };
}
it('acknowledges only after bytes are durable and displayed; recovery reuses the same file', async () => {
  const f = await setup();
  f.acknowledge.mockImplementation(async () => {
    expect(f.ctx.displayFile).toHaveBeenCalled();
    const file = f.ctx.displayFile.mock.calls[0][0].path;
    expect((await fs.readFile(file)).toString()).toBe('GIF89a');
  });
  const names = await deliverImages(result, f.ctx, 'generate_image');
  expect(await deliverImages(result, f.ctx, 'generate_image')).toEqual(names);
  expect(await fs.readdir(path.join(f.dir, 'generated'))).toEqual(names);
  expect(f.acknowledge).toHaveBeenCalledTimes(2); // The server settles the identical receipt once.
});
it('a failed save never acknowledges or overwrites an existing file', async () => {
  const f = await setup();
  await fs.mkdir(path.join(f.dir, 'generated'));
  const name = `image-${result.delivery.id}-1.gif`;
  await fs.writeFile(path.join(f.dir, 'generated', name), 'user content');
  await expect(deliverImages(result, f.ctx, 'generate_image')).rejects.toThrow();
  expect(await fs.readFile(path.join(f.dir, 'generated', name), 'utf8')).toBe('user content');
  expect(f.acknowledge).not.toHaveBeenCalled(); expect(f.ctx.displayFile).not.toHaveBeenCalled();
  expect(await fs.readdir(path.join(f.dir, 'generated'))).toEqual([name]);
});
it('a failed display is recoverable and unacknowledged; a failed ACK does not hide saved output', async () => {
  const f = await setup();
  f.ctx.displayFile.mockImplementationOnce(() => { throw new Error('display failed'); });
  await expect(deliverImages(result, f.ctx, 'generate_image')).rejects.toThrow('display failed');
  expect(f.acknowledge).not.toHaveBeenCalled();
  f.acknowledge.mockRejectedValueOnce(new Error('network lost'));
  expect(await deliverImages(result, f.ctx, 'generate_image')).toHaveLength(1);
});
it('recovery lists existing tasks and uses stored results without starting generation', async () => {
  const f = await setup();
  expect(await recoverImageTool.execute({}, f.ctx)).toContain(result.delivery.id);
  expect(f.recover).not.toHaveBeenCalled();
  expect(await recoverImageTool.execute({ request_id: result.delivery.id }, f.ctx)).toContain('Recovered 1 image');
  expect(f.recover).toHaveBeenCalledWith(result.delivery.id, undefined);
  expect(f.acknowledge).toHaveBeenCalledTimes(1);
});

it('sandbox delivery requires durable conversation persistence, not a buffered display event', async () => {
  const f = await setup(); f.ctx.execMode = 'sandbox';
  let saved = false;
  f.ctx.persistImageFiles = vi.fn(async () => { await Promise.resolve(); saved = true; });
  f.acknowledge.mockImplementation(async () => { expect(saved).toBe(true); });
  await deliverImages(result, f.ctx, 'generate_image');
  f.ctx.persistImageFiles.mockRejectedValueOnce(new Error('display limit or database failure'));
  f.acknowledge.mockClear();
  await expect(deliverImages(result, f.ctx, 'generate_image')).rejects.toThrow();
  expect(f.acknowledge).not.toHaveBeenCalled();
});
it('a new run retries only receipts already persisted for its account', async () => {
  const acknowledge = vi.fn(async () => {});
  const hasImageDelivery = vi.fn(async (_user, _session, d) => d.id === result.delivery.id);
  configureTangu({ host: {} as any, billing: {} as any, state: { hasImageDelivery } as any,
    brain: { images: { listPending: async () => [
      { ...result.delivery, state: 'ready' }, { id: 'not-saved', receipt: 'other', state: 'ready' },
    ], acknowledge, recover: vi.fn() } } as any, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
  await retryImageDeliveries({ userId: 'owner', sessionId: 'next-session' });
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith(result.delivery);
  expect(hasImageDelivery).toHaveBeenCalledWith('owner', 'next-session', result.delivery);
});
