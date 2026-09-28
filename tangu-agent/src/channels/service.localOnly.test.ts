/**
 * 通道里回「批准」遇到受保护路径的审批(P1 · K3 §3.3 / U4,方案 §6.3):不兑现、保留待批、回双语说明;回「拒绝」照常取消。
 * 通道兑现带 by={via:'channel'}(另一端的卡据此写「经消息通道」)。团队成员的审批经团队 run 转发,payload.runId = 成员子 run:
 * 本机专属判定必须按**条目所属的 run** 查(按通道自己那条 run 查恒为 null → 批准就漏过去了)。
 * 负对照(实跑见红,记在 K3 交付报告):去掉 service.ts 批准分支里的 approvalLocalOnly 判断 → resolveApproval 收到 approve。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDriver } from './types.js';

const state = vi.hoisted(() => ({
  created: null as any,
  resolved: [] as any[],
  localOnly: new Map<string, string>(), // approvalId -> 所属 run
  nextEvent: null as any,
}));

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
vi.mock('../services/agentLoop.js', () => ({ abortRun: vi.fn(), enqueueRun: vi.fn() }));
vi.mock('../services/eventBus.js', () => ({
  subscribe: vi.fn((_runId: string, listener: (event: any) => void) => {
    const ev = state.nextEvent ?? { type: 'done', payload: { content: 'ok' } };
    state.nextEvent = null;
    queueMicrotask(() => listener(ev));
    return () => {};
  }),
}));
vi.mock('../services/approvals.js', () => ({
  resolveApproval: vi.fn((...a: any[]) => { state.resolved.push(a); return true; }),
  approvalLocalOnly: vi.fn((id: string, runId: string) => (state.localOnly.has(id) ? state.localOnly.get(id) === runId : null)),
}));
vi.mock('../agents/agentRegistry.js', () => ({ readAgentsMeta: () => ({ defaultSlug: 'xyra' }), listAgents: vi.fn(async () => []), getAgent: vi.fn(async () => null) }));
vi.mock('../services/replySegment.js', () => ({ resolveReplySegment: () => ({ enabled: false }), splitMessage: (t: string) => [t], segmentDelayMs: () => 0 }));
vi.mock('../services/voiceMessage.js', () => ({ resolveVoiceMessage: () => ({ enabled: false, wechat: false, model: '' }), synthesizeVoiceWav: vi.fn(), VOICE_MESSAGE_PLUGIN_ID: 'voice-message' }));
vi.mock('../plugins/settingsStore.js', () => ({ setPluginEnabled: vi.fn(), setScopeSettings: vi.fn() }));
vi.mock('./config.js', () => ({
  channelSettings: () => ({ enabled: true, sessions: true, agentSlug: '', modelId: 'model-1', imageModelId: '', ttsModelId: '', ttsVoice: '', approvalMode: 'auto-edit', inboxForward: { enabled: false, senders: 'all' } }),
  channelWorkspaceDir: (kind: string) => `/tmp/${kind}`,
}));

import { ChannelService } from './service.js';

function service(): ChannelService {
  const driver: ChannelDriver = { kind: 'wechat', start: async () => {}, stop: () => {}, status: () => [], send: async () => ({ ok: true }) };
  return new ChannelService({ kind: 'wechat', driver, unboundHint: 'unbound', inboxDirName: 'wechat-inbox', sessionTitle: 'wechat' });
}
const inbound = (s: ChannelService, text: string) => s.handleInbound({ accountId: 'account-1', peerId: 'peer-1', text, messageId: `m-${text}` });

beforeEach(() => {
  state.created = null;
  state.resolved = [];
  state.localOnly.clear();
  state.nextEvent = null;
});

describe('通道批准 × 受保护审批', () => {
  it('团队成员子 run 的受保护审批:回「批准」不兑现、保留待批、回双语说明;再回「拒绝」→ 按 channel 来源拒绝', async () => {
    const s = service();
    state.localOnly.set('apv_prot', 'child-run'); // 条目属于成员子 run,不是通道起的那条
    state.nextEvent = { type: 'approval_request', payload: { approvalId: 'apv_prot', preview: '⚠ 受保护的配置 · write config.json', runId: 'child-run' } };
    const first = await inbound(s, '改一下配置');
    expect(first).toContain('需要你批准');
    const approve = await inbound(s, '批准');
    expect(approve).toContain('只能在电脑上批准');
    expect(approve).toContain('can only be approved on the computer');
    expect(state.resolved).toEqual([]);
    await inbound(s, '拒绝');
    expect(state.resolved).toEqual([['apv_prot', { action: 'reject' }, undefined, { via: 'channel' }]]);
  });

  it('普通审批:回「批准」照常兑现,by={via:channel}', async () => {
    const s = service();
    state.nextEvent = { type: 'approval_request', payload: { approvalId: 'apv_plain', preview: '$ npm test' } };
    await inbound(s, '跑测试');
    await inbound(s, 'ok');
    expect(state.resolved).toEqual([['apv_plain', { action: 'approve' }, undefined, { via: 'channel' }]]);
  });
});
