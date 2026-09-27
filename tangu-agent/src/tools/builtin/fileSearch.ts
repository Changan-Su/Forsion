/**
 * 文件搜索工具:search_files(grep 式内容搜索)+ glob_files(通配符找文件)。mode:'both':
 *   - host:基于 ctx.cwd 的真实 FS;search 优先用 ripgrep(快、尊重 .gitignore),无 rg 回退纯 Node 扫描
 *   - sandbox:基于会话工作区。getSessionDir 命中(per-run 本地 hydrate 目录)→ 本地扫描;
 *     未命中(纯 Penzor 云模式)→ glob 走 listWorkspaceMetas 元数据;search 拉取文件内容(带量级上限)
 * 输出统一截断,跳过 .git/node_modules 等重目录与二进制文件。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { getSessionDir } from '../../sandbox/sessionSandbox.js';
import { listWorkspaceMetas, readWorkspaceFileRaw, scopeOf } from '../fileWorkspace.js';
import { runBoundedProcess } from '../../utils/boundedProcess.js';
import { FileSearchWorker, checkSearchAbort, searchAbortError } from './fileSearchWorker.js';
import path from 'node:path';
import { canonicalFuturePath, credentialPaths, matchProtected, pathWithin } from '../../sandbox/hostSandboxProtection.js';
import { toolSubprocessEnv } from '../../sandbox/credentialEnv.js';

/**
 * 契约 C4:凭据文件对所有 run 读硬拒 —— 内容搜索**打开之前**就排除(cwd 在家目录时 rg 会走进
 * ~/Library/Application Support/<桌面>/tangu-desktop-config.json;在 ~/.forsion 里则直接命中 auth.json)。
 * 返回搜索根下凭据路径的相对 posix 形态(rg 用 `--iglob !/<rel>`、回退扫描按名跳过);根本身就在凭据路径里 → null(整次拒)。
 */
function credentialExclusions(baseDir: string): string[] | null {
  const creds = credentialPaths();
  const bases = [...new Set([path.resolve(baseDir), canonicalFuturePath(baseDir)])];
  if (bases.some((b) => matchProtected(b, creds))) return null;
  const rels = new Set<string>();
  for (const b of bases) {
    for (const c of creds) {
      if (!pathWithin(c, b)) continue;
      const rel = path.relative(b, c).split(path.sep).join('/');
      if (rel && !rel.startsWith('..')) rels.add(rel);
    }
  }
  return [...rels];
}
const CREDENTIAL_SEARCH_DENIED = 'Error: Access denied: this directory holds protected credential files and cannot be searched by agents.';

/** 第二道:结果行里若仍出现凭据文件(硬链接 / 大小写别名等),整行丢掉。 */
function dropCredentialLines(text: string, baseDir: string): string {
  const creds = credentialPaths();
  return text.split('\n').filter((line) => {
    const m = /^(.*?):\d+:/.exec(line);
    return !m || !matchProtected(path.resolve(baseDir, m[1]), creds);
  }).join('\n');
}

const MAX_FILES_VISITED = 5000;
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_GLOB_RESULTS = 500;
// 纯 Penzor 云模式 search 的远程拉取上限(每文件一次 OSS 往返,必须收紧)
const CLOUD_SEARCH_MAX_FILES = 30;

/** One budget covers discovery, remote reads and matching, including fallback. */
function withSearchLifetime(execute: (args: Record<string, any>, ctx: ToolContext) => Promise<string>) {
  return async (args: Record<string, any>, ctx: ToolContext): Promise<string> => {
    checkSearchAbort(ctx.signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(ctx.signal?.reason);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Search exceeded its 30 second deadline')), 30_000);
    try { return await execute(args, { ...ctx, signal: controller.signal }); }
    finally { clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort); }
  };
}

/** glob → RegExp:支持 **(跨目录)、*(段内)、?、{a,b}。匹配相对路径(posix)。 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  const g = glob.replace(/\\/g, '/');
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` 或 `**`:跨目录任意段
        re += '(?:.*)';
        i += g[i + 2] === '/' ? 3 : 2;
        if (re.endsWith('(?:.*)') && g[i - 1] === '/') re = re.slice(0, -6) + '(?:.*/)?';
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) { re += '\\{'; i++; continue; }
      const alts = g.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
      re += `(?:${alts.join('|')})`;
      i = end + 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  // 无目录分隔的裸模式(如 *.ts)匹配任意目录下的文件名
  const anchored = g.includes('/') ? `^${re}$` : `(?:^|/)${re}$`;
  return new RegExp(anchored);
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

interface SearchHit { file: string; line: number; text: string }

