/**
 * Muse Space「今日简报」的布局协议(2026-11-08,方案 D 第一期)。
 * 方案页:仓根 `docs/ToBeImproved/MuseSpace优化方案_2026-11-07/details.html` §4–6。
 *
 * 两份文件,都只在本机(Space 目录本来就不同步,见 agentSyncRules):
 *   agents/muse/Space/space.json       卜算子写(经 muse_space 工具)。它也能用 write_file 直接改 → 读时一律过 sanitizeMuseSpaceDoc。
 *   <tangu home>/ui/muse-space.json    你的摆放(宿主经引擎路由写),在卜算子免审目录之外。
 * 引擎统一写:加锁、expectedRev、原子替换;读坏 = 用最后一份有效的,不当空、不重写。
 *
 * 谁管什么(第一期):
 *   · 卜算子:那句话(hero)、备好的(prepared)、提议(proposed),以及它自己小组件的内容(走 widgetStore,不在这两份文件里)。
 *   · 你:小组件那一节的格子 —— 缺省三张 + 你从「添加」放上的 + 你点「放上」接受的提议;顺序、隐藏、墓碑。
 *   卜算子的文件里**不放格子**:方案页「卜算子能改的」只列了上面那四样,新卡一律走提议、你点头才进格子。
 *   所以「你 pinned 的格子它不能挪」在第一期天然成立,不需要 pinned 字段。
 *
 * 本文件只有类型和纯函数(sanitize / compose / applyPlacementOp),引擎与宿主共用,不碰 IO。
 */

export const MUSE_SPACE_SCHEMA = 1 as const;

/** 宿主内置的四张卡:待你看的 / 在跟的 / 今天 / 卜算子状态。key 就是种类名。 */
export const MUSE_BUILTIN_CARDS = ['todos', 'tracking', 'today', 'status'] as const;
export type MuseBuiltinCard = (typeof MUSE_BUILTIN_CARDS)[number];
export const isMuseBuiltinCard = (x: unknown): x is MuseBuiltinCard => (MUSE_BUILTIN_CARDS as readonly unknown[]).includes(x);

export type MuseCardRef = { builtin: MuseBuiltinCard } | { widgetId: string };
export interface MuseSpaceCard { key: string; ref: MuseCardRef }
export interface MuseSpaceProposal extends MuseSpaceCard {
  /** 卜算子给的一句理由(卡顶那条「卜算子想加这张」后面) */
  why?: string;
  /** ISO 时间,引擎填 */
  at?: string;
}
export interface MuseSpaceHero {
  /** ≤ MUSE_HERO_MAX 个字符,可带 [[Library 相对路径]] 链接 */
  text: string;
  /** ISO 时间,引擎在写入时填(不让模型填) */
  at: string;
  sources?: string[];
}

/** agents/muse/Space/space.json —— 卜算子的那份。 */
export interface MuseSpaceDoc {
  schemaVersion: 1;
  rev: number;
  template: 'brief';
  hero: MuseSpaceHero | null;
  /** Library 相对路径,≤ MUSE_PREPARED_MAX 份 */
  prepared: string[];
  proposed: MuseSpaceProposal[];
}

/** 能隐藏、不能挪的两节。 */
export const MUSE_SECTIONS = ['section:prepared', 'section:today'] as const;
export type MuseSection = (typeof MUSE_SECTIONS)[number];

/** <tangu home>/ui/muse-space.json —— 你的摆放。 */
export interface MuseSpacePlacement {
  schemaVersion: 1;
  rev: number;
  /** 你排过的顺序;null = 从没动过(用缺省顺序)。里面可能有已经不在格子里的 key,合成时跳过。 */
  order: string[] | null;
  /** 隐藏的格子 key,以及 MUSE_SECTIONS 里的两节 */
  hidden: string[];
  /** 你放上的卡(「添加」里点的,或者接受的提议)。缺省三张不在这里。 */
  added: MuseSpaceCard[];
  /** 你拒掉的提议:按语义 key 记,卜算子换个小组件 id 也加不回来。「恢复默认」不清它。 */
  tombstones: { key: string; at: string }[];
}

export const MUSE_HERO_MAX = 160;
export const MUSE_PREPARED_MAX = 3;
/** 挂着的提议最多几张(每轮最多新提一张,不点就一直挂着) */
export const MUSE_PROPOSED_MAX = 3;
export const MUSE_WHY_MAX = 120;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const WIDGET_ID_RE = /^w_[A-Za-z0-9_-]{1,64}$/;
const MAX_ADDED = 24;
const MAX_TOMBSTONES = 200;

export const validMuseCardKey = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k);
export const validWidgetId = (id: unknown): id is string => typeof id === 'string' && WIDGET_ID_RE.test(id);

