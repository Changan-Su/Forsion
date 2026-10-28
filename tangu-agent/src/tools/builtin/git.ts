/**
 * git_status / git_commit / git_push / git_pull —— 当前项目的 git(仓根 docs/ToBeImproved/Git对话卡片方案_2026-10-28,方案 B)。
 *
 * 和项目详情 › Git 页是同一套动作(services/gitActions.ts):同一道信任闸、同一个写队列(serialized)、同一套远端凭据 ——
 * Forsion Git 用 Forsion 账号、GitHub 用绑定的账号、别的远端用这台电脑自己的凭据(runWithRemoteCredentials 按地址挑)。
 * 提交身份同提交框(resolveGitIdentity + 账号推出来的缺省),所以没配过 git 的人也能让 Agent 提交。
 *
 * 结果回紧凑 JSON:模型读得懂,桌面的 Git 卡(views/chat2/GitToolCard.tsx)解析它画卡。失败以 `Error:` 开头(registry 据此标
 * isError),第二行起是同形 JSON,带机器码 error(桌面按 projectProfile.git.err.<code> 本地化)。
 *
 * 审批档(approvals.toolNeedsApproval;10-28 用户定「有权限就直接做」):status 不问;commit 同写文件(只读档问);
 * push / pull 同跑命令(capabilities.approval:'command':只读、替我批准问,完全通行直接做,「本会话总是允许」有效)。不用 'always'。
 *
 * 可见性:host 模式 + 会话属于一个本机项目(ctx.projectScoped,按会话存档的 project_path 定,模型给不了)。开着宿主沙箱时
 * 不在 hostSandboxPolicy 的放行名单里(git 子进程不进沙箱)→ 看不到,模型照旧在沙箱里用 run_bash。
 */
import type { ToolDef, ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { GitActionError, gitCommit, gitPending, gitPull, gitPush, serialized } from '../../services/gitActions.js';
import { canonicalProjectPath, gitSummary, type GitSummary } from '../../services/projectContext.js';
import { githubLinkInfo } from '../../services/githubGit.js';
import { accountIdentityDefaults, resolveGitIdentity } from '../../services/gitIdentity.js';
import type { GitRemoteInfo } from '../../services/gitRemotes.js';

export const GIT_TOOL_NAMES = ['git_status', 'git_commit', 'git_push', 'git_pull'] as const;

const FILES_LISTED = 20;
const COMMITS_LISTED = 5;

function enabledFor(_p: unknown, ctx: ToolContext): boolean {
  return !!ctx.projectScoped && !!ctx.cwd;
}

/** 绑定的 GitHub 账号(远端行的「用谁的账号」)。走一趟云端,限时;读不到 = undefined(只说「绑定的 GitHub 账号」)。 */
async function githubLogin(): Promise<string | null | undefined> {
  const timeout = new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 3000).unref(); });
  const info = await Promise.race([githubLinkInfo().catch(() => undefined), timeout]);
  if (!info) return undefined;
  return info.linked ? info.login ?? undefined : null;
}

/** 远端 → 给模型 / 卡片看的一行:哪个站、哪个仓库、推拉用谁的账号。站名与 desktop ProjectGitRemotes.siteName 同口径。 */
export function describeRemote(r: GitRemoteInfo, pushRemote: string | null | undefined, login: string | null | undefined) {
  const site = r.host === 'forsion' ? 'Forsion Git' : r.host === 'github' ? 'GitHub' : r.hostname ?? 'local path';
  const account = r.auth === 'forsion' ? "the user's Forsion account"
    : r.auth === 'github' ? (login ? `linked GitHub account @${login}` : login === null ? "this computer's own git credentials (no GitHub account linked)" : 'the linked GitHub account')
      : "this computer's own git credentials";
  return { name: r.name, site, host: r.host, auth: r.auth, repo: r.path, web: r.web, account, ...(login && r.auth === 'github' ? { login } : {}), ...(r.name === pushRemote ? { pushTarget: true } : {}) };
}

