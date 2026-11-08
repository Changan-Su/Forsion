/**
 * 文件改动记录审阅页的「未提交(Git)」范围:项目目录相对 HEAD 的全部改动(已暂存 + 未暂存一起 = `git diff HEAD`;
 * 还没有提交的新仓对空树)+ 未跟踪且没被忽略的文件(按新建算)。形状与 checkpoints.listChanges 的 FileChange 一致,runs 恒为 0。
 *
 * 只读、零点击路径(打开审阅页就会跑):
 * - 走 gitActions.readGit(内置 git 选择 + 加固前缀:不分页、不抢索引锁、不跑 fsmonitor / 钩子 / 外部 diff),
 *   diff 再加 --no-ext-diff / --no-textconv(textconv 是仓库配置里的程序,读级闸不拦它,这里直接关掉)。
 * - 仓库带读级可执行配置(过滤器 clean/smudge:diff 读工作区时照跑)且未经用户信任 → 不读,reason 'untrusted'
 *   (与 projectContext.gitSummary 的 changesUnread 同一判据)。
 * - 项目是大仓的子目录时只看项目目录里的改动(--relative / ls-files 本来就按 cwd),root = 项目目录。
 * - 未跟踪文件只读普通文件(FIFO 之类读了会卡死),软链按 git 的口径取链接目标文本。
 * - 每个 git 调用限时;文件数封顶 GIT_CHANGES_MAX_FILES。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GitActionError, readGit } from './gitActions.js';
import { isRepoTrusted, repoConfigRisks } from './gitTrust.js';
import { DIFF_MAX_BYTES, PATCH_MAX_LINES, hunkHeader, newFileStat, type FileChange } from './checkpoints.js';

export interface GitChanges {
  available: boolean;
  /** available=false 时:没装 git / 不是仓库 / 会话没有项目目录 / 仓库配置未经信任(读它会跑仓库自带的程序)。 */
  reason?: 'nogit' | 'notrepo' | 'nocwd' | 'untrusted';
  /** 路径的基准目录(= 项目目录);FileChange.path = root + 相对路径。 */
  root?: string;
  files: FileChange[];
  /** 文件数超过上限 / git 输出超过上限,清单不全。 */
  truncatedFiles?: boolean;
  /** 11-07 多仓 Git:这次列到的仓(按 dir 最长前缀把 files 归到各仓;只有一个仓时也给)。 */
  repos?: GitChangesRepo[];
}

export interface GitChangesRepo {
  id: string;
  name: string;
  label: string;
  root: string;
  group: 'project' | 'inside' | 'extra';
  /** 这个仓的改动的基准目录(子目录模式 = 仓里的那个子目录)。 */
  dir: string;
  /** 这个仓读不了的原因(其他仓照常列)。 */
  reason?: GitChanges['reason'];
  truncatedFiles?: boolean;
}

/**
 * 多仓版:项目碰得到的每个仓各列一份,合成一张清单(文件路径都是绝对路径,repos 标明各仓的基准目录)。
 * 项目自己不在仓里、里面也没有仓 → 与 listGitChanges 一样回 notrepo。文件总数照旧封顶。
 */
