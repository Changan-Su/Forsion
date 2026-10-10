/**
 * PROJECT 详情「Git」页的宿主动作 —— 用户点了才做:建仓 / 待提交清单 / 生成提交信息 / 提交 / 新建分支 / 推送 / 信任仓库。
 *
 * 口径(对标 ChatGPT 桌面端 + Codex 源码,2026-09-26 核过):agent 永远不自己 `git init`;建仓是用户点的按钮。
 * Codex 的每轮自动快照 2026-04 已撤掉,此前它在一个受信的家目录里 `git add -A` 撑爆过磁盘(openai/codex#19588)。
 *
 * 边界(Codex 评审 09-27 的 P0 全在这里):
 * - 目录只来自路由按 sessionId 取的会话 project_path(cwd 不从客户端收);默认工作区及其上级不建仓、不整目录提交。
 * - 写动作只在**仓库根目录**做:项目是大仓的子目录时 `add -A` 会暂存整个父仓 → 拒(nested_repo)。
 * - 仓库自带会执行程序的配置(钩子 / 过滤器 / sshCommand / 凭据助手…)未经用户信任不跑(gitTrust);信任后照用户自己的配置跑,
 *   与他在终端里敲的一样。自动触发的只读路径一律走 READ_ONLY_GIT_ARGS。
 * - 提交:有已暂存的就只提交已暂存的(不替用户推翻部分暂存);没有才 `add -A`。按**最终 index** 复核:新文件数、单文件体积、
 *   嵌套仓(gitlink)、凭据类文件名 —— 不过关就拒;是我们自己 add 的,拒之前把 index 退回原样。
 * - 推送:显式 refspec 推当前分支;改写历史只在设置开了时带 `--force-with-lease --force-if-includes`。
 * - 拉取:fetch 当前分支上游所在的远端,然后**只做快进**;两边都有新提交(diverged)只报告,不合并、不变基;
 *   没有上游(no_upstream)、本地改动挡住快进(dirty_worktree)各有稳定 code。它会跑钩子(post-merge)→ 与别的写动作同一道闸。
 * - 连远端的动作(推送 / 拉取的 fetch)按远端主机问一次凭据接缝(services/gitCredentials.ts):有提供方认领就把凭据
 *   **只经环境变量、只给这一个子进程**;没人认领 = 一个字节都不多。凭据不进命令行参数、不进日志、不进错误 detail、不回渲染层:
 *   带凭据的子进程先摘掉 `GIT_TRACE*` / `GIT_CURL_VERBOSE`,输出回显前再按字面遮一遍。
 *   仓库自带传输配置(http.* / 远端代理:代理 + 关证书校验能把请求头交给中间人)时,未经信任不带凭据(untrusted_transport)。
 * - 绝不等交互:GIT_TERMINAL_PROMPT=0、ssh BatchMode;超时即报错。
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runBoundedProcess } from '../utils/boundedProcess.js';
import { deps } from '../seams/runtime.js';
import type { ChatMessage } from '../core/types.js';
import { GIT_SCRUBBED_ENV, READ_ONLY_GIT_ARGS, gitExecutable } from './gitExec.js';
import { isRepoTrusted, repoConfigRisks, trustRepo, untrustedRisks } from './gitTrust.js';
import { gitSettings } from './gitSettings.js';
import { defaultWorkspaceDir } from '../channels/config.js';
import { GitCredentialError, gitCredentialEnv, isGitAuthFailure, refreshGitCredential, scrubGitSecrets, stripGitTraceEnv, type GitCredentialGrant } from './gitCredentials.js';

const ACTION_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;
/** 快进的检出 + post-merge 钩子(常见的是装依赖)。放宽:中途被杀会留下检出到一半的工作区。 */
const MERGE_TIMEOUT_MS = 5 * 60_000;
/** 一次提交最多新增这么多个文件;再多几乎一定是漏了 .gitignore(node_modules、构建产物、整个笔记库)。 */
export const MAX_NEW_FILES = 1000;
/** 单个文件的上限:GitHub 拒收 100MB 以上的文件,50MB 起就会告警。 */
export const MAX_NEW_FILE_BYTES = 50 * 1024 * 1024;
export const COMMIT_MESSAGE_MAX = 5000;
/** 待提交清单的上限:面板完整列出;一次提交超过这么多条目直接拒 —— 列不全的东西不许提交。 */
export const PENDING_LIST_MAX = 1000;
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

/** 带稳定 code 的失败:桌面按 code 出本地化文案,detail 给原文(git 的 stderr / 点名的文件 / 风险配置项)。 */
export class GitActionError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: string) { super(message); }
}

interface RunResult { code: number; stdout: string; stderr: string; reason?: string }

const baseEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of GIT_SCRUBBED_ENV) delete env[key];
  return env;
};

/** 只读、加固的 git(清单 / 摘要 / 生成信息用):不跑 fsmonitor / 钩子 / 外部 diff,不抢索引锁。 */
export async function readGit(cwd: string, args: string[], opts: { input?: string; maxOutputBytes?: number; timeoutMs?: number; indexFile?: string } = {}): Promise<RunResult> {
  const r = await runBoundedProcess(gitExecutable(), [...READ_ONLY_GIT_ARGS, '-c', 'core.quotepath=false', '-C', cwd, ...args], {
    cwd, env: { ...baseEnv(), ...(opts.indexFile ? { GIT_INDEX_FILE: opts.indexFile } : {}) }, input: opts.input, timeoutMs: opts.timeoutMs ?? ACTION_TIMEOUT_MS, maxOutputBytes: opts.maxOutputBytes ?? 1024 * 1024,
  });
  if (r.reason === 'spawn-error') throw new GitActionError('git_unavailable', 'git is not available on this machine');
  return r;
}

/** 用户的写动作:照用户自己的 git 配置跑(仓库级的可执行配置须先经 requireTrust),只关终端交互。
 *  credentials = 凭据接缝给这一次的东西(runRemoteAction 传进来):那三项环境变量只进这一个子进程;
 *  带了凭据就先摘掉跟踪开关,输出在离开这个函数之前遮掉密文 —— 之后无论进错误 detail 还是回给界面都是遮过的。 */
