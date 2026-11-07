/**
 * 记忆的遥测计数(帮助改进 v2 契约 §7 daily_memory;human 的写入计数在 humanTelemetry.ts,每日快照在 telemetrySnapshot.ts)。账本见 telemetryLedger.ts。
 * 这里只把引擎已经知道的事(动作、范围、来源、条数)翻成白名单里的枚举键;记忆正文只在本机比一下是不是同一句,比完只记次数。
 */
import { basename, dirname, resolve } from 'node:path';
import { agentsDir } from '../core/tanguHome.js';
import { ledger, agentRoleOf, type AgentRole } from './telemetryLedger.js';
import { isMemoryTombstoneActive, memoryFactFingerprint, normalizeMemoryFact, setMemoryCommitObserver, type MemoryEntry, type MemorySnapshot, type MemorySource } from './memoryRepository.js';
import { getAgent } from '../agents/agentRegistry.js';
import { noteColdstartPersonWrite } from './humanTelemetry.js';
import { MEMORY_FORGET_REASONS, type MemoryForgetReason } from '../contracts/clientTypes.js';

const WEEK = 7 * 86_400_000;

/** 记忆目录 → 账本维度:只有 agents/<slug>/ 算某个 Agent 的记忆;项目记忆等别的目录 → null(不按 Agent 计)。 */
export function memoryRoleOfDir(baseDir: string): AgentRole | null {
  try {
    const dir = resolve(baseDir);
    return dirname(dir) === resolve(agentsDir()) ? agentRoleOf(basename(dir)) : null;
  } catch { return null; }
}

const SRC = {
  explicit: 'srcExplicit', historian: 'srcHistorian', dream: 'srcDream', manual: 'srcManual',
  restore: 'srcRestore', 'external-edit': 'srcExternalEdit', sync: 'srcSync', migration: 'srcMigration',
} as const;

/** memoryRepository 每次落盘后报一声(只有来源种类)。 */
export function noteMemoryCommit(baseDir: string, kind: MemorySource['kind']): void {
  const role = memoryRoleOfDir(baseDir);
  const field = SRC[kind];
  if (role && field) ledger.inc('daily_memory', field, { dim: role });
}
setMemoryCommitObserver(noteMemoryCommit);

const SCOPE_FIELD = {
  add: { agent: 'addAgent', project: 'addProject', person: 'addPerson' },
  update: { agent: 'updateAgent', project: 'updateProject', person: 'updatePerson' },
  forget: { agent: 'forgetAgent', project: 'forgetProject', person: 'forgetPerson' },
} as const;
type Scope = 'agent' | 'project' | 'person';
type Action = keyof typeof SCOPE_FIELD;

/**
 * remember 工具的一次调用:跑完按回执计数(成功是 ok:true 的 JSON,失败以 Error 开头),抛出去的版本冲突单记。
 * 回执的字句只用来分类,一个字也不进账本。slug = 写的那个 Agent(显示身份)。
 */
export async function countRemember(slug: string, args: Record<string, any>, run: () => Promise<string>): Promise<string> {
  let out: string;
  try { out = await run(); } catch (e) { noteRememberThrow(slug, e); throw e; }
  noteRememberOutcome(slug, String(args?.action ?? 'add'), out, typeof args?.fact === 'string' ? args.fact.trim() : '');
  return out;
}

const VERSION_CONFLICT = /expectedVersion is not current|not a version of this memory|changed since it was listed|changed (?:during|while) the/;
export function noteRememberOutcome(slug: string | undefined, action: string, out: unknown, fact = ''): void {
  try {
    const dim = agentRoleOf(slug);
    const text = typeof out === 'string' ? out : '';
    if (text === '已记入长期记忆。') { ledger.inc('daily_memory', 'addAgent', { dim }); return; } // 没有条目管理的旧后台
    if (text.startsWith('Error')) {
      if (/portrait is full/.test(text)) ledger.inc('daily_memory', 'errPortraitFull', { dim });
      else if (/memory is full/.test(text)) ledger.inc('daily_memory', 'errFull', { dim });
      else if (VERSION_CONFLICT.test(text)) ledger.inc('daily_memory', 'errVersionConflict', { dim });
      return;
    }
    let r: any;
    try { r = JSON.parse(text); } catch { return; }
    if (!r?.ok) return;
    const a = (['add', 'update', 'forget'] as const).includes(r.action) ? (r.action as Action) : null;
    const scope = (['agent', 'project', 'person'] as const).includes(r.scope) ? (r.scope as Scope) : null;
    if (!a || !scope) return;
    if (r.moved) ledger.inc('daily_memory', 'moveScope', { dim });
    if (scope === 'person' && a !== 'forget' && fact) notePersonWrite(slug, fact, !!r.duplicate);
    // 原样已有、什么也没写的 add 不算一次写入;画像的重复在这里记重述(agent / project 的在写之前比,见 noteRetell)
    if (r.duplicate && a === 'add') { if (scope === 'person') ledger.inc('daily_memory', 'retellExisting', { dim }); return; }
    ledger.inc('daily_memory', SCOPE_FIELD[a][scope], { dim });
  } catch { /* 计数不挡业务 */ }
}
/** remember 工具抛出来的(没被它自己接住的)错误:版本冲突单独记。 */
export function noteRememberThrow(slug: string | undefined, e: unknown): void {
  try {
    if ((e as any)?.code === 'MEMORY_VERSION_CONFLICT') ledger.inc('daily_memory', 'errVersionConflict', { dim: agentRoleOf(slug) });
  } catch { /* 同上 */ }
}
/** 往画像写(add / update)的那个 Agent 建好还不满 7 天 → 冷启动计数(要读 Agent 的建立时间,异步、不等)。 */
function notePersonWrite(slug: string | undefined, fact: string, duplicate: boolean): void {
  if (!slug) return;
  void getAgent(slug).then((def) => { if (def) noteColdstartPersonWrite(def.createdAt, fact, duplicate); }).catch(() => {});
}