/** Library 相对路径:不许绝对、不许 ..、不许隐藏段;统一成正斜杠。不合法 → null。 */
export function normalizeLibraryPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const s = p.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!s || s.length > 300 || s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))) return null;
  return parts.join('/');
}

export function sanitizeCardRef(r: unknown): MuseCardRef | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (isMuseBuiltinCard(o.builtin)) return { builtin: o.builtin };
  if (validWidgetId(o.widgetId)) return { widgetId: o.widgetId };
  return null;
}
function sanitizeCard(c: unknown): MuseSpaceCard | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const ref = sanitizeCardRef(o.ref);
  if (!validMuseCardKey(o.key) || !ref) return null;
  // 内置卡的 key 只能是它自己的种类名:不许「todos」这个 key 指向别的东西,也不许内置卡换个 key 出现两次
  if ('builtin' in ref ? o.key !== ref.builtin : isMuseBuiltinCard(o.key)) return null;
  return { key: o.key, ref };
}
const isoOr = (v: unknown, fallback: string): string => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : fallback);
const intOr0 = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

export type SanitizeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 卜算子那份:结构不对 = 读坏(调用方用最后一份有效的);个别项不合法 = 丢掉那一项、整份照用。 */
export function sanitizeMuseSpaceDoc(raw: unknown): SanitizeResult<MuseSpaceDoc> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'space.json must be a JSON object' };
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== MUSE_SPACE_SCHEMA) return { ok: false, error: `space.json schemaVersion must be ${MUSE_SPACE_SCHEMA}` };
  if (o.template !== undefined && o.template !== 'brief') return { ok: false, error: 'space.json template must be "brief"' };
  let hero: MuseSpaceHero | null = null;
  if (o.hero != null) {
    const h = o.hero as Record<string, unknown>;
    if (typeof h !== 'object' || typeof h.text !== 'string') return { ok: false, error: 'space.json hero must be { text, at }' };
    const text = clipChars(h.text.trim(), MUSE_HERO_MAX);
    const sources = Array.isArray(h.sources) ? h.sources.map(normalizeLibraryPath).filter((x): x is string => !!x).slice(0, 5) : undefined;
    if (text) hero = { text, at: isoOr(h.at, new Date(0).toISOString()), ...(sources?.length ? { sources } : {}) };
  }
  const prepared = dedupe((Array.isArray(o.prepared) ? o.prepared : []).map(normalizeLibraryPath).filter((x): x is string => !!x)).slice(0, MUSE_PREPARED_MAX);
  const seen = new Set<string>();
  const proposed: MuseSpaceProposal[] = [];
  for (const p of Array.isArray(o.proposed) ? o.proposed : []) {
    const c = sanitizeCard(p);
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    const q = p as Record<string, unknown>;
    proposed.push({ ...c, ...(typeof q.why === 'string' && q.why.trim() ? { why: clipChars(q.why.trim(), MUSE_WHY_MAX) } : {}), ...(typeof q.at === 'string' ? { at: isoOr(q.at, new Date(0).toISOString()) } : {}) });
    if (proposed.length >= MUSE_PROPOSED_MAX) break;
  }
  return { ok: true, value: { schemaVersion: 1, rev: intOr0(o.rev), template: 'brief', hero, prepared, proposed } };
}

export function sanitizeMuseSpacePlacement(raw: unknown): SanitizeResult<MuseSpacePlacement> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'muse-space.json must be a JSON object' };
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== MUSE_SPACE_SCHEMA) return { ok: false, error: `muse-space.json schemaVersion must be ${MUSE_SPACE_SCHEMA}` };
  const keyish = (x: unknown): x is string => validMuseCardKey(x) || (MUSE_SECTIONS as readonly unknown[]).includes(x);
  const order = Array.isArray(o.order) ? dedupe(o.order.filter(validMuseCardKey)) : null;
  const hidden = dedupe((Array.isArray(o.hidden) ? o.hidden : []).filter(keyish));
  const seen = new Set<string>();
  const added: MuseSpaceCard[] = [];
  for (const c of Array.isArray(o.added) ? o.added : []) {
    const card = sanitizeCard(c);
    if (!card || seen.has(card.key)) continue;
    seen.add(card.key);
    added.push(card);
    if (added.length >= MAX_ADDED) break;
  }
  const tseen = new Set<string>();
  const tombstones: { key: string; at: string }[] = [];
  for (const t of Array.isArray(o.tombstones) ? o.tombstones : []) {
    const k = (t as Record<string, unknown> | null)?.key;
    if (!validMuseCardKey(k) || tseen.has(k)) continue;
    tseen.add(k);
    tombstones.push({ key: k, at: isoOr((t as Record<string, unknown>).at, new Date(0).toISOString()) });
  }
  return { ok: true, value: { schemaVersion: 1, rev: intOr0(o.rev), order, hidden, added, tombstones: tombstones.slice(-MAX_TOMBSTONES) } };
}

