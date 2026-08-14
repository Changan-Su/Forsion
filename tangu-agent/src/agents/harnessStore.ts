/**
 * Per-agent 自进化工作笔记(subharness)—— `agents/<slug>/HARNESS.md` 的唯一读写点。
 * (借 prime-agent Continual Harness:小步、有证据的增量编辑 + 快照可回滚;评审见
 *  docs 与记忆 project_tangu_continual_harness_borrow。)
 *
 * 三层分工:SOUL.md/developer_instructions = 用户拥有的人格(agent 不可自改);MEMORY.md =
 * 「世界是什么样」;HARNESS.md = 「我该怎么干活」—— agent 唯一自有、可进化的层,经 manage_harness
 * 工具走审批写入,每次改动在 `.harness-refinements.jsonl` 留 before/after 快照,可回滚。
 *
 * 格式(人可读可手改,保持 `## [id] 标题 (kind)` 的抬头形状即可):
 *   ## [h-x3k9] 评审必须先跑测试 (note)
 *   - evidence: 2026-08-11/13 两次被用户纠正
 *   - created: 2026-08-11
 *   - updated: 2026-08-13 v2
 *
 *   正文……
 *
 * 写入时封顶(30 条 × 正文 300 字)而非渲染时截断:小抄永远全文进系统提示,没有「模型只看得到
 * 摘要、全文怎么读」的洞;超限工具直接报错,逼 agent 先合并/淘汰弱条(资源约束=进化压力)。
 * 未知 kind / 未知 meta 行解析时原样保留(扩展性契约:新 kind 只增不改,旧版渲染器忽略并保留)。
 *
 * 与跨设备同步的关系(设计取舍,勿当 bug 修):HARNESS.md 走 agentFileSync 全文件镜像
 * (LWW+冲突副本),对端改动**不经本管线**、不进本机 journal——journal 只是**本设备**的编辑史,
 * rollback 恢复的是本机视角的上一版,可能盖掉刚同步进来的对端版本(rollback 自身也留快照,可再撤)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { agentsDir } from '../core/tanguHome.js';
import { redactSecrets } from '../core/redact.js';

export const HARNESS_FILE = 'HARNESS.md';
/** 快照史(dot-file → agentFileSync 自动排除,只留本机)。 */
export const HARNESS_JOURNAL_FILE = '.harness-refinements.jsonl';

export const MAX_ENTRIES = 30;
export const TITLE_MAX = 80;
export const BODY_MAX = 300;
export const EVIDENCE_MAX = 200;

export interface HarnessEntry {
  id: string;
  /** 'note'(工作方法) | 'recipe'(委托配方);未知值保留原样。 */
  kind: string;
  title: string;
  body: string;
  evidence?: string;
  createdAt: string; // YYYY-MM-DD
  updatedAt: string;
  version: number;
  /** 手改时留下的未识别 meta 行(`- key: value`),序列化原样带回。 */
  extraMeta?: string[];
}

export interface HarnessEditInput {
  action: 'upsert' | 'delete' | 'rollback';
  id?: string;
  kind?: string;
  title?: string;
  body?: string;
  evidence?: string;
}

interface JournalLine {
  ts: string;
  action: 'upsert' | 'delete' | 'rollback';
  entryId: string;
  before: HarnessEntry | null;
  after: HarnessEntry | null;
  sessionId?: string;
}

const HEADER =
  '# Working Notes\n' +
  '<!-- managed by the manage_harness tool; hand-edits are OK — keep the "## [id] title (kind)" heading shape -->\n';

const HEADING_RE = /^## \[([a-z0-9][a-z0-9-]*)\]\s*(.*)$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function harnessPath(slug: string): string {
  return path.join(agentsDir(), slug, HARNESS_FILE);
}
function journalPath(slug: string): string {
  return path.join(agentsDir(), slug, HARNESS_JOURNAL_FILE);
}
const today = (): string => new Date().toISOString().slice(0, 10);

/** 解析 HARNESS.md → 条目列表。首个 `## [id]` 之前的前言忽略(序列化重生成固定 HEADER)。
 *  CRLF 归一为 LF;meta 段止于首个空行(其后 `- key: value` 形状的行属正文,不再被吞进 extraMeta)。 */