export async function listGitChangesMulti(
  projectDir: string,
  repos: ReadonlyArray<{ id: string; name: string; label: string; root: string; group: GitChangesRepo['group']; dir: string }>,
  opts: { diff?: boolean; path?: string } = {},
): Promise<GitChanges> {
  if (!repos.length) return listGitChanges(projectDir, opts);
  // 只看一个文件:交给基准目录离它最近的那个仓
  const inDir = (dir: string, p: string) => { const rel = path.relative(dir, p); return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
  const targets = opts.path !== undefined
    ? repos.filter((r) => inDir(r.dir, opts.path!)).sort((a, b) => b.dir.length - a.dir.length).slice(0, 1)
    : repos;
  const out: GitChanges = { available: false, root: projectDir, files: [], repos: [] };
  let nogit = false;
  for (const r of repos) {
    const meta: GitChangesRepo = { id: r.id, name: r.name, label: r.label, root: r.root, group: r.group, dir: r.dir };
    out.repos!.push(meta);
    if (!targets.includes(r)) continue;
    if (out.files.length >= GIT_CHANGES_MAX_FILES) { out.truncatedFiles = true; meta.truncatedFiles = true; continue; }
    let one: GitChanges;
    try { one = await listGitChanges(r.dir, opts); } catch { meta.reason = 'notrepo'; continue; }
    if (!one.available) { meta.reason = one.reason; if (one.reason === 'nogit') nogit = true; continue; }
    out.available = true;
    const room = GIT_CHANGES_MAX_FILES - out.files.length;
    out.files.push(...one.files.slice(0, room));
    if (one.truncatedFiles || one.files.length > room) { out.truncatedFiles = true; meta.truncatedFiles = true; }
  }
  if (!out.available) {
    // 全都读不了:沿用单仓的原因(只有一个仓时与以前完全一样)
    const reasons = out.repos!.map((m) => m.reason).filter(Boolean);
    out.reason = nogit ? 'nogit' : reasons.length && reasons.every((x) => x === 'untrusted') ? 'untrusted' : reasons[0] ?? 'notrepo';
    if (opts.path !== undefined && !targets.length) { out.available = true; delete out.reason; }
  }
  return out;
}

const GIT_TIMEOUT_MS = 15_000;
export const GIT_CHANGES_MAX_FILES = 300;
const LIST_MAX_BYTES = 4 * 1024 * 1024;
const PATCH_MAX_BYTES = 16 * 1024 * 1024;
// --ignore-submodules=all:不进子模块(子模块自己的 clean 过滤器不受上面的信任检查管,git 进去跑 status 就会执行它);
// 前缀钉死 a/ b/:用户配了 diff.noprefix / mnemonicPrefix 时文件头会变,解析认不出就静默丢掉 patch(Codex 评审)
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--relative', '--ignore-submodules=all', '--src-prefix=a/', '--dst-prefix=b/'];

/** 一次只读 git;超时 / 非零退出一律抛错(路由回 500,不挂住)。output-limit 交给调用方按「不全」处理。 */
async function git(cwd: string, args: string[], opts: { maxOutputBytes?: number; input?: string } = {}): Promise<{ stdout: string; cut: boolean }> {
  const r = await readGit(cwd, args, { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: opts.maxOutputBytes ?? LIST_MAX_BYTES, ...(opts.input !== undefined ? { input: opts.input } : {}) });
  if (r.reason === 'timeout') throw new Error(`git ${args[0]} timed out`);
  if (r.reason === 'output-limit') return { stdout: r.stdout, cut: true };
  if (r.code !== 0 || r.reason) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return { stdout: r.stdout, cut: false };
}

/** -z 输出切成字段;被截断时最后一段可能是半截,一律丢掉(完整输出的最后一段本来就是空串)。 */
const zFields = (stdout: string): string[] => stdout.split('\0').slice(0, -1);

/** `"a/x\ty"` 这类 C 风格引号串 → 原文(git 对控制字符 / 引号 / 反斜杠加引号;quotepath=false 时非 ASCII 原样)。 */
export function cUnquote(s: string, from: number): { value: string; end: number } | null {
  if (s[from] !== '"') return null;
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
  for (let i = from + 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') return { value: Buffer.from(bytes).toString('utf8'), end: i + 1 };
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && /[0-7]/.test(nx)) {
        bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
        i += 3;
      } else if (nx !== undefined && nx in simple) {
        bytes.push(simple[nx]);
        i += 1;
      } else return null;
      continue;
    }
    // 按码点取(代理对不能拆开编码)
    const cp = s.codePointAt(i) ?? 0;
    if (cp > 0xffff) i++;
    bytes.push(...Buffer.from(String.fromCodePoint(cp), 'utf8'));
  }
  return null;
}

