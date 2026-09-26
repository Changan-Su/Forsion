/**
 * PROJECT 详情「Git」页的宿主动作 —— 用户点了才做:建仓 / 生成提交信息 / 提交 / 新建分支 / 推送。
 *
 * 口径(对标 ChatGPT 桌面端 + Codex 源码,2026-09-26 核过):agent 永远不自己 `git init`;建仓是用户点的按钮。
 * Codex 的每轮自动快照 2026-04 已撤掉,此前它在一个受信的家目录里 `git add -A` 撑爆过磁盘(openai/codex#19588)
 * —— 所以提交前先看要进仓的东西,太多 / 太大 / 夹着别的仓就拒绝并说清楚,不替用户 `add -A` 一个大目录。
 *
 * - 目录只来自路由按 sessionId 取的会话 project_path(cwd 不从客户端收)。
 * - 这些是**用户自己的 git 操作**:照用户的 git 配置跑(钩子、签名、过滤器、LFS 都生效),与他在终端里敲的一样。
 *   自动触发的只读路径(面板摘要、每轮 `[Git state]`)仍走 runGit 的加固前缀 —— 那些没有人点。
 * - 绝不等交互:GIT_TERMINAL_PROMPT=0、ssh BatchMode;超时即报错。
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { runBoundedProcess } from '../utils/boundedProcess.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import { gitExecutable, runGit } from './runtimeContext.js';
import { gitSettings } from './gitSettings.js';

const ACTION_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;
/** 一次提交最多新增这么多个未跟踪文件;再多几乎一定是漏了 .gitignore(node_modules、构建产物、整个笔记库)。 */
export const MAX_NEW_FILES = 1000;
/** 单个新文件的上限:GitHub 拒收 100MB 以上的文件,50MB 起就会告警。 */
export const MAX_NEW_FILE_BYTES = 50 * 1024 * 1024;
export const COMMIT_MESSAGE_MAX = 5000;
/** 喂给模型写提交信息的 diff 上限。 */
const DIFF_BUDGET = 12_000;
const MESSAGE_MAX_TOKENS = 400;

/** 建仓时没有 .gitignore 就放这一份(有就一个字不动)。 */
export const DEFAULT_GITIGNORE = [
  '# Created by Forsion together with this repository. Edit freely.',
  'node_modules/',
  '.DS_Store',
  'Thumbs.db',
  '.env',
  '.env.*',
  '!.env.example',
  '__pycache__/',
  '.venv/',
  '*.log',
  '',
].join('\n');

/** 带稳定 code 的失败:桌面按 code 出本地化文案,detail 给原文(git 的 stderr / 文件名)。 */
export class GitActionError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: string) { super(message); }
}

/** 这几个环境变量会把 git 指到别的仓去;仓只由 -C 决定(同 runtimeContext / desktop gitHistory)。 */
const SCRUBBED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE'];

interface ActionResult { code: number; stdout: string; stderr: string }

async function runAction(cwd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<ActionResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of SCRUBBED_ENV) delete env[key];
  // 口令短语 / 首次连接确认都会让 ssh 等一个不存在的终端;ssh-agent / 钥匙串里的钥匙照常可用。用户自己设了就不动。
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  const r = await runBoundedProcess(gitExecutable(), ['--no-pager', '-c', 'core.quotepath=false', '-C', cwd, ...args], {
    cwd, env, input: opts.input, timeoutMs: opts.timeoutMs ?? ACTION_TIMEOUT_MS, maxOutputBytes: 1024 * 1024,
  });
  if (r.reason === 'spawn-error') throw new GitActionError('git_unavailable', 'git is not available on this machine');
  if (r.reason === 'timeout') throw new GitActionError('git_timeout', `git ${args[0]} timed out`, tail(r.stderr || r.stdout));
  return r;
}

const tail = (text: string, max = 1500): string => { const t = text.trim(); return t.length > max ? `…${t.slice(-max)}` : t; };

function must(r: ActionResult, what: string): ActionResult {
  if (r.code !== 0) throw new GitActionError('git_failed', `git ${what} failed`, tail(r.stderr || r.stdout));
  return r;
}

async function insideWorkTree(cwd: string): Promise<boolean> {
  const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], undefined, 5000);
  if (r.reason === 'spawn-error') throw new GitActionError('git_unavailable', 'git is not available on this machine');
  return r.code === 0 && r.stdout.trim() === 'true';
}

async function requireRepo(cwd: string): Promise<void> {
  if (!(await insideWorkTree(cwd))) throw new GitActionError('not_repo', 'This folder is not a git repository');
}

