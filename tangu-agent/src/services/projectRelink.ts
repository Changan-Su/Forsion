/**
 * 项目文件夹搬走后重新指向(借鉴 magpie 第二轮 9;桌面左栏项目菜单「重新指向文件夹…」)。
 *
 * 项目按路径认:挪了文件夹或改了名,左栏照常显示旧项目,里面的会话在一个不存在的目录里干活。按路径作键的有三份,一起改,
 * 要么都成要么都不改:
 *   1. 会话行的 project_path(左栏分组键)和会话配置里落在旧目录下的 cwd / extraRoots(引擎按 cwd 定工作目录);
 *   2. 项目记忆目录 `tanguHome()/project-memory/<realpath 哈希>/`(按新 realpath 重算哈希后改名,projectMemory.rehomeProjectMemory);
 *   3. `tanguHome()/project-settings.json` 里那一项(连同记下的 git 远端,projectContext.rekeyProjectSettings)。
 * 没有事务可用(core/db 只有 query):按「记忆目录 → 设置文件 → 会话库」的顺序做,每一步留下撤销,会话库那一步是一条 UPDATE
 * (要么全改要么不改);任何一步失败,把已做的倒着撤回去。只改元数据,不搬文件;会话正文里出现过的旧路径不改写(同 magpie)。
 * 项目自己的 `.tangu/`(指令、技能、计划、图标、项目级 HUMAN.md)住在项目文件夹里,跟着文件夹走,这里不用管。
 *
 * 新位置已经是另一个项目(本人某个会话的 project_path realpath 后就是它)→ 不改,回 already_project;用户点了「合并」再来
 * (merge=true):会话并进那个项目的分组键、项目名跟它走,两份项目记忆合并去重,那边已有的默认项保留。
 *
 * ponytail: 撤销只防本进程内的失败;撤销自己也失败(磁盘拔了)时如实抛出,不再补救。一个 home 只有一个引擎,不考虑跨进程。
 */
import { promises as fs, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { query } from '../core/db.js';
import { withKeyLock } from '../core/keyLock.js';
import { canonicalProjectPath, projectSettingsAt, rekeyProjectSettings, maskRemoteUrl, type ProjectSettings } from './projectContext.js';
import type { RelinkCandidate, RelinkInfo, RelinkResult } from '../contracts/clientTypes.js';
import { findProjectMemoryDir, projectMemoryCount, rehomeProjectMemory } from './projectMemory.js';
import { runGit } from './runtimeContext.js';

export class RelinkError extends Error {
  constructor(public readonly code: 'not_found' | 'same_folder' | 'not_relinked', message: string) { super(message); this.name = 'RelinkError'; }
}

const parseConfig = (v: unknown): Record<string, any> | null => {
  if (!v) return null;
  try { const o = typeof v === 'string' ? JSON.parse(v) : v; return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, any> : null; } catch { return null; }
};

/** 旧路径的几种写法:原样,和「最深的现存上级 realpath + 余下部分」(建项目时记的是 realpath,`/var/x` 记成了 `/private/var/x`)。 */
export function oldPathKeys(old: string): string[] {
  const abs = path.resolve(old);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try { return [...new Set([abs, path.join(realpathSync(cur), ...rest.reverse())])]; } catch { /* 这一级也不在,再往上 */ }
    const up = path.dirname(cur);
    if (up === cur) return [abs];
    rest.push(path.basename(cur));
    cur = up;
  }
}

/** 一个目录还在不在:2 秒没回话(网络盘挂死)也当不在 —— 只拿来打标记,不会因此改任何东西。 */
async function dirPresent(p: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000); });
  try { return await Promise.race([fs.stat(p).then((s) => s.isDirectory(), () => false), late]); } finally { clearTimeout(timer); }
}

async function localProjects(userId: string): Promise<Array<{ path: string; name: string }>> {
  const rows = await query<any[]>('SELECT DISTINCT project_path, project_name, projectless FROM chat_sessions WHERE user_id = ? AND project_path IS NOT NULL', [userId]);
  const seen = new Map<string, string>();
  for (const r of rows) {
    const p = String(r.project_path || '');
    if (!p || r.projectless || !path.isAbsolute(p)) continue;
    if (!seen.has(p) || (!seen.get(p) && r.project_name)) seen.set(p, String(r.project_name || ''));
  }
  return [...seen].map(([p, name]) => ({ path: p, name: name || path.basename(p) }));
}