export async function runAction(cwd: string, args: string[], opts: { timeoutMs?: number; input?: string; credentials?: GitCredentialGrant; /** 要认 git 的原文时固定成英文。 */ english?: boolean } = {}): Promise<RunResult> {
  const env = baseEnv();
  // 口令短语 / 首次连接确认都会让 ssh 等一个不存在的终端;ssh-agent / 钥匙串里的钥匙照常可用。用户自己设了就不动。
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  const grant = opts.credentials;
  const secrets = grant?.secrets ?? [];
  const scoped: string[] = [];
  if (secrets.length && grant?.origin) {
    stripGitTraceEnv(env);
    Object.assign(env, grant.env);
    // 这一枚被远端拒掉(401)之后,git 会回头去问用户的凭据助手、再问 askpass:
    //   - 助手手里要是有这个站的旧凭据,git 会带着它重试(和我们的头撞在一起,照样失败),然后**让助手把它删掉** —— 用户存的东西没了;
    //   - 图形界面的助手 / askpass(Windows 的 Git Credential Manager、编辑器给的 GIT_ASKPASS)会弹窗干等到超时。
    // 所以带凭据的这一个子进程里,对这个站点清空助手列表、关掉 askpass:被拒就立刻失败,交给上面「作废重取一次」。
    // 只限这个站点(别的主机的子模块照用用户的助手);站点地址不是秘密,走命令行 `-c`(环境变量给不了空值的平台上也成立)。
    scoped.push('-c', `credential.${grant.origin}.helper=`);
    env.GIT_ASKPASS = '';
  }
  // 提供方参与的这一次(带了凭据,或者它说暂时取不到)要认 git 的原文来判「是不是认证失败」:消息固定成英文
  // (LANGUAGE 只管 gettext 取哪种语言,不动字符集;没有本地化的 git 不受影响)。别的远端不碰,原文照用户的语言。
  if (secrets.length || grant?.unavailable || opts.english) env.LANGUAGE = 'en';
  const raw = await runBoundedProcess(gitExecutable(), ['--no-pager', '-c', 'core.quotepath=false', ...scoped, '-C', cwd, ...args], {
    cwd, env, input: opts.input, timeoutMs: opts.timeoutMs ?? ACTION_TIMEOUT_MS, maxOutputBytes: 1024 * 1024,
  });
  const r = secrets.length ? { ...raw, stdout: scrubGitSecrets(raw.stdout, secrets), stderr: scrubGitSecrets(raw.stderr, secrets) } : raw;
  if (r.reason === 'spawn-error') throw new GitActionError('git_unavailable', 'git is not available on this machine');
  if (r.reason === 'timeout') throw new GitActionError('git_timeout', `git ${args[0]} timed out`, tail(r.stderr || r.stdout));
  return r;
}

/** 接缝里带话的失败 → 动作的失败(code / detail 原样;detail 是提供方给界面的东西,例如去哪里开账号)。 */
const credentialFailure = (e: GitCredentialError): GitActionError => new GitActionError(e.code, e.message, e.detail);

/** 替用户带凭据之前的那一道:仓库级的传输配置(http.* / 远端代理)能把这次连接引到别处 —— 代理加上关掉证书校验,
 *  请求头就到了中间人手里。仓库的 `.git/config` 不可信(解压 / 拷来的文件夹自带),所以未经用户信任不带凭据:
 *  报 untrusted_transport 并点名那几项,用户点「信任并继续」(trust = true)后记下、照带。
 *  没有凭据可带时不走这里 —— 那是用户自己的连接,这些配置照他的意思生效(现状)。 */
async function requireTransportTrust(cwd: string, trust: boolean | undefined): Promise<void> {
  const risk = await repoConfigRisks(cwd);
  if (!risk?.transport.length || await isRepoTrusted(risk.commonDir)) return;
  if (trust === true) { await trustRepo(risk.commonDir); return; }
  throw new GitActionError('untrusted_transport', 'This repository has its own git network configuration; trust it before credentials are sent through it', risk.transport.join('\n'));
}

/** 连远端的动作(push / fetch)。远端的 origin 有凭据提供方认领时按次带上凭据;没人认领 = 与 runAction 逐字一致。
 *  - 远端地址用 `git remote get-url [--push]`(吃 insteadOf / pushurl,就是 git 真正会连的那个;多个 pushurl 取第一个 ——
 *    extraheader 按 URL 前缀生效,别的主机拿不到这个头)。
 *  - git 报认证失败、而这次带的是提供方的凭据 → 让提供方作废重取,**只重试一次**(别的进程用同一个设备名重发会让手里这枚失效)。
 *  - 提供方说这次暂时取不到(限次 / 够不着)→ 先照没有凭据跑;git 也因为认证失败时,报提供方给的 code(否则用户只看到
 *    「could not read Username」)。用户自己配过凭据的照常成功。
 *  args[0] 必须是子命令(push / fetch):带凭据时紧跟着它插 `--no-recurse-submodules`。
 *  fetch(= 拉取,新动作)的消息固定成英文,好认「远端没有这条分支」;push 不带凭据时原文照用户的语言(现状)。 */
