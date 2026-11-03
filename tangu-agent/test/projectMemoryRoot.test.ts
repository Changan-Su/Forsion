/**
 * 项目记忆按 git 根认、目录名看得懂、旧目录自动并进来(11-03):
 *   - 子文件夹 / worktree 认到同一个根;嵌套的独立仓、子模块式 `.git` 文件、不在 git 里的文件夹各算各的
 *   - 目录名 = 路径各段连起来 + 8 位哈希:`/a-b` 与 `/a/b` 不撞,长路径不超文件名上限
 *   - 旧的按文件夹哈希建的目录(含回退到老引擎时它新建的那份)下次打开时并进来,删过的不回来;原文件夹不在了的不动
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryRepository, isMemoryTombstoneActive } from '../src/services/memoryRepository.js';
import { memoryDirName, openProjectMemory, projectMemoryRoot, projectMemoryView, refOf, resetProjectMemoryAbsorbForTests, PROJECT_MEMORY_CHAR_BUDGET } from '../src/services/projectMemory.js';

let base: string;
let prevHome: string | undefined;
const mk = (rel: string): string => { const p = path.join(base, rel); mkdirSync(p, { recursive: true }); return realpathSync(p); };
const git = (cwd: string, ...args: string[]): void => { execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' }); };
const memRoot = (): string => path.join(process.env.TANGU_HOME!, 'project-memory');
/** 老引擎的样子:按会话那个文件夹 realpath 的哈希建目录,标记里写那个文件夹。 */
const legacy = (folder: string, facts: string[]): string => {
  const dir = path.join(memRoot(), createHash('sha256').update(folder).digest('hex').slice(0, 32));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ project: folder }));
  const repo = createMemoryRepository(dir);
  for (const fact of facts) repo.mutate({ action: 'add', fact, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'manual' } });
  return dir;
};
const facts = async (project: string): Promise<string[]> => (await projectMemoryView(project)).entries.map((e) => e.content);

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-root-')));
  prevHome = process.env.TANGU_HOME;
});
afterAll(() => { if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome; rmSync(base, { recursive: true, force: true }); });
let homeN = 0;
beforeEach(() => { process.env.TANGU_HOME = mk(`home${++homeN}`); resetProjectMemoryAbsorbForTests(); });

describe('按 git 根认项目', () => {
  it('子文件夹、worktree 认到主检出;嵌套的独立仓、子模块式 .git 文件、不在 git 里的各算各的', () => {
    const main = mk('repo');
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    const sub = mk('repo/packages/app');
    const wt = path.join(base, 'repo-wt');
    git(main, 'worktree', 'add', '-q', wt);
    const nested = mk('repo/vendor/lib');
    git(nested, 'init', '-q');
    const submodule = mk('repo/modules/sm');
    writeFileSync(path.join(submodule, '.git'), 'gitdir: ../../.git/modules/sm\n'); // 没有 commondir
    const loose = mk('loose/folder');

    expect(projectMemoryRoot(sub)).toBe(main);
    expect(projectMemoryRoot(realpathSync(wt))).toBe(main);
    expect(projectMemoryRoot(nested)).toBe(nested);
    expect(projectMemoryRoot(submodule)).toBe(submodule);
    expect(projectMemoryRoot(loose)).toBe(loose);
    expect(refOf(sub)).toEqual(refOf(realpathSync(wt)));
    expect(refOf(sub)).toMatchObject({ project: main, name: 'repo' });
  });

  it('worktree 里记的,主检出和子文件夹里都看得到', async () => {
    const main = mk('repo2');
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = path.join(base, 'repo2-wt');
    git(main, 'worktree', 'add', '-q', wt);
    (await openProjectMemory(refOf(realpathSync(wt)))).mutate({ action: 'add', fact: 'Release only from the main branch.', cap: PROJECT_MEMORY_CHAR_BUDGET });
    expect(await facts(main)).toEqual(['Release only from the main branch.']);
    expect(await facts(mk('repo2/docs'))).toEqual(['Release only from the main branch.']);
    expect(readdirSync(memRoot())).toHaveLength(1);
  });
});

describe('目录名', () => {
  it('看得懂、带 8 位哈希;/a-b 与 /a/b 不撞;长路径不超文件名上限', () => {
    expect(memoryDirName('/Users/me/Projects/notes')).toMatch(/^Users-me-Projects-notes-[0-9a-f]{8}$/);
    expect(memoryDirName('/x/a-b')).not.toBe(memoryDirName('/x/a/b'));
    const long = `/${Array.from({ length: 30 }, (_, i) => `目录第${i}层`).join('/')}`;
    const name = memoryDirName(long);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(130);
    expect(name).toMatch(/目录第29层-[0-9a-f]{8}$/);
    expect(memoryDirName('C:\\Users\\me\\proj')).toMatch(/^C_-Users-me-proj-[0-9a-f]{8}$/);
  });
});

describe('旧目录并进来', () => {
  it('旧的按文件夹哈希建的几份(worktree / 子文件夹 / 根自己)并成一份,删过的不回来,旧目录不留', async () => {
    const main = mk('repo3');
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = path.join(base, 'repo3-wt');
    git(main, 'worktree', 'add', '-q', wt);
    const sub = mk('repo3/app');
    legacy(main, ['Tests run with pnpm test:unit.']);
    legacy(realpathSync(wt), ['Deploy only from the ops laptop.', 'Tests run with pnpm test:unit.']);
    const subDir = legacy(sub, ['The API lives in services/api.']);
    // 子文件夹那份里删过一句:合并后这一句不许回来
    const subRepo = createMemoryRepository(subDir);
    const gone = subRepo.mutate({ action: 'add', fact: 'Never print the staging token.', cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'manual' } }).entries.find((e) => e.content.startsWith('Never'))!;
    subRepo.mutate({ action: 'forget', id: gone.id });

    expect((await facts(sub)).sort()).toEqual(['Deploy only from the ops laptop.', 'Tests run with pnpm test:unit.', 'The API lives in services/api.']);
    expect(readdirSync(memRoot())).toEqual([memoryDirName(main)]);
    const merged = (await openProjectMemory(refOf(main))).snapshot();
    expect(merged.entries.some((e) => e.content.startsWith('Never'))).toBe(false);
    expect(merged.tombstones.some((t) => t.content === 'Never print the staging token.' && isMemoryTombstoneActive(t))).toBe(true);
  });

  it('回退到老引擎时它新建的那份:新引擎下次启动(新进程)再并进来,不丢', async () => {
    const proj = mk('plain-project');
    (await openProjectMemory(refOf(proj))).mutate({ action: 'add', fact: 'Written by the new engine.', cap: PROJECT_MEMORY_CHAR_BUDGET });
    legacy(proj, ['Written by the old engine.']);
    expect(await facts(proj)).toEqual(['Written by the new engine.']); // 这个进程已经扫过,不再扫
    resetProjectMemoryAbsorbForTests(); // = 新引擎重启
    expect(await facts(proj)).toEqual(['Written by the new engine.', 'Written by the old engine.']);
    expect(readdirSync(memRoot())).toEqual([memoryDirName(proj)]);
  });

  it('原来那个文件夹已经不在了:不动它(认不准属于哪个仓,交给「重新指向」)', async () => {
    const main = mk('repo4');
    git(main, 'init', '-q');
    const vanished = path.join(main, 'gone-worktree');
    const stray = legacy(vanished, ['Belongs to a folder that no longer exists.']);
    expect(await facts(main)).toEqual([]);
    expect(existsSync(stray)).toBe(true);
  });
});
