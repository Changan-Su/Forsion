/** P1 · K2 §3.2:在飞 run 登记表 —— 分类只认引擎自己写的字段、中途染色即按远程列、待批计数来自 K3 索引、快照 seq 单调 + 去抖。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runCategory, registerRun, unregisterRun, activitySnapshot, onActivityChange, notifyActivity, __resetActivityForTests,
} from './remoteActivity.js';
import { taintRunRemote, clearRunRemoteTaint, sanitizeRemoteAgentConfig } from './remoteOrigin.js';
import { trackPrompt, untrackPrompt, onPromptChange } from './pendingPromptIndex.js';

// ⚠️ 不调 __resetPromptIndexForTests:它会清掉索引的全部订阅者(含本模块在装载时挂的那一个),之后待批进出就不再通知活动面。
beforeEach(() => {
  __resetActivityForTests();
});
afterEach(() => {
  vi.useRealTimers();
  __resetActivityForTests();
});

const REMOTE = { remote: { via: 'tunnel', marked: true, callerUnit: '0f5b2c1e-8a3d-4c6b-9e7f-1a2b3c4d5e6f', callerKind: 'phone', callerName: 'Pixel‮ evil' } };

describe('runCategory', () => {
  it('四类:remote / channel / unattended(muse、automation)/ local', () => {
    expect(runCategory(REMOTE)).toBe('remote');
    expect(runCategory({ source: { channel: 'wechat' } })).toBe('channel');
    expect(runCategory({ background: 'muse' })).toBe('unattended');
    expect(runCategory({ agentConfig: { automationOrigin: 't1' } })).toBe('unattended');
    expect(runCategory({ message: 'hi' })).toBe('local');
    expect(runCategory(null)).toBe('local');
    expect(runCategory('garbage')).toBe('local');
  });

  it('远程压过其它标记(远程 run 伪造不出 channel / unattended 豁免)', () => {
    expect(runCategory({ ...REMOTE, source: { channel: 'wechat' }, background: 'muse' })).toBe('remote');
    // 远端写进 agent_config 的 automationOrigin 在路由里就被剥了(S9);就算没剥,remote 也先判
    const cfg = sanitizeRemoteAgentConfig({ automationOrigin: 't1', agentSlug: 'x' });
    expect(cfg.automationOrigin).toBeUndefined();
    expect(runCategory({ ...REMOTE, agentConfig: cfg })).toBe('remote');
  });

  it('本机起、被远端 steer 染色 → 按 runId 判为 remote;清色后回 local', () => {
    expect(runCategory({}, 'R-taint')).toBe('local');
    taintRunRemote('R-taint', { via: 'p2p', marked: false });
    expect(runCategory({}, 'R-taint')).toBe('remote');
    clearRunRemoteTaint('R-taint');
    expect(runCategory({}, 'R-taint')).toBe('local');
  });
});

describe('activitySnapshot', () => {
  it('登记 → 快照列出(含调用方;名字的双向覆写已被 remoteOf 剥掉);注销 → 消失', () => {
    registerRun('R1', 'S1', REMOTE);
    registerRun('R2', 'S2', { source: { channel: 'telegram' } });
    registerRun('R3', 'S3', { background: 'muse' });
    registerRun('R4', 'S4', { agentConfig: { automationOrigin: 'x', agentSlug: 'helper' } });
    registerRun('R5', 'S5', {});
    const snap = activitySnapshot();
    expect(snap.v).toBe(1);
    expect(snap.runs.map((r) => [r.runId, r.category])).toEqual([['R1', 'remote'], ['R2', 'channel'], ['R3', 'unattended'], ['R4', 'unattended'], ['R5', 'local']]);
    expect(snap.runs[0].remote).toEqual({ via: 'tunnel', marked: true, callerUnit: '0f5b2c1e-8a3d-4c6b-9e7f-1a2b3c4d5e6f', callerKind: 'phone', callerName: 'Pixel evil' });
    expect(snap.runs[1].channel).toBe('telegram');
    expect(snap.runs[2].unattended).toBe('muse');
    expect(snap.runs[3]).toMatchObject({ unattended: 'automation', agentSlug: 'helper' });
    unregisterRun('R1');
    expect(activitySnapshot().runs.map((r) => r.runId)).not.toContain('R1');
  });

  it('中途染色的本机 run → 快照里 remote + taintedMidRun', () => {
    registerRun('R-mid', 'S', {});
    taintRunRemote('R-mid', { via: 'lan', marked: true });
    const r = activitySnapshot().runs.find((x) => x.runId === 'R-mid')!;
    expect(r).toMatchObject({ category: 'remote', taintedMidRun: true, remote: { via: 'lan', marked: true } });
    clearRunRemoteTaint('R-mid');
  });

  it('待批计数按 runId 取自 K3 索引(审批 + 计划算 approvals,询问单算)', async () => {
    registerRun('RA', 'SA', REMOTE);
    const added = new Promise<void>((res) => { let n = 0; const off = onPromptChange((c) => { if (c.type === 'added' && ++n === 3) { off(); res(); } }); });
    trackPrompt({ id: 'a1', kind: 'approval', runId: 'RA', tool: 'run_bash' });
    trackPrompt({ id: 'p1', kind: 'plan', runId: 'RA' });
    trackPrompt({ id: 'i1', kind: 'inquiry', runId: 'RA' });
    await added;
    expect(activitySnapshot().runs[0]).toMatchObject({ pendingApprovals: 2, pendingInquiries: 1 });
    untrackPrompt('a1', 'approved');
    expect(activitySnapshot().runs[0]).toMatchObject({ pendingApprovals: 1, pendingInquiries: 1 });
    untrackPrompt('p1', 'approved');
    untrackPrompt('i1', 'answered');
  });

  it('待批进出会通知活动订阅者(托盘「等待批准」及时刷新)', async () => {
    registerRun('RB', 'SB', REMOTE);
    await new Promise((r) => setTimeout(r, 250)); // 吃掉 registerRun 那一次
    let n = 0;
    onActivityChange(() => { n++; });
    const added = new Promise<void>((res) => { const off = onPromptChange((c) => { if (c.type === 'added') { off(); res(); } }); });
    trackPrompt({ id: 'b1', kind: 'approval', runId: 'RB', tool: 'run_bash' });
    await added;
    await new Promise((r) => setTimeout(r, 250));
    expect(n).toBe(1);
    untrackPrompt('b1', 'rejected');
    await new Promise((r) => setTimeout(r, 250));
    expect(n).toBe(2);
  });

  it('变更去抖 200ms、seq 单调;待批进出也会通知', async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    onActivityChange(() => seen.push(activitySnapshot().seq));
    const s0 = activitySnapshot().seq;
    registerRun('RX', 'S', REMOTE);
    registerRun('RY', 'S', REMOTE);
    notifyActivity();
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(seen).toEqual([s0 + 1]); // 三次变更合成一次
    unregisterRun('RX');
    await vi.advanceTimersByTimeAsync(200);
    expect(seen).toEqual([s0 + 1, s0 + 2]);
  });

  it('快照带锁状态(env 没设 = 未锁)与 bootId', () => {
    const snap = activitySnapshot();
    expect(snap.lock).toEqual({ locked: false, source: null });
    expect(snap.bootId).toMatch(/^[0-9a-f]{8}$/);
  });
});