export const emptyMusePlacement = (): MuseSpacePlacement => ({ schemaVersion: 1, rev: 0, order: null, hidden: [], added: [], tombstones: [] });

const BUILTIN_CARD = (b: MuseBuiltinCard): MuseSpaceCard => ({ key: b, ref: { builtin: b } });

/** 合成后的格子(按顺序)、被藏起来的、还挂着的提议、两节显不显示。 */
export interface MuseSpaceComposed {
  cards: (MuseSpaceCard & { source: 'default' | 'added' })[];
  hidden: (MuseSpaceCard & { source: 'default' | 'added' })[];
  proposed: MuseSpaceProposal[];
  sections: { prepared: boolean; today: boolean };
}

/**
 * 合成规则(details §4 + 用户 11-08 的决定):
 *  · 格子的成员 = 缺省三张 + 你放上的(added),减去墓碑。缺省三张 = 待你看的 · 卜算子做的第一张(你接受过的它的小组件,没有就「今天」)· 在跟的。
 *  · 顺序 = 你排过的(order 里还在的)在前,其余按缺省顺序接在后面;没排过 = 缺省顺序,再接 added 的顺序。
 *  · 提议 = 卜算子挂着的、key 不在墓碑里、也还不在格子里的。
 *  · 没有卜算子那份(第一轮之前 / 读坏且没有有效版)也能合成:宿主先画内置卡。
 */
export function composeMuseSpace(doc: MuseSpaceDoc | null, placement: MuseSpacePlacement): MuseSpaceComposed {
  const dead = new Set(placement.tombstones.map((t) => t.key));
  const firstMuseWidget = placement.added.find((c) => 'widgetId' in c.ref);
  const defaults: MuseSpaceCard[] = [BUILTIN_CARD('todos'), firstMuseWidget ?? BUILTIN_CARD('today'), BUILTIN_CARD('tracking')];
  const members = new Map<string, MuseSpaceCard & { source: 'default' | 'added' }>();
  for (const c of defaults) if (!dead.has(c.key) && !members.has(c.key)) members.set(c.key, { ...c, source: placement.added.some((a) => a.key === c.key) ? 'added' : 'default' });
  for (const c of placement.added) if (!dead.has(c.key) && !members.has(c.key)) members.set(c.key, { ...c, source: 'added' });
  const ordered: string[] = [];
  for (const k of placement.order ?? []) if (members.has(k) && !ordered.includes(k)) ordered.push(k);
  for (const k of members.keys()) if (!ordered.includes(k)) ordered.push(k);
  const hiddenSet = new Set(placement.hidden);
  const all = ordered.map((k) => members.get(k)!);
  const proposed = (doc?.proposed ?? []).filter((p) => !dead.has(p.key) && !members.has(p.key));
  return {
    cards: all.filter((c) => !hiddenSet.has(c.key)),
    hidden: all.filter((c) => hiddenSet.has(c.key)),
    proposed,
    sections: { prepared: !hiddenSet.has('section:prepared'), today: !hiddenSet.has('section:today') },
  };
}

/** 你在页上做的一下。move 的 to = 在**可见格子**里的新位置。 */
export type MusePlacementOp =
  | { type: 'move'; key: string; to: number }
  | { type: 'hide'; key: string }
  | { type: 'show'; key: string }
  | { type: 'add'; card: MuseSpaceCard }
  | { type: 'accept'; key: string }
  | { type: 'reject'; key: string }
  | { type: 'reset' };

export function sanitizePlacementOp(raw: unknown): MusePlacementOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const keyish = (x: unknown): x is string => validMuseCardKey(x) || (MUSE_SECTIONS as readonly unknown[]).includes(x);
  switch (o.type) {
    case 'move': return validMuseCardKey(o.key) && Number.isInteger(o.to) && (o.to as number) >= 0 ? { type: 'move', key: o.key, to: o.to as number } : null;
    case 'hide': case 'show': return keyish(o.key) ? { type: o.type, key: o.key } : null;
    case 'add': { const card = sanitizeCard(o.card); return card ? { type: 'add', card } : null; }
    case 'accept': case 'reject': return validMuseCardKey(o.key) ? { type: o.type, key: o.key } : null;
    case 'reset': return { type: 'reset' };
    default: return null;
  }
}

/**
 * 把一下操作落到摆放上(纯函数;引擎在锁里调,rev 由调用方 +1)。
 * 返回新摆放,以及接受 / 拒绝提议时卜算子那份要摘掉的提议 key(引擎同一把锁里一起写)。不适用的操作返回 error,什么都不改。
 */