async function runRemoteAction(cwd: string, remote: string, direction: 'push' | 'fetch', args: string[], timeoutMs: number, trust: boolean | undefined): Promise<RunResult> {
  // 远端名来自仓库配置(branch.<分支>.remote):以 - 开头的当不成远端名,只会被 git 当成选项 —— 不拿它去问地址
  const located = remote.startsWith('-') ? null : await readGit(cwd, ['remote', 'get-url', ...(direction === 'push' ? ['--push'] : []), remote], { timeoutMs: 5000 });
  const url = located?.code === 0 ? located.stdout.split('\n')[0].trim() : '';
  const ask = async (again?: GitCredentialGrant): Promise<GitCredentialGrant> => {
    try { return again ? await refreshGitCredential(url, again) : await gitCredentialEnv(url); } catch (e) {
      if (e instanceof GitCredentialError) throw credentialFailure(e);
      return { env: {}, secrets: [] };
    }
  };
  let grant = url ? await ask() : { env: {}, secrets: [] } as GitCredentialGrant;
  if (grant.credential) await requireTransportTrust(cwd, trust);
  // 带着凭据就不递归进子模块:子模块是另一个仓库,它自带的配置(凭据助手、sshCommand、钩子)没过信任闸,
  // 而递归起的 git 继承同一份环境 —— 那些程序读得到这枚凭据。不带凭据时照用户自己的配置(现状)。
  const bare = (g: GitCredentialGrant): boolean => !!g.credential && !args.includes('--no-recurse-submodules');
  const run = (g: GitCredentialGrant): Promise<RunResult> =>
    runAction(cwd, bare(g) ? [args[0], '--no-recurse-submodules', ...args.slice(1)] : args, { timeoutMs, credentials: g, english: direction === 'fetch' });
  let r = await run(grant);
  if (r.code !== 0 && grant.credential && isGitAuthFailure(r.stderr)) {
    grant = await ask(grant);
    if (grant.credential) r = await run(grant);
  }
  if (r.code !== 0 && grant.unavailable && isGitAuthFailure(r.stderr)) throw credentialFailure(grant.unavailable);
  return r;
}

const tail = (text: string, max = 1500): string => { const t = text.trim(); return t.length > max ? `…${t.slice(-max)}` : t; };

function must(r: RunResult, what: string): RunResult {
  if (r.code !== 0 || r.reason) throw new GitActionError('git_failed', `git ${what} failed`, tail(r.stderr || r.stdout));
  return r;
}

async function insideWorkTree(cwd: string): Promise<boolean> {
  const r = await readGit(cwd, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 5000 });
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** 写动作的前提:这里就是仓库根目录。项目是大仓的子目录时 `add -A` 会暂存整个父仓;`.git` 文件 / core.worktree 把工作树
 *  指到别处也一样 —— 都按 nested_repo 拒。 */
export async function requireRepoRoot(cwd: string): Promise<void> {
  if (!(await insideWorkTree(cwd))) throw new GitActionError('not_repo', 'This folder is not a git repository');
  const top = await readGit(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: 5000 });
  const real = await fs.realpath(cwd).catch(() => cwd);
  const topReal = top.code === 0 ? await fs.realpath(top.stdout.trim()).catch(() => top.stdout.trim()) : '';
  if (topReal !== real) throw new GitActionError('nested_repo', 'This folder is not the root of its git repository', topReal || undefined);
}

/** 仓库级可执行配置的信任闸:没有该级风险 / 已信任 → 放行;trust=true = 用户刚在面板上点了「信任并继续」→ 记下再放行。 */
export async function requireTrust(cwd: string, level: 'read' | 'write', trust: boolean | undefined): Promise<void> {
  const blocked = await untrustedRisks(cwd, level);
  if (!blocked) return;
  if (trust === true) { await trustRepo(blocked.commonDir); return; }
  throw new GitActionError('untrusted_config', 'This repository has its own git configuration that runs programs', blocked.risks.join('\n'));
}

/** 默认工作区(常在笔记库里的 Sessions/)是所有「不在项目里」的对话共用的大目录;它和它的上级都不建仓、不整目录提交 ——
 *  一次 `add -A` 就把整片笔记收进仓里。桌面也不给这里露写按钮,这里是第二道。 */
async function assertNotSharedWorkspace(cwd: string): Promise<void> {
  const shared = await fs.realpath(defaultWorkspaceDir()).catch(() => null);
  if (!shared) return;
  const real = await fs.realpath(cwd).catch(() => cwd);
  if (real === shared || shared.startsWith(real + path.sep)) {
    throw new GitActionError('shared_workspace', 'The default workspace is shared by every conversation outside a project; use a project folder for version control');
  }
}

/** 同一目录的写动作排队(双击 / 两个窗口同时点:并发的 add / commit 会撞 index.lock)。写动作只在仓库根上做,目录即仓。 */
const chains = new Map<string, Promise<unknown>>();
export function serialized<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const next = (chains.get(cwd) ?? Promise.resolve()).catch(() => {}).then(task);
  chains.set(cwd, next);
  void next.catch(() => {}).finally(() => { if (chains.get(cwd) === next) chains.delete(cwd); });
  return next;
}

// ── 信任 / 建仓 ───────────────────────────────────────────────────────────

/** 面板上「信任这个仓库」:记下仓库级配置可以照跑。不是仓 → not_repo。 */
export async function gitTrustRepo(cwd: string): Promise<{ trusted: true }> {
  const risk = await repoConfigRisks(cwd);
  if (!risk) throw new GitActionError('not_repo', 'This folder is not a git repository');
  await trustRepo(risk.commonDir);
  return { trusted: true };
}

/** 在项目目录里建仓(不做首次提交 —— 要进仓的东西让用户在面板里看过再提交)。已在某个仓里(含外层仓)→ 拒绝。
 *  没有 .gitignore 才写一份缺省的:lstat 看到任何东西(含软链)都不碰,新建用 O_EXCL。
 *  用户配了 init.defaultBranch 就照用,没配才用 main。 */
export async function gitInit(cwd: string): Promise<{ createdGitignore: boolean }> {
  await assertNotSharedWorkspace(cwd);
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

// ── 待提交的东西 ──────────────────────────────────────────────────────────

export interface PendingFile { code: string; path: string; /** 改名 / 复制的原路径。 */ from?: string }
interface StagedEntry { status: string; path: string; mode: string; blob: string }

/** 全量改动(未跟踪文件逐个列出)。输出爆了上限 = 文件多到离谱,直接按「太多」拒。 */
async function pendingChanges(cwd: string): Promise<{ entries: PendingFile[]; untracked: string[]; paths: Set<string> }> {
  const r = await readGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxOutputBytes: 2 * 1024 * 1024 });
  if (r.reason === 'output-limit') throw new GitActionError('too_many_files', 'Too many files to commit; add the generated folders to .gitignore first');
  must(r, 'status');
  const entries: PendingFile[] = [];
  const untracked: string[] = [];
  const paths = new Set<string>(); // 这些改动会碰到的全部路径(改名的原路径也算:暂存后它以删除出现)
  const fields = r.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const entry: PendingFile = { code, path: field.slice(3) };
    paths.add(entry.path);
    if (code === '??') untracked.push(entry.path);
    if (/[RC]/.test(code)) { i++; if (fields[i]) { entry.from = fields[i]; paths.add(fields[i]); } } // 改名 / 复制后面跟一个原路径字段
    entries.push(entry);
  }
  return { entries, untracked, paths };
}

