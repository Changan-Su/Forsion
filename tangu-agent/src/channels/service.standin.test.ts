/**
 * 分身(11-09)在通道层的那半:通道 run 带上 multiPeer、会话里存的身份和这次的不一样又已经聊过 → 开新的会话历史、绑定改指它。
 * 和 service.multipeer.test.ts 一样跑真 SQL(内存 SQLite);身份解析用真的 agents/standIn.ts,注册表换成内存表。
 * 负对照(11-09 实跑):去掉 dispatchInbound 里的 standInSession 那一步、source 不带 multiPeer → 5 条红 4 条(「接着用」那条本来就该绿)。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ChannelDriver, ChannelInbound } from './types.js';

const state = vi.hoisted(() => {
  const listeners = new Map<string, Set<(ev: any) => void>>();
  return {
    listeners,
    emit(runId: string, type: string, payload: any = {}): void {
      for (const l of [...(listeners.get(runId) ?? [])]) l({ seq: 0, type, payload });
    },
    db: null as any,
    ws: '',
    settings: {} as Record<string, any>,
    runs: [] as any[],
    aborted: [] as string[],
    beforeBindingInsert: null as null | (() => Promise<unknown>),
    approvals: [] as Array<[string, any, any]>,
    resolveOk: true,
    locked: false,
    localOnly: new Set<string>(),
    msgCounts: {} as Record<string, number>,
    agents: {} as Record<string, any>,
  };
});

vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string, params: any[] = []) => {
    if (state.beforeBindingInsert && sql.includes('INSERT INTO tangu_wechat_bindings')) {
      const hook = state.beforeBindingInsert;
      state.beforeBindingInsert = null;
      await hook();
    }
    const stmt = state.db.prepare(sql);
    if (stmt.reader) return stmt.all(...params);
    stmt.run(...params);
    return [];
  }),
}));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({
    profile: { appId: 'tangu', defaultModelId: 'model-1', capabilities: { hostExec: true } },
    state: {
      autoCreateSession: async (s: any) => { state.db.prepare('INSERT INTO chat_sessions (id, user_id, title, model_id) VALUES (?, ?, ?, ?)').run(s.id, s.userId, s.title, s.modelId); },
      getAgentConfig: async (id: string) => state.db.prepare('SELECT agent_config FROM chat_sessions WHERE id = ?').get(id)?.agent_config ?? null,
      setAgentConfig: async (id: string, json: string) => { state.db.prepare('UPDATE chat_sessions SET agent_config = ? WHERE id = ?').run(json, id); },
      countSessionMessages: async (id: string) => state.msgCounts[id] ?? 0,
    },
  }),
}));
vi.mock('../services/runStore.js', () => ({ createRun: vi.fn(async (run: any) => { state.runs.push(run); }) }));
vi.mock('../services/agentLoop.js', () => ({
  abortRun: vi.fn((runId: string) => { state.aborted.push(runId); }),
  enqueueRun: vi.fn(),
  sessionHasActiveRun: vi.fn(() => false),
}));
vi.mock('../services/eventBus.js', () => ({
  subscribe: vi.fn((runId: string, l: (ev: any) => void) => {
    let set = state.listeners.get(runId);
    if (!set) state.listeners.set(runId, (set = new Set()));
    set.add(l);
    return () => { set!.delete(l); };
  }),
}));
vi.mock('../services/approvals.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/approvals.js')>()),
  resolveApproval: vi.fn((id: string, d: any, _run: any, by: any) => { state.approvals.push([id, d, by]); return state.resolveOk; }),
  approvalLocalOnly: vi.fn((id: string) => state.localOnly.has(id)),
}));
vi.mock('../services/remoteLock.js', () => ({ remoteLocked: () => state.locked }));
vi.mock('../services/inquiries.js', () => ({ resolveInquiry: vi.fn(() => true) }));
vi.mock('../services/modelCatalog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/modelCatalog.js')>()),
  listModelCatalog: vi.fn(async () => ({ models: [] })),
}));
vi.mock('../agents/agentRegistry.js', () => ({
  readAgentsMeta: () => ({ defaultSlug: 'xyra' }),
  listAgents: vi.fn(async () => []),
  getAgent: vi.fn(async (slug: string) => state.agents[slug] ?? null),
  agentCapOf: () => null,
  isValidSlug: (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s),
  saveAgent: vi.fn(),
  AgentExistsError: class extends Error {},
}));
vi.mock('../services/replySegment.js', () => ({ resolveReplySegment: () => ({ enabled: false }), splitMessage: (t: string) => [t], segmentDelayMs: () => 0 }));
vi.mock('../services/voiceMessage.js', () => ({ resolveVoiceMessage: () => ({ enabled: false, wechat: false, model: '' }), synthesizeVoiceWav: vi.fn(), VOICE_MESSAGE_PLUGIN_ID: 'voice-message' }));
vi.mock('../plugins/settingsStore.js', () => ({ setPluginEnabled: vi.fn(), setScopeSettings: vi.fn() }));
vi.mock('./config.js', () => ({
  channelSettings: () => state.settings,
  saveChannelSettings: vi.fn(),
  channelWorkspaceDir: (kind: string) => path.join(state.ws, kind),
}));

import { ChannelService } from './service.js';
import { standInPeerKey } from '../agents/standIn.js';

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const bindingOf = (peer: string): any => state.db.prepare('SELECT * FROM tangu_wechat_bindings WHERE peer_id = ? AND is_active = 1').get(peer);
const cfgOf = (id: string): any => JSON.parse(state.db.prepare('SELECT agent_config FROM chat_sessions WHERE id = ?').get(id).agent_config);
const setCfg = (id: string, patch: any): void => { state.db.prepare('UPDATE chat_sessions SET agent_config = ? WHERE id = ?').run(JSON.stringify({ ...cfgOf(id), ...patch }), id); };

function harness() {
  const driver: ChannelDriver = { kind: 'chat', start: async () => {}, stop: () => {}, status: () => [], send: async () => ({ ok: true }) };
  const svc = new ChannelService({ kind: 'chat', driver, inboxDirName: 'chat-inbox', sessionTitle: 'Chat', unboundHint: 'unbound', multiPeer: true });
  const say = async (peerId: string, text: string, extra: Partial<ChannelInbound> = {}): Promise<void> => {
    const runs = state.runs.length;
    let done = false;
    void svc.handleInbound({ accountId: 'acc', peerId, text, ...extra }).finally(() => { done = true; });
    const deadline = Date.now() + 1500;
    while (!done && state.runs.length === runs && Date.now() < deadline) await new Promise((r) => setImmediate(r));
    await flush();
  };
  return { svc, say };
}
const lastRun = (): any => state.runs[state.runs.length - 1];

beforeEach(() => {
  state.ws = mkdtempSync(path.join(tmpdir(), 'channel-standin-'));
  state.db = new Database(':memory:');
  state.db.exec(`
    CREATE TABLE tangu_wechat_bindings (id TEXT PRIMARY KEY, user_id TEXT, channel TEXT, account_id TEXT, peer_id TEXT, session_id TEXT, remote_approval_mode TEXT, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE tangu_wechat_accounts (id TEXT PRIMARY KEY, user_id TEXT, wx_user_id TEXT, channel TEXT, status TEXT, created_at TIMESTAMP, updated_at TIMESTAMP);
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, model_id TEXT, agent_config TEXT, project_path TEXT, projectless BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  `);
  state.settings = { enabled: true, sessions: true, agentSlug: 'aria', modelId: 'model-1', imageModelId: '', ttsModelId: '', ttsVoice: '', approvalMode: 'auto-edit', inboxForward: { enabled: false, senders: 'all' } };
  state.runs = [];
  state.msgCounts = {};
  state.agents = { aria: { slug: 'aria', name: 'Aria' } };
  state.listeners.clear();
});
afterEach(() => {
  state.db.close();
  rmSync(state.ws, { recursive: true, force: true });
});

const standInOf = (peer: string): string => `aria-standin-chat-${standInPeerKey('acc', peer)}`;

describe('分身:通道层', () => {
  it('通道 run 的来源带 multiPeer;通道里存的仍是本体 slug(由引擎在建 run 时换成分身)', async () => {
    const { svc, say } = harness();
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    expect(lastRun().input.source).toMatchObject({ channel: 'chat', accountId: 'acc', openid: 'p1', multiPeer: true });
    expect(lastRun().input.agentConfig.agentSlug).toBe('aria');
  });

  it('会话里存的是本体、已经聊过,这次是分身 → 开新的会话历史、绑定改指它;旧会话原样留着', async () => {
    const { svc, say } = harness();
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'first');
    const old = bindingOf('p1').session_id;
    state.msgCounts[old] = 4; // 本体在这段会话里聊过(分身上线前的老会话)
    await say('p1', 'second');
    const now = bindingOf('p1').session_id;
    expect(now).not.toBe(old);
    expect(lastRun().sessionId).toBe(now);
    expect(cfgOf(now).cwd).toBe(cfgOf(old).cwd); // 同一个联系人的目录
    expect(cfgOf(old).agentSlug).toBe('aria');
  });

  it('会话已经归这位联系人的分身 → 接着用;空会话也接着用(身份由引擎写穿)', async () => {
    const { svc, say } = harness();
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'first');
    const sid = bindingOf('p1').session_id;
    state.agents[standInOf('p1')] = { slug: standInOf('p1'), standInOf: 'aria', standInChannel: 'chat' };
    setCfg(sid, { agentSlug: standInOf('p1') });
    state.msgCounts[sid] = 6;
    await say('p1', 'again');
    expect(bindingOf('p1').session_id).toBe(sid);
    expect(lastRun().sessionId).toBe(sid);
  });

  it('用户把这组通道关回本体:会话里存的是分身、聊过 → 也开新的(本体不接着读别人说的话)', async () => {
    const { svc, say } = harness();
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'first');
    const sid = bindingOf('p1').session_id;
    state.agents[standInOf('p1')] = { slug: standInOf('p1'), standInOf: 'aria', standInChannel: 'chat' };
    setCfg(sid, { agentSlug: standInOf('p1') });
    state.msgCounts[sid] = 6;
    state.agents.aria = { slug: 'aria', name: 'Aria', standInOff: ['plugin'] };
    await say('p1', 'again');
    expect(bindingOf('p1').session_id).not.toBe(sid);
  });

  it('驱动给联系人 A 钉了联系人 B 的分身:先剥回本体,落到 A 自己的分身(会话里存着 B 的、聊过 → 开新的)', async () => {
    const { svc, say } = harness();
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('pa', 'first');
    const sid = bindingOf('pa').session_id;
    state.agents[standInOf('pb')] = { slug: standInOf('pb'), standInOf: 'aria', standInChannel: 'chat' };
    setCfg(sid, { agentSlug: standInOf('pb') });
    state.msgCounts[sid] = 2;
    await say('pa', 'again', { agentSlug: standInOf('pb') });
    expect(bindingOf('pa').session_id).not.toBe(sid);
  });
});

// approvalModeFor:/approval /status 报的档,与 agentLoop 收紧同一口径(通道设置 × 绑定 × 这次会用的 Agent;分身再加本体)
describe('approvalModeFor', () => {
  const modeFor = (svc: ChannelService, peer: string | null, slug: string): Promise<string> =>
    (svc as any).approvalModeFor({ id: 'b', user_id: 'u1', channel: 'chat', account_id: 'acc', peer_id: peer, session_id: 's', remote_approval_mode: 'full-auto' }, slug);

  it('Agent 没设档 → 只看通道 × 绑定', async () => {
    const { svc } = harness();
    state.settings.approvalMode = 'full-auto';
    state.agents.aria = { slug: 'aria', name: 'Aria', approvalMode: '', standInOff: ['im', 'plugin'] };
    expect(await modeFor(svc, 'p1', 'aria')).toBe('full-auto');
  });

  it('Agent 自己设了只读 / custom → 只读;设得更松 → 仍按通道', async () => {
    const { svc } = harness();
    state.settings.approvalMode = 'full-auto';
    state.agents.aria = { slug: 'aria', name: 'Aria', approvalMode: 'readonly', standInOff: ['im', 'plugin'] };
    expect(await modeFor(svc, 'p1', 'aria')).toBe('readonly');
    state.agents.aria.approvalMode = 'custom';
    expect(await modeFor(svc, 'p1', 'aria')).toBe('readonly');
    state.settings.approvalMode = 'auto-edit';
    state.agents.aria.approvalMode = 'full-auto';
    expect(await modeFor(svc, 'p1', 'aria')).toBe('auto-edit');
  });

  it('分身(还没建出来):按本体的档;本体没设 → 通道档', async () => {
    const { svc } = harness();
    state.settings.approvalMode = 'full-auto';
    state.agents.aria = { slug: 'aria', name: 'Aria', approvalMode: 'readonly' };
    expect(await modeFor(svc, 'p1', 'aria')).toBe('readonly');
    state.agents.aria.approvalMode = '';
    expect(await modeFor(svc, 'p1', 'aria')).toBe('full-auto');
  });

  it('分身已建、自己没设档:仍按本体的档', async () => {
    const { svc } = harness();
    state.settings.approvalMode = 'full-auto';
    state.agents.aria = { slug: 'aria', name: 'Aria', approvalMode: 'auto-edit' };
    state.agents[standInOf('p1')] = { slug: standInOf('p1'), standInOf: 'aria', standInChannel: 'chat', approvalMode: '' };
    expect(await modeFor(svc, 'p1', 'aria')).toBe('auto-edit');
  });
});