function formatHits(hits: SearchHit[], truncatedScan: boolean): string {
  if (!hits.length) return `(no matches${truncatedScan ? `; scan capped at ${MAX_FILES_VISITED} files` : ''})`;
  const byFile = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const arr = byFile.get(h.file) || [];
    arr.push(h);
    byFile.set(h.file, arr);
  }
  let out = '';
  for (const [file, arr] of byFile) {
    out += `${file}:\n`;
    for (const h of arr) out += `  ${h.line}: ${h.text.length > 240 ? h.text.slice(0, 240) + '…' : h.text}\n`;
    if (out.length > MAX_OUTPUT_CHARS) break;
  }
  let footer = `\n${hits.length} match(es) in ${byFile.size} file(s)`;
  if (hits.length >= MAX_MATCHES) footer += `(hit cap ${MAX_MATCHES}, narrow your pattern)`;
  if (out.length > MAX_OUTPUT_CHARS) out = out.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]';
  return out + footer;
}

/** host 模式优先 ripgrep(ENOENT 回退 nodeSearch)。 */
async function rgSearch(cwd: string, pattern: string, include?: string, signal?: AbortSignal, caseSensitive = false, exclude: string[] = []): Promise<string | null> {
  checkSearchAbort(signal);
  // 凭据路径里带 glob 元字符(用户名 / 目录名含 [ ] 等)时 `!/rel` 不再字面匹配,rg 会先打开再被结果过滤兜住 ——
  // 不冒这个险:交回 Node 扫描(它按名跳过,打开之前)。转义在 Windows 的 globset 上不可靠,不走那条路。
  if (exclude.some((rel) => /[*?[\]{}\\!]/.test(rel))) return null;
  const args = ['-n', '--no-messages', '--max-count', '50', '--max-filesize', '1M', caseSensitive ? '--case-sensitive' : '--ignore-case', '-e', pattern];
  if (include) args.push('--glob', include);
  // 排除放在 include 之后(rg 的 glob 后者优先);`!/rel` 锚定到搜索根,iglob 大小写不敏感(macOS / Windows 文件系统同名)。
  for (const rel of exclude) args.push('--iglob', `!/${rel}`);
  args.push('.');
  const result = await runBoundedProcess('rg', args, { cwd, env: toolSubprocessEnv(), signal, timeoutMs: 30_000, maxOutputBytes: MAX_OUTPUT_CHARS * 4 });
  checkSearchAbort(signal);
  if (result.reason === 'aborted') throw searchAbortError(signal);
  if (result.cleanupTimedOut) throw new Error('Search process shutdown was not acknowledged');
  if (result.reason === 'spawn-error') {
    if (result.error?.code === 'ENOENT') return null;
    throw result.error || new Error('Failed to start ripgrep');
  }
  if (result.reason === 'timeout') throw new Error('Search timed out');
  if (result.reason !== 'output-limit' && result.code !== 0 && result.code !== 1) return `Error: rg exited ${result.code} (check the regular expression syntax)`;
  const text = dropCredentialLines(result.stdout, cwd).trimEnd();
  if (!text.trim()) return '(no matches)';
  return text.slice(0, MAX_OUTPUT_CHARS) + (text.length > MAX_OUTPUT_CHARS || result.reason === 'output-limit' ? '\n…[truncated]' : '')
    + `\n${text.split('\n').length} matching line(s)`;
}

/** 纯 Penzor 云模式:按元数据挑文件,逐个拉内容搜(上限收紧)。 */
async function cloudSearch(ctx: ToolContext, worker: FileSearchWorker): Promise<string> {
  checkSearchAbort(ctx.signal);
  const metas = await listWorkspaceMetas(ctx.userId, ctx.appId, scopeOf(ctx), ctx.signal);
  checkSearchAbort(ctx.signal);
  const eligible = metas.filter(m => m.size <= MAX_FILE_BYTES && (m.mimeType.startsWith('text/') || m.mimeType === 'application/json'));
  const paths = await worker.run<string[]>({ type: 'select', paths: eligible.map(m => m.path), limit: CLOUD_SEARCH_MAX_FILES });
  const candidates = eligible.filter(m => paths.includes(m.path));
  const hits: SearchHit[] = [];
  for (const m of candidates) {
    checkSearchAbort(ctx.signal);
    if (hits.length >= MAX_MATCHES) break;
    const raw = await readWorkspaceFileRaw(ctx.userId, ctx.appId, scopeOf(ctx), m.path, ctx.signal).catch(error => {
      checkSearchAbort(ctx.signal);
      if (error?.name === 'AbortError') throw error;
      return null;
    });
    checkSearchAbort(ctx.signal);
    if (!raw || raw.content.length > MAX_FILE_BYTES || looksBinary(raw.content)) continue;
    hits.push(...await worker.run<SearchHit[]>({ type: 'content', file: m.path, text: raw.content.toString('utf8'), limit: MAX_MATCHES - hits.length }));
  }
  const capped = metas.length > candidates.length ? `(云端工作区按前 ${CLOUD_SEARCH_MAX_FILES} 个文本文件搜索)` : '';
  return formatHits(hits, false) + (capped ? `\n${capped}` : '');
}

