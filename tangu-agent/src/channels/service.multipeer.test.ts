/**
 * 多 peer 通道(PluginChannelSpec.multiPeer)与结构化审批卡(driver.sendApproval)。
 *
 * service.flow.test.ts 的 query 是一行固定绑定的替身,隔离问题在那上面红不起来;这里跑真 SQL(内存 SQLite),
 * 绑定 / 会话都是真行。两组都带「默认关」的对照:没开这些字段的通道行为不变。
 *
 * 负对照(实跑见红,逐条改 service.ts 跑本文件):新 peer 复用已有会话;删 findBinding 的 multiPeer 分支;默认强开;
 * 文字批到结构化卡;新消息作废结构化卡;peer 能跑斜杠命令;收件箱发给最后说话的 peer;重复连接断开别的 peer;
 * respond 去掉送达闸;respond 去掉本机闸;目录哈希不带账号;peer 键改回拼接;账号前缀改回拼接;两处 projectless 去掉;
 * 去掉 INSERT 后的锚点复查 —— 都红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ChannelApprovalCard, ChannelDriver, ChannelInbound } from './types.js';
import { resolveProjectMemory } from '../services/projectMemory.js';

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
  getAgent: vi.fn(async () => null),
  agentCapOf: () => null,
  isValidSlug: (s: string) => /^[a-z0-9][a-z0-9-]*$/.test(s),
}));
vi.mock('../services/replySegment.js', () => ({ resolveReplySegment: () => ({ enabled: false }), splitMessage: (t: string) => [t], segmentDelayMs: () => 0 }));
vi.mock('../services/voiceMessage.js', () => ({ resolveVoiceMessage: () => ({ enabled: false, wechat: false, model: '' }), synthesizeVoiceWav: vi.fn(), VOICE_MESSAGE_PLUGIN_ID: 'voice-message' }));
vi.mock('../plugins/settingsStore.js', () => ({ setPluginEnabled: vi.fn(), setScopeSettings: vi.fn() }));
vi.mock('./config.js', () => ({
  channelSettings: () => state.settings,
  saveChannelSettings: vi.fn(),
  channelWorkspaceDir: (kind: string) => path.join(state.ws, kind),
}));

import { APPROVAL_CHANNEL_STOPPED_REASON, APPROVAL_DELIVERY_FAILED_REASON, APPROVAL_TIMEOUT_REASON, CHANNEL_APPROVAL_TIMEOUT_MS, ChannelService } from './service.js';

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const bindings = (): any[] => state.db.prepare('SELECT * FROM tangu_wechat_bindings ORDER BY created_at, rowid').all();
const session = (id: string): any => state.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
const cfgOf = (id: string): any => JSON.parse(session(id).agent_config);

interface Offered { accountId: string; peerId: string; card: ChannelApprovalCard; respond: (a: 'approve' | 'reject') => boolean; settle: (r: { ok: boolean; error?: string }) => void; }

function harness(opts: { multiPeer?: boolean; approvals?: boolean; settle?: boolean } = {}) {
  const sent: Array<[string, string]> = [];
  const offered: Offered[] = [];
  const settled: Array<[string, string, string]> = [];
  const driver: ChannelDriver = {
    kind: 'org',
    start: async () => {},
    stop: () => {},
    status: () => [],
    send: async (_a, peerId, text) => { sent.push([peerId, text]); return { ok: true }; },
    ...(opts.approvals ? {
      sendApproval: (accountId: string, peerId: string, card: ChannelApprovalCard, respond: Offered['respond']) =>
        new Promise<{ ok: boolean; error?: string }>((settle) => { offered.push({ accountId, peerId, card, respond, settle }); }),
    } : {}),
    ...(opts.settle ? { settleApproval: (_a: string, peerId: string, approvalId: string, outcome: string) => { settled.push([peerId, approvalId, outcome]); } } : {}),
  };
  const svc = new ChannelService({ kind: 'org', driver, inboxDirName: 'org-inbox', sessionTitle: 'Org', unboundHint: 'unbound', multiPeer: opts.multiPeer });
  // 起了 run 的那条要等 run 结束才回,这里不能干等:回复到了,或 run 落了行,就算走完这条入站(建会话有真的 mkdir,要多等几拍)。
  const say = async (peerId: string, text: string, extra: Partial<ChannelInbound> = {}): Promise<string> => {
    const runs = state.runs.length;
    let reply: string | null = null;
    void svc.handleInbound({ accountId: 'acc', peerId, text, ...extra }).then((r) => { reply = r; });
    for (let i = 0; i < 2000 && reply === null && state.runs.length === runs; i++) await new Promise((r) => setImmediate(r));
    await flush();
    return reply ?? '';
  };
  return { svc, driver, sent, offered, settled, say };
}
const lastRun = (): any => state.runs[state.runs.length - 1];
const approvalEvent = (over: Record<string, unknown> = {}) => ({ approvalId: 'a1', name: 'write_file', arguments: '{"path":"notes.md"}', preview: 'write notes.md', ...over });

beforeEach(() => {
  state.ws = mkdtempSync(path.join(tmpdir(), 'channel-multipeer-'));
  state.db = new Database(':memory:');
  state.db.exec(`
    CREATE TABLE tangu_wechat_bindings (id TEXT PRIMARY KEY, user_id TEXT, channel TEXT, account_id TEXT, peer_id TEXT, session_id TEXT, remote_approval_mode TEXT, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE tangu_wechat_accounts (id TEXT PRIMARY KEY, user_id TEXT, wx_user_id TEXT, channel TEXT, status TEXT, created_at TIMESTAMP, updated_at TIMESTAMP);
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, model_id TEXT, agent_config TEXT, project_path TEXT, projectless BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  `);
  state.settings = { enabled: true, sessions: true, agentSlug: '', modelId: 'model-1', imageModelId: '', ttsModelId: '', ttsVoice: '', approvalMode: 'auto-edit', inboxForward: { enabled: false, senders: 'all' } };
  state.runs = [];
  state.aborted = [];
  state.approvals = [];
  state.resolveOk = true;
  state.locked = false;
  state.localOnly = new Set();
  state.listeners.clear();
});
afterEach(() => {
  vi.useRealTimers();
  state.db.close();
  rmSync(state.ws, { recursive: true, force: true });
});

describe('multiPeer: one binding and session per peer', () => {
  it('keeps the same peer id on two accounts apart', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc2' });
    await say('same', 'one');
    const first = lastRun().input.agentConfig.cwd;
    await say('same', 'two', { accountId: 'acc2' });
    expect(lastRun().input.agentConfig.cwd).not.toBe(first);
  });

  it('does not merge contacts whose ids only look alike once joined', async () => {
    const { svc, say } = harness({ multiPeer: true, approvals: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'a' });
    await svc.bindAccount({ userId: 'u1', accountId: 'a:b' });
    await say('c', 'one', { accountId: 'a:b' });
    const run = lastRun();
    state.emit(run.id, 'approval_request', approvalEvent());
    await flush();
    await say('b:c', 'stop that', { accountId: 'a' });
    await say('b:c', '/stop', { accountId: 'a' });
    expect(state.aborted).not.toContain(run.id);
  });

  it('finds every key of an account and none of another account', () => {
    const svc = harness({ multiPeer: true }).svc as any;
    expect(svc.peerKey('a', 'x').startsWith(svc.peerKeyPrefix('a'))).toBe(true);
    expect(svc.peerKey('a:b', 'x').startsWith(svc.peerKeyPrefix('a'))).toBe(false);
    expect(svc.peerKey('ab', 'x').startsWith(svc.peerKeyPrefix('a'))).toBe(false);
  });

  it('gives peer sessions no project memory, so one contact\'s facts stay out of the next one\'s context', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('conv-1/a', 'claims the first session');
    await say('conv-2/a', 'opens its own');
    const sessions = bindings().map((r) => r.session_id);
    expect(sessions).toHaveLength(2);
    expect(await Promise.all(sessions.map((id) => resolveProjectMemory('u1', id)))).toEqual([null, null]);
  });

  it('leaves project memory on a single-contact channel alone', async () => {
    const { svc, say } = harness();
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('conv-1/a', 'hello');
    expect(await resolveProjectMemory('u1', bindings()[0].session_id)).not.toBeNull();
  });

  it('does not resurrect a binding when the account disconnects during its insert', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('conv-1/a', 'claims the first session');
    state.beforeBindingInsert = () => svc.disconnect('u1');
    await say('conv-2/a', 'lands during the disconnect');
    expect(bindings().filter((r) => r.is_active)).toEqual([]);
  });

  it('gives every peer its own session and keeps later messages there', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('conv-1/a', 'first from one');
    const one = lastRun().sessionId;
    await say('conv-2/a', 'first from two');
    const two = lastRun().sessionId;
    expect(two).not.toBe(one);
    await say('conv-1/a', 'second from one');
    expect(lastRun().sessionId).toBe(one);
    await say('conv-2/a', 'second from two');
    expect(lastRun().sessionId).toBe(two);
    const rows = bindings();
    expect(rows.map((r) => r.peer_id).sort()).toEqual(['conv-1/a', 'conv-2/a']);
    expect(rows.every((r) => r.is_active && r.user_id === 'u1')).toBe(true);
  });

  it('keeps inbound files of one peer out of the working folder of another', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    const cwd1 = lastRun().input.agentConfig.cwd;
    await say('p2', 'hi');
    const cwd2 = lastRun().input.agentConfig.cwd;
    expect(cwd1).not.toBe(cwd2);
    expect(cwd1.startsWith(path.join(state.ws, 'org', 'peers'))).toBe(true);
    expect(cwd2.startsWith(path.join(state.ws, 'org', 'peers'))).toBe(true);
    expect(cwd1).not.toContain('p1'); // peerId 由驱动编码,不直接进路径
  });

  it('hashes hostile peer ids instead of walking the filesystem', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('../../etc', 'hi');
    expect(path.dirname(lastRun().input.agentConfig.cwd)).toBe(path.join(state.ws, 'org', 'peers'));
  });

  it('reconnecting keeps every peer connected and adds no binding', async () => {
    const { svc, say } = harness({ multiPeer: true });
    const first = await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    await say('p2', 'hi');
    const again = await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    expect(bindings()).toHaveLength(2);
    expect(bindings().every((r) => r.is_active)).toBe(true);
    expect(typeof again.sessionId).toBe('string');
    expect(first.sessionId).toBe(bindings()[0].session_id);
  });

  it('turns peers away once the account is disconnected', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    await svc.disconnect('u1', 'acc');
    expect(await say('p2', 'hi')).toBe('unbound');
    expect(bindings()).toHaveLength(1);
    expect(state.runs).toHaveLength(1);
  });

  it('turns peers away on an account that never connected', async () => {
    const { say } = harness({ multiPeer: true });
    expect(await say('p1', 'hi')).toBe('unbound');
    expect(bindings()).toHaveLength(0);
  });

  it('opens one binding when a new peer sends two messages at once', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    void svc.receive({ accountId: 'acc', peerId: 'p2', text: 'one' });
    void svc.receive({ accountId: 'acc', peerId: 'p2', text: 'two' });
    await vi.waitFor(() => expect(state.runs).toHaveLength(3));
    expect(bindings().map((r) => r.peer_id).sort()).toEqual(['p1', 'p2']);
    expect(new Set(state.runs.map((r) => r.sessionId)).size).toBe(2);
  });

  it('does not write a binding when the account goes away while the session is created', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    const create = vi.spyOn(svc, 'createChannelSession').mockImplementationOnce(async () => { svc.releasePendingFor('acc'); return 'orphan'; });
    expect(await say('p2', 'hi')).toBe('');
    expect(create).toHaveBeenCalledOnce();
    expect(bindings().map((r) => r.peer_id)).toEqual(['p1']);
  });

  it('keeps a stop in one conversation away from the other', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'long task');
    const one = lastRun().id;
    await say('p2', 'long task');
    const two = lastRun().id;
    await say('p1', '/stop');
    expect(state.aborted).toEqual([one]);
    expect(state.aborted).not.toContain(two);
  });

  it('pins the agent per peer, on the session and on the run', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi', { agentSlug: 'alpha' });
    expect(lastRun().input.agentConfig.agentSlug).toBe('alpha');
    await say('p2', 'hi', { agentSlug: 'beta' });
    expect(lastRun().input.agentConfig.agentSlug).toBe('beta');
    expect(cfgOf(lastRun().sessionId).agentSlug).toBe('beta');
    await say('p3', 'hi');
    expect(lastRun().input.agentConfig.agentSlug).toBe('xyra');
  });

  it('ignores a malformed pinned agent', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi', { agentSlug: '../evil' });
    expect(lastRun().input.agentConfig.agentSlug).toBe('xyra');
  });

  it('treats slash commands as text so a peer cannot reach other sessions', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    const one = lastRun().sessionId;
    await say('p2', 'hi');
    const two = lastRun().sessionId;
    await say('p2', `/resume ${one}`);
    expect(lastRun().input.message).toBe(`/resume ${one}`);
    expect(lastRun().sessionId).toBe(two);
    expect(bindings().find((r) => r.peer_id === 'p2').session_id).toBe(two);
    await say('p2', '/sessions');
    expect(lastRun().input.message).toBe('/sessions');
  });

  it('refuses to move every peer onto one session', async () => {
    const { svc, say } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    await say('p2', 'hi');
    const before = bindings().map((r) => r.session_id);
    await expect(svc.setConnectedSession('u1', before[0])).rejects.toThrow(/one session per contact/);
    expect(bindings().map((r) => r.session_id)).toEqual(before);
  });

  it('never forwards the owner inbox to whichever peer spoke last', async () => {
    const { svc, say, sent } = harness({ multiPeer: true });
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    expect(await svc.sendToOwner('u1', 'private')).toEqual({ ok: false, error: 'a multi-peer channel has no owner peer' });
    expect(sent.some(([, t]) => t === 'private')).toBe(false);
  });
});

describe('multiPeer off keeps the single-contact behaviour', () => {
  it('lets the first peer claim the binding and refuses the next', async () => {
    const { svc, say } = harness();
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    expect(state.runs).toHaveLength(1);
    expect(await say('p2', 'hi')).toBe('unbound');
    expect(state.runs).toHaveLength(1);
    expect(bindings()).toHaveLength(1);
    expect(bindings()[0].peer_id).toBe('p1');
  });

  it('replaces the binding with a fresh session on every connect', async () => {
    const { svc } = harness();
    const a = await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    const b = await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    expect(b.sessionId).not.toBe(a.sessionId);
    const active = bindings().filter((r) => r.is_active);
    expect(active.map((r) => r.session_id)).toEqual([b.sessionId]);
  });

  it('still runs slash commands and still answers the owner', async () => {
    const { svc, say, sent } = harness();
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'hi');
    const before = state.runs.length;
    expect(await say('p1', '/status')).toContain('xyra');
    expect(state.runs).toHaveLength(before);
    expect(await svc.sendToOwner('u1', 'hello')).toEqual({ ok: true });
    expect(sent.at(-1)).toEqual(['p1', 'hello']);
  });

  it('still shows a text card that text can approve', async () => {
    const { svc, say, sent } = harness();
    await svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await say('p1', 'do it');
    state.emit(lastRun().id, 'approval_request', approvalEvent());
    await flush();
    expect(sent.some(([, t]) => t.includes('write notes.md'))).toBe(true);
    await say('p1', '批准');
    expect(state.approvals.map(([id, d]) => [id, d.action])).toEqual([['a1', 'approve']]);
  });
});

describe('sendApproval: structured approval cards', () => {
  async function start(opts: Parameters<typeof harness>[0] = {}) {
    const h = harness({ multiPeer: true, approvals: true, ...opts });
    await h.svc.bindAccount({ userId: 'u1', accountId: 'acc' });
    await h.say('p1', 'do it');
    return { ...h, runId: lastRun().id as string };
  }

  it('hands the full card to the driver instead of a text card', async () => {
    const { offered, sent, runId } = await start();
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    expect(sent).toEqual([]);
    expect(offered).toHaveLength(1);
    expect(offered[0].peerId).toBe('p1');
    expect(offered[0].card).toMatchObject({ approvalId: 'a1', runId, toolName: 'write_file', arguments: '{"path":"notes.md"}', localOnly: false });
    expect(offered[0].card.preview).toContain('write notes.md');
  });

  it('resolves through respond, once, and reports it was the channel', async () => {
    const { offered, runId } = await start();
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    expect(offered[0].respond('approve')).toBe(true);
    expect(offered[0].respond('approve')).toBe(false);
    expect(offered[0].respond('reject')).toBe(false);
    expect(state.approvals).toEqual([['a1', { action: 'approve' }, { via: 'channel' }]]);
  });

  it('cannot be approved by text from the conversation', async () => {
    const { offered, say, runId } = await start();
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    await say('p1', '批准');
    await say('p1', '好');
    expect(state.approvals).toEqual([]);
    expect(offered[0].respond('approve')).toBe(true);
  });

  it('is not rejected by a new message in the conversation', async () => {
    const { offered, say, runId } = await start();
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    await say('p1', 'something else entirely');
    expect(state.approvals).toEqual([]);
    expect(lastRun().id).not.toBe(runId);
    expect(offered[0].respond('reject')).toBe(true);
    expect(state.approvals[0][1]).toEqual({ action: 'reject' });
  });

  it('does not approve before the driver confirmed delivery, but rejects any time', async () => {
    const { offered, runId } = await start();
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    expect(offered[0].respond('approve')).toBe(false);
    expect(state.approvals).toEqual([]);
    expect(offered[0].respond('reject')).toBe(true);
    expect(state.approvals[0][1]).toEqual({ action: 'reject' });
  });

  it('rejects when the driver could not deliver the card', async () => {
    const { offered, settled, sent, runId } = await start({ settle: true });
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: false, error: 'gateway down' });
    await flush();
    expect(state.approvals[0][1]).toEqual({ action: 'reject', rejectReason: APPROVAL_DELIVERY_FAILED_REASON });
    expect(settled).toEqual([['p1', 'a1', 'undelivered']]);
    expect(sent).toEqual([]);
  });

  it('treats a throwing driver as undelivered', async () => {
    const h = await start();
    (h.driver as any).sendApproval = () => { throw new Error('boom'); };
    state.emit(h.runId, 'approval_request', approvalEvent());
    await flush();
    expect(state.approvals[0][1]).toEqual({ action: 'reject', rejectReason: APPROVAL_DELIVERY_FAILED_REASON });
  });

  it('times out ten minutes after it was shown, and the driver writes the notice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { offered, settled, sent, runId } = await start({ settle: true });
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    vi.advanceTimersByTime(CHANNEL_APPROVAL_TIMEOUT_MS - 1);
    expect(state.approvals).toEqual([]);
    vi.advanceTimersByTime(1);
    await flush();
    expect(state.approvals[0][1]).toEqual({ action: 'reject', rejectReason: APPROVAL_TIMEOUT_REASON });
    expect(settled).toEqual([['p1', 'a1', 'timeout']]);
    expect(sent).toEqual([]);
    expect(offered[0].respond('approve')).toBe(false);
  });

  it('falls back to the text notice when the driver has no settleApproval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { offered, sent, runId } = await start();
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    vi.advanceTimersByTime(CHANNEL_APPROVAL_TIMEOUT_MS);
    await flush();
    expect(sent).toHaveLength(1);
  });

  it('follows an answer given elsewhere and stops the timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { offered, settled, runId } = await start({ settle: true });
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    state.emit(runId, 'approval_result', { approvalId: 'a1', action: 'approve', by: { via: 'local' } });
    await flush();
    expect(settled).toEqual([['p1', 'a1', 'approved']]);
    expect(offered[0].respond('approve')).toBe(false);
    vi.advanceTimersByTime(CHANNEL_APPROVAL_TIMEOUT_MS * 2);
    await flush();
    expect(state.approvals).toEqual([]);
  });

  it('does not tell the driver about its own respond', async () => {
    const { offered, settled, runId } = await start({ settle: true });
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    offered[0].respond('reject');
    state.emit(runId, 'approval_result', { approvalId: 'a1', action: 'reject', by: { via: 'channel' } });
    await flush();
    expect(settled).toEqual([]);
  });

  it('keeps a protected action on the computer', async () => {
    const { offered, runId } = await start();
    state.emit(runId, 'approval_request', approvalEvent({ localOnly: true }));
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    expect(offered[0].card.localOnly).toBe(true);
    expect(offered[0].respond('approve')).toBe(false);
    expect(state.approvals).toEqual([]);
    expect(offered[0].respond('reject')).toBe(true);
  });

  it('checks the registry too, for an approval the event did not mark', async () => {
    const { offered, runId } = await start();
    state.localOnly.add('a1');
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    expect(offered[0].respond('approve')).toBe(false);
  });

  it('does not approve while remote access is locked', async () => {
    const { offered, runId } = await start();
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    state.locked = true;
    expect(offered[0].respond('approve')).toBe(false);
    expect(offered[0].respond('reject')).toBe(true);
  });

  it('shows one card per peer at a time and keeps the other peer independent', async () => {
    const { offered, say, runId } = await start();
    await say('p2', 'other task');
    const other = lastRun().id;
    state.emit(runId, 'approval_request', approvalEvent({ approvalId: 'a1' }));
    state.emit(runId, 'approval_request', approvalEvent({ approvalId: 'a2' }));
    state.emit(other, 'approval_request', approvalEvent({ approvalId: 'b1' }));
    await flush();
    expect(offered.map((o) => o.card.approvalId)).toEqual(['a1', 'b1']);
    offered[0].settle({ ok: true });
    offered[1].settle({ ok: true });
    await flush();
    expect(offered[0].respond('approve')).toBe(true);
    await flush();
    expect(offered.map((o) => o.card.approvalId)).toEqual(['a1', 'b1', 'a2']);
  });

  it('only cancels the cards the driver has seen when the run ends', async () => {
    const { offered, settled, runId } = await start({ settle: true });
    state.emit(runId, 'approval_request', approvalEvent({ approvalId: 'a1' }));
    state.emit(runId, 'approval_request', approvalEvent({ approvalId: 'a2' }));
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    state.emit(runId, 'done', { content: 'finished' });
    await flush();
    expect(settled).toEqual([['p1', 'a1', 'cancelled']]);
    expect(offered).toHaveLength(1);
  });

  it('cancels on stop', async () => {
    const { offered, settled, say, runId } = await start({ settle: true });
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    await say('p1', '/stop');
    expect(settled).toEqual([['p1', 'a1', 'cancelled']]);
    expect(offered[0].respond('approve')).toBe(false);
  });

  it('rejects and cancels when the channel stops', async () => {
    const { svc, offered, settled, runId } = await start({ settle: true });
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    svc.releasePending();
    await flush();
    expect(state.approvals[0][1]).toEqual({ action: 'reject', rejectReason: APPROVAL_CHANNEL_STOPPED_REASON });
    expect(settled).toEqual([['p1', 'a1', 'cancelled']]);
    expect(offered[0].respond('approve')).toBe(false);
  });

  it('passes long content through rather than refusing it', async () => {
    const { offered, runId } = await start();
    state.emit(runId, 'approval_request', approvalEvent({ name: undefined, arguments: undefined, preview: 'x'.repeat(30_000) }));
    await flush();
    expect(offered).toHaveLength(1);
    expect(offered[0].card.preview).toHaveLength(30_000);
    expect(state.approvals).toEqual([]);
  });

  it('survives a driver whose settleApproval throws', async () => {
    const h = await start({ settle: true });
    (h.driver as any).settleApproval = () => { throw new Error('boom'); };
    state.emit(h.runId, 'approval_request', approvalEvent());
    await flush();
    h.offered[0].settle({ ok: true });
    await flush();
    state.emit(h.runId, 'done', { content: 'finished' });
    await flush();
    expect(h.sent.at(-1)?.[1]).toBe('finished');
  });

  it('still delivers the end of the run through send', async () => {
    const { offered, sent, runId } = await start();
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    offered[0].respond('approve');
    state.emit(runId, 'done', { content: 'all done' });
    await flush();
    expect(sent).toEqual([['p1', 'all done']]);
  });

  it('works on a single-contact channel too', async () => {
    const { offered, say, runId } = await start({ multiPeer: false });
    expect(await say('p2', 'hi')).toBe('unbound');
    state.emit(runId, 'approval_request', approvalEvent());
    await flush();
    offered[0].settle({ ok: true });
    await flush();
    expect(offered[0].respond('approve')).toBe(true);
  });
});