export function parseHarness(raw: string): HarnessEntry[] {
  const out: HarnessEntry[] = [];
  let cur: HarnessEntry | null = null;
  let bodyLines: string[] = [];
  let inMeta = false;
  const flush = (): void => {
    if (!cur) return;
    cur.body = bodyLines.join('\n').trim();
    out.push(cur);
    cur = null;
    bodyLines = [];
  };
  for (const line of raw.split(/\r?\n/)) {
    const h = line.match(HEADING_RE);
    if (h) {
      flush();
      let title = h[2].trim();
      let kind = 'note';
      const k = title.match(/\(([a-z][a-z0-9-]*)\)$/);
      if (k) {
        kind = k[1];
        title = title.slice(0, -k[0].length).trim();
      }
      cur = { id: h[1], kind, title, body: '', createdAt: '', updatedAt: '', version: 1 };
      inMeta = true;
      continue;
    }
    if (!cur) continue; // 前言
    if (!line.trim()) {
      if (inMeta) { inMeta = false; continue; } // meta→正文的分隔空行,消费掉
      bodyLines.push(line); // 正文内部空行(多段落)保留
      continue;
    }
    if (inMeta) {
      const m = line.match(/^- ([a-z][\w-]*):\s*(.*)$/i);
      if (m) {
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === 'evidence') cur.evidence = val;
        else if (key === 'created') cur.createdAt = val;
        else if (key === 'updated') {
          const uv = val.match(/^(\S+)(?:\s+v(\d+))?$/);
          cur.updatedAt = uv?.[1] ?? val;
          if (uv?.[2]) cur.version = parseInt(uv[2], 10) || 1;
        } else (cur.extraMeta ??= []).push(line);
        continue;
      }
      inMeta = false; // 非 meta 形状 → 提前进入正文
    }
    bodyLines.push(line);
  }
  flush();
  return out;
}

export function serializeHarness(entries: HarnessEntry[]): string {
  const blocks = entries.map((e) => {
    const lines = [`## [${e.id}] ${e.title} (${e.kind})`];
    if (e.evidence) lines.push(`- evidence: ${e.evidence}`);
    if (e.createdAt) lines.push(`- created: ${e.createdAt}`);
    lines.push(`- updated: ${e.updatedAt || e.createdAt || today()}${e.version > 1 ? ` v${e.version}` : ''}`);
    for (const x of e.extraMeta ?? []) lines.push(x);
    return lines.join('\n') + (e.body ? `\n\n${e.body}` : '');
  });
  return `${HEADER}\n${blocks.join('\n\n')}\n`;
}

export async function loadHarness(slug: string): Promise<HarnessEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(harnessPath(slug), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e; // 读失败≠空文件:当成空会让下一次写覆盖整份现有笔记(Codex 评审 #6)
  }
  return parseHarness(raw);
}

async function saveHarness(slug: string, entries: HarnessEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(harnessPath(slug)), { recursive: true });
  await fs.writeFile(harnessPath(slug), serializeHarness(entries), 'utf-8');
}

async function appendJournal(slug: string, line: JournalLine): Promise<void> {
  await fs.mkdir(path.dirname(journalPath(slug)), { recursive: true });
  await fs.appendFile(journalPath(slug), JSON.stringify(line) + '\n', 'utf-8');
}

/** 读快照史(坏行跳过,单条脏数据不毁回滚)。 */
export async function readJournal(slug: string): Promise<JournalLine[]> {
  let raw: string;
  try {
    raw = await fs.readFile(journalPath(slug), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e; // 同 loadHarness:读失败别谎报「无历史」
  }
  const out: JournalLine[] = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* skip */ }
  }
  return out;
}

function newId(taken: Set<string>): string {
  // ponytail: 4 位随机 id,36^4≈168万,30 条封顶下碰撞重摇即可
  for (;;) {
    const id = 'h-' + Math.random().toString(36).slice(2, 6).padEnd(4, '0');
    if (!taken.has(id)) return id;
  }
}

