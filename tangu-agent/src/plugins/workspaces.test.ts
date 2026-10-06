import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
vi.mock('../seams/runtime.js', () => ({ deps: () => ({ profile: { capabilities: { hostExec: true } } }) }));
vi.mock('../seams/runContext.js', () => ({ currentRunId: () => undefined }));
import { createPluginWorkspaces } from './workspaces.js';
let root: string, project: string, sdk: ReturnType<typeof createPluginWorkspaces>;
const saved = { ...process.env };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dispatch-workspaces-')); project = path.join(root, 'project'); mkdirSync(project);
  const cfg = path.join(root, 'gitconfig'); writeFileSync(cfg, '');
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', TANGU_HOME: path.join(root, 'home'), GIT_AUTHOR_NAME: 'Dispatch Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Dispatch Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
  git(project, 'init', '-q', '-b', 'main'); writeFileSync(path.join(project, 'base.txt'), 'base\n'); writeFileSync(path.join(project, '.gitignore'), '*.cache\n'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'Base');
  sdk = createPluginWorkspaces('test-plugin', path.join(root, 'plugin'), () => true);
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
it('isolates three tasks and merges each without overwriting prior task changes', async () => {
  const tasks = await Promise.all([0,1,2].map(() => sdk.prepare({ id: randomUUID(), userId: 'u', cwd: project })));
  expect(new Set(tasks.map(t=>t.cwd)).size).toBe(3);
  for (const [i, task] of tasks.entries()) {
    writeFileSync(path.join(task.cwd, `task-${i}.txt`), `task ${i}\n`);
    const before = await sdk.inspect(task.id, 'u'); expect(before.diff).toContain(`task ${i}`);
    await sdk.merge(task.id, 'u', before.revision);
    expect(readFileSync(path.join(project, `task-${i}.txt`), 'utf8')).toBe(`task ${i}\n`);
  }
  expect(git(project, 'status', '--porcelain')).toBe('');
}, 30000);
it('rejects stale content previews, dirty destination and foreign ownership; archives ignored files intact', async () => {
  const task = await sdk.prepare({ id: randomUUID(), userId: 'u', cwd: project });
  writeFileSync(path.join(task.cwd, 'new.txt'), 'one');
  const preview = await sdk.inspect(task.id, 'u'); writeFileSync(path.join(task.cwd, 'new.txt'), 'two');
  await expect(sdk.merge(task.id, 'u', preview.revision)).rejects.toThrow(/Review again/);
  await expect(sdk.inspect(task.id, 'foreign')).rejects.toThrow(/owned/);
  writeFileSync(path.join(project, 'personal.txt'), 'keep');
  await expect(sdk.merge(task.id, 'u', (await sdk.inspect(task.id, 'u')).revision)).rejects.toThrow(/local changes/);
  rmSync(path.join(project, 'personal.txt'));
  writeFileSync(path.join(task.cwd, 'important.cache'), 'ignored content');
  const archive = await sdk.archive(task.id, 'u');
  expect(readFileSync(path.join(archive.cwd, 'important.cache'), 'utf8')).toBe('ignored content');
  expect(readFileSync(path.join(archive.cwd, 'new.txt'), 'utf8')).toBe('two');
  await expect(sdk.inspect(task.id, 'u')).rejects.toThrow(/not active/);
}, 30000);
it('keeps merge conflicts in the task worktree and leaves the destination clean', async () => {
  const task = await sdk.prepare({ id: randomUUID(), userId: 'u', cwd: project });
  writeFileSync(path.join(task.cwd, 'base.txt'), 'task change\n');
  writeFileSync(path.join(project, 'base.txt'), 'main change\n'); git(project, 'add', 'base.txt'); git(project, 'commit', '-qm', 'Advance main');
  await expect(sdk.merge(task.id, 'u', (await sdk.inspect(task.id, 'u')).revision)).rejects.toThrow(/Resolve the merge/);
  expect(git(project, 'status', '--porcelain')).toBe('');
  expect(readFileSync(path.join(project, 'base.txt'), 'utf8')).toBe('main change\n');
  expect(git(task.cwd, 'diff', '--name-only', '--diff-filter=U')).toBe('base.txt');
}, 30000);
it('recovers an archive move whose final ledger write was interrupted', async () => {
  const task=await sdk.prepare({id:randomUUID(),userId:'u',cwd:project});
  writeFileSync(path.join(task.cwd,'saved.cache'),'keep after crash');
  const archived=path.join(root,'plugin','archives',task.id);mkdirSync(path.dirname(archived),{recursive:true});
  const ledger=path.join(root,'plugin','workspaces',task.id+'.json');
  writeFileSync(ledger,JSON.stringify({...task,state:'archiving'}));
  git(project,'worktree','move',task.cwd,archived);
  const result=await sdk.archive(task.id,'u');
  expect(result).toMatchObject({state:'archived',cwd:archived});
  expect(readFileSync(path.join(result.cwd,'saved.cache'),'utf8')).toBe('keep after crash');
});
it('rejects content changed between approval and the source commit', async () => {
  const actions=await import('../services/gitActions.js');
  const original=actions.gitCommit;
  const task=await sdk.prepare({id:randomUUID(),userId:'u',cwd:project});
  writeFileSync(path.join(task.cwd,'base.txt'),'reviewed bytes');
  const preview=await sdk.inspect(task.id,'u');
  const spy=vi.spyOn(actions,'gitCommit').mockImplementation(async(...args)=>{
    writeFileSync(path.join(task.cwd,'base.txt'),'unreviewed continuation');return original(...args);
  });
  const before=readFileSync(path.join(project,'base.txt'),'utf8');
  try {await expect(sdk.merge(task.id,'u',preview.revision)).rejects.toThrow(/content changed after approval/);}
  finally {spy.mockRestore();}
  expect(readFileSync(path.join(project,'base.txt'),'utf8')).toBe(before);
});

it('recovers a preparing workspace when only its original branch was created', async () => {
  const id=randomUUID(),base=git(project,'rev-parse','HEAD'),branch=`dispatch/test-plugin/${id}`;
  const cwd=path.join(root,'plugin','trees',id);
  writeFileSync(path.join(root,'plugin','workspaces',id+'.json'),JSON.stringify({id,userId:'u',project:realpathSync(project),cwd,branch,base,state:'preparing'}));
  git(project,'branch',branch,base);
  const recovered=await sdk.prepare({id,userId:'u',cwd:project});
  expect(recovered.state).toBe('active');expect(git(recovered.cwd,'rev-parse','HEAD')).toBe(base);
  expect(git(recovered.cwd,'branch','--show-current')).toBe(branch);
});
