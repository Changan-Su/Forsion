/**
 * 设备能力 MCP 方案 P0 ④ · 远程污点传播(契约 C5)—— 讨论(start_discussion)。
 * 团队成员子 run / 项目会话 / 子代理 / 分支 / Muse TODO 注入各自在 teamRuns · groupChat · startProjectSession ·
 * subAgentEngine · remoteClampLoop · remoteClampRoutes 里钉;旁聊 /btw 不建 run、不带工具(asideSideChat.test 钉「payload 无 tools」),
 * 没有可继承的执行面。负对照:本机发起的讨论 run 不带污点。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/services/agentLoop.js', () => ({ enqueueRun: vi.fn(), abortRun: vi.fn() }));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { getRun } from '../src/services/runStore.js';
import { builtinAgentDef, saveAgent } from '../src/agents/agentRegistry.js';
import { DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';
import { discussProvider } from '../src/tools/builtin/discuss.js';

let home: string;
const profile = createTanguProfile({ sandboxMode: 'none' });
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-remote-prop-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile });
  await runMigration();
  const b = builtinAgentDef(DEFAULT_AGENT_SLUG)!;
  await saveAgent({ slug: DEFAULT_AGENT_SLUG, name: b.name, description: b.description, systemPrompt: b.systemPrompt, soul: b.soul });
});
afterAll(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('start_discussion', () => {
  const start = discussProvider.tools().find((t) => t.name === 'start_discussion')!;
  const ctx: any = { userId: 'u1', sessionId: 'S', appId: 'tangu', modelId: 'm1', agentSlug: DEFAULT_AGENT_SLUG, profile, execMode: 'host', runId: 'R0' };
  const inputOf = async (out: string): Promise<any> => {
    const id = String(out).match(/discussionId: ([^)]+)\)/)![1];
    const r = await getRun(id);
    return typeof r!.input === 'string' ? JSON.parse(r!.input) : r!.input;
  };

  it('远程 run 起的讨论 run 带 input.remote;run 中途被远端 steer 染上的也算;负对照:本机不带', async () => {
    const remote = await start.execute({ topic: 'x', instructions: 'be a peer' }, { ...ctx, remote: { via: 'lan', marked: true } });
    expect((await inputOf(String(remote))).remote).toEqual({ via: 'lan', marked: true });
    const local = await start.execute({ topic: 'x', instructions: 'be a peer' }, ctx);
    expect((await inputOf(String(local))).remote).toBeUndefined();
    const { taintRunRemote } = await import('../src/services/remoteOrigin.js');
    taintRunRemote('R-steered', { via: 'tunnel', marked: false });
    const steered = await start.execute({ topic: 'x', instructions: 'be a peer' }, { ...ctx, runId: 'R-steered' });
    expect((await inputOf(String(steered))).remote).toEqual({ via: 'tunnel', marked: false });
  });
});