/** 本人会话里出现过、现在 stat 不到目录的本地项目路径。外接盘 / 网络盘没挂上也在里面 —— 所以只标记,不自动改。 */
export async function missingProjectPaths(userId: string): Promise<string[]> {
  const all = await localProjects(userId);
  const present = await Promise.all(all.map((p) => dirPresent(p.path)));
  return all.filter((_, i) => !present[i]).map((p) => p.path);
}

/** 远端地址的比对形:去凭据、协议、`git@host:` 写法、结尾的 `.git` 与 `/`,主机名小写。 */
export function remoteIdentity(url: string): string {
  const s = maskRemoteUrl(url.trim()).replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@([^:/]+):/, '$1/').replace(/\/+$/, '').replace(/\.git$/i, '');
  const slash = s.indexOf('/');
  return slash < 0 ? s.toLowerCase() : s.slice(0, slash).toLowerCase() + s.slice(slash);
}


async function ownProjectAt(userId: string, real: string, except: string): Promise<{ path: string; name: string } | null> {
  for (const p of await localProjects(userId)) {
    if (p.path === except) continue;
    if (p.path === real || await fs.realpath(p.path).then((r) => r === real, () => false)) return p;
  }
  return null;
}

/** 对话框要的:有几个会话、几条项目记忆、哪些默认项会一起改;以及同名文件夹(旧路径的上一级、~、~/Documents、~/Projects)。
 *  记下过旧项目的 git 远端时,候选里远端对得上的才 remoteMatch(界面只预选这种)。 */
export async function relinkInfo(userId: string, from: string): Promise<RelinkInfo> {
  const [{ n }] = await query<any[]>('SELECT COUNT(*) AS n FROM chat_sessions WHERE user_id = ? AND project_path = ?', [userId, from]);
  const keys = oldPathKeys(from);
  const { settings, remote } = await projectSettingsAt(keys);
  const home = homedir();
  const name = path.basename(from);
  const roots = [path.dirname(from), home, path.join(home, 'Documents'), path.join(home, 'Projects')];
  const seen = new Set<string>(keys);
  const candidates: RelinkCandidate[] = [];
  for (const root of roots) {
    const real = await canonicalProjectPath(path.join(root, name)).catch(() => null);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    const got = await runGit(real, ['remote', 'get-url', 'origin'], undefined, 1500).catch(() => null);
    const there = got && got.code === 0 && !got.reason ? maskRemoteUrl(got.stdout.split('\n')[0].trim()) : null;
    candidates.push({
      path: real, remote: there,
      remoteMatch: !!remote && !!there && remoteIdentity(remote) === remoteIdentity(there),
      project: (await ownProjectAt(userId, real, from))?.name ?? null,
    });
  }
  return {
    from, sessions: Number(n) || 0, memoryEntries: projectMemoryCount(findProjectMemoryDir(keys)),
    settings: settings ? (Object.keys(settings) as Array<keyof ProjectSettings>) : [], remote, candidates,
  };
}

/** 落在旧目录(froms 里任一种写法)之下的路径换到 to 之下;别的原样。带 `..` 段的不认(`/a/site/../shared` 其实在项目外面)。 */
export function rebasePath(p: unknown, froms: readonly string[], to: string): unknown {
  if (typeof p !== 'string' || p.split(/[\\/]/).includes('..')) return p;
  for (const from of froms) {
    if (p === from) return to;
    const base = from.endsWith(path.sep) ? from : from + path.sep;
    if (p.startsWith(base)) return path.join(to, p.slice(base.length));
  }
  return p;
}

/** 见文件头。from = 会话行上的原样 project_path(调用方已从本人会话取出,不是客户端给的);newPath = 用户在选择器里挑的目录。
 *  同时只做一个:两个请求把两个项目指到同一处,不能都看见「那里还不是项目」然后悄悄并到一起(Codex 评审)。 */