// ── 字段清洗(写入即不变量) ─────────────────────────────────────────────────
/** 单行字段:脱敏+空白折叠(换行注入会伪造条目抬头/绕过封顶,Codex 评审 #8)。 */
function cleanLine(s: unknown, max: number, label: string): string {
  const v = redactSecrets(String(s ?? '')).replace(/\s+/g, ' ').trim();
  if (v.length > max) throw new Error(`${label} 超长(${v.length} > ${max});请精炼后重试`);
  return v;
}
/** 正文:脱敏+去 \r;不许包含条目抬头形状的行(会被解析成新条目)。 */
function cleanBody(s: unknown): string {
  const v = redactSecrets(String(s ?? '').replace(/\r/g, '')).trim();
  if (v.length > BODY_MAX) throw new Error(`body 超长(${v.length} > ${BODY_MAX});请精炼后重试`);
  if (v.split('\n').some((l) => HEADING_RE.test(l))) throw new Error('body 不能包含形如 "## [id] …" 的行(会被解析成新条目);请改写该行');
  return v;
}
const cleanKind = (s: unknown): string => {
  const v = String(s ?? '').trim();
  return /^[a-z][a-z0-9-]*$/.test(v) ? v : 'note';
};

// 同 agent 并发写串行化(同一引擎进程内多会话;Codex 评审 #5)。
// ponytail: 进程内 promise 链;跨进程并发(极罕见)仍是 LWW,journal 里两条都有据可查。
const writeLocks = new Map<string, Promise<unknown>>();

function withSlugLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(slug) ?? Promise.resolve();
  const job = prev.catch(() => {}).then(fn);
  writeLocks.set(slug, job);
  return job.finally(() => {
    if (writeLocks.get(slug) === job) writeLocks.delete(slug);
  });
}

/**
 * 唯一正典写点:校验 → journal 快照(WAL 式先行:save 失败只多一行 before=盘面现状的日志,
 * 回滚无害;反序会出现无快照的已生效改动) → 落盘。校验不过抛 Error(工具把 message 回给模型,
 * 模型自行改短重试——比静默截断诚实)。rollback = 恢复该条上一次改动前的状态(连续 rollback 会在
 * 最近两版间往返;完整历史在 journal,深回溯归 P2 UI)。
 */
export async function applyHarnessEdit(
  slug: string,
  edit: HarnessEditInput,
  opts?: { sessionId?: string },
): Promise<{ entry: HarnessEntry | null; before: HarnessEntry | null }> {
  return withSlugLock(slug, () => applyEditUnlocked(slug, edit, opts));
}

