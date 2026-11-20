import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

const workers = vi.hoisted(() => [] as any[]);
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  terminate = vi.fn(async () => 0);
  constructor() { super(); workers.push(this); }
} }));
import { fitUserImages } from './imageAttachments.js';

const phone = readFileSync(new URL('../../test/fixtures/phone-digits.heic', import.meta.url));
const image = (version: number) => {
  const bytes = Buffer.from(phone); bytes.writeUInt32BE(version, 12);
  return { url: `data:image/heic;base64,${bytes.toString('base64')}` };
};

it('cancels active and queued photos without processing the rest of a stopped run', async () => {
  const active = new AbortController(), queued = new AbortController();
  const first = fitUserImages([image(100), image(101), image(102)], active.signal);
  const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  const second = fitUserImages([image(103)], queued.signal);
  const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  queued.abort();
  await secondRejected; // Prompt rejection while another photo is still decoding.
  expect(workers).toHaveLength(1);
  active.abort();
  await firstRejected;
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  // Neither cancelled batch may create another worker; a new caller can proceed.
  const third = fitUserImages([image(104)]);
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  workers[1].emit('message', { width: 2, height: 2, data: new Uint8Array(16).fill(255).buffer });
  expect((await third)[0].url).toMatch(/^data:image\/jpeg;base64,/);
  expect(workers).toHaveLength(2);
});