/** 解析本次调用的搜索根:host → cwd;sandbox → 本地 hydrate 目录(无则 null=纯云)。 */
async function resolveBaseDir(ctx: ToolContext): Promise<string | null> {
  checkSearchAbort(ctx.signal);
  if (ctx.execMode === 'host') return ctx.cwd || process.cwd();
  const dir = await getSessionDir(ctx).catch(error => {
    checkSearchAbort(ctx.signal);
    if (error?.name === 'AbortError') throw error;
    return null;
  });
  checkSearchAbort(ctx.signal);
  return dir;
}

export const fileSearchProvider: ToolProvider = {
  id: 'builtin:file-search',
  tools: () => [
    {
      name: 'search_files',
      mode: 'both',
      definition: {
        type: 'function',
        function: {
          name: 'search_files',
          description:
            'Search file contents by regex (grep-style) under the working directory, returning file:line:content. ' +
            'Supports an include glob to restrict files (e.g. *.ts, src/**/*.py). Automatically skips .git/node_modules/binary files.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Search regular expression (JS syntax; matched per line)' },
              include: { type: 'string', description: 'Optional: filename glob filter, e.g. *.ts or src/**/*.py' },
              case_sensitive: { type: 'boolean', description: 'Case-sensitive (default false)' },
            },
            required: ['pattern'],
          },
        },
      },
      execute: withSearchLifetime(async (args, ctx) => {
        checkSearchAbort(ctx.signal);
        const pattern = String(args.pattern ?? '');
        if (!pattern) return 'Error: pattern is required';
        if (pattern.length > 4096 || String(args.include || '').length > 4096) return 'Error: pattern exceeds 4096 characters';
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, args.case_sensitive ? '' : 'i');
        } catch (e: any) {
          return `Error: invalid regular expression: ${e?.message || e}`;
        }
        const include = args.include ? globToRegExp(String(args.include)) : undefined;
        const baseDir = await resolveBaseDir(ctx);
        const exclude = baseDir ? credentialExclusions(baseDir) : [];
        if (exclude === null) return CREDENTIAL_SEARCH_DENIED;
        if (ctx.execMode === 'host') {
          const viaRg = await rgSearch(baseDir!, pattern, args.include ? String(args.include) : undefined, ctx.signal, !!args.case_sensitive, exclude);
          if (viaRg !== null) return viaRg;
        }
        checkSearchAbort(ctx.signal);
        const worker = new FileSearchWorker({ pattern: regex.source, flags: regex.flags, include: include?.source }, ctx.signal);
        try {
          if (!baseDir) return await cloudSearch(ctx, worker);
          const result = await worker.run<{ hits: SearchHit[]; capped: boolean }>({ type: 'scan', base: baseDir, exclude });
          // 同 dropCredentialLines:凭据文件的命中行不出工具结果(C4)。云端 / 会话工作区里没有它们,照样过一遍无害。
          const creds = credentialPaths();
          return formatHits(result.hits.filter((h) => !matchProtected(path.resolve(baseDir, h.file), creds)), result.capped);
        } finally { await worker.dispose(); }
      }),
    },
    {
      name: 'glob_files',
      mode: 'both',
      definition: {
        type: 'function',
        function: {
          name: 'glob_files',
          description:
            'List file paths under the working directory matching a glob pattern (e.g. **/*.test.ts, src/*.py). ' +
            'Use this to find files; use search_files to search contents.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Glob pattern: ** across directories, * within a segment, ? single character, {a,b} alternation' },
            },
            required: ['pattern'],
          },
        },
      },
      execute: withSearchLifetime(async (args, ctx) => {
        checkSearchAbort(ctx.signal);
        const pattern = String(args.pattern ?? '');
        if (!pattern) return 'Error: pattern is required';
        if (pattern.length > 4096) return 'Error: pattern exceeds 4096 characters';
        const re = globToRegExp(pattern);
        const baseDir = await resolveBaseDir(ctx);
        const worker = new FileSearchWorker({ include: re.source }, ctx.signal);
        let matched: string[];
        try {
          if (baseDir) matched = await worker.run({ type: 'glob', base: baseDir });
          else {
            const metas = await listWorkspaceMetas(ctx.userId, ctx.appId, scopeOf(ctx), ctx.signal);
            checkSearchAbort(ctx.signal);
            matched = await worker.run({ type: 'select', paths: metas.map(m => m.path), limit: MAX_GLOB_RESULTS });
          }
        } finally {
          await worker.dispose();
        }
        if (!matched.length) return '(no files matched)';
        let out = matched.join('\n');
        if (matched.length >= MAX_GLOB_RESULTS) out += `\n…[capped at ${MAX_GLOB_RESULTS}]`;
        return out;
      }),
    },
  ],
};