async function applyEditUnlocked(
  slug: string,
  edit: HarnessEditInput,
  opts?: { sessionId?: string },
): Promise<{ entry: HarnessEntry | null; before: HarnessEntry | null }> {
  const entries = await loadHarness(slug);
  const byId = new Map(entries.map((e) => [e.id, e]));

  if (edit.action === 'delete' || edit.action === 'rollback') {
    const id = String(edit.id ?? '').trim();
    if (!SAFE_ID.test(id)) throw new Error(`${edit.action} 需要合法的条目 id`);
    if (edit.action === 'delete') {
      const before = byId.get(id);
      if (!before) throw new Error(`未找到条目: ${id}`);
      const next = entries.filter((e) => e.id !== id);
      await appendJournal(slug, { ts: new Date().toISOString(), action: 'delete', entryId: id, before, after: null, sessionId: opts?.sessionId });
      await saveHarness(slug, next);
      return { entry: null, before };
    }
    // rollback:找最近一条触及该 id 的 journal,恢复其 before。
    const hist = await readJournal(slug);
    const last = [...hist].reverse().find((l) => l.entryId === id);
    if (!last) throw new Error(`条目 ${id} 没有可回滚的历史`);
    const current = byId.get(id) ?? null;
    const restored = last.before;
    const next = entries.filter((e) => e.id !== id);
    if (restored && !current && next.length >= MAX_ENTRIES) {
      throw new Error(`回滚会超出 ${MAX_ENTRIES} 条上限;先 delete 一条再回滚`); // Codex 评审 #7
    }
    if (restored) next.push(restored);
    await appendJournal(slug, { ts: new Date().toISOString(), action: 'rollback', entryId: id, before: current, after: restored, sessionId: opts?.sessionId });
    await saveHarness(slug, next);
    return { entry: restored, before: current };
  }

  if (edit.action !== 'upsert') throw new Error(`未知 action: ${String(edit.action)}`);

  const id = edit.id ? String(edit.id).trim() : '';
  if (id) {
    // update
    if (!SAFE_ID.test(id)) throw new Error(`非法条目 id: ${id}`);
    const cur = byId.get(id);
    if (!cur) throw new Error(`未找到要更新的条目: ${id}(新建请不带 id)`);
    const before = { ...cur };
    if (edit.title != null) cur.title = cleanLine(edit.title, TITLE_MAX, 'title') || cur.title;
    if (edit.body != null) cur.body = cleanBody(edit.body) || cur.body;
    if (edit.evidence != null) cur.evidence = cleanLine(edit.evidence, EVIDENCE_MAX, 'evidence') || undefined;
    if (edit.kind != null && String(edit.kind).trim()) cur.kind = cleanKind(edit.kind);
    cur.updatedAt = today();
    cur.version = (cur.version || 1) + 1;
    await appendJournal(slug, { ts: new Date().toISOString(), action: 'upsert', entryId: id, before, after: { ...cur }, sessionId: opts?.sessionId });
    await saveHarness(slug, entries);
    return { entry: cur, before };
  }

  // create
  if (entries.length >= MAX_ENTRIES) {
    throw new Error(`工作笔记已满(${MAX_ENTRIES} 条)。先用 delete 淘汰或 upsert 合并弱条,再新建`);
  }
  const title = cleanLine(edit.title, TITLE_MAX, 'title');
  const body = cleanBody(edit.body);
  const evidence = cleanLine(edit.evidence, EVIDENCE_MAX, 'evidence');
  if (!title) throw new Error('新建需要 title');
  if (!body) throw new Error('新建需要 body');
  if (!evidence) throw new Error('新建需要 evidence(本对话里具体发生了什么;有证据的教训才许沉淀)');
  const entry: HarnessEntry = {
    id: newId(new Set(byId.keys())),
    kind: cleanKind(edit.kind),
    title,
    body,
    evidence,
    createdAt: today(),
    updatedAt: today(),
    version: 1,
  };
  entries.push(entry);
  await appendJournal(slug, { ts: new Date().toISOString(), action: 'upsert', entryId: entry.id, before: null, after: { ...entry }, sessionId: opts?.sessionId });
  await saveHarness(slug, entries);
  return { entry, before: null };
}

/** 渲染成系统提示区块(空笔记返回 '');全文内联——见文件头「写入时封顶」的理由。 */
export function renderHarnessSection(entries: HarnessEntry[]): string {
  if (!entries.length) return '';
  const line = (e: HarnessEntry): string =>
    `- [${e.id}] ${e.title} — ${e.body.replace(/\s*\n\s*/g, ' ')}${e.evidence ? ` (evidence: ${e.evidence})` : ''}`;
  const notes = entries.filter((e) => e.kind !== 'recipe');
  const recipes = entries.filter((e) => e.kind === 'recipe');
  const parts = [
    '## My Working Notes (self-curated)\n' +
      'Lessons you have accumulated about HOW to work for this user, curated by you via the manage_harness tool. ' +
      'Follow them unless the user overrides; revise or retire an entry when the evidence changes.',
  ];
  if (notes.length) parts.push(notes.map(line).join('\n'));
  if (recipes.length) parts.push('Delegation recipes (patterns that worked; reuse when the task matches):\n' + recipes.map(line).join('\n'));
  return parts.join('\n\n');
}

/** /refine 的尾部复盘指令(单源;desktop/TUI 只发原文,引擎在 agentLoop 检测并注入本段)。 */
export const REFINE_DIRECTIVE =
  '## Refine Your Working Notes (this turn)\n' +
  'The user invoked /refine. Review THIS conversation for durable lessons about how you should work, and reconcile them against your "My Working Notes" section:\n' +
  '- Confirmed again by this conversation → upsert that entry (tighten wording, refresh evidence).\n' +
  '- Contradicted by this conversation → revise it, or delete it if plainly wrong.\n' +
  '- Genuinely new lesson → create it (at most 3 new entries per refine), each with concrete evidence of what actually happened.\n' +
  'Route by type: a working-method lesson → manage_harness (kind "note"); a delegation pattern that worked well → manage_harness (kind "recipe"); a reusable step-by-step procedure (optionally with a helper script you already verified this session) → manage_skill with scope "agent".\n' +
  'NEVER record: environment/setup failures, "tool X is broken" claims, transient errors, or one-off task narratives — they harden into refusals that bite you later.\n' +
  'These tools are deferred — call load_tools with the exact names first. If nothing qualifies, say so and change nothing.';