/** 比较基准:有 HEAD 用 HEAD;还没有提交的新仓用空树 —— 空树 id 按仓库的对象格式现算(SHA-256 仓不是那串 SHA-1)。 */
async function diffBase(cwd: string): Promise<string> {
  if ((await readGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 5000 })).code === 0) return 'HEAD';
  return must(await readGit(cwd, ['hash-object', '-t', 'tree', '--stdin'], { input: '', timeoutMs: 5000 }), 'hash-object').stdout.trim();
}

/** 已暂存的条目(index 对 HEAD;还没有提交的新仓对空树)。只读 index,不读工作区。 */
async function stagedEntries(cwd: string): Promise<StagedEntry[]> {
  const base = await diffBase(cwd);
  const r = must(await readGit(cwd, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', ...(base === 'HEAD' ? [] : [base])], { maxOutputBytes: 4 * 1024 * 1024 }), 'diff --cached');
  return parseRaw(r.stdout);
}

/** `--raw -z --no-renames` 的输出 → 条目(目标侧的 mode / blob)。 */
function parseRaw(stdout: string): StagedEntry[] {
  const out: StagedEntry[] = [];
  const fields = stdout.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i];
    if (!meta.startsWith(':')) break;
    const [, dstMode, , dstBlob, status] = meta.slice(1).split(' ');
    out.push({ status: status || '', path: fields[i + 1], mode: dstMode || '', blob: dstBlob || '' });
  }
  return out;
}

/** 凭据类文件名(与 desktop/electron/gitHistory.ts 的 SENSITIVE_NAME / TOKEN_CREDENTIAL 同源,再加几类常见的密钥 / 登录文件)。 */
const SENSITIVE_NAME = /(^|[._-])(secrets?|credentials?|private[-_]?key|service[-_]?account)([._-]|$)/i;
const TOKEN_CREDENTIAL = /^(?:(?:access|refresh|auth|oauth|api)[._-])?tokens?(?:[._-](?:cache|credentials|store))?\.(?:jsonc?|ya?ml|toml|txt|ini|conf)$/i;
const ENV_FILE = /^\.env(\..+)?$/i;
const ENV_TEMPLATE = /^\.env\.(example|sample|template|defaults)$/i;
const KEY_MATERIAL = /(\.(pem|key|p12|pfx|jks|keystore)|^id_(rsa|dsa|ecdsa|ed25519)(_[\w-]+)?)$/i;
const LOGIN_FILE = /^(\.npmrc|\.pypirc|\.netrc|\.git-credentials|auth\.json|auth\.toml)$/i;
export function isCredentialPath(file: string): boolean {
  const name = path.posix.basename(file);
  return file.split('/').some((part) => SENSITIVE_NAME.test(part)) || TOKEN_CREDENTIAL.test(name)
    || (ENV_FILE.test(name) && !ENV_TEMPLATE.test(name)) || KEY_MATERIAL.test(name) || LOGIN_FILE.test(name);
}

/** 提交前的第一道(便宜的,在 `add -A` 之前):夹着别的 git 仓 / 新文件过多 / 有超大新文件 → 拒绝并点名。
 *  先挡住才不会把一个大目录整个哈希进 .git/objects 再回头说不行。 */
