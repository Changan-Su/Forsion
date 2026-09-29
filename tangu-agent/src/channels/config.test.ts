/**
 * 通道设置读取(config.ts)的审批档归一:只有空 / 缺席才走兜底(微信 legacy → auto-edit);
 * 不认识的非空值(手改拼错的 "read-only"、custom、旧 env 脏值)一律 readonly —— 旧版落兜底 auto-edit,
 * 新绑定被写成 auto-edit、写文件免批(评审二轮 P1,与绑定侧 P0-1 同类)。
 * 另钉 channelHasCredentials 与驱动 start 的早退条件同口径(凭据清空 → hub 走完全停止)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sections: {} as Record<string, any> }));
vi.mock('../core/config.js', () => ({
  getRawSection: (name: string) => state.sections[name],
  updateSection: (name: string, fn: (cur: any) => any) => { state.sections[name] = fn(state.sections[name]); },
}));
vi.mock('../core/tanguHome.js', () => ({ tanguHome: () => '/tmp/tangu-home' }));

import { channelHasCredentials, channelSettings, normApproval, saveChannelSettings } from './config.js';

const ENV_KEYS = ['TANGU_WECHAT_REMOTE_APPROVAL_MODE', 'TANGU_WECHAT_ENABLED'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  state.sections = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  vi.restoreAllMocks();
});

describe('normApproval:未知非空 → readonly,只有空 / 缺席走兜底', () => {
  it('三档原样;空 / 缺席 → 兜底;其它一律 readonly', () => {
    for (const m of ['readonly', 'auto-edit', 'full-auto'] as const) expect(normApproval(m, 'auto-edit')).toBe(m);
    expect(normApproval(undefined, 'auto-edit')).toBe('auto-edit');
    expect(normApproval(null, 'full-auto')).toBe('full-auto');
    expect(normApproval('', 'auto-edit')).toBe('auto-edit');
    expect(normApproval('  ', 'auto-edit')).toBe('auto-edit');
    for (const bad of ['read-only', 'Full-Auto', 'custom', 'bogus', 1, true, {}]) expect(normApproval(bad, 'auto-edit')).toBe('readonly');
  });
});

describe('channelSettings().approvalMode', () => {
  it('channels.<kind>.approvalMode 拼错(read-only)→ readonly,不是 auto-edit', () => {
    state.sections.channels = { telegram: { approvalMode: 'read-only' }, qq: { approvalMode: 'custom' } };
    expect(channelSettings('telegram').approvalMode).toBe('readonly');
    expect(channelSettings('qq').approvalMode).toBe('readonly');
  });

  it('没写 → 缺省 auto-edit(全端默认档,不变)', () => {
    expect(channelSettings('telegram').approvalMode).toBe('auto-edit');
    state.sections.channels = { telegram: { approvalMode: '' } };
    expect(channelSettings('telegram').approvalMode).toBe('auto-edit');
  });

  it('微信 legacy:env / 旧 wechat.remoteApprovalMode 的脏值 → readonly;channels.wechat 里的未知值不回落到 legacy', () => {
    process.env.TANGU_WECHAT_REMOTE_APPROVAL_MODE = 'readOnly';
    expect(channelSettings('wechat').approvalMode).toBe('readonly');
    delete process.env.TANGU_WECHAT_REMOTE_APPROVAL_MODE;
    state.sections.wechat = { remoteApprovalMode: 'yolo' };
    expect(channelSettings('wechat').approvalMode).toBe('readonly');
    state.sections.wechat = { remoteApprovalMode: 'full-auto' };
    expect(channelSettings('wechat').approvalMode).toBe('full-auto');
    state.sections.channels = { wechat: { approvalMode: 'full_auto' } }; // 拼错:不能借 legacy 的 full-auto 放宽
    expect(channelSettings('wechat').approvalMode).toBe('readonly');
  });

  it('写回后读到的也是归一值', () => {
    expect(saveChannelSettings('qq', { approvalMode: 'read-only' as any }).approvalMode).toBe('readonly');
  });
});

describe('channelHasCredentials', () => {
  it('Telegram 看 botToken,QQ 要 appId + appSecret 都有,微信恒 true', () => {
    expect(channelHasCredentials('telegram', { botToken: 't' })).toBe(true);
    expect(channelHasCredentials('telegram', { botToken: undefined })).toBe(false);
    expect(channelHasCredentials('qq', { appId: 'a', appSecret: 's' })).toBe(true);
    expect(channelHasCredentials('qq', { appId: 'a', appSecret: undefined })).toBe(false);
    expect(channelHasCredentials('qq', { appId: undefined, appSecret: 's' })).toBe(false);
    expect(channelHasCredentials('wechat', {})).toBe(true);
  });
});