/** `diff --git a/X b/X` → X(--no-renames 下两侧同名;带引号的按 C 风格解开)。认不出 → null。 */
function sectionPath(header: string): string | null {
  const rest = header.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const a = cUnquote(rest, 0);
    return a && a.value.startsWith('a/') ? a.value.slice(2) : null;
  }
  if (!rest.startsWith('a/') || (rest.length - 5) % 2 !== 0) return null;
  const x = rest.slice(2, 2 + (rest.length - 5) / 2);
  return rest === `a/${x} b/${x}` ? x : null;
}

/** `git diff -U2` 的输出 → 相对路径 → 规范化 hunk(去掉文件头、函数名尾巴与「\ No newline」行,头部计数补全)。 */
function parsePatch(stdout: string): Map<string, Array<{ aS: number; bS: number; body: string[] }>> {
  const out = new Map<string, Array<{ aS: number; bS: number; body: string[] }>>();
  let cur: Array<{ aS: number; bS: number; body: string[] }> | null = null;
  let hunk: { aS: number; bS: number; body: string[] } | null = null;
  for (const raw of stdout.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const p = sectionPath(raw);
      cur = p === null ? null : [];
      if (p !== null && cur) out.set(p, cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!m) { hunk = null; continue; }
      const aN = m[2] === undefined ? 1 : Number(m[2]);
      const bN = m[4] === undefined ? 1 : Number(m[4]);
      hunk = { aS: aN ? Number(m[1]) - 1 : Number(m[1]), bS: bN ? Number(m[3]) - 1 : Number(m[3]), body: [] };
      cur.push(hunk);
      continue;
    }
    if (!hunk) continue; // hunk 之前的文件头(index / --- / +++ / mode / Binary files …)
    const c = raw[0];
    if (c === ' ' || c === '+' || c === '-') hunk.body.push(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    // '\ No newline at end of file' 与末尾空串跳过(与 listChanges 一样不把「缺末尾换行」单列)
  }
  return out;
}

/** hunk 列表 → patch 文本,与 listChanges 同一个 2000 行上限;截断的那个 hunk 头部计数按留下的行重算。 */
function renderHunks(hunks: Array<{ aS: number; bS: number; body: string[] }>): { patch: string; truncated: boolean } {
  const out: string[] = [];
  for (const h of hunks) {
    const room = PATCH_MAX_LINES - out.length - 1;
    if (h.body.length > room) {
      if (room > 0) {
        const cut = h.body.slice(0, room);
        out.push(hunkHeader(h.aS, h.bS, cut), ...cut);
      }
      return { patch: out.join('\n'), truncated: true };
    }
    out.push(hunkHeader(h.aS, h.bS, h.body), ...h.body);
  }
  return { patch: out.join('\n'), truncated: false };
}

/** 未跟踪文件的内容:只读普通文件(FIFO / 设备读了会卡死或读不完);软链取链接目标文本(git 就是这么存的)。 */
async function untrackedBytes(abs: string): Promise<Buffer | null | 'large'> {
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) return Buffer.from(await fs.readlink(abs), 'utf8');
    if (!st.isFile()) return null;
    if (st.size > DIFF_MAX_BYTES) return 'large';
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/**
 * 列出项目目录(cwd,须已是 canonical 的绝对目录)里未提交的改动。
 * opts.path:只看这一个绝对路径(不在 cwd 之下 → 空清单);opts.diff:附 patch(adds/dels 为 null 时没有)。
 */