export async function assertCommittable(cwd: string, changes: { untracked: string[] }, limits = { maxFiles: MAX_NEW_FILES, maxBytes: MAX_NEW_FILE_BYTES }): Promise<void> {
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

/** 提交前的第二道:按**最终 index** 复核(用户自己预先暂存的、过滤器处理后的大对象都逃不过)。 */
export async function assertStagedSafe(cwd: string, staged: StagedEntry[], limits = { maxFiles: MAX_NEW_FILES, maxBytes: MAX_NEW_FILE_BYTES, maxEntries: PENDING_LIST_MAX }): Promise<void> {
  if (staged.length > limits.maxEntries) throw new GitActionError('too_many_files', `${staged.length} changes would be committed; the list can only show ${limits.maxEntries}`, topDirs(staged.map((e) => e.path)).join('\n'));
  const live = staged.filter((e) => e.status !== 'D');
  const embedded = live.filter((e) => e.mode === '160000').map((e) => `${e.path}/`);
  if (embedded.length) throw new GitActionError('embedded_repo', 'The commit would contain another git repository', embedded.slice(0, 5).join('\n'));
  const added = live.filter((e) => e.status === 'A');
  if (added.length > limits.maxFiles) throw new GitActionError('too_many_files', `${added.length} new files would be committed`, topDirs(added.map((e) => e.path)).join('\n'));
  const secrets = live.map((e) => e.path).filter(isCredentialPath);
  if (secrets.length) throw new GitActionError('credential_files', 'The commit would contain files that usually hold credentials', secrets.slice(0, 10).join('\n'));
  const blobs = live.filter((e) => e.mode.startsWith('100') && /^[0-9a-f]{40,64}$/.test(e.blob));
  if (!blobs.length) return;
  const sizes = must(await readGit(cwd, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: `${blobs.map((e) => e.blob).join('\n')}\n` }), 'cat-file');
  const sizeOf = new Map(sizes.stdout.split('\n').map((line) => line.split(' ')).filter((p) => p.length === 2).map(([sha, size]) => [sha, Number(size)]));
  const large = blobs.filter((e) => (sizeOf.get(e.blob) ?? 0) > limits.maxBytes).map((e) => `${e.path} (${Math.round((sizeOf.get(e.blob) ?? 0) / 1024 / 1024)} MB)`);
  if (large.length) throw new GitActionError('large_files', 'Some files are too large to commit', large.slice(0, 5).join('\n'));
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

/** 这次提交会带上的东西:有已暂存的 → 只有已暂存的(提交也只提交它们);没有 → 全部改动(提交时 add -A)。 */
async function commitScope(cwd: string): Promise<{ files: PendingFile[]; paths: Set<string>; staged: StagedEntry[]; changes: { entries: PendingFile[]; untracked: string[]; paths: Set<string> } | null }> {
  const staged = await stagedEntries(cwd);
  if (staged.length) return { files: staged.map((e) => ({ code: e.status, path: e.path })), paths: new Set(staged.map((e) => e.path)), staged, changes: null };
  const changes = await pendingChanges(cwd);
  return { files: changes.entries, paths: changes.paths, staged, changes };
}

/** 清单指纹:用户在提交框里看到的那份清单。提交时重算,对不上 = 看完之后又变了(changes_changed),让他重新过目。 */
export function changesToken(files: PendingFile[]): string {
  // JSON 逐条编码:文件名里的制表符 / 换行拼不出另一份清单的指纹
  return createHash('sha256').update(files.map((f) => JSON.stringify([f.code, f.path, f.from ?? null])).sort().join('\n')).digest('hex').slice(0, 32);
}

/** 面板的待提交清单(完整;超过上限时提交本来也会被拒)+ 指纹。 */
export async function gitPending(cwd: string, trust?: boolean): Promise<{ files: PendingFile[]; total: number; stagedOnly: boolean; token: string; tooMany: boolean }> {
  await requireRepoRoot(cwd);
  await requireTrust(cwd, 'read', trust);
  const scope = await commitScope(cwd);
  // tooMany:清单列不全 → 这次不能在面板上提交(提交时也会拒);让面板直接说清楚,别给一个注定失败的确认按钮
  return { files: scope.files.slice(0, PENDING_LIST_MAX), total: scope.files.length, stagedOnly: scope.staged.length > 0, token: changesToken(scope.files), tooMany: scope.files.length > PENDING_LIST_MAX };
}

// ── 提交 ──────────────────────────────────────────────────────────────────

/** 用户过目的清单 → 每条路径「相对 HEAD 最终应是什么改动」(A / M / D / T;改名 = 新路径 A + 原路径 D)。
 *  已暂存模式下清单本身就是 index 对 HEAD 的状态字母;全部改动模式下由 porcelain 两位码推出 `add -A` 之后的样子。 */
export function reviewedStatuses(files: PendingFile[], stagedOnly: boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    if (stagedOnly) { out.set(f.path, f.code.trim()); continue; }
    const c = f.code;
    if (c === '??') out.set(f.path, 'A');
    else if (/R/.test(c)) { out.set(f.path, 'A'); if (f.from) out.set(f.from, 'D'); }
    else if (/C/.test(c)) out.set(f.path, 'A');
    else if (/D/.test(c)) out.set(f.path, 'D');
    else if (/A/.test(c)) out.set(f.path, 'A');
    else if (/T/.test(c)) out.set(f.path, 'T');
    else out.set(f.path, 'M');
  }
  return out;
}

/** 提交内容必须**正好**是用户过目的那份:每条都在清单里且改动类型一致(删掉的又被建回来 = 删除变修改,也算没过目),
 *  清单里的也都得在(被钩子 / 别的进程移出去的也算变了)。 */
export function assertWithinReviewed(entries: StagedEntry[], reviewed: Map<string, string>): void {
  const off = entries.filter((e) => reviewed.get(e.path) !== e.status).map((e) => `${e.status} ${e.path}`);
  const present = new Set(entries.map((e) => e.path));
  const missing = [...reviewed.keys()].filter((p) => !present.has(p)).map((p) => `- ${p}`);
  if (off.length || missing.length) throw new GitActionError('changes_changed', 'The commit is different from the reviewed list', [...off, ...missing].slice(0, 10).join('\n'));
}

/** 提交。有已暂存的只提交它们;没有才 `add -A`(面板列出的全部改动)。信息走 stdin,不经命令行参数。
 *  expect = 提交框里那份清单的指纹:重算对不上就拒(changes_changed)。
 *  **权威复核在提交之后**:以「新提交 vs 提交前的基准」的全部改动为准 —— 每条都得在过目的清单里、类型一致,再过安全检查
 *  (凭据 / 体量 / 嵌套仓)。钩子(lint-staged 之类在已确认路径内改格式照常放行)、别的 git 进程在检查与提交之间塞进来的东西都逃不过;
 *  不过关报 hook_changed_commit 并列出来,**提交留着不撤**(为什么见提交后那段)。提交前那几道只是省得白建提交的早退。 */
