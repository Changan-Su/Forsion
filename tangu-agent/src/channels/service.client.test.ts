/**
 * Desktop 托管通道的「端×版本」归因回归。
 *
 * 渲染层直接发起的 run 会在 POST /agent/runs 里自报 client;微信/Telegram/QQ 消息
 * 由引擎后台创建 run,所以必须从 Desktop spawn 的 TANGU_HOST_CLIENT 继承。此测试
 * 直接跑通通道入站管线,防止将来重构 createRun 入参时又静默丢掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDriver, ChannelKind } from './types.js';

const state = vi.hoisted(() => ({
  created: null as any,
  enqueued: null as { sessionId: string; runId: string } | null,
}));

vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM tangu_wechat_bindings')) {
      return [{
        id: 'binding-1', user_id: 'user-1', channel: 'wechat', account_id: 'account-1',
        peer_id: 'peer-1', session_id: 'session-1', remote_approval_mode: 'auto-edit',
      }];
    }
    if (sql.includes('SELECT model_id, agent_config, project_path FROM chat_sessions')) {
      return [{ model_id: 'model-1', agent_config: '{}', project_path: '/tmp/channel-workspace' }];
    }
    throw new Error(`unexpected query in channel client test: ${sql}`);
  }),
}));

vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ profile: { appId: 'tangu', defaultModelId: 'model-1' } }),
}));

vi.mock('../services/runStore.js', () => ({
  createRun: vi.fn(async (run: any) => { state.created = run; }),
}));

vi.mock('../services/agentLoop.js', () => ({
  abortRun: vi.fn(),
  enqueueRun: vi.fn((sessionId: string, runId: string) => { state.enqueued = { sessionId, runId }; }),
}));

vi.mock('../services/eventBus.js', () => ({
  subscribe: vi.fn((_runId: string, listener: (event: any) => void) => {
    queueMicrotask(() => listener({ type: 'done', payload: { content: 'ok' } }));
    return () => {};
  }),
}));

vi.mock('../services/approvals.js', () => ({ resolveApproval: vi.fn(() => true) }));
vi.mock('../agents/agentRegistry.js', () => ({
  readAgentsMeta: () => ({ defaultSlug: 'xyra' }),
  listAgents: vi.fn(async () => []),
  getAgent: vi.fn(async () => null),
}));
vi.mock('../services/replySegment.js', () => ({
  resolveReplySegment: () => ({ enabled: false }),
  splitMessage: (text: string) => [text],
  segmentDelayMs: () => 0,
}));
vi.mock('../services/voiceMessage.js', () => ({
  resolveVoiceMessage: () => ({ enabled: false, wechat: false, model: '' }),
  synthesizeVoiceWav: vi.fn(),
  VOICE_MESSAGE_PLUGIN_ID: 'voice-message',
}));
vi.mock('../plugins/settingsStore.js', () => ({
  setPluginEnabled: vi.fn(),
  setScopeSettings: vi.fn(),
}));
vi.mock('./config.js', () => ({
  channelSettings: () => ({
    enabled: true, sessions: true, agentSlug: '', modelId: 'model-1', imageModelId: '',
    ttsModelId: '', ttsVoice: '', approvalMode: 'auto-edit',
    inboxForward: { enabled: false, senders: 'all' },
  }),
  channelWorkspaceDir: (kind: string) => `/tmp/${kind}`,
}));

import { ChannelService, normalizeChannelHostClientTag } from './service.js';

function service(kind: ChannelKind): ChannelService {
  const driver: ChannelDriver = {
    kind,
    start: async () => {},
    stop: () => {},
    status: () => [],
    send: async () => ({ ok: true }),
  };
  return new ChannelService({
    kind,
    driver,
    unboundHint: 'unbound',
    inboxDirName: `${kind}-inbox`,
    sessionTitle: kind,
  });
}

beforeEach(() => {
  state.created = null;
  state.enqueued = null;
  process.env.TANGU_HOST_CLIENT = 'desktop/2.9.9';
});

afterEach(() => {
  delete process.env.TANGU_HOST_CLIENT;
});

describe.each<ChannelKind>(['wechat', 'telegram', 'qq'])('%s channel client attribution', (kind) => {
  it('inherits the managed Desktop host tag while preserving the actual source channel', async () => {
    await expect(service(kind).handleInbound({
      accountId: 'account-1', peerId: 'peer-1', text: 'hello', messageId: 'message-1',
    })).resolves.toBe('ok');

    expect(state.created?.input).toMatchObject({
      client: 'desktop/2.9.9',
      source: { channel: kind, accountId: 'account-1', openid: 'peer-1', messageId: 'message-1' },
    });
    expect(state.enqueued).toEqual({ sessionId: 'session-1', runId: state.created.id });
  });
});

describe('normalizeChannelHostClientTag', () => {
  it('uses the same closed platform/version shape as public run attribution', () => {
    expect(normalizeChannelHostClientTag('desktop/2.9.9')).toBe('desktop/2.9.9');
    expect(normalizeChannelHostClientTag('web/2.9.9')).toBe('web/2.9.9');
    expect(normalizeChannelHostClientTag('wechat/2.9.9')).toBeUndefined();
    expect(normalizeChannelHostClientTag('desktop/2.9.9/extra')).toBeUndefined();
    expect(normalizeChannelHostClientTag('desktop/' + 'x'.repeat(33))).toBeUndefined();
  });
});
