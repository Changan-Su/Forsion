/**
 * P1 · K2 §3.4:锁定时通道入口现查(方案 §6.5「引擎拒绝通道起 run」)。通道 run 没有远程污点(只有 input.source.channel),
 * 不经 unitWeb —— 锁定判定必须在通道自己的入口做:
 *   「停止」照常(只会中止);「批准 / 拒绝」不兑现、新任务不 createRun、slash 不执行,一律回双语锁定提示;读锁抛异常按锁定。
 * 负对照:改前(service.ts 无现查)「批准」照样 resolveApproval、新消息照样 createRun → 红(实跑记在 K2 交付报告)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDriver } from './types.js';

const state = vi.hoisted(() => ({
  created: null as any,
  resolved: [] as any[],
  localOnly: new Map<string, string>(), // approvalId -> 所属 run('*' = 任意 run)
  /** 每次 subscribe 从队头取一条事件,微任务里**广播给该 run 的全部订阅者**(挂着没撤的等待也会收到 → 能测出「送两遍」)。 */
  script: [] as any[],
  listeners: new Map<string, Set<(event: any) => void>>(),
  sent: [] as string[],
  locked: false,
  lockThrows: false,
  aborted: [] as any[],
}));
const emit = (runId: string, ev: any): void => { for (const l of [...(state.listeners.get(runId) ?? [])]) l(ev); };
const subscribers = (runId: string): number => state.listeners.get(runId)?.size ?? 0;

vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM tangu_wechat_bindings')) {
      return [{ id: 'binding-1', user_id: 'user-1', channel: 'wechat', account_id: 'account-1', peer_id: 'peer-1', session_id: 'session-1', remote_approval_mode: 'auto-edit' }];
    }
    if (sql.includes('SELECT model_id, agent_config, project_path FROM chat_sessions')) return [{ model_id: 'model-1', agent_config: '{}', project_path: '/tmp/channel-workspace' }];
    return [];
  }),
}));
vi.mock('../seams/runtime.js', () => ({ deps: () => ({ profile: { appId: 'tangu', defaultModelId: 'model-1' } }) }));
vi.mock('../services/runStore.js', () => ({ createRun: vi.fn(async (run: any) => { state.created = run; }) }));
vi.mock('../services/agentLoop.js', () => ({ abortRun: vi.fn((...a: any[]) => { state.aborted.push(a); }), enqueueRun: vi.fn() }));
vi.mock('../services/remoteLock.js', () => ({
  remoteLocked: () => { if (state.lockThrows) throw new Error('boom'); return state.locked; },
}));
vi.mock('../services/eventBus.js', () => ({
  subscribe: vi.fn((runId: string, listener: (event: any) => void) => {
    let set = state.listeners.get(runId);
    if (!set) state.listeners.set(runId, (set = new Set()));
    set.add(listener);
    const ev = state.script.shift();
    if (ev) queueMicrotask(() => { for (const l of [...(state.listeners.get(runId) ?? [])]) l(ev); });
    return () => { set!.delete(listener); };
  }),
}));
vi.mock('../services/approvals.js', () => ({
  resolveApproval: vi.fn((...a: any[]) => { state.resolved.push(a); return true; }),
  approvalLocalOnly: vi.fn((id: string, runId: string) => (state.localOnly.has(id) ? ['*', runId].includes(state.localOnly.get(id)!) : null)),
}));
vi.mock('../agents/agentRegistry.js', () => ({ readAgentsMeta: () => ({ defaultSlug: 'xyra' }), listAgents: vi.fn(async () => []), getAgent: vi.fn(async () => null) }));
vi.mock('../services/replySegment.js', () => ({ resolveReplySegment: () => ({ enabled: false }), splitMessage: (t: string) => [t], segmentDelayMs: () => 0 }));
vi.mock('../services/voiceMessage.js', () => ({ resolveVoiceMessage: () => ({ enabled: false, wechat: false, model: '' }), synthesizeVoiceWav: vi.fn(), VOICE_MESSAGE_PLUGIN_ID: 'voice-message' }));
vi.mock('../plugins/settingsStore.js', () => ({ setPluginEnabled: vi.fn(), setScopeSettings: vi.fn() }));
vi.mock('./config.js', () => ({
  channelSettings: () => ({ enabled: true, sessions: true, agentSlug: '', modelId: 'model-1', imageModelId: '', ttsModelId: '', ttsVoice: '', approvalMode: 'auto-edit', inboxForward: { enabled: false, senders: 'all' } }),
  channelWorkspaceDir: (kind: string) => `/tmp/${kind}`,
}));