export async function gitCommit(cwd: string, message: unknown, trust?: boolean, expect?: unknown): Promise<{ sha: string; subject: string; stagedOnly: boolean }> {
  const text = typeof message === 'string' ? message.replace(/\0/g, '').replace(/\r\n/g, '\n').trim() : '';
  if (!text) throw new GitActionError('empty_message', 'The commit message is empty');
  if (text.length > COMMIT_MESSAGE_MAX) throw new GitActionError('message_too_long', `The commit message is longer than ${COMMIT_MESSAGE_MAX} characters`);
  await assertNotSharedWorkspace(cwd);
  await requireRepoRoot(cwd);
  await requireTrust(cwd, 'write', trust);
  const scope = await commitScope(cwd);
  if (!scope.files.length) throw new GitActionError('nothing_to_commit', 'There is nothing to commit');
  if (typeof expect === 'string' && expect !== changesToken(scope.files)) {
    throw new GitActionError('changes_changed', 'The changes are different from the list you reviewed');
  }
  if (scope.files.length > PENDING_LIST_MAX) throw new GitActionError('too_many_files', `${scope.files.length} changes would be committed; the list can only show ${PENDING_LIST_MAX}`, topDirs(scope.files.map((f) => f.path)).join('\n'));
  const stagedOnly = scope.staged.length > 0;
  const reviewed = reviewedStatuses(scope.files, stagedOnly);
  const baseR = await readGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 5000 });
  const base = baseR.code === 0 ? baseR.stdout.trim() : null;
  // 提交会落在哪个分支引用上(游离 HEAD 时就是 HEAD 本身);提交后核对 HEAD 还解析到它
  const refR = await readGit(cwd, ['symbolic-ref', '-q', 'HEAD'], { timeoutMs: 5000 });
  const ref = refR.code === 0 && refR.stdout.trim() ? refR.stdout.trim() : 'HEAD';
  let addedByUs = false;
  if (!stagedOnly) {
    await assertCommittable(cwd, scope.changes!);
    must(await runAction(cwd, ['add', '-A']), 'add');
    addedByUs = true;
  }
  try {
    const staged = addedByUs ? await stagedEntries(cwd) : scope.staged;
    if (!staged.length) throw new GitActionError('nothing_to_commit', 'There is nothing to commit');
    assertWithinReviewed(staged, reviewed);
    await assertStagedSafe(cwd, staged);
  } catch (e) {
    if (addedByUs) await unstageAll(cwd); // 是我们暂存的就退回去:用户看到的仓库状态与点提交之前一致
    throw e;
  }
  const committed = await runAction(cwd, ['commit', '-F', '-'], { input: `${text}\n` });
  if (committed.code !== 0 && /tell me who you are|unable to auto-detect email address|auto-detection is disabled/i.test(committed.stderr)) {
    throw new GitActionError('no_identity', 'git does not know your name and email yet', tail(committed.stderr));
  }
  must(committed, 'commit');
  // 提交后复核:HEAD 还解析到原来的分支引用、新提交的父提交是基准,再按「新提交 vs 基准」的全部改动核对清单与安全检查。
  // 读不到 / 对不上(post-commit 钩子又提交了一次、切了分支…)= commit_unverified:提交可能已经在了,只是没法确认,界面说清楚并重读。
  // **不自动撤回**:钩子是用户信任过才会跑的代码,能改写引用和 reflog,宿主没有可靠的办法认出「哪一个是我们的提交」,
  // 猜着撤会撤错(09-27 Codex 十轮评审一路收窄到这个结论);正常的钩子(重新生成 dist/ 或 lockfile 再 git add)也会让每次提交都被撤。
  // 内容不合清单 → hook_changed_commit 列出多出来的,提交留着给用户处理(推送之前先看)。
  let ours: string;
  let subject: string;
  let final: StagedEntry[];
  try {
    const nowRef = await readGit(cwd, ['symbolic-ref', '-q', 'HEAD'], { timeoutMs: 5000 });
    if ((nowRef.code === 0 && nowRef.stdout.trim() ? nowRef.stdout.trim() : 'HEAD') !== ref) throw new Error('the branch changed while committing');
    ours = must(await readGit(cwd, ['rev-parse', '--verify', ref]), 'rev-parse').stdout.trim();
    const info = must(await readGit(cwd, ['log', '-1', '--format=%P%x1f%s', ours]), 'log').stdout.replace(/\n$/, '');
    const sep = info.indexOf('\x1f'); // 标题里也可能有 \x1f:只按第一个切
    const parents = info.slice(0, sep).split(/\s+/).filter(Boolean);
    subject = info.slice(sep + 1);
    if (sep < 0 || (base ? parents.length !== 1 || parents[0] !== base : parents.length !== 0)) throw new Error('the commit has an unexpected parent');
    const diff = must(await readGit(cwd, ['diff-tree', '-r', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-commit-id', ...(base ? [base, ours] : ['--root', ours])], { maxOutputBytes: 8 * 1024 * 1024 }), 'diff-tree').stdout;
    final = parseRaw(diff);
  } catch (e) {
    throw new GitActionError('commit_unverified', 'The commit could not be verified; check the repository', String((e as Error)?.message || e));
  }
  try {
    assertWithinReviewed(final, reviewed);
    await assertStagedSafe(cwd, final);
  } catch (e) {
    throw postCommitFailure(e);
  }
  return { sha: ours, subject, stagedOnly };
}

const CONTENT_FAILURES = new Set(['changes_changed', 'too_many_files', 'embedded_repo', 'credential_files', 'large_files']);
/** 提交后复核不过的归类:内容不合(钩子往提交里加了东西)→ hook_changed_commit;复核自己读失败(cat-file 之类)不等于钩子加了东西 → commit_unverified。 */
export function postCommitFailure(e: unknown): GitActionError {
  const inner = e instanceof GitActionError ? e : null;
  if (inner && CONTENT_FAILURES.has(inner.code)) return new GitActionError('hook_changed_commit', 'A git hook changed the commit so it no longer matches the reviewed list; the commit was kept, check it before pushing', inner.detail || inner.message);
  return new GitActionError('commit_unverified', 'The commit could not be verified; check the repository', inner?.detail || String((e as Error)?.message || e));
}

/** 把 index 退回 HEAD(还没有提交的新仓 = 清空)。只在「index 是我们刚 add -A 的」时用。 */
async function unstageAll(cwd: string): Promise<void> {
  const hasHead = (await readGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 5000 })).code === 0;
  await runAction(cwd, hasHead ? ['reset', '-q'] : ['read-tree', '--empty']).catch(() => {});
}

// ── 新建分支 ──────────────────────────────────────────────────────────────

/** 从当前位置建分支并切过去(未提交的改动跟着走,不丢)。名字由用户给(面板预填了前缀),这里不再加前缀。
 *  切分支会跑 post-checkout 钩子 → 同样过信任闸。 */
export async function gitCreateBranch(cwd: string, name: unknown, trust?: boolean): Promise<{ branch: string }> {
  const branch = typeof name === 'string' ? name.trim() : '';
  await requireRepoRoot(cwd);
  const check = await readGit(cwd, ['check-ref-format', '--branch', branch || '-']);
  if (!branch || branch.startsWith('-') || check.code !== 0) throw new GitActionError('invalid_branch', 'That is not a valid branch name', branch);
  await requireTrust(cwd, 'write', trust);
  must(await runAction(cwd, ['switch', '-c', branch]), 'switch');
  return { branch };
}

