/**
 * 收件箱信的类别(Muse 读 / 标已读共用,纯函数)。全从现有字段推:正文里的审批围栏、没领的附件、反馈线程、发件人。
 * 服务端广播还没有「类型」:官方信一律 official,不问、不标。
 */
export type InboxCategory = 'approval' | 'reward' | 'feedback' | 'muse' | 'automation' | 'agent' | 'system' | 'official';

/** 要用户动手的:永远不自动已读,inbox_mark 恒拒,只进清单提醒。 */
export const NEEDS_USER: ReadonlySet<InboxCategory> = new Set(['approval', 'reward', 'feedback']);
/** 用户点过「好」才能自动标的类别。
 *  ponytail: 只有 Muse 自己的信 —— 官方信分不出更新 / 上新 / 维护。服务端广播带上类型后,把那几类加进这里。 */
export const AUTO_READ_CATEGORIES: readonly InboxCategory[] = ['muse'];

export interface InboxRow { sender_kind?: string | null; sender_id?: string | null; thread?: unknown; attachments?: unknown; body?: string | null }

/** 有没领的附件(落库形态 {items, claimed},inboxPull 包装;脏 JSON 按没有)。 */
export function unclaimedAttachment(r: Pick<InboxRow, 'attachments'>): boolean {
  if (!r.attachments) return false;
  try {
    const p = JSON.parse(String(r.attachments));
    return Array.isArray(p?.items) && p.items.length > 0 && !p.claimed;
  } catch { return false; }
}

export function inboxCategory(r: InboxRow): InboxCategory {
  if (String(r.body || '').includes('```forsion-approval')) return 'approval';
  if (unclaimedAttachment(r)) return 'reward';
  if (r.sender_kind === 'server') return r.thread ? 'feedback' : 'official';
  if (r.sender_kind === 'system') return 'system';
  const id = String(r.sender_id || '');
  if (id === 'muse') return 'muse';
  return id.startsWith('automation:') ? 'automation' : 'agent';
}
