/**
 * 收件箱信的类别(Muse 读 / 标已读共用,纯函数)。全从现有字段推:正文里的审批围栏、没领的附件、反馈线程、发件人。
 * 官方信按服务端广播的 kind 分;other 与老服务端没这个字段的信都算 official(只提醒,不自动标)。
 */
export type InboxCategory = 'approval' | 'reward' | 'feedback' | 'muse' | 'automation' | 'agent' | 'system' | 'official' | 'update' | 'store' | 'maintenance' | 'promo';

/** 服务端广播的类型(GET /api/brain/inbox/broadcasts 的 kind,server 与 Genesis 的约定,别改名)。 */
const BROADCAST_KINDS = ['update', 'store', 'maintenance', 'promo'] as const;
/** 入库口:没有这个字段、或不认识的值都是 other。 */
export const broadcastKind = (v: unknown): string => ((BROADCAST_KINDS as readonly unknown[]).includes(v) ? String(v) : 'other');

/** 要用户动手的:永远不自动已读,inbox_mark 恒拒,只进清单提醒。 */
export const NEEDS_USER: ReadonlySet<InboxCategory> = new Set(['approval', 'reward', 'feedback']);
/** 用户点过「好」才能自动标的类别。promo 和其余官方信只提醒,不在这里。 */
export const AUTO_READ_CATEGORIES: readonly InboxCategory[] = ['muse', 'update', 'store', 'maintenance'];

export interface InboxRow { sender_kind?: string | null; sender_id?: string | null; thread?: unknown; attachments?: unknown; body?: string | null; broadcast_kind?: string | null }

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
  if (r.sender_kind === 'server') {
    if (r.thread) return 'feedback';
    const kind = broadcastKind(r.broadcast_kind);
    return kind === 'other' ? 'official' : kind as InboxCategory;
  }
  if (r.sender_kind === 'system') return 'system';
  const id = String(r.sender_id || '');
  if (id === 'muse') return 'muse';
  return id.startsWith('automation:') ? 'automation' : 'agent';
}
