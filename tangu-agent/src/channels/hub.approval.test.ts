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
  syncFails: 0,
  /** 生命周期调用流水:`${kind}:driver.stop` / `${kind}:driver.start` / `${kind}:releasePending`。 */
  calls: [] as string[],
  driver: (kind: string) => class {
    start = async (cb: any) => { state.calls.push(`${kind}:driver.start`); state.onMessage = cb; };
    stop = () => { state.calls.push(`${kind}:driver.stop`); };
    status = () => [];
  },
}));

vi.mock('./service.js', () => ({
  ChannelService: class {
    kind: string;
    driver: any;
    constructor(opts: any) { this.kind = opts.kind; this.driver = opts.driver; }
    syncApprovalMode = vi.fn(async (mode: string, opts?: any) => {
      if (state.syncFails > 0) { state.syncFails -= 1; throw new Error('db locked'); }
      state.synced.push([this.kind, mode, opts ?? {}]);
    });
    releasePending() { state.calls.push(`${this.kind}:releasePending`); }
    receive = vi.fn(async () => '');
    handleInbound = vi.fn(async () => 'should not be used by drivers');
  },
}));
vi.mock('./wechat.js', () => ({ WechatChannel: state.driver('wechat') }));
vi.mock('./telegram.js', () => ({ TelegramChannel: state.driver('telegram') }));
vi.mock('./qq.js', () => ({ QQChannel: state.driver('qq') }));
vi.mock('../core/db.js', () => ({ query: vi.fn(async () => []) }));
vi.mock('../seams/runtime.js', () => ({ deps: () => ({ profile: { capabilities: { hostExec: true } } }) }));
vi.mock('./config.js', async (importOriginal) => ({
  channelHasCredentials: (await importOriginal<typeof import('./config.js')>()).channelHasCredentials, // 纯函数,用真的
  channelSettings: (kind: string) => state.settings[kind],
  saveChannelSettings: (kind: string, patch: any) => (state.settings[kind] = { ...state.settings[kind], ...patch }),
}));

import { channelHub } from './hub.js';

beforeEach(() => {
  state.synced = [];
  state.syncFails = 0;
  state.calls = [];
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


describe('Codex 评审(09-25):重启 ≠ 完全停止;同步失败留痕且不挡启停', () => {
  it('在跑的通道换凭据:只重启传输层,不 releasePending(run 订阅 / 待答卡片留着)', async () => {
    state.settings.telegram = { ...state.settings.telegram, enabled: true, botToken: 'old' };
    await channelHub.applySettings('telegram', { botToken: 'new' });
    expect(state.calls).toEqual(['telegram:driver.stop', 'telegram:driver.start']);
  });

  it('启用一个停着的通道:同样只起传输层,不 releasePending', async () => {
    await channelHub.applySettings('qq', { enabled: true });
    expect(state.calls).toEqual(['qq:driver.stop', 'qq:driver.start']);
  });

  it('禁用 = 完全停止:停传输层 + releasePending(兑现审批 / 询问)', async () => {
    state.settings.telegram = { ...state.settings.telegram, enabled: true };
    await channelHub.applySettings('telegram', { enabled: false });
    expect(state.calls).toEqual(['telegram:driver.stop', 'telegram:releasePending']);
  });

  it('审批档同步到绑定失败:applySettings 不抛、打日志,同一次补丁里的禁用照样生效', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.syncFails = 1;
    state.settings.telegram = { ...state.settings.telegram, enabled: true };
    const after = await channelHub.applySettings('telegram', { approvalMode: 'readonly', enabled: false });
    expect(after.approvalMode).toBe('readonly');
    expect(state.calls).toEqual(['telegram:driver.stop', 'telegram:releasePending']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('审批档同步到绑定失败') && String(c[1]).includes('db locked'))).toBe(true);
    warn.mockRestore();
  });
});

describe('评审二轮(09-25):凭据清空 = 完全停止,不是重启', () => {
  it('Telegram 在跑时清空 botToken:停传输层 + releasePending(驱动 start 见不到 token 会早退,不能当重启)', async () => {
    state.settings.telegram = { ...state.settings.telegram, enabled: true, botToken: 'old' };
    await channelHub.applySettings('telegram', { botToken: '' });
    expect(state.calls).toEqual(['telegram:driver.stop', 'telegram:releasePending']);
  });

  it('QQ 清空 appSecret(appId 还在):同样完全停止', async () => {
    state.settings.qq = { ...state.settings.qq, enabled: true, appId: 'a', appSecret: 's' };
    await channelHub.applySettings('qq', { appSecret: '' });
    expect(state.calls).toEqual(['qq:driver.stop', 'qq:releasePending']);
  });

  it('QQ 换成另一套完整凭据:仍只重启传输层', async () => {
    state.settings.qq = { ...state.settings.qq, enabled: true, appId: 'a', appSecret: 's' };
    await channelHub.applySettings('qq', { appId: 'b', appSecret: 't' });
    expect(state.calls).toEqual(['qq:driver.stop', 'qq:driver.start']);
  });
});
