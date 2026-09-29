/**
 * 通道设置读写:config.json 的 channels 段(每通道一个子对象)。
 * 微信保留 legacy 兼容:env TANGU_WECHAT_* 与旧 wechat 段(enabled/remoteApprovalMode)仍生效,
 * channels.wechat 里显式设置的键优先。
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { getRawSection, updateSection } from '../core/config.js';
import { tanguHome } from '../core/tanguHome.js';
import type { ApprovalMode, ChannelKind, ChannelSettings } from './types.js';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * 通道设置里的审批档归一(与引擎 normalizeApprovalMode 同口径,H5 fail-closed):只有**空 / 缺席**才走兜底链
 * (微信 legacy → 'auto-edit');三档原样;custom 与其它任何非空值(手改拼错的 "read-only"、旧 env 里的脏值)→ readonly。
 * 旧版把不认识的一律落兜底 auto-edit —— 用户想写只读、拼错一个字,新绑定就被写成 auto-edit、写文件免批。
 * 口径内联、不 import 引擎的 normalizeApprovalMode:approvals.ts 拖着 agentRegistry / pendingApprovals 等一整张图(经 forward.ts 的
 * 动态 import 还会绕回 hub → 本文件),而本文件被驱动与 agentRename 引用,设置读取不该挂上这张图。改口径时两处同改。
 */
const warnedApproval = new Set<string>();
export function normApproval(v: unknown, fallback: ApprovalMode): ApprovalMode {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return fallback;
  if (v === 'readonly' || v === 'auto-edit' || v === 'full-auto') return v;
  const k = JSON.stringify(v) ?? String(v);
  if (!warnedApproval.has(k) && warnedApproval.size < 50) { // 每次读设置都过这里:同一个值只告警一次
    warnedApproval.add(k);
    console.warn(`[channels] 通道设置里的审批档 ${k} 不认识,按 readonly 处理`);
  }
  return 'readonly';
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
    locale: raw.locale === 'zh' || raw.locale === 'en' ? raw.locale : undefined,
    botToken: str(raw.botToken) || undefined,
    appId: str(raw.appId) || undefined,
    appSecret: str(raw.appSecret) || undefined,
  };
}

/**
 * 该通道的凭据是否齐全(与驱动 start 的早退条件同一口径:Telegram 要 botToken,QQ 要 appId + appSecret;
 * 微信的凭据是扫码登录的 iLink 账号,不在设置里,恒 true)。凭据被清空时 hub 走完全停止而不是重启。
 */
export function channelHasCredentials(kind: ChannelKind, st: Pick<ChannelSettings, 'botToken' | 'appId' | 'appSecret'>): boolean {
  if (kind === 'telegram') return !!st.botToken;
  if (kind === 'qq') return !!st.appId && !!st.appSecret;
  return true;
}

/** 合并写回某通道设置(只动传入的键;secrets 传空串表示清除)。 */
export function saveChannelSettings(kind: ChannelKind, patch: Partial<ChannelSettings>): ChannelSettings {
  updateSection('channels', (all: any) => ({ ...(all || {}), [kind]: { ...(all?.[kind] || {}), ...patch } })); // 锁内读改写:别的进程同时改别的通道不会被盖掉
  return channelSettings(kind);
}
