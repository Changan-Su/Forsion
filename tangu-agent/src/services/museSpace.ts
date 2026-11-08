/**
 * Muse Space「今日简报」两份布局文件的读写(2026-11-08,方案 D 第一期)。规则(校验、合成、摆放操作)全在 contracts/museSpace.ts,
 * 这里只管 IO:
 *   卜算子那份  agents/muse/Space/space.json      卜算子经 muse_space 工具写;它也能 write_file 直接改 → 读时一律过 sanitize。
 *   你的摆放    <tangu home>/ui/muse-space.json   宿主经 POST /agent/special/muse/space/placement 写,在卜算子的免审目录之外。
 *   最后一份有效的  <tangu home>/ui/muse-space.doc.good.json / muse-space.good.json:同样放在卜算子的可写目录之外,
 *             每次读到 / 写出一份有效的就刷新(内容没变不写)。
 *
 * 读:文件不存在 = 没有(卜算子那份 null、摆放 = 空摆放),不算问题。读不出(ENOENT 以外的 IO 错、软链、坏 JSON、校验不过)
 *     = 用最后一份有效的,并在 problems 里记一条 —— **读失败 ≠ 空**,也绝不改写 / 「修好」那份坏文件。
 *     hasDoc = 手里有一份有效的卜算子文档(本份或最后一份有效的);文件在但坏了又没有有效版 → hasDoc false + 一条问题。
 * 写:两份共用一把进程内锁(读也拿锁:读时刷新「最后一份有效的」会和写撞);带 expectedRev,对不上回最新;atomicSyncWrite 原子替换
 *     (拒软链);rev = 旧 rev + 1。哪一份读坏了就**拒写**那一份(方案 §4「坏 JSON 用最后一份有效的,拒写,不重新播种」):
 *     卜算子那份坏了,muse_space update 报错并把最后一份有效的交给它自己用 write_file 恢复;你的摆放坏了,摆放操作 409。
 *     接受 / 拒绝提议时卜算子那份坏了 → 只写摆放、不碰它(合成本来就把已接受 / 已拒绝的 key 从提议里滤掉)。
 *
 * 不 import services/muse.ts:工具要用这里,而 muse.ts 经 agentLoop → registry 反向依赖工具,直接 import 成环。
 * Library / Space 两个目录因此住在这里,muse.ts 转出口。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { agentsDir, tanguHome } from '../core/tanguHome.js';
import { MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';
import { atomicSyncWrite, readSyncBytes } from './agentSyncPaths.js';
import { loadSpecialAgentsConfig } from './specialAgentsConfig.js';
import { readLastCycleAt } from './museState.js';
import {
  applyPlacementOp, composeMuseSpace, emptyMusePlacement, normalizeLibraryPath, sanitizeMuseSpaceDoc, sanitizeMuseSpacePlacement,
  MUSE_PREPARED_MAX, type MusePlacementOp, type MuseSpaceComposed, type MuseSpaceDoc, type MuseSpacePlacement, type MuseSpaceView, type SanitizeResult,
} from '../contracts/museSpace.js';

/** Muse 的工作区 = 自己的 Library(桌面 Muse Space 的「备好的」/ 手记都从这里读)。 */
export function museLibraryDir(): string {
  return path.join(agentsDir(), MUSE_AGENT_SLUG, 'Library');
}
/** Muse 的 Space 目录:今天只有 space.json 被宿主读(11-08 起 main.js 不再加载,留在盘上不删)。三档权限都把它并入可写根。 */
export function museSpaceDir(): string {
  return path.join(agentsDir(), MUSE_AGENT_SLUG, 'Space');
}
export const museSpaceDocFile = (): string => path.join(museSpaceDir(), 'space.json');
export const musePlacementFile = (): string => path.join(tanguHome(), 'ui', 'muse-space.json');
const docGoodFile = (): string => path.join(tanguHome(), 'ui', 'muse-space.doc.good.json');
const placementGoodFile = (): string => path.join(tanguHome(), 'ui', 'muse-space.good.json');

export type MuseSpaceProblem = MuseSpaceView['problems'][number];

let chain: Promise<unknown> = Promise.resolve();
/** 两份文件共用的一把锁(单进程:引擎是唯一的写者;卜算子 write_file 直改不走这里,读时校验兜住)。 */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