async function projectDir(ctx: ToolContext): Promise<string> {
  return canonicalProjectPath(ctx.cwd);
}

/** git_status 的结果:分支、上下游、改动清单、远端(全部列出,标出推送去向)、最近几个提交。 */
export function renderStatus(s: GitSummary, login: string | null | undefined): Record<string, unknown> {
  if (!s.available) return { repo: false, note: 'git is not installed on this computer.' };
  if (!s.repo) return { repo: false, note: 'This project folder is not a git repository. The user can create one in the project details (Git tab), or you can run `git init` with run_bash if they ask.' };
  if (s.nested) return { repo: true, nested: true, note: 'This project folder is inside a larger repository, not at its root; commit / push / pull from here are refused. Use run_bash for this repository.' };
  const notes: string[] = [];
  if (s.configRisks?.length && !s.trusted) notes.push('This repository has its own git configuration that runs programs. Commit, push and pull are refused until the user trusts it in the project details (Git tab).');
  if (s.changesUnread) notes.push('The list of changes could not be read without running the repository\'s own filters; it is not necessarily clean.');
  if (s.detached) notes.push('HEAD is detached; switch to a branch before committing or pushing.');
  if ((s.remoteList?.length ?? 0) > 1 && !s.pushRemote) notes.push('Several remotes and none is the push target: pass `remote` to git_push, or ask the user which one.');
  return {
    repo: true,
    branch: s.branch ?? null,
    ...(s.detached ? { detached: true } : {}),
    upstream: s.upstream ?? null,
    ahead: s.ahead ?? 0,
    behind: s.behind ?? 0,
    changes: {
      total: s.changesTotal ?? s.changes?.length ?? 0,
      staged: s.staged ?? 0, unstaged: s.unstaged ?? 0, untracked: s.untracked ?? 0,
      files: (s.changes ?? []).slice(0, FILES_LISTED).map((c) => ({ code: c.code, path: c.path })),
    },
    remotes: (s.remoteList ?? []).map((r) => describeRemote(r, s.pushRemote, login)),
    pushTarget: s.pushRemote ?? null,
    recentCommits: (s.commits ?? []).slice(0, COMMITS_LISTED).map((c) => ({ sha: c.short, subject: c.subject })),
    ...(notes.length ? { notes } : {}),
  };
}

/** 引擎机器码 → 给模型的一句「接下来怎么办」(界面另按机器码本地化,不读这句)。 */
const NEXT_STEP: Partial<Record<string, string>> = {
  untrusted_config: 'Ask the user to trust this repository in the project details (Git tab), then try again.',
  credential_denied: 'The account used for this remote has no write access. Tell the user which account was used and suggest linking a different GitHub account in the account centre, or pushing to a remote they own.',
  no_remote: 'There is no remote. The user can add or publish one in the project details (Git tab).',
  ambiguous_remote: 'Call git_status to see the remotes, then pass `remote` to git_push or ask the user which one.',
  no_upstream: 'This branch has no upstream yet; push it first.',
  diverged: 'Local and remote both have new commits. Nothing was merged; ask the user how to reconcile (rebase or merge) before doing it with run_bash.',
  dirty_worktree: 'Uncommitted changes are in the way; commit them first or ask the user.',
  nothing_to_commit: 'There is nothing to commit.',
  changes_changed: 'The changes moved while committing; call git_status and try again.',
};

function failure(action: string, e: unknown): string {
  if (e instanceof GitActionError) {
    const detail = typeof e.detail === 'string' && e.detail ? e.detail.slice(-600) : undefined;
    const next = NEXT_STEP[e.code];
    return `Error: ${e.message}${next ? ` ${next}` : ''}\n${JSON.stringify({ action, error: e.code, message: e.message, ...(detail ? { detail } : {}) })}`;
  }
  const message = e instanceof Error ? e.message : String(e);
  return `Error: git ${action} failed: ${message}\n${JSON.stringify({ action, error: 'git_failed', message })}`;
}