import { ChannelService, REMOTE_LOCKED_CHANNEL_REPLY } from './service.js';

function service(): ChannelService {
  const driver: ChannelDriver = { kind: 'wechat', start: async () => {}, stop: () => {}, status: () => [], send: async (_a: string, _p: string, text: string) => { state.sent.push(text); return { ok: true }; } };
  return new ChannelService({ kind: 'wechat', driver, unboundHint: 'unbound', inboxDirName: 'wechat-inbox', sessionTitle: 'wechat' });
}
const inbound = (s: ChannelService, text: string) => s.handleInbound({ accountId: 'account-1', peerId: 'peer-1', text, messageId: `m-${text}` });

beforeEach(() => {
  state.created = null;
  state.resolved = [];
  state.localOnly.clear();
  state.script = [];
  state.listeners.clear();
  state.sent = [];
  state.locked = false;
  state.lockThrows = false;
  state.aborted = [];
});

describe('通道入口 × 远程锁定', () => {
  it('锁定时新任务不 createRun,回双语锁定提示', async () => {
    state.locked = true;
    const r = await inbound(service(), '帮我整理一下下载文件夹');
    expect(r).toBe(REMOTE_LOCKED_CHANNEL_REPLY);
    expect(r).toContain('锁定');
    expect(r).toContain('locked');
    expect(state.created).toBeNull();
  });

  it('锁定时「批准」不兑现挂着的审批、「拒绝」也不兑现;解锁后照常', async () => {
    const s = service();
    state.script = [{ type: 'approval_request', payload: { approvalId: 'apv1', preview: 'run_bash rm -rf build' } }];
    expect(await inbound(s, '清理构建目录')).toContain('需要你批准');
    state.locked = true;
    expect(await inbound(s, '批准')).toBe(REMOTE_LOCKED_CHANNEL_REPLY);
    expect(await inbound(s, '拒绝')).toBe(REMOTE_LOCKED_CHANNEL_REPLY);
    expect(state.resolved).toEqual([]);
    state.locked = false;
    state.script = [{ type: 'done', payload: { content: '好了' } }];
    expect(await inbound(s, '批准')).toBe('好了');
    expect(state.resolved).toEqual([['apv1', { action: 'approve' }, undefined, { via: 'channel' }]]);
  });

  it('锁定时「停止」照常中止(只会收紧)', async () => {
    const s = service();
    state.script = [{ type: 'approval_request', payload: { approvalId: 'apv2', preview: 'run_bash make' } }];
    await inbound(s, '跑一下构建');
    const runId = state.created.id;
    state.locked = true;
    expect(await inbound(s, '停止')).toContain('已停止');
    expect(state.aborted).toEqual([[runId]]);
  });

  it('锁定时 slash 命令也不执行', async () => {
    state.locked = true;
    expect(await inbound(service(), '/new')).toBe(REMOTE_LOCKED_CHANNEL_REPLY);
  });

  it('读锁抛异常 → 按锁定', async () => {
    state.lockThrows = true;
    expect(await inbound(service(), '你好')).toBe(REMOTE_LOCKED_CHANNEL_REPLY);
    expect(state.created).toBeNull();
  });
});