/**
 * 这句话之前就记过(现有条目)/ 被忘掉过(墓碑):本机按归一后的原文比,只记次数。用户在反复说同一件事 = 上次没记住、没用上或删错了。
 * 同一个 run 里刚写的那条不算(模型自己连发两次,不是用户又说了一遍)。
 */
export function noteRetell(slug: string | undefined, before: Pick<MemorySnapshot, 'entries' | 'tombstones'> | undefined, fact: string, runId?: string): void {
  try {
    if (!before || !fact) return;
    const dim = agentRoleOf(slug);
    const norm = normalizeMemoryFact(fact);
    if (before.entries.some((e) => normalizeMemoryFact(e.content) === norm && !(runId && e.source?.runId === runId))) { ledger.inc('daily_memory', 'retellExisting', { dim }); return; }
    const fp = memoryFactFingerprint(fact);
    if ((before.tombstones || []).some((t) => isMemoryTombstoneActive(t) && t.fingerprint === fp)) ledger.inc('daily_memory', 'retellForgotten', { dim });
  } catch { /* 同上 */ }
}

/** 这一条是 Agent 写的(来源不是手动)、而且是 7 天内写的:用户改掉 / 删掉它 = 间接的「记错了」。 */
const agentWrittenRecently = (e: MemoryEntry | undefined, now = Date.now()): boolean =>
  !!e && e.source?.kind !== 'manual' && now - Number(e.createdAt) <= WEEK;

/** 记忆页上逐条改(POST /agent/agents/:slug/memory/entries)。 */
/** 遗忘理由 → 账本字段(daily_memory,按 agentRole)。 */
const FORGET_REASON_FIELD = { wrong: 'userForgetWrong', stale: 'userForgetStale', unwanted: 'userForgetUnwanted', duplicate: 'userForgetDuplicate' } as const satisfies Record<MemoryForgetReason, string>;
/** 客户端传来的遗忘理由:只认表里的四个,别的(含非字符串)当没给。 */
export function memoryForgetReason(x: unknown): MemoryForgetReason | undefined {
  return typeof x === 'string' && (MEMORY_FORGET_REASONS as readonly string[]).includes(x) ? (x as MemoryForgetReason) : undefined;
}
export function noteUserEntryEdit(slug: string, action: string, old: MemoryEntry | undefined, reason?: unknown): void {
  try {
    const dim = agentRoleOf(slug);
    if (action === 'add') ledger.inc('daily_memory', 'userAdd', { dim });
    else if (action === 'update') {
      ledger.inc('daily_memory', 'userEdit', { dim });
      if (agentWrittenRecently(old)) ledger.inc('daily_memory', 'userEditAgentWritten7d', { dim });
    } else if (action === 'forget') {
      ledger.inc('daily_memory', 'userForget', { dim });
      if (agentWrittenRecently(old)) ledger.inc('daily_memory', 'userForgetAgentWritten7d', { dim });
      const why = memoryForgetReason(reason);
      if (why) ledger.inc('daily_memory', FORGET_REASON_FIELD[why], { dim });
    }
  } catch { /* 同上 */ }
}
/** 记忆页上整份改(PUT):按条目 id 比前后,删掉的记 forget、新出现的记 add(整份编辑里改一个字也是一删一加,分不出「改」)。 */
export function noteUserDocumentEdit(slug: string, before: MemorySnapshot, after: MemorySnapshot): void {
  try {
    const dim = agentRoleOf(slug);
    const kept = new Set(after.entries.map((e) => e.id));
    const had = new Set(before.entries.map((e) => e.id));
    const removed = before.entries.filter((e) => !kept.has(e.id));
    const added = after.entries.filter((e) => !had.has(e.id)).length;
    if (removed.length) ledger.inc('daily_memory', 'userForget', { dim, n: removed.length });
    const recent = removed.filter((e) => agentWrittenRecently(e)).length;
    if (recent) ledger.inc('daily_memory', 'userForgetAgentWritten7d', { dim, n: recent });
    if (added) ledger.inc('daily_memory', 'userAdd', { dim, n: added });
  } catch { /* 同上 */ }
}
/** 还原到某一版:要回来的条目里,有哪些是这一版之后被某次 Dream 整理拿掉的(按 Dream 前后两版的条目比,归一原文)。
 *  revisions = repo.revisions()(新的在前,第 0 条是当前这一版)。 */
export function noteUserRestore(slug: string, revisions: Array<{ version: string; source: MemorySource; entries: Array<{ content: string }> }>, version: string, before: MemorySnapshot, after: MemorySnapshot): void {
  try {
    const at = revisions.findIndex((r) => r.version === version);
    if (at <= 0) return;
    const facts = (r: { entries: Array<{ content: string }> }): Set<string> => new Set(r.entries.map((e) => normalizeMemoryFact(e.content)));
    const retired = new Set<string>();
    for (let i = 0; i < at; i++) { // revisions[i] 由 revisions[i + 1] 变来
      if (revisions[i].source?.kind !== 'dream') continue;
      const kept = facts(revisions[i]);
      for (const f of facts(revisions[i + 1])) if (!kept.has(f)) retired.add(f);
    }
    if (!retired.size) return;
    const had = facts(before);
    const back = after.entries.filter((e) => { const f = normalizeMemoryFact(e.content); return !had.has(f) && retired.has(f); }).length;
    if (back) ledger.inc('daily_memory', 'userRestoreDreamRetired', { dim: agentRoleOf(slug), n: back });
  } catch { /* 同上 */ }
}
