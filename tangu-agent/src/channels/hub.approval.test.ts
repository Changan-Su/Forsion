/**
 * hub 侧的审批档同步接线:设置页改审批档(applySettings)→ 同步到该通道全部绑定(双向);引擎启动时按设置对齐一次
 * (修复前改过档的老绑定还停在旧档)—— 只收紧(narrowOnly),启动不是用户动作,不能借兜底值放宽老绑定。别的键不触发同步。
 * 另钉:驱动的入站回调接的是 receive(不占轮询),不是会等 run 回复的 handleInbound。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  synced: [] as Array<[string, string, any]>,
  settings: {} as Record<string, any>,
  onMessage: null as null | ((msg: any) => Promise<string>),
  driver: () => class { start = async (cb: any) => { state.onMessage = cb; }; stop = () => {}; status = () => []; },
}));

vi.mock('./service.js', () => ({
  ChannelService: class {
    kind: string;
    driver: any;
    constructor(opts: any) { this.kind = opts.kind; this.driver = opts.driver; }
    syncApprovalMode = vi.fn(async (mode: string, opts?: any) => { state.synced.push([this.kind, mode, opts ?? {}]); });
    releasePending() {}
    receive = vi.fn(async () => '');
    handleInbound = vi.fn(async () => 'should not be used by drivers');
  },
}));
vi.mock('./wechat.js', () => ({ WechatChannel: state.driver() }));
vi.mock('./telegram.js', () => ({ TelegramChannel: state.driver() }));
vi.mock('./qq.js', () => ({ QQChannel: state.driver() }));
vi.mock('../core/db.js', () => ({ query: vi.fn(async () => []) }));
vi.mock('../seams/runtime.js', () => ({ deps: () => ({ profile: { capabilities: { hostExec: true } } }) }));
vi.mock('./config.js', () => ({
  channelSettings: (kind: string) => state.settings[kind],
  saveChannelSettings: (kind: string, patch: any) => (state.settings[kind] = { ...state.settings[kind], ...patch }),
}));

import { channelHub } from './hub.js';

beforeEach(() => {
  state.synced = [];
  const base = { enabled: false, sessions: true, approvalMode: 'auto-edit', inboxForward: { enabled: false, senders: 'all' } };
  state.settings = { wechat: { ...base }, telegram: { ...base }, qq: { ...base, approvalMode: 'full-auto' } };
});

describe('channelHub 审批档同步', () => {
  it('applySettings 改审批档 → 同步该通道绑定;改别的键不同步', async () => {
    await channelHub.applySettings('telegram', { approvalMode: 'readonly' });
    expect(state.synced).toEqual([['telegram', 'readonly', {}]]);
    await channelHub.applySettings('telegram', { modelId: 'x' });
    expect(state.synced).toHaveLength(1);
  });

  it('启动时按设置把三个通道的绑定对齐一次(只收紧);驱动入站接 receive', async () => {
    state.settings.telegram.enabled = true;
    await channelHub.startAll();
    const narrow = { narrowOnly: true };
    expect(state.synced).toEqual([['wechat', 'auto-edit', narrow], ['telegram', 'auto-edit', narrow], ['qq', 'full-auto', narrow]]);
    expect(await state.onMessage!({ accountId: 'tg:1', peerId: '42', text: 'hi' })).toBe('');
    const svc = channelHub.service('telegram') as any;
    expect(svc.receive).toHaveBeenCalledTimes(1);
    expect(svc.handleInbound).not.toHaveBeenCalled();
  });
});
