/**
 * 头像读-写入队(Codex 09-25 二轮 #3)× 首访播种的重入:播种 ensureAgentsReady → ensureBuiltinAvatar → saveAgentAvatar(xyra)。
 * 若进程里第一次访问恰是 saveAgentAvatar / deleteAgentAvatar(xyra),而首访播种经**锁内**的 getAgent 触发 = 外层持着 xyra 的队、
 * 播种里那次 saveAgentAvatar(xyra) 排在它后面 —— 自己等自己,永久挂死。所以两者都在入队前先跑 ensureAgentsReady。
 * 每个用例 vi.resetModules() 拿一份新的模块实例(播种标志与队都是模块级)+ 全新的家目录 → 播种一定没跑过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const hung = (): Promise<'hung'> => new Promise((r) => setTimeout(() => r('hung'), 3000));

let home = '';
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.TANGU_HOME;
  home = mkdtempSync(path.join(tmpdir(), 'tangu-avatar-first-'));
  process.env.TANGU_HOME = home;
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('头像操作 · 进程首次访问就改默认 agent 的头像', () => {
  it('saveAgentAvatar(xyra) 不因首访播种里的 saveAgentAvatar(xyra) 自锁挂死', async () => {
    const reg = await import('../src/agents/agentRegistry.js');
    const { DEFAULT_AGENT_SLUG } = await import('../src/core/tanguHome.js');
    const { builtinAgentAvatar } = await import('../src/agents/builtinAvatars.js');
    expect(builtinAgentAvatar(DEFAULT_AGENT_SLUG)).toBeTruthy(); // 前提:播种确实会为它存内置头像(否则本用例测不到重入)
    const r = await Promise.race([reg.saveAgentAvatar(DEFAULT_AGENT_SLUG, PNG, 'image/png'), hung()]);
    expect(r).toBe('avatar.png');
    expect((await reg.getAgent(DEFAULT_AGENT_SLUG))?.avatar).toBe('avatar.png');
  });

  it('deleteAgentAvatar(xyra) 同理', async () => {
    const reg = await import('../src/agents/agentRegistry.js');
    const { DEFAULT_AGENT_SLUG } = await import('../src/core/tanguHome.js');
    const r = await Promise.race([reg.deleteAgentAvatar(DEFAULT_AGENT_SLUG), hung()]);
    expect(r).toBe(true);
    expect((await reg.getAgent(DEFAULT_AGENT_SLUG))?.avatar).toBeFalsy();
  });
});