interface FileRead<T> {
  /** 手里这份有效的(本份或最后一份有效的);null = 没有 */
  value: T | null;
  /** 本份读坏了(此时 value 来自最后一份有效的或为 null) */
  problem?: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const jsonText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function readGood<T>(file: string, sanitize: (raw: unknown) => SanitizeResult<T>): T | null {
  try {
    const bytes = readSyncBytes(tanguHome(), file);
    if (!bytes) return null;
    const r = sanitize(JSON.parse(bytes.toString('utf8')));
    return r.ok ? r.value : null;
  } catch { return null; }
}
/** 刷新「最后一份有效的」:内容一样不写;写失败只记日志(它是备份,不该让正事失败)。 */
function refreshGood(file: string, value: unknown): void {
  const text = jsonText(value);
  try {
    const cur = readSyncBytes(tanguHome(), file);
    if (cur && cur.toString('utf8') === text) return;
    atomicSyncWrite(tanguHome(), file, text);
  } catch (e) { console.warn(`[muse-space] 刷新 ${path.basename(file)} 失败:${errText(e)}`); }
}

function readOne<T>(root: string, file: string, goodFile: string, sanitize: (raw: unknown) => SanitizeResult<T>): FileRead<T> {
  let bytes: Buffer | null;
  try { bytes = readSyncBytes(root, file); } catch (e) {
    return { value: readGood(goodFile, sanitize), problem: `cannot be read (${errText(e)})` };
  }
  if (!bytes) return { value: null };
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch {
    return { value: readGood(goodFile, sanitize), problem: 'is not valid JSON' };
  }
  const r = sanitize(raw);
  if (!r.ok) return { value: readGood(goodFile, sanitize), problem: r.error };
  refreshGood(goodFile, r.value);
  return { value: r.value };
}

interface Both { doc: FileRead<MuseSpaceDoc>; placement: FileRead<MuseSpacePlacement> }
function readBoth(): Both {
  return {
    doc: readOne(agentsDir(), museSpaceDocFile(), docGoodFile(), sanitizeMuseSpaceDoc),
    placement: readOne(tanguHome(), musePlacementFile(), placementGoodFile(), sanitizeMuseSpacePlacement),
  };
}
function problemsOf(b: Both): MuseSpaceProblem[] {
  const out: MuseSpaceProblem[] = [];
  if (b.doc.problem) out.push({ file: 'space', message: `space.json ${b.doc.problem}${b.doc.value ? '; showing the last valid version' : ''}` });
  if (b.placement.problem) out.push({ file: 'placement', message: `muse-space.json ${b.placement.problem}${b.placement.value ? '; showing the last valid version' : ''}` });
  return out;
}

function writeDoc(doc: MuseSpaceDoc): void {
  atomicSyncWrite(agentsDir(), museSpaceDocFile(), jsonText(doc));
  refreshGood(docGoodFile(), doc);
}
function writePlacement(p: MuseSpacePlacement): void {
  atomicSyncWrite(tanguHome(), musePlacementFile(), jsonText(p));
  refreshGood(placementGoodFile(), p);
}

/**
 * Library 里一个文件还在不在(「备好的」只列还在的)。口径同 GET /agent/special/muse/library/file:相对路径、无 ..、无隐藏段,
 * realpath 之后仍须在 Library 内、解析后的路径也不含隐藏段(软链指出去 / 指向隐藏文件的一律当不在)。不在 / 不合法 → null。
 */
export async function libraryFileStat(rel: string): Promise<{ path: string; mtime: number } | null> {
  const norm = normalizeLibraryPath(rel);
  if (!norm) return null;
  try {
    const root = museLibraryDir();
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(path.resolve(root, norm));
    if (!real.startsWith(realRoot + path.sep)) return null;
    if (path.relative(realRoot, real).split(path.sep).some((s) => s.startsWith('.'))) return null;
    const st = await fs.stat(real);
    return st.isFile() ? { path: norm, mtime: st.mtimeMs } : null;
  } catch { return null; }
}

const titleOf = (p: string): string => { const base = p.slice(p.lastIndexOf('/') + 1); const dot = base.lastIndexOf('.'); return dot > 0 ? base.slice(0, dot) : base; };

async function composeView(b: Both): Promise<MuseSpaceView> {
  const doc = b.doc.value;
  const placement = b.placement.value ?? emptyMusePlacement();
  const composed = composeMuseSpace(doc, placement);
  const prepared = (await Promise.all((doc?.prepared ?? []).map(libraryFileStat)))
    .filter((x): x is { path: string; mtime: number } => !!x)
    .sort((a, c) => c.mtime - a.mtime)
    .slice(0, MUSE_PREPARED_MAX)
    .map((x) => ({ path: x.path, title: titleOf(x.path), mtime: x.mtime }));
  const heroAt = doc?.hero ? Date.parse(doc.hero.at) || 0 : 0;
  const enabled = loadSpecialAgentsConfig().muse.enabled;
  return {
    enabled,
    hasDoc: !!doc,
    libraryRoot: museLibraryDir(),
    hero: doc?.hero ? { text: doc.hero.text, at: heroAt, sources: doc.hero.sources ?? [] } : null,
    prepared,
    cards: composed.cards,
    hidden: composed.hidden,
    proposed: composed.proposed,
    sections: composed.sections,
    rev: { doc: doc?.rev ?? 0, placement: placement.rev },
    problems: problemsOf(b),
    stoppedAt: enabled ? null : (heroAt || (await readLastCycleAt().catch(() => 0)) || null),
  };
}

/** GET /agent/special/muse/space。 */
export function museSpaceView(): Promise<MuseSpaceView> {
  return locked(() => composeView(readBoth()));
}

export type PlacementResult =
  | { ok: true; view: MuseSpaceView }
  | { ok: false; reason: 'conflict' | 'unreadable' | 'invalid'; detail: string; view: MuseSpaceView };

/**
 * 你在页上做的一下(宿主经路由调)。摆放读坏 → 拒写;rev 对不上 → 冲突回最新;操作不适用(格子变了)→ 回最新让宿主重画。
 * 接受 / 拒绝提议:同一把锁里把那条提议从卜算子那份摘掉(那份 rev + 1);那份读坏了就不碰它。
 */
export function applyMusePlacement(expectedRev: number, op: MusePlacementOp, now = Date.now()): Promise<PlacementResult> {
  return locked(async () => {
    const b = readBoth();
    if (b.placement.problem) return { ok: false, reason: 'unreadable', detail: `muse-space.json ${b.placement.problem}; nothing was saved`, view: await composeView(b) };
    const placement = b.placement.value ?? emptyMusePlacement();
    if (placement.rev !== expectedRev) return { ok: false, reason: 'conflict', detail: `placement is at rev ${placement.rev}, not ${expectedRev}`, view: await composeView(b) };
    const r = applyPlacementOp(b.doc.value, placement, op, new Date(now).toISOString());
    if (!r.ok) return { ok: false, reason: 'invalid', detail: r.error, view: await composeView(b) };
    writePlacement({ ...r.placement, rev: placement.rev + 1 });
    const doc = b.doc.value;
    if (r.dropProposal && doc && !b.doc.problem && doc.proposed.some((x) => x.key === r.dropProposal)) {
      try { writeDoc({ ...doc, rev: doc.rev + 1, proposed: doc.proposed.filter((x) => x.key !== r.dropProposal) }); }
      catch (e) { console.warn(`[muse-space] 摘提议 ${r.dropProposal} 失败(合成照样滤掉它):${errText(e)}`); }
    }
    return { ok: true, view: await composeView(readBoth()) };
  });
}

/** 工具读到的整份状态(合成 + 原样的两份 + 问题)。 */
export interface MuseSpaceState {
  doc: MuseSpaceDoc | null;
  /** 卜算子那份读坏了(值来自最后一份有效的或为 null) */
  docProblem?: string;
  placement: MuseSpacePlacement;
  /** 摆放读坏了且没有最后一份有效的:墓碑不知道 → 不许提议 */
  placementUnknown: boolean;
  composed: MuseSpaceComposed;
  problems: MuseSpaceProblem[];
}
function stateOf(b: Both): MuseSpaceState {
  const placement = b.placement.value ?? emptyMusePlacement();
  return {
    doc: b.doc.value, ...(b.doc.problem ? { docProblem: b.doc.problem } : {}),
    placement, placementUnknown: !!b.placement.problem && !b.placement.value,
    composed: composeMuseSpace(b.doc.value, placement), problems: problemsOf(b),
  };
}
export function readMuseSpaceState(): Promise<MuseSpaceState> {
  return locked(async () => stateOf(readBoth()));
}

export const emptyMuseDoc = (): MuseSpaceDoc => ({ schemaVersion: 1, rev: 0, template: 'brief', hero: null, prepared: [], proposed: [] });

export type DocUpdateResult =
  | { ok: true; doc: MuseSpaceDoc; changed: boolean }
  | { ok: false; reason: 'conflict'; state: MuseSpaceState }
  | { ok: false; reason: 'unreadable'; error: string; lastGood: MuseSpaceDoc | null }
  | { ok: false; reason: 'invalid'; error: string };

/**
 * 卜算子改自己那份(muse_space update)。mutate 拿到当前状态,回新文档(rev 由这里定)或错误;都在锁里。
 * 那份读坏了 → 拒写,把最后一份有效的交回去;rev 对不上 → 回最新状态;内容没变 → 不写(changed false)。
 * 顺手:写出去的提议只留还挂着的(墓碑里的、已在格子里的摘掉),免得陈旧的占着三张的名额。
 */
export function updateMuseDoc(expectedRev: number, mutate: (s: MuseSpaceState) => { ok: true; doc: MuseSpaceDoc } | { ok: false; error: string }): Promise<DocUpdateResult> {
  return locked(async () => {
    const b = readBoth();
    if (b.doc.problem) return { ok: false, reason: 'unreadable', error: `space.json ${b.doc.problem}`, lastGood: b.doc.value };
    const s = stateOf(b);
    const cur = s.doc ?? emptyMuseDoc();
    if (cur.rev !== expectedRev) return { ok: false, reason: 'conflict', state: s };
    const r = mutate(s);
    if (!r.ok) return { ok: false, reason: 'invalid', error: r.error };
    const pending = new Set(composeMuseSpace(r.doc, s.placement).proposed.map((p) => p.key));
    const body = { ...r.doc, proposed: r.doc.proposed.filter((p) => pending.has(p.key)) };
    const check = sanitizeMuseSpaceDoc(body);
    if (!check.ok) return { ok: false, reason: 'invalid', error: check.error };
    const same = (x: MuseSpaceDoc): string => JSON.stringify({ ...x, rev: 0 });
    if (s.doc && same(check.value) === same(s.doc)) return { ok: true, doc: s.doc, changed: false };
    const next = { ...check.value, rev: cur.rev + 1 };
    writeDoc(next);
    return { ok: true, doc: next, changed: true };
  });
}
