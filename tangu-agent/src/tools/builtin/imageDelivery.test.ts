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

// Android app storage refuses hard links (EACCES); PRoot's link emulation on arm64 returns a meaningless errno.
const refusals = [
  Object.assign(new Error('EACCES: permission denied, link'), { code: 'EACCES', errno: -13 }),
  Object.assign(new Error('Unknown system error -353152064, link'), { code: 'Unknown system error -353152064', errno: -353152064 }),
];
it.each(refusals)('saves by exclusive write when hard links are refused ($code)', async (refusal) => {
  const f = await setup();
  const link = vi.spyOn(fs, 'link').mockRejectedValue(refusal);
  try {
    const names = await deliverImages(result, f.ctx, 'generate_image');
    expect(link).toHaveBeenCalled();
    expect(await fs.readdir(path.join(f.dir, 'generated'))).toEqual(names); // no temp file left behind
    expect((await fs.readFile(path.join(f.dir, 'generated', names[0]))).toString()).toBe('GIF89a');
    expect(f.acknowledge).toHaveBeenCalledTimes(1);
    expect(await deliverImages(result, f.ctx, 'generate_image')).toEqual(names); // a retry recognises its own file
  } finally { link.mockRestore(); }
});
it('the exclusive-write fallback still never overwrites an existing file', async () => {
  const f = await setup();
  const link = vi.spyOn(fs, 'link').mockRejectedValue(refusals[0]);
  try {
    await fs.mkdir(path.join(f.dir, 'generated'));
    const name = `image-${result.delivery.id}-1.gif`;
    await fs.writeFile(path.join(f.dir, 'generated', name), 'user content');
    await expect(deliverImages(result, f.ctx, 'generate_image')).rejects.toThrow();
    expect(await fs.readFile(path.join(f.dir, 'generated', name), 'utf8')).toBe('user content');
    expect(await fs.readdir(path.join(f.dir, 'generated'))).toEqual([name]);
    expect(f.acknowledge).not.toHaveBeenCalled();
  } finally { link.mockRestore(); }
});
it('an empty reservation left by a killed delivery is completed instead of blocking recovery', async () => {
  const f = await setup();
  const link = vi.spyOn(fs, 'link').mockRejectedValue(refusals[0]);
  try {
    const name = `image-${result.delivery.id}-1.gif`;
    await fs.mkdir(path.join(f.dir, 'generated'));
    await fs.writeFile(path.join(f.dir, 'generated', name), ''); // the engine died between reserving and renaming
    expect(await deliverImages(result, f.ctx, 'generate_image')).toEqual([name]);
    expect((await fs.readFile(path.join(f.dir, 'generated', name))).toString()).toBe('GIF89a');
    expect(await fs.readdir(path.join(f.dir, 'generated'))).toEqual([name]);
  } finally { link.mockRestore(); }
});
it('concurrent deliveries of the same task both succeed without hard links and never expose partial bytes', async () => {
  const f = await setup();
  const link = vi.spyOn(fs, 'link').mockRejectedValue(refusals[1]);
  try {
    const [a, b] = await Promise.all([deliverImages(result, f.ctx, 'generate_image'), deliverImages(result, f.ctx, 'generate_image')]);
    expect(a).toEqual(b);
    expect(await fs.readdir(path.join(f.dir, 'generated'))).toEqual(a);
    expect((await fs.readFile(path.join(f.dir, 'generated', a[0]))).toString()).toBe('GIF89a');
    for (const [file] of f.ctx.displayFile.mock.calls) expect((await fs.readFile(file.path)).toString()).toBe('GIF89a');
  } finally { link.mockRestore(); }
});
it('a failed rename deletes nothing; the empty reservation it leaves is completed by the next delivery', async () => {
  const f = await setup();
  const target = path.join(f.dir, 'generated', `image-${result.delivery.id}-1.gif`);
  const realRename = fs.rename.bind(fs);
  const link = vi.spyOn(fs, 'link').mockRejectedValue(refusals[0]);
  const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async () => { throw Object.assign(new Error('EIO: rename'), { code: 'EIO' }); });
  try {
    await expect(deliverImages(result, f.ctx, 'generate_image')).rejects.toThrow('EIO');
    expect(await fs.readdir(path.join(f.dir, 'generated'))).toEqual([path.basename(target)]);
    expect((await fs.stat(target)).size).toBe(0);
    expect(f.acknowledge).not.toHaveBeenCalled();
    rename.mockImplementation(realRename as any);
    expect(await deliverImages(result, f.ctx, 'generate_image')).toEqual([path.basename(target)]);
    expect((await fs.readFile(target)).toString()).toBe('GIF89a');
  } finally { rename.mockRestore(); link.mockRestore(); }
});
it('a stale reservation is completed when hard links work again, and a non-empty file there still wins', async () => {
  const f = await setup();
  const name = `image-${result.delivery.id}-1.gif`, target = path.join(f.dir, 'generated', name);
  await fs.mkdir(path.join(f.dir, 'generated'));
  await fs.writeFile(target, ''); // left by a delivery that died on a phone; this run has real hard links
  expect(await deliverImages(result, f.ctx, 'generate_image')).toEqual([name]);
  expect((await fs.readFile(target)).toString()).toBe('GIF89a');
  await fs.writeFile(target, 'user content');
  await expect(deliverImages(result, f.ctx, 'generate_image')).rejects.toThrow();
  expect(await fs.readFile(target, 'utf8')).toBe('user content');
});
