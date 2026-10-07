import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { HOST_TOOLS } from './hostExec.js';
import type { ToolContext } from './toolTypes.js';

// view_image 的接线:大图缩了再进上下文并报前后尺寸;小图、坏图、非图片走的还是原来那条路(文案逐字不变)。

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

/** 纯色底 + 右下一块噪点(noise=0 → 几 KB 的小图)。 */
function shot(w: number, h: number, noise: number): Buffer {
  const p = new PNG({ width: w, height: h });
  let seed = 4242;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, noisy = x > w * (1 - noise) && y > h * (1 - noise);
      for (let c = 0; c < 3; c++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; p.data[i + c] = noisy ? (seed >> 16) & 0xff : 235; }
      p.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(p);
}

async function view(name: string, bytes: Buffer | null) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-viewimage-test-'));
  tempDirs.push(cwd);
  if (bytes) await fs.writeFile(path.join(cwd, name), bytes);
  const images: string[] = [];
  const ctx = { userId: 'test', sessionId: 'test', appId: 'test', cwd, collectImage: (img: { url: string }) => { images.push(img.url); } } as ToolContext;
  const text = await HOST_TOOLS.view_image.execute({ path: name }, ctx);
  return { text, images };
}
const untouched = (name: string, mime: string, bytes: Buffer) =>
  `Loaded image ${name} (${mime}, ${(bytes.length / 1024).toFixed(0)} KB). The image itself has been provided to you as content — answer from it directly; do not try to read_file it.`;

describe('view_image 缩图接线', () => {
  it('小图:原样送、文案不变', async () => {
    const bytes = shot(640, 480, 0);
    const r = await view('small.png', bytes);
    expect(r.images).toEqual([`data:image/png;base64,${bytes.toString('base64')}`]);
    expect(r.text).toBe(untouched('small.png', 'image/png', bytes));
  });

  it('大截图:送缩后的 JPEG,结果里写明原尺寸和缩后尺寸', async () => {
    const bytes = shot(1800, 1500, 0.4);
    const r = await view('big.png', bytes);
    expect(r.images).toHaveLength(1);
    expect(r.images[0].startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(r.images[0].length).toBeLessThan(bytes.length);
    const m = /It is 1800x1500 px on disk and was downscaled to (\d+)x(\d+) px for you/.exec(r.text);
    expect(m, r.text).not.toBeNull();
    expect(Number(m![1]) * Number(m![2])).toBeLessThanOrEqual(1_150_000);
    expect(r.text.startsWith(`Loaded image big.png (image/png, ${(bytes.length / 1024).toFixed(0)} KB). `)).toBe(true);
    expect(r.text.endsWith('do not try to read_file it.')).toBe(true);
  });

  it('损坏的大 .png:不多出新的报错,照旧原样送', async () => {
    const bytes = Buffer.concat([shot(64, 64, 0).subarray(0, 33), Buffer.alloc(300_000, 0x5a)]);
    const r = await view('broken.png', bytes);
    expect(r.images).toEqual([`data:image/png;base64,${bytes.toString('base64')}`]);
    expect(r.text).toBe(untouched('broken.png', 'image/png', bytes));
  });

  it('不是图片 / 文件不存在:原来的报错,不收图', async () => {
    const txt = await view('notes.txt', Buffer.from('hello'));
    expect(txt.text).toBe('Error: unsupported image format (only png/jpg/jpeg/gif/webp/bmp): notes.txt');
    const missing = await view('gone.png', null);
    expect(missing.text).toBe('Error: file not found: gone.png');
    expect([...txt.images, ...missing.images]).toEqual([]);
  });
});