/**
 * 审批说明(英文;TUI / 通道 / 收件箱 / 代批判官读它,桌面卡另按参数和现场画结构化卡身)。模型给的参数里没有「提交哪些文件」
 * 「推到哪个站、用谁的账号」,只有闸门读得到 —— approvals.gateToolCall 限时调它,读不到退回参数。不是 git 工具 → null。
 */
export async function gitApprovalPreview(name: string, args: any, cwd: string | undefined): Promise<string | null> {
  if (!cwd || !(GIT_TOOL_NAMES as readonly string[]).includes(name) || name === 'git_status') return null;
  const dir = await canonicalProjectPath(cwd);
  if (name === 'git_commit') {
    const [s, pending] = await Promise.all([gitSummary(dir), gitPending(dir).catch(() => null)]);
    const msg = typeof args?.message === 'string' ? args.message.trim() : '';
    const more = pending && pending.total > FILES_LISTED ? `\n  … ${pending.total - FILES_LISTED} more` : '';
    const files = pending
      ? `${pending.total} file${pending.total === 1 ? '' : 's'}${pending.stagedOnly ? ' (staged only)' : ''}:\n${pending.files.slice(0, FILES_LISTED).map((f) => `  ${f.code} ${f.path}`).join('\n')}${more}`
      : 'files: (could not be listed)';
    return `commit to ${s.branch ?? 'HEAD'}\n${msg}\n${files}`;
  }
  const [s, login] = await Promise.all([gitSummary(dir), name === 'git_push' ? githubLogin() : Promise.resolve(undefined)]);
  if (name === 'git_pull') return `pull ${s.upstream ?? '(no upstream)'} into ${s.branch ?? 'HEAD'} (fast-forward only)`;
  const once = typeof args?.remote === 'string' && args.remote.trim() ? args.remote.trim() : null;
  const to = once ?? s.pushRemote ?? null;
  const r = to ? s.remoteList?.find((x) => x.name === to) : undefined;
  const d = r ? describeRemote(r, s.pushRemote, login) : null;
  const where = d ? `${d.site} ${d.repo ?? r!.url} (${d.name})` : to ? `remote ${to}` : 'the default remote';
  const ahead = !once && s.upstream ? `\n${s.ahead ?? 0} commit${s.ahead === 1 ? '' : 's'} ahead of ${s.upstream}` : '';
  return `push ${s.branch ?? 'HEAD'} to ${where}${d ? `\nwith ${d.account}` : ''}${ahead}${once && s.pushRemote && once !== s.pushRemote ? `\nthis once; the default push target stays ${s.pushRemote}` : ''}`;
}

const project = {
  type: 'object',
  properties: {},
};

function tool(name: (typeof GIT_TOOL_NAMES)[number], hint: string, description: string, parameters: object, execute: ToolDef['execute'], extra: Partial<ToolDef> = {}): ToolDef {
  return {
    name, mode: 'host', deferred: true, deferGroup: 'git', deferHint: hint, isEnabledFor: enabledFor,
    definition: { type: 'function', function: { name, description, parameters } } as ToolDef['definition'],
    execute, ...extra,
  };
}

