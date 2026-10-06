/** Plugin-owned task worktrees. Registry paths and branch names are assigned by the host. */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withTaskMaintenance } from '../services/taskProjectQueue.js';
import { deps } from '../seams/runtime.js';
import { currentRunId } from '../seams/runContext.js';
import { effectiveRemote } from '../services/remoteOrigin.js';
import { isForbiddenProjectRoot } from '../tools/builtin/startProjectSession.js';
import { readGit, runAction, requireRepoRoot, requireTrust, serialized, gitPending, gitCommit } from '../services/gitActions.js';

export interface PluginWorkspace {
  id: string; userId: string; project: string; cwd: string; branch: string; base: string;
  state: 'preparing' | 'active' | 'archiving' | 'archived'; mergedSha?: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9-]{27,40}$/i;
const must = (r: { code: number; stdout: string; stderr: string; reason?: string }) => {
  if (r.code || r.reason) throw new Error((r.stderr || r.stdout || r.reason || 'Git failed').slice(-3000));
  return r.stdout.trim();
};
export function createPluginWorkspaces(owner: string, directory: string, alive: () => boolean) {
  const check = () => {
    if (!alive() || !deps().profile.capabilities.hostExec || (currentRunId() && effectiveRemote({ runId: currentRunId()! }))) throw new Error('Local active plugin required');
  };
  const recordPath = (id: string) => {
    if (!UUID.test(id)) throw new Error('Invalid workspace ID');
    return path.join(directory, 'workspaces', `${id}.json`);
  };
  const save = async (row: PluginWorkspace) => {
    const file = recordPath(row.id); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(row), { mode: 0o600 }); await fs.rename(`${file}.tmp`, file);
  };
  const read = async (id: string, userId: string): Promise<PluginWorkspace> => {
    check(); const row = JSON.parse(await fs.readFile(recordPath(id), 'utf8')) as PluginWorkspace;
    if (row.id !== id || row.userId !== userId || !row.cwd.startsWith(path.resolve(directory) + path.sep)) throw new Error('Workspace not owned by this user');
    if (row.state === 'archiving' || (row.state === 'active' && !await fs.stat(row.cwd).then(()=>true,()=>false))) {
      const archive = path.join(directory, 'archives', id);
      if (await fs.stat(path.join(archive, '.git')).then(()=>true,()=>false)) {
        await validate({...row,cwd:archive,state:'active'});
        row.cwd=archive;row.state='archived';await save(row);
      } else if (row.state === 'archiving') { row.state='active';await validate(row);await save(row); }
    }
    return row;
  };
  const validate = async (row: PluginWorkspace) => {
    if (row.state !== 'active') throw new Error('Workspace is not active');
    await requireRepoRoot(row.cwd); await requireTrust(row.cwd, 'read', false);
    const branch = must(await readGit(row.cwd, ['symbolic-ref', '--short', 'HEAD']));
    if (branch !== row.branch) throw new Error('Task workspace branch changed; restore it before continuing');
    const common = async (cwd: string) => fs.realpath(path.resolve(cwd, must(await readGit(cwd, ['rev-parse', '--git-common-dir']))));
    if (await common(row.project) !== await common(row.cwd)) throw new Error('Task workspace repository changed');
  };
  const preview = async (row: PluginWorkspace) => {
    await validate(row); await requireTrust(row.project, 'read', false);
    const sourceHead = must(await readGit(row.cwd, ['rev-parse', 'HEAD']));
    const targetHead = must(await readGit(row.project, ['rev-parse', 'HEAD']));
    const targetBranch = must(await readGit(row.project, ['symbolic-ref', '--short', 'HEAD']));
    const statusResult = await readGit(row.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']); must(statusResult);const status=statusResult.stdout;
    const untrackedResult=await readGit(row.cwd, ['ls-files', '--others', '--exclude-standard', '-z']);must(untrackedResult);
    const untracked = untrackedResult.stdout.split('\0').filter(Boolean);
    if (untracked.length > 1000) throw new Error('Too many new files; review .gitignore first');
    const hash = createHash('sha256').update(JSON.stringify([sourceHead, targetHead, targetBranch, status]));
    for (const name of untracked) {
      const file = path.resolve(row.cwd, name);
      if (!file.startsWith(row.cwd + path.sep)) throw new Error('Invalid Git file path');
      const stat = await fs.lstat(file);
      if (stat.size > 50 * 1024 * 1024) throw new Error(`New file exceeds 50 MB: ${name}`);

    }
    // Freeze approved bytes in a private index; never stage files in the user's index.
    const indexFile=path.join(directory, `preview-${randomUUID()}.index`);
    let tree;
    try {
      must(await readGit(row.cwd,['read-tree',sourceHead],{indexFile}));
      must(await readGit(row.cwd,['add','--all','--','.'],{indexFile}));
      tree=must(await readGit(row.cwd,['write-tree'],{indexFile}));
    } finally {await fs.rm(indexFile,{force:true});await fs.rm(indexFile+'.lock',{force:true});}
    hash.update(tree);
    const result=await readGit(row.cwd,['diff','--no-ext-diff','--no-textconv','--binary',row.base,tree,'--'],{maxOutputBytes:8*1024*1024});must(result);const diff=result.stdout;
    return { ...row, tree, sourceHead, targetHead, targetBranch, revision: hash.digest('hex'),
      diff: diff.slice(0, 150000), truncated: diff.length > 150000,
      dirty: !!status, untracked };
  };
  return {
    async prepare(p: { id: string; userId: string; cwd: string; baseRef?: string; trust?: boolean }): Promise<PluginWorkspace> {
      check(); recordPath(p.id);
      if (!p.userId || !path.isAbsolute(p.cwd)) throw new Error('User and absolute project directory required');
      const project = await fs.realpath(p.cwd);
      if (isForbiddenProjectRoot(project)) throw new Error('Choose a project repository');
      await requireRepoRoot(project); await requireTrust(project, 'write', p.trust);
      return serialized(project, async () => {
        let row: PluginWorkspace | undefined;
        try { row = await read(p.id, p.userId); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
        if (row && row.project !== project) throw new Error('Workspace already belongs to another project');
        if (row?.state === 'archived') throw new Error('Workspace has been archived');
        if (row?.state === 'active') { await validate(row); return row; }
        if (!row) {
          const ref = p.baseRef || 'HEAD';
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(ref)) throw new Error('Invalid base ref');
          const base = must(await readGit(project, ['rev-parse', '--verify', `${ref}^{commit}`]));
          row = { id: p.id, userId: p.userId, project, cwd: path.join(directory, 'trees', p.id), branch: `dispatch/${owner}/${p.id}`, base, state: 'preparing' };
          await save(row);
        }
        const exists = await fs.stat(path.join(row.cwd, '.git')).then(() => true, () => false);
        if (!exists) {
          await fs.mkdir(path.dirname(row.cwd), { recursive: true });
          const branch = await readGit(project, ['rev-parse', '--verify', `refs/heads/${row.branch}`]);
          if (branch.code === 0) {
            // A prior add may have created the branch before its process stopped. Never reset it.
            if (branch.stdout.trim() !== row.base) throw new Error('Preparing workspace branch has changed; recover it manually');
            must(await runAction(project, ['worktree', 'add', row.cwd, row.branch]));
          } else must(await runAction(project, ['worktree', 'add', '-b', row.branch, row.cwd, row.base]));
        }
        row.state = 'active'; await validate(row); await save(row); return row;
      });
    },
    async inspect(id: string, userId: string) { return preview(await read(id, userId)); },
    async merge(id: string, userId: string, revision: string) {
      const row = await read(id, userId);
      return withTaskMaintenance([row.project,row.cwd], () => serialized(row.project, async () => {
        const before = await preview(row);
        if (before.truncated) throw new Error('Diff is too large for this preview; review and merge manually');
        if (revision !== before.revision) throw new Error('Changes or target branch changed. Review again.');
        await requireTrust(row.project, 'write', false); await requireTrust(row.cwd, 'write', false);
        if (must(await readGit(row.project, ['status', '--porcelain=v1', '--untracked-files=all']))) throw new Error('The destination project has local changes; keep them and merge after they are resolved');
        if (before.dirty) {
          const pending = await gitPending(row.cwd);
          if (pending.stagedOnly && must(await readGit(row.cwd, ['diff', '--name-only']))) throw new Error('Both staged and unstaged changes exist. Commit or unstage them in the task first.');
          await gitCommit(row.cwd, `Complete Dispatch task ${id}`, false, pending.token);
          if (must(await readGit(row.cwd, ['status', '--porcelain=v1', '--untracked-files=all']))) throw new Error('Uncommitted changes remain. Review again.');
        }
        if (must(await readGit(row.cwd,['rev-parse','HEAD^{tree}'])) !== before.tree) throw new Error('Task content changed after approval. Review again.');
        // Integrate the destination in the isolated task first. Conflicts never dirty the destination.
        const sync = await runAction(row.cwd, ['merge', '--no-edit', '--no-overwrite-ignore', before.targetHead]);
        if (sync.code || sync.reason) throw new Error(`Resolve the merge in the task workspace, then review again: ${sync.stderr || sync.stdout}`);
        const nowHead = must(await readGit(row.project, ['rev-parse', 'HEAD']));
        const nowBranch = must(await readGit(row.project, ['symbolic-ref', '--short', 'HEAD']));
        if (nowHead !== before.targetHead || nowBranch !== before.targetBranch) throw new Error('The destination changed while preparing the merge. Review again.');
        if (must(await readGit(row.project, ['status', '--porcelain=v1', '--untracked-files=all']))) throw new Error('The destination acquired local changes. Review again.');
        const head = must(await readGit(row.cwd, ['rev-parse', 'HEAD']));
        must(await runAction(row.project, ['merge', '--ff-only', '--no-overwrite-ignore', head]));
        row.mergedSha = head; await save(row); return { sha: head, branch: before.targetBranch };
      }));
    },
    async archive(id: string, userId: string) {
      const row = await read(id, userId);
      return withTaskMaintenance([row.project,row.cwd], () => serialized(row.project, async () => {
        if (row.state === 'archived') return row;
        await validate(row); await requireTrust(row.cwd, 'write', false);
        const archive = path.join(directory, 'archives', row.id); await fs.mkdir(path.dirname(archive), { recursive: true });
        row.state='archiving';await save(row);
        // Move intact, including ignored files and uncommitted work. Never force-remove or delete branches.
        must(await runAction(row.project, ['worktree', 'move', row.cwd, archive]));
        row.cwd = archive; row.state = 'archived'; await save(row); return row;
      }));
    },
  };
}