export async function listGitChanges(cwd: string, opts: { diff?: boolean; path?: string } = {}): Promise<GitChanges> {
  let inside;
  try {
    inside = await readGit(cwd, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: GIT_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof GitActionError && e.code === 'git_unavailable') return { available: false, reason: 'nogit', files: [] };
    throw e;
  }
  if (inside.reason === 'timeout') throw new Error('git rev-parse timed out');
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { available: false, reason: 'notrepo', files: [] };

  // 读级闸:过滤器在 diff 读工作区时照跑 —— 未经信任不读(读不出配置 = 按有风险算)。
  const risk = await repoConfigRisks(cwd).catch(() => null);
  if (!risk || (risk.read.length && !(await isRepoTrusted(risk.commonDir)))) {
    return { available: false, reason: 'untrusted', root: cwd, files: [] };
  }

  let spec: string[] = [];
  if (opts.path !== undefined) {
    const rel = path.relative(cwd, opts.path);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { available: true, root: cwd, files: [] };
    spec = ['--', `:(literal)${rel.split(path.sep).join('/')}`];
  }

  const head = await readGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  if (head.reason === 'timeout') throw new Error('git rev-parse timed out');
  // 还没有提交的新仓:对空树比。空树 id 按仓库的对象格式现算(SHA-256 仓不是那串 SHA-1)。
  const base = head.code === 0 ? 'HEAD' : (await git(cwd, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).stdout.trim();

  const [ns, num, ut, pt] = await Promise.all([
    git(cwd, ['diff', base, '--name-status', '-z', ...DIFF_FLAGS, ...spec]),
    git(cwd, ['diff', base, '--numstat', '-z', ...DIFF_FLAGS, ...spec]),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...spec]),
    opts.diff ? git(cwd, ['diff', base, '-U2', ...DIFF_FLAGS, ...spec], { maxOutputBytes: PATCH_MAX_BYTES }) : Promise.resolve(null),
  ]);

  const tracked: Array<{ rel: string; status: string }> = [];
  const nsf = zFields(ns.stdout);
  for (let i = 0; i + 1 < nsf.length; i += 2) tracked.push({ status: nsf[i], rel: nsf[i + 1] });

  const counts = new Map<string, { adds: number; dels: number } | 'binary'>();
  for (const rec of zFields(num.stdout)) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(rec);
    if (!m) continue;
    counts.set(m[3], m[1] === '-' || m[2] === '-' ? 'binary' : { adds: Number(m[1]), dels: Number(m[2]) });
  }

  const untracked = zFields(ut.stdout).filter((r) => r && !r.endsWith('/')); // 末尾 / = 内嵌的另一个仓,不展开
  const hunks = pt ? parsePatch(pt.stdout) : null;
  let truncatedFiles = ns.cut || num.cut || ut.cut;
  if (tracked.length + untracked.length > GIT_CHANGES_MAX_FILES) truncatedFiles = true;

  // patch 输出被截断时,最后解析到的那一段可能是半截
  const partialKey = pt?.cut && hunks ? [...hunks.keys()].pop() : undefined;
  const files: FileChange[] = [];
  for (const { rel, status } of tracked.slice(0, GIT_CHANGES_MAX_FILES)) {
    const kind: FileChange['kind'] = status === 'A' ? 'created' : status === 'D' ? 'deleted' : 'modified';
    const fc: FileChange = { path: path.join(cwd, rel), kind, adds: null, dels: null, runs: 0 };
    const c = counts.get(rel);
    if (c === 'binary') fc.reason = 'binary';
    else if (!c) fc.reason = 'nosnap'; // numstat 里没有(两次调用之间工作区变了 / 输出被截断)
    else {
      fc.adds = c.adds;
      fc.dels = c.dels;
      if (hunks) {
        const hs = hunks.get(rel);
        if (hs) {
          const { patch, truncated } = renderHunks(hs);
          fc.patch = patch;
          if (truncated) fc.truncated = true;
        } else {
          fc.patch = ''; // 只改了权限位 / 子模块指针;或 patch 输出超了上限没轮到它
          if (pt?.cut) fc.truncated = true;
        }
        if (partialKey !== undefined && rel === partialKey) fc.truncated = true;
      }
    }
    files.push(fc);
  }

  for (const rel of untracked.slice(0, Math.max(0, GIT_CHANGES_MAX_FILES - files.length))) {
    const abs = path.join(cwd, rel);
    const st = newFileStat(await untrackedBytes(abs), !!opts.diff);
    const fc: FileChange = { path: abs, kind: 'created', adds: st.adds, dels: st.dels, runs: 0 };
    if (st.adds === null) fc.reason = st.reason;
    else {
      if (opts.diff) fc.patch = st.patch ?? '';
      if (st.truncated) fc.truncated = true;
    }
    files.push(fc);
  }

  return { available: true, root: cwd, files, ...(truncatedFiles ? { truncatedFiles: true } : {}) };
}