export function relinkProject(userId: string, from: string, newPath: unknown, opts: { merge?: boolean } = {}): Promise<RelinkResult> {
  return withKeyLock('project-relink', () => relinkOnce(userId, from, newPath, opts));
}

async function relinkOnce(userId: string, from: string, newPath: unknown, opts: { merge?: boolean }): Promise<RelinkResult> {
  const to = await canonicalProjectPath(newPath); // 绝对 / 存在 / 是目录 / 不是根或家目录;外接盘没挂上的选不到这里
  const keys = oldPathKeys(from);
  if (keys.includes(to)) throw new RelinkError('same_folder', 'This is the folder the project already points to.');
  const rows = await query<any[]>('SELECT id FROM chat_sessions WHERE user_id = ? AND project_path = ?', [userId, from]);
  if (!rows.length) throw new RelinkError('not_found', 'No chats belong to this project.');
  const other = await ownProjectAt(userId, to, from);
  if (other && !opts.merge) return { ok: false, error: 'already_project', path: other.path, name: other.name };
  // 并进已有项目:会话用那个项目的分组键(它的原样 project_path)与项目名,左栏才落在同一组
  const key = other?.path ?? to;
  const ids = rows.map((r) => String(r.id)).sort();

  const undo: Array<() => unknown> = [];
  try {
    const memory = rehomeProjectMemory(keys, to);
    undo.push(() => memory.undo());
    undo.push(await rekeyProjectSettings(keys, to, !!other));
    // 会话配置的写入与 PATCH / writeSessionConfig 同一把锁(按 id 排好序逐个拿,不会互等);锁里重读,不盖掉并发写进来的配置
    const configs: Record<string, { cwd?: string; extraRoots?: string[] }> = {};
    const update = async (): Promise<void> => {
      const cfgRows = await query<any[]>(`SELECT id, agent_config FROM chat_sessions WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
      const cases: string[] = [];
      const caseParams: unknown[] = [];
      for (const r of cfgRows) {
        const cfg = parseConfig(r.agent_config);
        if (!cfg) continue;
        const froms = [from, ...keys];
        const next = { ...cfg, cwd: rebasePath(cfg.cwd, froms, key), ...(Array.isArray(cfg.extraRoots) ? { extraRoots: cfg.extraRoots.map((x: unknown) => rebasePath(x, froms, key)) } : {}) };
        if (JSON.stringify(next) === JSON.stringify(cfg)) continue;
        cases.push('WHEN ? THEN ?'); caseParams.push(String(r.id), JSON.stringify(next));
        configs[String(r.id)] = { ...(typeof next.cwd === 'string' ? { cwd: next.cwd } : {}), ...(Array.isArray(next.extraRoots) ? { extraRoots: next.extraRoots.filter((x: unknown): x is string => typeof x === 'string') } : {}) };
      }
      const sets = ['project_path = ?', ...(other ? ['project_name = ?'] : []), ...(cases.length ? [`agent_config = CASE id ${cases.join(' ')} ELSE agent_config END`] : [])];
      // 一条语句改完所有行:要么全改,要么(抛错)一行没动
      await query(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE user_id = ? AND project_path = ? AND id IN (${ids.map(() => '?').join(', ')})`,
        [key, ...(other ? [other.name] : []), ...caseParams, userId, from, ...ids]);
    };
    await ids.reduceRight<() => Promise<void>>((inner, id) => () => withKeyLock(`session:config:${id}`, inner), update)();
    // 会话库已经改成:这之后只清合并时留的旧副本,清不掉也不回滚(多两个 .before-* 目录,不影响读写)
    try { memory.commit(); } catch { /* 见上 */ }
    return { ok: true, path: key, name: other?.name ?? null, sessionIds: ids, memory: memory.kind, configs };
  } catch (e) {
    // 每一步都试着撤:前一步撤不掉不妨碍撤后一步(Codex 评审);撤不干净的如实报出来
    const failed: string[] = [];
    for (const step of undo.reverse()) { try { await step(); } catch (u) { failed.push((u as Error)?.message || String(u)); } }
    if (failed.length) throw new RelinkError('not_relinked', `Relink failed and could not be fully undone: ${failed.join('; ')} (after: ${(e as Error)?.message || e})`);
    throw e;
  }
}
