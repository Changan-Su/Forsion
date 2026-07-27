/**
 * 通道设置读写:config.json 的 channels 段(每通道一个子对象)。
 * 微信保留 legacy 兼容:env TANGU_WECHAT_* 与旧 wechat 段(enabled/remoteApprovalMode)仍生效,
 * channels.wechat 里显式设置的键优先。
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { getRawSection, saveSection } from '../core/config.js';
import { tanguHome } from '../core/tanguHome.js';
import type { ApprovalMode, ChannelKind, ChannelSettings } from './types.js';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function normApproval(v: unknown, fallback: ApprovalMode): ApprovalMode {
  return v === 'readonly' || v === 'auto-edit' || v === 'full-auto' ? v : fallback;
}

function legacyWechat(): { enabled: boolean; approvalMode: ApprovalMode } {
  const w = (getRawSection('wechat') as any) || {};
  const enabled = process.env.TANGU_WECHAT_ENABLED !== undefined
    ? process.env.TANGU_WECHAT_ENABLED !== '0'
    : w.enabled !== false; // 微信历史默认开
  return { enabled, approvalMode: normApproval(process.env.TANGU_WECHAT_REMOTE_APPROVAL_MODE || w.remoteApprovalMode, 'auto-edit') };
}

/** 微信 iLink 运行时状态目录(accounts.json / *.state.json / runtime.log)。 */
export function wechatStateDir(): string {
  return process.env.TANGU_WECHAT_STATE_DIR || str((getRawSection('wechat') as any)?.stateDir) || path.join(tanguHome(), 'wechat');
}

/** 默认工作区目录(通道 Project 目录的父目录;与 wechatRemote 历史行为一致)。 */
export function defaultWorkspaceDir(): string {
  const v = (process.env.TANGU_DEFAULT_WORKSPACE || (getRawSection('workspace') as string) || '').trim();
  return v || path.join(homedir(), 'Tangu');
}

/** 每通道专属工作区目录名(微信沿用历史 webot;桌面侧栏按 project_path 归组)。 */
export const CHANNEL_DIR_NAME: Record<ChannelKind, string> = { wechat: 'webot', telegram: 'tgbot', qq: 'qqbot' };

export function channelWorkspaceDir(kind: ChannelKind): string {
  return path.join(defaultWorkspaceDir(), CHANNEL_DIR_NAME[kind]);
}

function normForward(v: any): ChannelSettings['inboxForward'] {
  const senders = Array.isArray(v?.senders) ? v.senders.map(str).filter(Boolean) : 'all';
  return { enabled: v?.enabled === true, senders: senders === 'all' || senders.length ? senders : 'all' };
}

/** 读某通道的完整设置(缺省字段补默认;微信合并 legacy)。 */
export function channelSettings(kind: ChannelKind): ChannelSettings {
  const raw = ((getRawSection('channels') as any) || {})[kind] || {};
  const legacy = kind === 'wechat' ? legacyWechat() : null;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : (legacy ? legacy.enabled : false),
    sessions: raw.sessions !== false,
    agentSlug: str(raw.agentSlug),
    modelId: str(raw.modelId),
    imageModelId: str(raw.imageModelId),
    ttsModelId: str(raw.ttsModelId),
    ttsVoice: str(raw.ttsVoice),
    // 默认「替我批准」(auto-edit) —— 全端默认统一到这一档,通道不再比桌面更保守。
    approvalMode: normApproval(raw.approvalMode, legacy ? legacy.approvalMode : 'auto-edit'),
    inboxForward: normForward(raw.inboxForward),
    botToken: str(raw.botToken) || undefined,
    appId: str(raw.appId) || undefined,
    appSecret: str(raw.appSecret) || undefined,
  };
}

/** 合并写回某通道设置(只动传入的键;secrets 传空串表示清除)。 */
export function saveChannelSettings(kind: ChannelKind, patch: Partial<ChannelSettings>): ChannelSettings {
  const all = ((getRawSection('channels') as any) || {});
  all[kind] = { ...(all[kind] || {}), ...patch };
  saveSection('channels', all);
  return channelSettings(kind);
}
