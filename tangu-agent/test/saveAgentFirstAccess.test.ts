/**
 * saveAgent 同 slug 串行化 × 首访播种的重入(09-25):首访播种 ensureAgentsReady → ensureBuiltinAvatar →
 * saveAgentAvatar → saveAgent(xyra)。若播种经锁内的 getAgent 触发,进程里第一次保存恰是 xyra 时就是「自己等自己」、永久挂死
 * (sessionFacts / startProjectSession / chatPreset 的 setupLoop 都是先存 xyra)。本文件独占一份模块实例 → 播种一定没跑过。
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveAgent, getAgent, builtinAgentDef } from '../src/agents/agentRegistry.js';
import { DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';

const prevHome = process.env.TANGU_HOME;
const home = mkdtempSync(path.join(tmpdir(), 'tangu-save-first-'));
process.env.TANGU_HOME = home;
afterAll(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('saveAgent · 进程首次访问就存默认 agent', () => {
  it('不因首访播种里的 saveAgent(xyra) 自锁挂死', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = builtinAgentDef(DEFAULT_AGENT_SLUG)!;
    const saved = await Promise.race([
      saveAgent({ slug: DEFAULT_AGENT_SLUG, name: b.name, systemPrompt: b.systemPrompt, soul: b.soul }),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 3000)),
    ]);
    expect(saved).not.toBe('hung');
    expect((await getAgent(DEFAULT_AGENT_SLUG))?.slug).toBe(DEFAULT_AGENT_SLUG);
  });
});