/** 同一目录的写动作排队(双击 / 两个窗口同时点:并发的 add / commit 会撞 index.lock)。 */
const chains = new Map<string, Promise<unknown>>();
export function serialized<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const next = (chains.get(cwd) ?? Promise.resolve()).catch(() => {}).then(task);
  chains.set(cwd, next);
  void next.catch(() => {}).finally(() => { if (chains.get(cwd) === next) chains.delete(cwd); });
  return next;
}

// ── 建仓 ──────────────────────────────────────────────────────────────────

/** 在项目目录里建仓(不做首次提交 —— 要进仓的东西让用户在面板里看过再提交)。已在某个仓里(含外层仓)→ 拒绝。
 *  没有 .gitignore 才写一份缺省的:lstat 看到任何东西(含软链)都不碰,新建用 O_EXCL。
 *  用户配了 init.defaultBranch 就照用,没配才用 main。 */
export async function gitInit(cwd: string): Promise<{ createdGitignore: boolean }> {
  if (await insideWorkTree(cwd)) throw new GitActionError('already_repo', 'This folder is already inside a git repository');
  let createdGitignore = false;
  const ignore = path.join(cwd, '.gitignore');
  const present = await fs.lstat(ignore).then(() => true, (e) => { if (e?.code === 'ENOENT') return false; throw e; });
  if (!present) {
    const handle = await fs.open(ignore, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
    try { await handle.writeFile(DEFAULT_GITIGNORE, 'utf8'); } finally { await handle.close(); }
    createdGitignore = true;
  }
  const configured = await runAction(cwd, ['config', '--get', 'init.defaultBranch']);
  const named = configured.code === 0 && configured.stdout.trim() ? null : await runAction(cwd, ['init', '-b', 'main']);
  if (!named || named.code !== 0) must(await runAction(cwd, ['init']), 'init'); // 用户配了缺省分支名,或 git < 2.28 不认 -b
  return { createdGitignore };
}

// ── 提交前的体检 ──────────────────────────────────────────────────────────

interface PendingChanges { entries: string[]; untracked: string[] }

/** 全量改动(未跟踪文件逐个列出)。输出爆了上限 = 文件多到离谱,直接按「太多」拒。 */
async function pendingChanges(cwd: string): Promise<PendingChanges> {
  const r = await runBoundedProcess(gitExecutable(), ['--no-pager', '-c', 'core.quotepath=false', '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: ACTION_TIMEOUT_MS, maxOutputBytes: 2 * 1024 * 1024,
  });
  if (r.reason === 'output-limit') throw new GitActionError('too_many_files', 'Too many files to commit; add the generated folders to .gitignore first');
  if (r.reason) throw new GitActionError('git_failed', 'git status failed', tail(r.stderr));
  must(r, 'status');
  const entries: string[] = [];
  const untracked: string[] = [];
  const fields = r.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const file = field.slice(3);
    entries.push(file);
    if (code === '??') untracked.push(file);
    if (/[RC]/.test(code)) i++; // 改名 / 复制后面跟一个原路径字段
  }
  return { entries, untracked };
}

/** 提交前的三道闸:夹着别的 git 仓 / 新文件过多 / 有超大新文件 → 拒绝,并点名。 */
export async function assertCommittable(cwd: string, changes: PendingChanges, limits = { maxFiles: MAX_NEW_FILES, maxBytes: MAX_NEW_FILE_BYTES }): Promise<void> {
  // -uall 不会钻进别的仓:嵌在里面的仓以 `dir/` 出现。add -A 会把它记成一个没有 .gitmodules 的 gitlink,克隆下来是个空目录。
  const embedded = changes.untracked.filter((f) => f.endsWith('/'));
  if (embedded.length) throw new GitActionError('embedded_repo', 'The folder contains another git repository', embedded.slice(0, 5).join('\n'));
  if (changes.untracked.length > limits.maxFiles) {
    throw new GitActionError('too_many_files', `${changes.untracked.length} new files would be added`, topDirs(changes.untracked).join('\n'));
  }
  const large: string[] = [];
  for (const file of changes.untracked) {
    const st = await fs.lstat(path.join(cwd, file)).catch(() => null);
    if (st?.isFile() && st.size > limits.maxBytes) large.push(`${file} (${Math.round(st.size / 1024 / 1024)} MB)`);
  }
  if (large.length) throw new GitActionError('large_files', 'Some new files are too large to commit', large.slice(0, 5).join('\n'));
}

