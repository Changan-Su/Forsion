/**
 * 拍板 3(2026-09-11):Muse 自建 Space 目录三档免审 —— 用真 checkWritePath 钉住,而不只是断言 extraRoots 里有那个路径。
 * 事实边界:writableRoots = cwd + **当前 agent 自己的目录**(agents/<slug>/)+ extraRoots;身份文件(config.toml 等)硬拒。
 * 所以在 muse 的 run 上下文里 Space 本就可写;museAgentConfig 把 Space 显式并入 extraRoots 是给**没有 agent 上下文**的执行路径
 * (负对照那组)兜底。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let home = '';
const prevHome = process.env.TANGU_HOME;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-muse-space-'));
  process.env.TANGU_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('checkWritePath × Muse 自建 Space', () => {
  for (const mode of ['ask', 'agent', 'auto'] as const) {
    it(`${mode} 档(muse 上下文):Space / Library 可写;agent 目录外越界=可审批非硬拒;config.toml 硬拒`, async () => {
      const { museAgentConfig, museSpaceDir, museLibraryDir } = await import('../services/muse.js');
      const { SPECIAL_AGENTS_DEFAULTS } = await import('../services/specialAgentsConfig.js');
      const { checkWritePath } = await import('./fsPolicy.js');
      const { runWithAgentSlug } = await import('../seams/runContext.js');
      const { agentsDir } = await import('../core/tanguHome.js');
      fs.mkdirSync(museSpaceDir(), { recursive: true });
      fs.mkdirSync(path.join(museLibraryDir(), 'Journal'), { recursive: true });
      fs.mkdirSync(path.join(home, 'elsewhere'), { recursive: true });
      const ac = museAgentConfig({ ...SPECIAL_AGENTS_DEFAULTS.muse, mode, allowedFolders: [] });
      const ctx = { cwd: ac.cwd, extraRoots: ac.extraRoots } as any;
      await runWithAgentSlug('muse', async () => {
        expect(checkWritePath(ctx, path.join(museSpaceDir(), 'main.js')).ok).toBe(true);
        expect(checkWritePath(ctx, path.join(museSpaceDir(), 'lib', 'x.js')).ok).toBe(true);
        expect(checkWritePath(ctx, path.join(museLibraryDir(), 'Journal', 'x.md')).ok).toBe(true);
        const outside = checkWritePath(ctx, path.join(home, 'elsewhere', 'notes.md'));
        expect(outside.ok).toBe(false);
        expect(outside.hardDeny).toBe(false); // 越界 = 走审批(ask/agent 档排队),不是硬拒
        const identity = checkWritePath(ctx, path.join(agentsDir(), 'muse', 'config.toml'));
        expect(identity.ok).toBe(false);
        expect(identity.hardDeny).toBe(true); // 身份/自进化文件:任何档、任何根都硬拒
      });
    });
  }
  it('没有 agent 上下文的执行路径:Space 只靠 extraRoots 才可写(负对照:去掉即越界)', async () => {
    const { museAgentConfig, museSpaceDir } = await import('../services/muse.js');
    const { SPECIAL_AGENTS_DEFAULTS } = await import('../services/specialAgentsConfig.js');
    const { checkWritePath } = await import('./fsPolicy.js');
    fs.mkdirSync(museSpaceDir(), { recursive: true });
    const ac = museAgentConfig({ ...SPECIAL_AGENTS_DEFAULTS.muse, mode: 'ask', allowedFolders: [] });
    const target = path.join(museSpaceDir(), 'main.js');
    expect(checkWritePath({ cwd: ac.cwd, extraRoots: ac.extraRoots } as any, target).ok).toBe(true);
    expect(checkWritePath({ cwd: ac.cwd, extraRoots: [] } as any, target).ok).toBe(false);
  });
});