// ── 推送 ──────────────────────────────────────────────────────────────────

/** 推当前分支,refspec 写明(不吃 push.default / remote.pushDefault 的隐式选择)。有上游 → 推到上游那个分支;
 *  没有 → 推到 origin(只有一个远端时推到它)的同名分支并设为上游。
 *  「设置 → Git」开了 forceWithLease 才带 `--force-with-lease --force-if-includes`:
 *  后者要求远端跟踪分支的尖端已被本地吸收 —— 后台 fetch 把别人的新提交拉进远端跟踪分支之后,单靠 lease 挡不住覆盖。 */
export async function gitPush(cwd: string, trust?: boolean): Promise<{ remote: string; branch: string; target: string; output: string }> {
  await requireRepoRoot(cwd);
  const head = must(await readGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'rev-parse').stdout.trim();
  if (!head || head === 'HEAD') throw new GitActionError('detached', 'HEAD is detached; switch to a branch before pushing');
  await requireTrust(cwd, 'write', trust);
  const force = gitSettings().forceWithLease ? ['--force-with-lease', '--force-if-includes'] : [];
  const cfg = async (key: string): Promise<string> => (await readGit(cwd, ['config', '--get', key])).stdout.trim();
  const upstreamRemote = await cfg(`branch.${head}.remote`);
  const upstreamMerge = await cfg(`branch.${head}.merge`);
  let remote: string;
  let ref: string;
  let args: string[];
  if (upstreamRemote && upstreamRemote !== '.' && upstreamMerge.startsWith('refs/heads/')) {
    remote = upstreamRemote; ref = upstreamMerge;
    args = ['push', ...force, remote, `HEAD:${ref}`];
  } else {
    const remotes = must(await readGit(cwd, ['remote']), 'remote').stdout.split('\n').map((r) => r.trim()).filter(Boolean);
    const target = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '';
    if (!target) throw new GitActionError(remotes.length ? 'ambiguous_remote' : 'no_remote', remotes.length ? 'Several remotes are configured and none is called origin' : 'No remote is configured', remotes.join('\n'));
    remote = target; ref = `refs/heads/${head}`;
    args = ['push', ...force, '--set-upstream', remote, `HEAD:${ref}`];
  }
  // 远端名来自仓库配置(branch.<分支>.remote):以 - 开头的会被 git 当成选项(--receive-pack=… 就是一条本机命令)
  if (remote.startsWith('-')) throw new GitActionError('no_remote', 'The upstream remote of this branch is not a valid remote name', remote);
  const r = await runRemoteAction(cwd, remote, 'push', args, PUSH_TIMEOUT_MS, trust);
  if (r.code !== 0 && force.length && /force-if-includes/.test(r.stderr) && /unknown option|usage:/i.test(r.stderr)) {
    throw new GitActionError('git_too_old', 'This git is too old for a safe --force-with-lease push (needs 2.30 or later)', tail(r.stderr));
  }
  must(r, 'push');
  const branch = ref.replace(/^refs\/heads\//, '');
  return { remote, branch, target: `${remote}/${branch}`, output: tail(r.stderr || r.stdout, 600) };
}

// ── 拉取 ──────────────────────────────────────────────────────────────────

export interface PullResult {
  remote: string; branch: string; /** `origin/main` 这样的显示名。 */ upstream: string;
  /** false = 没有要拉的(已经一致,或者只是本地领先)。 */
  updated: boolean; /** 快进了多少个提交。 */ commits: number; /** 本地领先上游多少个(没推的)。 */ ahead: number;
}

/** 拉当前分支的上游:从上游所在的远端**只取那一条分支**,然后**只做快进**(`merge --ff-only`)。
 *  - 没有上游(没设过 / 远端那条分支已经没了)→ no_upstream。
 *  - 本地和上游各有新提交 → diverged,只报告两边各几个;不合并、不变基 —— 那是要用户自己拿主意的事。
 *  - 快进会改到的文件上有没提交的改动 / 会盖掉一个没进仓的本地文件(含被忽略的,如 .env)→ dirty_worktree
 *    (git 自己拒的,什么都没动);不相干的本地改动留着不碰。
 *  不用 `git pull`:它吃 pull.rebase / pull.ff 配置,同一个按钮在两台机器上能做出两件事。
 *  不用 `git fetch <远端>`(取全部):那会照远端配置的 refspec 更新一切,配了 `+refs/heads/x:refs/heads/x` 这类映射的仓库里,
 *    别的本地分支会被强行改写。只取上游这一条;远端跟踪分支由 git 按配置的映射顺带更新(面板的领先 / 落后才对得上)。
 *  不递归子模块(fetch 不进、快进时也不动它们的工作区):子模块是另一份没过信任闸的仓库配置。
 *  快进会跑 post-merge 钩子、检出时跑 smudge 过滤器,fetch 会用仓库配的凭据助手 → 与别的写动作同一道信任闸。
 *  ponytail: 检出到一半失败(过滤器报错 / 超时被杀)时已经写出去的文件不回滚 —— 与终端里的 git 一样,HEAD 没动,
 *    `git status` 看得到;要做成原子的得自己备份工作区,不值。超时放宽到几分钟,别在大仓库的检出中途动手。 */
export async function gitPull(cwd: string, trust?: boolean): Promise<PullResult> {
  await requireRepoRoot(cwd);
  const head = must(await readGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), 'rev-parse').stdout.trim();
  if (!head || head === 'HEAD') throw new GitActionError('detached', 'HEAD is detached; switch to a branch before pulling');
  await requireTrust(cwd, 'write', trust);
  const cfg = async (key: string): Promise<string> => (await readGit(cwd, ['config', '--get', key])).stdout.trim();
  const remote = await cfg(`branch.${head}.remote`);
  const merge = await cfg(`branch.${head}.merge`);
  if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) throw new GitActionError('no_upstream', 'The current branch has no upstream branch to pull from');
  const upstream = `${remote}/${merge.replace(/^refs\/heads\//, '')}`;
  // 远端名来自仓库配置:以 - 开头的会被 git 当成选项(--upload-pack=… 就是一条本机命令)
  if (remote.startsWith('-')) throw new GitActionError('no_upstream', 'The upstream remote of this branch is not a valid remote name', remote);
  const fetched = await runRemoteAction(cwd, remote, 'fetch', ['fetch', '--no-recurse-submodules', remote, merge], PUSH_TIMEOUT_MS, trust);
  if (fetched.code !== 0 && /couldn't find remote ref/i.test(fetched.stderr)) throw new GitActionError('no_upstream', 'The upstream branch no longer exists on the remote', upstream);
  must(fetched, 'fetch');
  // 刚取回来的那个提交(FETCH_HEAD 的第一行就是点名要的这条分支);不靠远端跟踪分支 —— 映射不到它的仓库里它不存在
  const tip = await readGit(cwd, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'], { timeoutMs: 5000 });
  const target = tip.code === 0 ? tip.stdout.trim() : '';
  if (!target) throw new GitActionError('git_failed', 'git fetch did not report what it fetched', tail(fetched.stderr || fetched.stdout));
  /** 本地 / 上游各自独有的提交数(对刚才解析出来的那个上游提交量,不是「此刻的上游」)。 */
  const measure = async (): Promise<{ ahead: number; behind: number }> => {
    const m = /^(\d+)\s+(\d+)/.exec(must(await readGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...${target}`]), 'rev-list').stdout.trim());
    return { ahead: m ? Number(m[1]) : 0, behind: m ? Number(m[2]) : 0 };
  };
  const diverged = (c: { ahead: number; behind: number }): GitActionError => new GitActionError('diverged', 'The branch and its upstream have both moved; nothing was merged', `${head}: ${c.ahead}\n${upstream}: ${c.behind}`);
  const before = await measure();
  if (!before.behind) return { remote, branch: head, upstream, updated: false, commits: 0, ahead: before.ahead };
  if (before.ahead) throw diverged(before);
  // 按量过的那个提交快进:量完之后别的进程又 fetch 了一次,也不会把没量过的东西合进来。
  // merge.autoStash 关掉:开着它时 git 会先把没提交的改动收进 stash、快进完再放回来 —— 放不回来就在工作区留下冲突标记,
  // 与「挡住了就什么都不动」的承诺相反(用配置而不是 --no-autostash:老 git 不认这个选项,不认识的配置项它只是忽略)。
  // --no-overwrite-ignore:上游开始跟踪一个本地被忽略的文件(典型是 .env)时,git 缺省**悄悄盖掉**本地那份;改成拒绝。
  // submodule.recurse 关掉:快进时不去动子模块的工作区(那会在子模块里跑它自己的配置)。
  const merged = await runAction(cwd, ['-c', 'merge.autoStash=false', '-c', 'submodule.recurse=false', 'merge', '--ff-only', '--no-overwrite-ignore', target], { timeoutMs: MERGE_TIMEOUT_MS, english: true });
  if (merged.code !== 0 && /would be overwritten by merge/i.test(merged.stderr)) {
    throw new GitActionError('dirty_worktree', 'Uncommitted changes are in the way of the update; nothing was changed', tail(merged.stderr));
  }
  // 量完之后本地又多了提交(别的窗口 / 终端里刚提交):快进不了,同样只报告
  if (merged.code !== 0 && /not possible to fast-forward/i.test(merged.stderr)) throw diverged(await measure());
  must(merged, 'merge');
  return { remote, branch: head, upstream, updated: true, commits: before.behind, ahead: 0 };
}

// ── 生成提交信息 ──────────────────────────────────────────────────────────

/** 写提交信息要看的现场:要提交的文件、diff(截断)、最近几条提交的风格。读工作区 → 过 read 级信任闸。 */
export async function commitMessageContext(cwd: string, trust?: boolean): Promise<string> {
  const pending = await gitPending(cwd, trust);
  if (!pending.total) throw new GitActionError('nothing_to_commit', 'There is nothing to commit');
  const base = await diffBase(cwd);
  const hasHead = base === 'HEAD';
  // 只提交已暂存的时候,diff 也只看已暂存的,别让模型描述不会进这次提交的改动
  const scope = pending.stagedOnly ? ['--cached'] : [];
  const [stat, patch, log] = await Promise.all([
    readGit(cwd, ['diff', ...scope, base, '--stat', '--no-color'], { timeoutMs: 10_000 }),
    readGit(cwd, ['diff', ...scope, base, '--no-color', '--no-ext-diff', '--no-textconv', '-U2'], { timeoutMs: 10_000 }),
    hasHead ? readGit(cwd, ['log', '-8', '--format=%s'], { timeoutMs: 5000 }) : null,
  ]);
  const parts: string[] = [];
  if (log?.code === 0 && log.stdout.trim()) parts.push(`Recent commit subjects (match their language and style):\n${log.stdout.trim()}`);
  else parts.push('This will be the first commit of the repository.');
  parts.push(`Files in this commit (${pending.total}${pending.stagedOnly ? ', staged only' : ''}):\n${pending.files.slice(0, 60).map((f) => `${f.code.trim() || '·'} ${f.path}`).join('\n')}${pending.total > 60 ? '\n…' : ''}`);
  if (stat.code === 0 && stat.stdout.trim()) parts.push(`Changed tracked files:\n${stat.stdout.trim()}`);
  const diff = patch.code === 0 ? patch.stdout : '';
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
export async function generateCommitMessage(cwd: string, opts: { userId: string; modelId: string | null; appId: string; trust?: boolean; signal?: AbortSignal }): Promise<string> {
  const modelId = (opts.modelId || '').trim();
  if (!modelId) throw new GitActionError('no_model', 'This conversation has no model yet');
  const context = await commitMessageContext(cwd, opts.trust);
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