/** 新文件最多的几个顶层目录,告诉用户该往 .gitignore 里加什么。 */
function topDirs(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const top = f.includes('/') ? `${f.split('/')[0]}/` : f;
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([dir, n]) => `${dir} (${n})`);
}

// ── 提交 ──────────────────────────────────────────────────────────────────

/** 提交全部改动(与面板上列出的一致:已跟踪的改动 + 未被忽略的新文件)。信息走 stdin,不经命令行参数。 */
export async function gitCommit(cwd: string, message: unknown): Promise<{ sha: string; subject: string }> {
  const text = typeof message === 'string' ? message.replace(/\0/g, '').replace(/\r\n/g, '\n').trim() : '';
  if (!text) throw new GitActionError('empty_message', 'The commit message is empty');
  if (text.length > COMMIT_MESSAGE_MAX) throw new GitActionError('message_too_long', `The commit message is longer than ${COMMIT_MESSAGE_MAX} characters`);
  await requireRepo(cwd);
  const changes = await pendingChanges(cwd);
  if (!changes.entries.length) throw new GitActionError('nothing_to_commit', 'There is nothing to commit');
  await assertCommittable(cwd, changes);
  must(await runAction(cwd, ['add', '-A']), 'add');
  const committed = await runAction(cwd, ['commit', '-F', '-'], { input: `${text}\n` });
  if (committed.code !== 0 && /tell me who you are|unable to auto-detect email address|auto-detection is disabled/i.test(committed.stderr)) {
    throw new GitActionError('no_identity', 'git does not know your name and email yet', tail(committed.stderr));
  }
  must(committed, 'commit');
  const head = must(await runAction(cwd, ['log', '-1', '--format=%H%x1f%s']), 'log');
  const [sha, subject = ''] = head.stdout.trim().split('\x1f');
  return { sha, subject };
}

// ── 新建分支 ──────────────────────────────────────────────────────────────

/** 从当前位置建分支并切过去(未提交的改动跟着走,不丢)。名字由用户给(面板预填了前缀),这里不再加前缀。 */
export async function gitCreateBranch(cwd: string, name: unknown): Promise<{ branch: string }> {
  const branch = typeof name === 'string' ? name.trim() : '';
  await requireRepo(cwd);
  const check = await runAction(cwd, ['check-ref-format', '--branch', branch || '-']);
  if (!branch || branch.startsWith('-') || check.code !== 0) throw new GitActionError('invalid_branch', 'That is not a valid branch name', branch);
  must(await runAction(cwd, ['switch', '-c', branch]), 'switch');
  return { branch };
}

// ── 推送 ──────────────────────────────────────────────────────────────────

/** 推当前分支。有上游 → 推上游;没有 → 推到 origin(只有一个远端时推到它)并设为上游。
 *  「设置 → Git」开了 forceWithLease 就一律带 --force-with-lease:改写过历史也能推,但远端被别人推进过仍拒绝。 */
export async function gitPush(cwd: string): Promise<{ remote: string; branch: string; output: string }> {
  await requireRepo(cwd);
  const head = must(await runAction(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'rev-parse').stdout.trim();
  if (!head || head === 'HEAD') throw new GitActionError('detached', 'HEAD is detached; switch to a branch before pushing');
  const force = gitSettings().forceWithLease ? ['--force-with-lease'] : [];
  const upstream = await runAction(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let remote: string;
  let args: string[];
  if (upstream.code === 0 && upstream.stdout.trim()) {
    remote = upstream.stdout.trim().split('/')[0];
    args = ['push', ...force];
  } else {
    const remotes = must(await runAction(cwd, ['remote']), 'remote').stdout.split('\n').map((r) => r.trim()).filter(Boolean);
    const target = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '';
    if (!target) throw new GitActionError(remotes.length ? 'ambiguous_remote' : 'no_remote', remotes.length ? 'Several remotes are configured and none is called origin' : 'No remote is configured', remotes.join('\n'));
    remote = target;
    args = ['push', ...force, '--set-upstream', target, head];
  }
  const r = must(await runAction(cwd, args, { timeoutMs: PUSH_TIMEOUT_MS }), 'push');
  return { remote, branch: head, output: tail(r.stderr || r.stdout, 600) };
}

// ── 生成提交信息 ──────────────────────────────────────────────────────────

/** 写提交信息要看的现场:改了哪些文件、diff(截断)、最近几条提交的风格。 */
export async function commitMessageContext(cwd: string): Promise<string> {
  await requireRepo(cwd);
  const changes = await pendingChanges(cwd);
  if (!changes.entries.length) throw new GitActionError('nothing_to_commit', 'There is nothing to commit');
  const hasHead = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, 5000)).code === 0;
  const [stat, patch, log] = await Promise.all([
    hasHead ? runGit(cwd, ['diff', 'HEAD', '--stat', '--no-color'], undefined, 10_000) : null,
    hasHead ? runGit(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '-U2'], undefined, 10_000) : null,
    hasHead ? runGit(cwd, ['log', '-8', '--format=%s'], undefined, 5000) : null,
  ]);
  const parts: string[] = [];
  if (log?.code === 0 && log.stdout.trim()) parts.push(`Recent commit subjects (match their language and style):\n${log.stdout.trim()}`);
  else parts.push('This will be the first commit of the repository.');
  if (changes.untracked.length) parts.push(`New files (${changes.untracked.length}):\n${changes.untracked.slice(0, 60).join('\n')}${changes.untracked.length > 60 ? '\n…' : ''}`);
  if (stat?.code === 0 && stat.stdout.trim()) parts.push(`Changed tracked files:\n${stat.stdout.trim()}`);
  const diff = patch?.code === 0 ? patch.stdout : '';
  if (diff.trim()) parts.push(`Diff${diff.length > DIFF_BUDGET ? ' (truncated)' : ''}:\n${diff.slice(0, DIFF_BUDGET)}`);
  return parts.join('\n\n');
}

