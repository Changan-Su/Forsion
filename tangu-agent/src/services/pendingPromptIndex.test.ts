/**
 * 进程级待批索引(P1 · K3 §3.1)。真 SQLite(内存)+ 真登记表(approvals.ts / inquiries.ts),事件总线换成桩(不落库)。
 *   上架 / 下架 / 中止 → expired / 解析期间被兑现 → 静默丢弃 / 团队成员子 run → 团队会话 / 远程判定两路(审批的 origin、询问按 run 行
 *   + 中途 steer 染色)/ rev / sweepTerminal / S6(工具与模型上下文不 import 本模块)。
 * 负对照(实跑见红,记在 K3 交付报告):去掉 approvals.ts onAbort 里的 untrackPrompt → 「中止 → expired」一条红(条目泄漏);
 *   去掉 inquiries.ts onAbort 里的 untrackPrompt → 「询问(inquiry / plan)中止」两条红。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('./eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: vi.fn(async () => 1) }));

import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { requestApproval, resolveApproval } from './approvals.js';
import { requestInquiry, resolveInquiry } from './inquiries.js';
import { taintRunRemote } from './remoteOrigin.js';
import {
  __resetPromptIndexForTests, listPrompts, onPromptChange, promptsRev, sessionAttention, sweepTerminal, trackPrompt, untrackPrompt, type PromptChange,
} from './pendingPromptIndex.js';
import type { ToolCall } from '../core/types.js';

const call = (name: string): ToolCall => ({ id: 'c1', type: 'function', function: { name, arguments: '{"command":"npm test"}' } }) as ToolCall;
const UNIT = '6c1d7a4e-2b3f-4a5c-8d9e-0f1a2b3c4d5e';
let changes: PromptChange[] = [];
const added = (): Extract<PromptChange, { type: 'added' }>[] => changes.filter((c): c is Extract<PromptChange, { type: 'added' }> => c.type === 'added');
const removed = (): Extract<PromptChange, { type: 'removed' }>[] => changes.filter((c): c is Extract<PromptChange, { type: 'removed' }> => c.type === 'removed');
const waitAdded = (n: number): Promise<void> => vi.waitFor(() => expect(added().length).toBe(n));

async function addRun(id: string, sessionId: string, input: unknown = {}, status = 'running'): Promise<void> {
  await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES (?, ?, 'u1', ?, ?)`, [id, sessionId, status, JSON.stringify(input)]);
}
async function addSession(id: string, title: string): Promise<void> {
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES (?, 'u1', 'tangu', ?, 'm1', 'user', 1, '{}')`, [id, title]);
}

beforeAll(async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});
beforeEach(() => {
  __resetPromptIndexForTests();
  changes = [];
  onPromptChange((c) => { changes.push(c); });
});

describe('上架 / 下架', () => {
  it('审批:发出请求 → added(会话 / 标题 / 工具);兑现 → removed(approved,带 by);rev 单调前进', async () => {
    await addSession('S-a', '修 CI');
    await addRun('R-a', 'S-a');
    const rev0 = promptsRev();
    const decided = requestApproval('R-a', call('run_bash'), '$ npm test');
    await waitAdded(1);
    const it0 = added()[0].item;
    expect(it0).toMatchObject({ kind: 'approval', runId: 'R-a', sessionId: 'S-a', sessionTitle: '修 CI', tool: 'run_bash', localOnly: false, remote: null });
    expect(it0.id).toMatch(/^apv_/);
    expect(listPrompts().map((p) => p.id)).toEqual([it0.id]);
    expect(sessionAttention()).toEqual([{ sessionId: 'S-a', approvals: 1, inquiries: 0, localOnly: 0, oldestAt: new Date(it0.createdAt).toISOString(), remote: false }]);
    expect(promptsRev()).not.toBe(rev0);

    expect(resolveApproval(it0.id, { action: 'approve' }, 'R-a', { via: 'tunnel', callerUnit: UNIT, callerName: 'Pixel' })).toBe(true);
    await expect(decided).resolves.toEqual({ action: 'approve' });
    expect(removed()).toEqual([expect.objectContaining({ id: it0.id, sessionId: 'S-a', outcome: 'approved', by: { via: 'tunnel', callerUnit: UNIT, callerName: 'Pixel' } })]);
    expect(listPrompts()).toEqual([]);
    expect(sessionAttention()).toEqual([]);
  });

  it('受保护路径的审批:localOnly 进索引与计数', async () => {
    await addRun('R-p', 'S-p');
    const decided = requestApproval('R-p', call('write_file'), 'write ~/.forsion/config.json', undefined, { kind: 'protected', mode: 'auto-edit' });
    await waitAdded(1);
    expect(added()[0].item.localOnly).toBe(true);
    expect(sessionAttention()[0]).toMatchObject({ sessionId: 'S-p', approvals: 1, localOnly: 1 });
    resolveApproval(added()[0].item.id, { action: 'reject' }, 'R-p');
    await decided;
    expect(removed()[0]).toMatchObject({ outcome: 'rejected', by: { via: 'local' } });
  });

  it('中止 → removed(expired):approval_result 不发的那条分支也要撤,否则通知 / 角标残留(S9)', async () => {
    await addRun('R-ab', 'S-ab');
    const ac = new AbortController();
    const decided = requestApproval('R-ab', call('run_bash'), '$ x', ac.signal);
    await waitAdded(1);
    ac.abort();
    await expect(decided).resolves.toEqual({ action: 'reject' });
    expect(removed()).toEqual([expect.objectContaining({ id: added()[0].item.id, outcome: 'expired' })]);
    expect(listPrompts()).toEqual([]);
  });

  it.each([['inquiry', undefined], ['plan', 'plan']] as const)('询问(%s)中止 → removed(expired),流与按会话计数都撤(S9:ask_user / 计划拍板同样不发 inquiry_result)', async (kind, payloadKind) => {
    await addRun(`R-qab-${kind}`, `S-qab-${kind}`);
    const ac = new AbortController();
    const answered = requestInquiry(`R-qab-${kind}`, { question: '用哪个?', options: ['A'], allowFreeText: true, ...(payloadKind ? { kind: payloadKind } : {}) }, ac.signal);
    await waitAdded(1);
    expect(added()[0].item.kind).toBe(kind);
    expect(sessionAttention()).toEqual([expect.objectContaining({ sessionId: `S-qab-${kind}`, inquiries: 1 })]);
    ac.abort();
    await answered;
    expect(removed()).toEqual([expect.objectContaining({ id: added()[0].item.id, outcome: 'expired' })]);
    expect(listPrompts()).toEqual([]);
    expect(sessionAttention()).toEqual([]);
  });

  it('解析期间被兑现:静默丢弃(订阅者从没见过它 —— 不发 added,也不发 removed)', async () => {
    trackPrompt({ id: 'apv_x', kind: 'approval', runId: 'R-none' });
    untrackPrompt('apv_x', 'approved');
    await new Promise((r) => setTimeout(r, 30));
    expect(changes).toEqual([]);
    expect(listPrompts()).toEqual([]);
  });

  it('询问 / 计划拍板:kind 区分,回答 → answered + by;计数进 inquiries', async () => {
    await addRun('R-q', 'S-q');
    const a = requestInquiry('R-q', { question: '用哪个?', options: ['A', 'B'], allowFreeText: true });
    const b = requestInquiry('R-q', { question: 'plan', options: [], allowFreeText: true, kind: 'plan' });
    await waitAdded(2);
    expect(added().map((c) => c.item.kind).sort()).toEqual(['inquiry', 'plan']);
    expect(added().every((c) => c.item.tool === null)).toBe(true);
    expect(sessionAttention()[0]).toMatchObject({ sessionId: 'S-q', approvals: 0, inquiries: 2 });
    for (const c of added()) resolveInquiry(c.item.id, 'A', 'R-q', { via: 'channel' });
    await Promise.all([a, b]);
    expect(removed().map((r) => [r.outcome, r.by?.via])).toEqual([['answered', 'channel'], ['answered', 'channel']]);
  });

  it('没装配 / 读 run 失败也上架(会话未知 = 不进按会话的聚合,但流里仍有,通知计数不丢)', async () => {
    trackPrompt({ id: 'apv_orphan', kind: 'approval', runId: 'R-missing', tool: 'run_bash' });
    await waitAdded(1);
    expect(added()[0].item).toMatchObject({ sessionId: '', sessionTitle: null, tool: 'run_bash' });
    expect(sessionAttention()).toEqual([]);
  });
});

describe('可见会话与远程判定', () => {
  it('团队成员子 run 的审批 → 挂在团队会话上(input 是 JSON 串也认)', async () => {
    await addSession('S-team', '团队');
    await addRun('R-member', 'S-member-work', { agentConfig: { teamMember: { teamSessionId: 'S-team' } } });
    const d = requestApproval('R-member', call('run_bash'), '$ x');
    await waitAdded(1);
    expect(added()[0].item).toMatchObject({ runId: 'R-member', sessionId: 'S-team', sessionTitle: '团队' });
    resolveApproval(added()[0].item.id, { action: 'reject' }, 'R-member');
    await d;
  });

  it('审批用闸里传来的有效污点(origin);询问按 run 行的 input.remote 现算', async () => {
    await addRun('R-rem', 'S-rem', { remote: { via: 'tunnel', marked: true, callerUnit: UNIT, callerKind: 'phone', callerName: 'Pixel 9' } });
    const origin = { via: 'tunnel' as const, marked: true, callerUnit: UNIT, callerKind: 'phone' as const, callerName: 'Pixel 9' };
    const d = requestApproval('R-rem', call('run_bash'), '$ x', undefined, undefined, origin);
    const q = requestInquiry('R-rem', { question: '?', options: [], allowFreeText: true });
    await waitAdded(2);
    for (const c of added()) expect(c.item.remote).toEqual({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone', callerName: 'Pixel 9' });
    expect(sessionAttention()[0].remote).toBe(true);
    for (const c of added()) {
      if (c.item.kind === 'approval') resolveApproval(c.item.id, { action: 'reject' }, 'R-rem');
      else resolveInquiry(c.item.id, 'x', 'R-rem');
    }
    await Promise.all([d, q]);
  });

  it('本机起、之后被远端 steer 染上的 run:询问也按远程算(与审批闸同一个 effectiveRemote)', async () => {
    await addRun('R-steer', 'S-steer', {});
    taintRunRemote('R-steer', { via: 'lan', marked: true });
    const q = requestInquiry('R-steer', { question: '?', options: [], allowFreeText: true });
    await waitAdded(1);
    expect(added()[0].item.remote).toEqual({ via: 'lan' });
    resolveInquiry(added()[0].item.id, 'x', 'R-steer');
    await q;
  });

  it('本机 run:remote = null', async () => {
    await addRun('R-local', 'S-local', {});
    const q = requestInquiry('R-local', { question: '?', options: [], allowFreeText: true });
    await waitAdded(1);
    expect(added()[0].item.remote).toBeNull();
    resolveInquiry(added()[0].item.id, 'x', 'R-local');
    await q;
  });
});

describe('sweepTerminal', () => {
  it('登记超过 30s 且 run 已终态 / 不存在 → expired;还在跑的不动;30s 内不重复查库', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await addRun('R-dead', 'S-dead', {}, 'failed');
      await addRun('R-live', 'S-live', {}, 'running');
      trackPrompt({ id: 'apv_dead', kind: 'approval', runId: 'R-dead' });
      trackPrompt({ id: 'apv_live', kind: 'approval', runId: 'R-live' });
      trackPrompt({ id: 'apv_gone', kind: 'approval', runId: 'R-no-row' });
      await waitAdded(3);
      await sweepTerminal(); // 都不满 30s:什么都不撤
      expect(removed()).toEqual([]);
      vi.setSystemTime(Date.now() + 31_000);
      await sweepTerminal();
      expect(removed().map((r) => r.id).sort()).toEqual(['apv_dead', 'apv_gone']);
      expect(removed().every((r) => r.outcome === 'expired')).toBe(true);
      expect(listPrompts().map((p) => p.id)).toEqual(['apv_live']);
      await query(`UPDATE agent_runs SET status = 'done' WHERE id = 'R-live'`);
      await sweepTerminal(); // 距上次不到 30s:节流,不查库
      expect(listPrompts().map((p) => p.id)).toEqual(['apv_live']);
      vi.setSystemTime(Date.now() + 31_000);
      await sweepTerminal();
      expect(listPrompts()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('S6 审批卡与待批索引不进模型上下文', () => {
  it('src/tools/** 没有任何文件 import pendingPromptIndex', () => {
    const root = join(__dirname, '..', 'tools');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(name) && /pendingPromptIndex/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(root);
    expect(readdirSync(root).length, '扫描根指错了:src/tools 下一个文件都没有').toBeGreaterThan(5);
    expect(hits).toEqual([]);
  });
});
