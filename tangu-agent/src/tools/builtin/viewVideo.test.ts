/** view_video:取样计划纯函数 + (有 ffmpeg 时)对合成视频的真抽帧 e2e。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planFrameTimes, fmtClock, viewVideoProvider } from './viewVideo.js';

describe('planFrameTimes', () => {
  it('43s 全片 → 16 个窗口中点,单调递增且在 (0,43) 内', () => {
    const ts = planFrameTimes(43);
    expect(ts).toHaveLength(16);
    expect(ts[0]).toBeCloseTo(43 / 16 / 2, 1);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    expect(ts[0]).toBeGreaterThan(0);
    expect(ts[ts.length - 1]).toBeLessThan(43);
  });
  it('短视频按秒数取帧:3.4s → 3 帧', () => {
    expect(planFrameTimes(3.4)).toHaveLength(3);
  });
  it('极短视频 → 恰 1 帧,不为负', () => {
    const ts = planFrameTimes(0.15);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toBeGreaterThanOrEqual(0);
  });
  it('窗口 [10,20] → 全部落在窗口内', () => {
    const ts = planFrameTimes(120, 10, 20);
    expect(ts).toHaveLength(10);
    for (const t of ts) { expect(t).toBeGreaterThan(10); expect(t).toBeLessThan(20); }
  });
  it('end 超时长被钳到 duration;start>end 退化为单帧', () => {
    const ts = planFrameTimes(30, 20, 999);
    for (const t of ts) expect(t).toBeLessThan(30);
    expect(planFrameTimes(30, 25, 10)).toHaveLength(1);
  });
});

describe('fmtClock', () => {
  it('秒 → mm:ss / h:mm:ss', () => {
    expect(fmtClock(5)).toBe('00:05');
    expect(fmtClock(95)).toBe('01:35');
    expect(fmtClock(3661)).toBe('1:01:01');
  });
});

// ── 真抽帧 e2e:本机有 ffmpeg 才跑(CI 无 ffmpeg 时静默跳过)。──
const hasFfmpeg = ((): boolean => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe.skipIf(!hasFfmpeg)('view_video 真抽帧', () => {
  let dir: string;
  let video: string;
  const tool = viewVideoProvider.tools()[0];

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vvtest-'));
    video = path.join(dir, 'test.mp4');
    // mpeg4 编码器是 ffmpeg 内置的(libx264 是外部库,极简构建可能没有)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x240:rate=10',
      '-c:v', 'mpeg4', video], { stdio: 'ignore' });
    expect(existsSync(video)).toBe(true);
  }, 30_000);

  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const ctxWith = (images: any[]) => ({ cwd: dir, collectImage: (img: any) => images.push(img) }) as any;

  it('概览:回灌一张 jpeg 联络表,文本含时长与逐格秒数', async () => {
    const images: any[] = [];
    const out = await tool.execute({ path: 'test.mp4' }, ctxWith(images));
    expect(out).toContain('duration 8.0s');
    expect(out).toMatch(/Row 1: /);
    expect(out).toContain('#t=');
    expect(images).toHaveLength(1);
    expect(images[0].url).toMatch(/^data:image\/jpeg;base64,/);
  }, 60_000);

  it('time 模式:单帧回灌,文本报所取时刻', async () => {
    const images: any[] = [];
    const out = await tool.execute({ path: 'test.mp4', time: 3 }, ctxWith(images));
    expect(out).toContain('t=3s');
    expect(images).toHaveLength(1);
    expect(images[0].url).toMatch(/^data:image\/jpeg;base64,/);
  }, 60_000);

  it('负对照:不存在的文件 / 非视频文件 → Error,不回灌图', async () => {
    const images: any[] = [];
    expect(await tool.execute({ path: 'nope.mp4' }, ctxWith(images))).toMatch(/^Error: file not found/);
    const txt = path.join(dir, 'not-video.mp4');
    await fs.writeFile(txt, 'plain text pretending to be video');
    expect(await tool.execute({ path: 'not-video.mp4' }, ctxWith(images))).toMatch(/^Error:/);
    expect(images).toHaveLength(0);
  }, 60_000);

  it('无图像回灌通道 → 诚实报错', async () => {
    const out = await tool.execute({ path: 'test.mp4' }, { cwd: dir } as any);
    expect(out).toMatch(/^Error: this runtime cannot display images/);
  });

  it('取消原样上抛,不伪装成解码错误(Codex 08-29 #2)', async () => {
    const ac = new AbortController();
    ac.abort();
    const images: any[] = [];
    const ctx = { ...ctxWith(images), signal: ac.signal };
    await expect(tool.execute({ path: 'test.mp4' }, ctx)).rejects.toThrow();
    expect(images).toHaveLength(0);
  }, 30_000);

  it('time 模式对 >1280px 源按口径缩到恰 1280 宽(Codex 08-29 #1 的契约测试)', async () => {
    const wide = path.join(dir, 'wide.mp4');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=1920x1080:rate=5',
      '-c:v', 'mpeg4', wide], { stdio: 'ignore' });
    const images: any[] = [];
    const out = await tool.execute({ path: 'wide.mp4', time: 1 }, ctxWith(images));
    expect(out).toContain('at most 1280px');
    const jpg = path.join(dir, 'check.jpg');
    await fs.writeFile(jpg, Buffer.from(images[0].url.split(',')[1], 'base64'));
    const w = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', jpg]).toString().trim();
    expect(w).toBe('1280');
  }, 60_000);
});