export function commitMessagePrompt(instructions: string): string {
  return [
    'You write git commit messages. Reply with the commit message only: no code fences, no quotes, no commentary.',
    'Start with a subject line of at most 72 characters in the imperative mood that says what the change does.',
    'Add a blank line and a short body only when the reason or the scope is not obvious from the subject.',
    'Describe only what the provided changes show; do not invent details.',
    instructions ? `Follow these instructions from the user; they override the style above where they conflict:\n${instructions}` : '',
  ].filter(Boolean).join('\n');
}

/** 模型偶尔还是会包一层代码块 / 引号,剥掉;行尾空白收紧。 */
export function cleanCommitMessage(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fence) text = fence[1].trim();
  if (/^(["'`])[\s\S]*\1$/.test(text) && !text.slice(1, -1).includes(text[0])) text = text.slice(1, -1).trim();
  return text.split('\n').map((line) => line.trimEnd()).join('\n').slice(0, COMMIT_MESSAGE_MAX);
}

/** 用会话自己的模型写一条提交信息。这条路不经 agent loop:计费照 visionService 同款三步(预检 → 扣费 → 记用量),漏了就是免费 LLM。 */
export async function generateCommitMessage(cwd: string, opts: { userId: string; modelId: string | null; appId: string; signal?: AbortSignal }): Promise<string> {
  const modelId = (opts.modelId || '').trim();
  if (!modelId) throw new GitActionError('no_model', 'This conversation has no model yet');
  const context = await commitMessageContext(cwd);
  const billing = deps().billing;
  const user = (await deps().brain.users.getUserById(opts.userId).catch(() => null)) ?? { id: opts.userId, username: 'local' };
  const estCost = await billing.calculateCost(modelId, Math.ceil(context.length / 3), MESSAGE_MAX_TOKENS);
  const pre = await billing.canConsumeTokenPoints(user.id, estCost);
  if (!pre.ok) throw new GitActionError('quota_exceeded', 'token_quota_exceeded');
  const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(modelId);
  const payload = await deps().brain.llm.buildProviderPayload({
    model, apiModelId,
    messages: [
      { role: 'system', content: commitMessagePrompt(gitSettings().commitInstructions) },
      { role: 'user', content: context },
    ] as ChatMessage[],
    projectSource: '', usageSource: opts.appId,
    temperature: 0.2, maxTokens: MESSAGE_MAX_TOKENS, stream: true, signal: opts.signal,
  } as any);
  const res = await deps().brain.llm.streamProviderCompletion({ apiKey, baseUrl, payload, provider: (model as any)?.provider, signal: opts.signal });
  const usage = res?.usage || ({} as any);
  const cached = usage.cached_tokens || 0;
  const cost = await billing.calculateCost(modelId, usage.prompt_tokens || 0, usage.completion_tokens || 0, undefined, cached);
  await billing.consumeTokenPoints(user.id, cost).catch(() => {});
  await (billing.logApiUsage as any)(
    user.username, modelId, model.name, model.provider,
    usage.prompt_tokens || 0, usage.completion_tokens || 0, true, undefined, opts.appId, cost, cached,
  ).catch(() => {});
  const message = cleanCommitMessage(String(res?.content || ''));
  if (!message) throw new GitActionError('empty_message', 'The model returned an empty commit message');
  return message;
}
