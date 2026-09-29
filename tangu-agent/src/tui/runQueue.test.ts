import { describe, expect, it } from 'vitest';
import { drainQueue, mustQueue } from './runQueue.js';

describe('TUI 运行中排队', () => {
  it('忙时消息、改动运行的命令与自定义命令排队;其余内置命令立即执行', () => {
    expect(mustQueue('继续', true, 0)).toBe(true);
    expect(mustQueue('/compact 关注 API', true, 0)).toBe(true);
    expect(mustQueue('/retry', true, 0)).toBe(true);
    expect(mustQueue('/my-custom arg', true, 0)).toBe(true); // 自定义命令展开即消息
    expect(mustQueue('/model gpt', true, 0)).toBe(false);
    expect(mustQueue('/queue clear', true, 0)).toBe(false);
    expect(mustQueue('/effort high', true, 0)).toBe(false); // 别名归一到 /think
  });

  it('空闲且队空时什么都不排;队里还有东西时新消息排在后面', () => {
    expect(mustQueue('hi', false, 0)).toBe(false);
    expect(mustQueue('/compact', false, 0)).toBe(false);
    expect(mustQueue('hi', false, 2)).toBe(true);
    expect(mustQueue('/help', false, 2)).toBe(false);
  });

  it('某条执行抛错只报错,不抛出去、不拖垮后面的', async () => {
    const q = ['/branch', 'next'];
    const ran: string[] = [];
    const failed: string[] = [];
    const run = async (line: string): Promise<void> => {
      if (line === '/branch') throw new Error('db down');
      ran.push(line);
    };
    await drainQueue({ idle: () => true, take: () => q.shift() }, run, (line) => failed.push(line));
    expect(failed).toEqual(['/branch']);
    expect(ran).toEqual(['next']);
  });

  it('按先后逐条执行,某条重新忙起来(起 run)就停,剩下的等下次', async () => {
    const q = ['/new', '/compact', 'after compact', 'later'];
    let busy = false;
    const ran: string[] = [];
    const run = async (line: string): Promise<void> => {
      ran.push(line);
      if (line === '/compact' || !line.startsWith('/')) busy = true;
    };
    const io = { idle: () => !busy, take: () => q.shift() };
    await drainQueue(io, run, () => {});
    expect(ran).toEqual(['/new', '/compact']);
    busy = false; // 压缩完成
    await drainQueue(io, run, () => {});
    expect(ran).toEqual(['/new', '/compact', 'after compact']);
    busy = false; // run 收尾
    await drainQueue(io, run, () => {});
    expect(ran).toEqual(['/new', '/compact', 'after compact', 'later']);
    expect(q).toEqual([]);
  });
});
