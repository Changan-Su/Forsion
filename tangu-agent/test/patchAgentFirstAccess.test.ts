/**
 * patchAgent × 首访播种的重入(同 saveAgentFirstAccess):首访播种 ensureAgentsReady → ensureBuiltinAvatar → saveAgentAvatar(xyra)
 * 入 xyra 的队。patchAgent 若在锁里才(经 getAgent)触发播种,进程里第一次写恰是「改默认 agent 的某个字段」时就是自己等自己、
 * 永久挂死。本文件独占一份模块实例 → 播种一定没跑过。
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { patchAgent, getAgent } from '../src/agents/agentRegistry.js';
import { DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';

const prevHome = process.env.TANGU_HOME;
const home = mkdtempSync(path.join(tmpdir(), 'tangu-patch-first-'));
process.env.TANGU_HOME = home;
afterAll(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('patchAgent · 进程首次访问就改默认 agent', () => {
  it('不因首访播种里的 saveAgentAvatar(xyra) 自锁挂死', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = await Promise.race([
      patchAgent(DEFAULT_AGENT_SLUG, { model: 'm-first' }),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 3000)),
    ]);
    expect(saved).not.toBe('hung');
    const d = await getAgent(DEFAULT_AGENT_SLUG);
    expect(d?.model).toBe('m-first');
    expect(d?.avatar).toBeTruthy(); // 播种的头像照常落盘,且没被这次 patch 洗掉
  });
});
