/**
 * /diff:工作目录的 git 改动一览(status + stat + 截断的 diff,含未跟踪文件的内容)。
 *
 * 安全口径(如实写,别夸大):仓内 .git/config 能配「读一下就执行命令」的东西。本文件关掉的是
 *   - core.fsmonitor(`-c core.fsmonitor=`)、外部 diff(`--no-ext-diff`)、textconv(`--no-textconv`);
 *   - pager(--no-pager / GIT_PAGER=cat)、凭证提示(GIT_TERMINAL_PROMPT=0)、抢 index.lock(GIT_OPTIONAL_LOCKS=0);execFile 不经 shell。
 * **关不掉**的:clean / smudge 过滤器(filter.<name>.clean 由 .gitattributes 选中)—— status / diff 比对工作区时照样会跑。
 * `--attr-source=<空树>` 能让仓内 .gitattributes 失效,但 .git/info/attributes 仍生效,且会让 git-lfs 仓整片误报「已修改」,不用。
 * 利用它得先能写 .git/config:clone 带不过来,agent 写 .git 被 fsPolicy 拦 —— 暴露面与用户自己敲 `git status` 相同。
 * (status / diff 本不跑 hooks;core.hooksPath 置空只是给以后加的子命令兜底。)
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { L } from './i18n.js';

const SAFE = ['--no-pager', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'color.ui=false', '-c', 'core.quotepath=false'];
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];
export const DIFF_MAX_LINES = 300;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_BYTES = 256 * 1024;

interface GitOut {
  /** 退出码;没跑起来 / 被杀 / 输出超限 → -1(看 errCode / killed)。 */
  code: number;
  stdout: string;
  stderr: string;
  /** Node 层错误码:ENOENT(找不到 git,或 cwd 不存在)、ERR_CHILD_PROCESS_STDIO_MAXBUFFER 等。 */
  errCode?: string;
  /** 超时被杀。 */
  killed?: boolean;
}

function git(cwd: string, args: string[]): Promise<GitOut> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...SAFE, ...args],
      {
        cwd,
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (err: any, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (err && typeof err.code !== 'number' ? String(err.message || err) : ''),
          errCode: err && typeof err.code === 'string' ? err.code : undefined,
          killed: !!err?.killed,
        });
      },
    );
  });
}

/** 保留前 max 行,返回被丢掉的行数。 */
export function truncateLines(text: string, max: number): { text: string; dropped: number } {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length <= max) return { text: lines.join('\n'), dropped: 0 };
  return { text: lines.slice(0, max).join('\n'), dropped: lines.length - max };
}

export type GitDiffReport =
  | { kind: 'no_git'; detail: string }
  | { kind: 'no_cwd' }
  | { kind: 'error'; detail: string }
  | { kind: 'not_repo' }
  | { kind: 'clean'; root: string }
  | { kind: 'ok'; root: string; text: string };

/** 没跑成(非「git 正常退出但返回非 0」)的一句话原因:超时 / 输出超限 / 其他 Node 层错误。 */
function failure(o: GitOut): string | null {
  if (o.code !== -1) return null;
  if (o.killed) return L('git 超时', 'git timed out');
  if (o.errCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return L('git 输出过大', 'git output too large');
  return o.stderr.trim() || o.errCode || 'unknown error';
}

export async function collectGitDiff(cwd: string, maxLines = DIFF_MAX_LINES): Promise<GitDiffReport> {
  const probe = await git(cwd, ['rev-parse', '--show-toplevel']);
  // spawn 的 ENOENT 两种来源:git 不在 PATH,或 cwd 已被删(Node 报的也是 spawn git ENOENT)。
  if (probe.errCode === 'ENOENT') return existsSync(cwd) ? { kind: 'no_git', detail: probe.stderr.trim() } : { kind: 'no_cwd' };
  const probeFail = failure(probe);
  if (probeFail) return { kind: 'error', detail: probeFail };
  if (probe.code !== 0) return { kind: 'not_repo' };
  // 之后一律在仓根跑:status --porcelain / diff HEAD 本就按全仓、路径相对仓根;ls-files 却只列 cwd 以下 ——
  // 从子目录 /diff 时,仓根别处的未跟踪文件会在 status 里出现、内容却展不开。
  const root = probe.stdout.trim() || cwd;

  const st = await git(root, ['status', '--porcelain', '--untracked-files=all']);
  const stFail = failure(st) ?? (st.code !== 0 ? st.stderr.trim() || `git status exit ${st.code}` : null);
  if (stFail) return { kind: 'error', detail: stFail }; // 别把「status 没跑成」报成「工作区干净」
  const status = st.stdout.replace(/\n+$/, '');
  if (!status.trim()) return { kind: 'clean', root };

  const notes: string[] = [];
  // diff 这类取数失败不致命(status 已经有了),但要说出来,别静默少一块。
  const out = async (args: string[]): Promise<string> => {
    const o = await git(root, args);
    const f = failure(o);
    if (f) notes.push(L(`… git ${args.find((a) => !a.startsWith('-')) || ''} 失败：${f}（请在终端运行 git diff）`, `… git ${args.find((a) => !a.startsWith('-')) || ''} failed: ${f} (run git diff in a terminal)`));
    return o.stdout;
  };
  // 有 HEAD:diff HEAD 同时覆盖已暂存 + 未暂存;新仓(还没有提交)只能分别取两边。
  const hasHead = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
  const tracked = hasHead
    ? [await out(['diff', ...DIFF_FLAGS, 'HEAD'])]
    : [await out(['diff', ...DIFF_FLAGS, '--cached']), await out(['diff', ...DIFF_FLAGS])];
  const stat = hasHead
    ? await out(['diff', ...DIFF_FLAGS, '--stat', 'HEAD'])
    : (await out(['diff', ...DIFF_FLAGS, '--stat', '--cached'])) + (await out(['diff', ...DIFF_FLAGS, '--stat']));

  // 未跟踪文件:git diff 不含它们 —— 逐个与 /dev/null 对比(git 在所有平台上都认这个字面量),限量限大小。
  const untracked = (await out(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const untrackedDiffs: string[] = [];
  let skipped = 0;
  for (const rel of untracked) {
    if (untrackedDiffs.length >= MAX_UNTRACKED_FILES) {
      skipped++;
      continue;
    }
    try {
      if (statSync(path.join(root, rel)).size > MAX_UNTRACKED_BYTES) {
        skipped++;
        continue;
      }
    } catch {
      skipped++;
      continue;
    }
    const d = await git(root, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', rel]); // 有差异时退出码 1,属正常
    if (d.stdout) untrackedDiffs.push(d.stdout);
  }

  const body = [...tracked, ...untrackedDiffs].filter((s) => s.trim()).join('\n');
  const { text: diffText, dropped } = truncateLines(body, maxLines);
  const parts = [
    `── git status  (${root}) ──`,
    status,
    stat.trim() ? `── git diff --stat ──\n${stat.replace(/\n+$/, '')}` : '',
    diffText ? `── git diff ──\n${diffText}` : '',
    dropped ? L(`… 还有 ${dropped} 行未显示（完整内容请在终端运行 git diff）`, `… ${dropped} more lines not shown (run git diff for the full output)`) : '',
    skipped ? L(`… ${skipped} 个未跟踪文件过大或过多，未展开内容`, `… ${skipped} untracked file(s) too large or too many; contents not shown`) : '',
    ...notes,
  ];
  return { kind: 'ok', root, text: parts.filter(Boolean).join('\n') };
}