export const gitToolsProvider: ToolProvider = {
  id: 'builtin:git',
  tools: () => [
    tool('git_status',
      "The current project's git state: branch, changes, remotes (Forsion Git / GitHub) and which one pushes, recent commits. Use these git_* tools instead of running git in the shell to check, commit, push or pull.",
      "Read the current project's git state: branch and upstream, how far ahead / behind, the changed files, every remote (site such as Forsion Git or GitHub, repository, and the account used for it) with the one that `git_push` uses by default, and the latest commits. Read-only. " +
        'The user sees the result as a git card in the conversation.',
      project,
      async (_args, ctx) => {
        try {
          const cwd = await projectDir(ctx);
          const [s, login] = await Promise.all([gitSummary(cwd), githubLogin()]);
          return JSON.stringify({ action: 'status', ...renderStatus(s, login) });
        } catch (e) { return failure('status', e); }
      },
      { capabilities: { sideEffect: 'read' } }),
    tool('git_commit',
      'Commit the current project\'s changes with a message (staged changes if any are staged, otherwise all changes).',
      'Commit in the current project, like the Commit button in the project details: if some changes are staged, only those are committed; otherwise all changes, including new files, are added and committed. ' +
        "The author is the user's git identity, or the one Forsion fills in from their account. Files that look like credentials and very large files are refused. " +
        'Write the message in the style of the recent commits (see git_status). The user sees the result as a git card.',
      { type: 'object', properties: { message: { type: 'string', description: 'The commit message: a short subject line, optionally a blank line and a body' } }, required: ['message'] },
      async (args, ctx) => {
        try {
          const cwd = await projectDir(ctx);
          return await serialized(cwd, async () => {
            const who = await resolveGitIdentity(() => accountIdentityDefaults(ctx.userId), cwd);
            const pending = await gitPending(cwd);
            const r = await gitCommit(cwd, args?.message, undefined, pending.token, who.env);
            const branch = (await gitSummary(cwd)).branch ?? null;
            return JSON.stringify({
              action: 'commit', sha: r.sha, short: r.sha.slice(0, 7), subject: r.subject, branch, stagedOnly: r.stagedOnly,
              files: pending.total, paths: pending.files.slice(0, FILES_LISTED).map((f) => f.path),
              ...(who.identity ? { author: `${who.identity.name} <${who.identity.email}>` } : {}),
            });
          });
        } catch (e) { return failure('commit', e); }
      },
      { capabilities: { sideEffect: 'write' } }),
    tool('git_push',
      "Push the current project's branch to its remote (Forsion Git, GitHub or another one), with the account Forsion uses for that site.",
      'Push the current branch. Without `remote` it goes where the project pushes by default (the branch\'s upstream, else origin, else the only remote; see `pushTarget` in git_status). ' +
        'With `remote` it pushes the branch to that remote once, without changing where it normally pushes. ' +
        "Credentials: Forsion Git uses the user's Forsion account, GitHub uses their linked GitHub account, other remotes use this computer's own git credentials. Never force-pushes unless the user turned that on in Settings. " +
        'The user sees the result as a git card.',
      { type: 'object', properties: { remote: { type: 'string', description: 'Name of the remote to push to this once (from git_status `remotes`). Leave it out to use the default push target.' } } },
      async (args, ctx) => {
        try {
          const cwd = await projectDir(ctx);
          const to = typeof args?.remote === 'string' && args.remote.trim() ? args.remote.trim() : undefined;
          return await serialized(cwd, async () => {
            const [before, login] = await Promise.all([gitSummary(cwd), githubLogin()]);
            const r = to ? await gitPush(cwd, undefined, to, { once: true }) : await gitPush(cwd);
            const info = before.remoteList?.find((x) => x.name === r.remote);
            return JSON.stringify({
              action: 'push', remote: r.remote, branch: r.branch, target: r.target,
              commits: !to && before.upstream === r.target ? before.ahead ?? null : null,
              ...(info ? { site: describeRemote(info, before.pushRemote, login) } : {}),
              ...(r.ownCredentials ? { ownCredentials: true } : {}),
            });
          });
        } catch (e) { return failure('push', e); }
      },
      { capabilities: { sideEffect: 'network', approval: 'command' } }),
    tool('git_pull',
      "Bring the current project's branch up to date with its upstream (fast-forward only).",
      'Fetch the current branch\'s upstream and fast-forward to it. It never merges or rebases: if both sides have new commits, or uncommitted changes are in the way, nothing changes and the error says why. ' +
        'The user sees the result as a git card.',
      project,
      async (_args, ctx) => {
        try {
          const cwd = await projectDir(ctx);
          return await serialized(cwd, async () => JSON.stringify({ action: 'pull', ...(await gitPull(cwd)) }));
        } catch (e) { return failure('pull', e); }
      },
      { capabilities: { sideEffect: 'network', approval: 'command' } }),
  ],
};