/** 本轮用户消息是否 /refine 调用(检测收口单源:desktop/TUI/通道只发原文,引擎据此注入 REFINE_DIRECTIVE)。 */
export function isRefineInvocation(text: string): boolean {
  return /^\/refine(\s|$)/.test(text.trimStart());
}

// ── 自动档候选收件箱(.harness-raw.md,P3)────────────────────────────────────
// Historian 判官盲写提名(行式,同 .memory-raw.md 格式),/refine 时一次性注入并消费——
// 候选没有任何权威:只有经 manage_harness(审批)采纳才成为笔记。dot-file → agentFileSync 不同步。
// slug 必传且=展示身份(HARNESS.md 按 agent 本体,不折叠 shareDefaultMemory;与注入槽同源)——
// 别抄 .memory-raw.md 的 currentAgentSlug() 兜底链,Historian 里 ALS 是折叠后的记忆域,会归错桶。
export const HARNESS_RAW_FILE = '.harness-raw.md';
const RAW_KEEP_MAX = 40; // 收件箱封顶:一直不跑 /refine 就按尾部保留,旧候选自然淘汰

function rawInboxPath(slug: string): string {
  return path.join(agentsDir(), slug, HARNESS_RAW_FILE);
}

/** 追加候选行(Historian 调用;调用方已脱敏封顶)。与现有行及批内去重;写锁内读-改-写。
 *  边界自守(不信调用方):正文压平成单行(防换行注入多占行数配额/伪造抬头),会话标签只留安全字符。 */
export async function appendHarnessCandidates(slug: string, sessionId: string, cands: string[]): Promise<number> {
  if (!cands.length) return 0;
  return withSlugLock(slug, async () => {
    const p = rawInboxPath(slug);
    let existing: string[] = [];
    try {
      existing = (await fs.readFile(p, 'utf-8')).split('\n').filter((l) => l.trim());
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    const seen = new Set(existing.map((l) => l.replace(/^- \[[^\]]*\]\s*/, '')));
    const fresh: string[] = [];
    for (const c0 of cands) {
      const c = String(c0 ?? '').replace(/\s+/g, ' ').trim();
      if (!c || seen.has(c)) continue;
      seen.add(c);
      fresh.push(c);
    }
    if (!fresh.length) return 0;
    const sess = String(sessionId || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 8);
    const date = today();
    const lines = [...existing, ...fresh.map((c) => `- [${date} s:${sess}] ${c}`)].slice(-RAW_KEEP_MAX);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, lines.join('\n') + '\n', 'utf-8');
    return fresh.length;
  });
}

/** /refine 注入时一次性取走全部候选行(注入=消费,不再二次展示)。写锁内原子读清:
 *  同进程其他会话的 Historian 追加(也持锁)不会被吞;跨进程并发同上文 LWW 取舍。 */
export async function consumeHarnessCandidates(slug: string): Promise<string[]> {
  return withSlugLock(slug, async () => {
    const p = rawInboxPath(slug);
    let raw: string;
    try {
      raw = await fs.readFile(p, 'utf-8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return [];
      throw e;
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length) await fs.writeFile(p, '', 'utf-8');
    return lines;
  });
}

/** /refine 指令的候选附录(空清单返回 '')。 */
export function renderPendingHarnessCandidates(lines: string[]): string {
  if (!lines.length) return '';
  return (
    '[Auto-collected candidates] The background Historian proposed these working-note candidates from past sessions. ' +
    'They have been removed from the inbox and will NOT be shown again — triage each one THIS turn: ' +
    'adopt the durable ones via manage_harness (same evidence bar and anti-patterns as above), silently drop the rest.\n' +
    lines.join('\n')
  );
}