export function applyPlacementOp(doc: MuseSpaceDoc | null, p: MuseSpacePlacement, op: MusePlacementOp, now: string):
  { ok: true; placement: MuseSpacePlacement; dropProposal?: string } | { ok: false; error: string } {
  const next: MuseSpacePlacement = { ...p, order: p.order ? [...p.order] : null, hidden: [...p.hidden], added: [...p.added], tombstones: [...p.tombstones] };
  const composed = composeMuseSpace(doc, p);
  const unbury = (k: string): void => { next.tombstones = next.tombstones.filter((t) => t.key !== k); };
  switch (op.type) {
    case 'move': {
      const visible = composed.cards.map((c) => c.key);
      const from = visible.indexOf(op.key);
      if (from < 0) return { ok: false, error: `card ${op.key} is not in the grid` };
      visible.splice(from, 1);
      visible.splice(Math.min(op.to, visible.length), 0, op.key);
      // 藏起来的格子也记进顺序(排在后面),恢复显示时回到原来那一带
      next.order = [...visible, ...composed.hidden.map((c) => c.key)];
      return { ok: true, placement: next };
    }
    case 'hide':
      if (!next.hidden.includes(op.key)) next.hidden.push(op.key);
      return { ok: true, placement: next };
    case 'show':
      next.hidden = next.hidden.filter((k) => k !== op.key);
      return { ok: true, placement: next };
    case 'add': {
      // 你主动放回被拒过的卡可以,墓碑随之清掉;已在格子里(藏着)→ 取消隐藏;缺省三张拿掉过再放回 = 同上,不进 added
      unbury(op.card.key);
      next.hidden = next.hidden.filter((k) => k !== op.card.key);
      const member = composeMuseSpace(doc, next).cards.find((c) => c.key === op.card.key);
      if (member && JSON.stringify(member.ref) !== JSON.stringify(op.card.ref)) return { ok: false, error: `card ${op.card.key} already points elsewhere` };
      if (!member) {
        if (next.added.length >= MAX_ADDED) return { ok: false, error: 'too many cards' };
        next.added = [...next.added, op.card];
      }
      if (next.order) next.order = [...next.order.filter((k) => k !== op.card.key), op.card.key];
      return { ok: true, placement: next };
    }
    case 'accept': {
      const prop = doc?.proposed.find((x) => x.key === op.key);
      if (!prop) return { ok: false, error: `no proposal ${op.key}` };
      unbury(op.key);
      if (next.added.length >= MAX_ADDED) return { ok: false, error: 'too many cards' };
      next.added = [...next.added.filter((c) => c.key !== op.key), { key: prop.key, ref: prop.ref }];
      next.hidden = next.hidden.filter((k) => k !== op.key);
      if (next.order) next.order = [...next.order.filter((k) => k !== op.key), op.key];
      return { ok: true, placement: next, dropProposal: op.key };
    }
    case 'reject':
      if (!next.tombstones.some((t) => t.key === op.key)) next.tombstones = [...next.tombstones, { key: op.key, at: now }].slice(-MAX_TOMBSTONES);
      return { ok: true, placement: next, dropProposal: op.key };
    case 'reset':
      // 恢复默认:清你的摆放,不清墓碑
      return { ok: true, placement: { schemaVersion: 1, rev: p.rev, order: null, hidden: [], added: [], tombstones: next.tombstones } };
  }
}

function dedupe<T>(xs: T[]): T[] { return [...new Set(xs)]; }
/** 按 Unicode 字符截,不把代理对切成两半。 */
export function clipChars(s: string, max: number): string { const a = Array.from(s); return a.length > max ? a.slice(0, max).join('') : s; }

/** GET /agent/special/muse/space 的回包。 */
export interface MuseSpaceView {
  enabled: boolean;
  /** 卜算子那份是否存在(第一轮之前 = false,宿主画占位) */
  hasDoc: boolean;
  hero: { text: string; at: number; sources: string[] } | null;
  /** 只列还在的,最新的在前,≤3 */
  prepared: { path: string; title: string; mtime: number }[];
  cards: MuseSpaceComposed['cards'];
  hidden: MuseSpaceComposed['hidden'];
  proposed: MuseSpaceProposal[];
  sections: MuseSpaceComposed['sections'];
  rev: { doc: number; placement: number };
  /** 读坏的那份(用的是最后一份有效的);空 = 都好 */
  problems: { file: 'space' | 'placement'; message: string }[];
  /** 停用时横条写「下面是 … 停下前留的」的那个时刻(那句话的时间,没有就上次醒来);开着时 null */
  stoppedAt: number | null;
}
