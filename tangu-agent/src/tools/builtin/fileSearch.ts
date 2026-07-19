/**
 * 文件搜索工具:search_files(grep 式内容搜索)+ glob_files(通配符找文件)。mode:'both':
 *   - host:基于 ctx.cwd 的真实 FS;search 优先用 ripgrep(快、尊重 .gitignore),无 rg 回退纯 Node 扫描
 *   - sandbox:基于会话工作区。getSessionDir 命中(per-run 本地 hydrate 目录)→ 本地扫描;
 *     未命中(纯 Penzor 云模式)→ glob 走 listWorkspaceMetas 元数据;search 拉取文件内容(带量级上限)
 * 输出统一截断,跳过 .git/node_modules 等重目录与二进制文件。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { getSessionDir } from '../../sandbox/sessionSandbox.js';
import { listWorkspaceMetas, readWorkspaceFileRaw, scopeOf } from '../fileWorkspace.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', '.venv', 'venv', '__pycache__', '.next', 'target', 'out']);
const MAX_FILES_VISITED = 5000;
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_GLOB_RESULTS = 500;
// 纯 Penzor 云模式 search 的远程拉取上限(每文件一次 OSS 往返,必须收紧)
const CLOUD_SEARCH_MAX_FILES = 30;

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

/** 递归收集 baseDir 下文件相对路径(posix),跳过重目录/点目录,带访问上限。 */
async function walkFiles(baseDir: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length < MAX_FILES_VISITED) {
    const rel = queue.shift()!;
    const dir = path.join(baseDir, rel);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        queue.push(r);
      } else if (e.isFile()) {
        out.push(r);
        if (out.length >= MAX_FILES_VISITED) break;
      }
    }
  }
  return out;
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

/** 纯 Node 内容搜索(host 无 rg / sandbox 本地目录通用)。 */
async function nodeSearch(baseDir: string, regex: RegExp, include?: RegExp): Promise<string> {
  const rels = await walkFiles(baseDir);
  const hits: SearchHit[] = [];
  for (const rel of rels) {
    if (hits.length >= MAX_MATCHES) break;
    if (include && !include.test(rel)) continue;
    let buf: Buffer;
    try {
      const st = await fs.stat(path.join(baseDir, rel));
      if (st.size > MAX_FILE_BYTES) continue;
      buf = await fs.readFile(path.join(baseDir, rel));
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
      if (regex.test(lines[i])) hits.push({ file: rel, line: i + 1, text: lines[i].trim() });
    }
  }
  return formatHits(hits, rels.length >= MAX_FILES_VISITED);
}

/** host 模式优先 ripgrep(ENOENT 回退 nodeSearch)。 */
function rgSearch(cwd: string, pattern: string, include?: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ['-n', '--no-messages', '--max-count', '50', '--max-filesize', '1M', '-e', pattern];
    if (include) args.push('--glob', include);
    args.push('.');
    let child;
    try {
      child = spawn('rg', args, { cwd, signal });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let resolved = false;
    child.on('error', () => { if (!resolved) { resolved = true; resolve(null); } }); // rg 不存在 → 回退
    child.stdout?.on('data', (d) => {
      if (out.length < MAX_OUTPUT_CHARS * 2) out += d.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      if (code === 0 || code === 1) {
        // rg: 0=有匹配,1=无匹配
        if (!out.trim()) { resolve('(no matches)'); return; }
        let text = out.trimEnd();
        const lines = text.split('\n');
        let footer = `\n${lines.length} matching line(s)`;
        if (text.length > MAX_OUTPUT_CHARS) { text = text.slice(0, MAX_OUTPUT_CHARS) + '\n…[truncated]'; }
        resolve(text + footer);
      } else {
        resolve(`Error: rg exited ${code}(检查 pattern 的正则语法)`);
      }
    });
  });
}

/** 纯 Penzor 云模式:按元数据挑文件,逐个拉内容搜(上限收紧)。 */
async function cloudSearch(ctx: ToolContext, regex: RegExp, include?: RegExp): Promise<string> {
  const metas = await listWorkspaceMetas(ctx.userId, ctx.appId, scopeOf(ctx));
  const candidates = metas
    .filter((m) => (!include || include.test(m.path)) && m.size <= MAX_FILE_BYTES && (m.mimeType.startsWith('text/') || m.mimeType === 'application/json'))
    .slice(0, CLOUD_SEARCH_MAX_FILES);
  const hits: SearchHit[] = [];
  for (const m of candidates) {
    if (hits.length >= MAX_MATCHES) break;
    const raw = await readWorkspaceFileRaw(ctx.userId, ctx.appId, scopeOf(ctx), m.path).catch(() => null);
    if (!raw || looksBinary(raw.content)) continue;
    const lines = raw.content.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
      if (regex.test(lines[i])) hits.push({ file: m.path, line: i + 1, text: lines[i].trim() });
    }
  }
  const capped = metas.length > candidates.length ? `(云端工作区按前 ${CLOUD_SEARCH_MAX_FILES} 个文本文件搜索)` : '';
  return formatHits(hits, false) + (capped ? `\n${capped}` : '');
}

/** 解析本次调用的搜索根:host → cwd;sandbox → 本地 hydrate 目录(无则 null=纯云)。 */
async function resolveBaseDir(ctx: ToolContext): Promise<string | null> {
  if (ctx.execMode === 'host') return ctx.cwd || process.cwd();
  return getSessionDir(ctx).catch(() => null);
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
      execute: async (args, ctx) => {
        const pattern = String(args.pattern ?? '');
        if (!pattern) return 'Error: pattern is required';
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, args.case_sensitive ? '' : 'i');
        } catch (e: any) {
          return `Error: 非法正则: ${e?.message || e}`;
        }
        const include = args.include ? globToRegExp(String(args.include)) : undefined;
        const baseDir = await resolveBaseDir(ctx);
        if (!baseDir) return cloudSearch(ctx, regex, include);
        if (ctx.execMode === 'host') {
          const viaRg = await rgSearch(baseDir, pattern, args.include ? String(args.include) : undefined, ctx.signal);
          if (viaRg !== null) return viaRg;
        }
        return nodeSearch(baseDir, regex, include);
      },
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
      execute: async (args, ctx) => {
        const pattern = String(args.pattern ?? '');
        if (!pattern) return 'Error: pattern is required';
        const re = globToRegExp(pattern);
        const baseDir = await resolveBaseDir(ctx);
        let rels: string[];
        if (baseDir) {
          rels = await walkFiles(baseDir);
        } else {
          rels = (await listWorkspaceMetas(ctx.userId, ctx.appId, scopeOf(ctx))).map((m) => m.path);
        }
        const matched = rels.filter((r) => re.test(r)).slice(0, MAX_GLOB_RESULTS);
        if (!matched.length) return '(no files matched)';
        let out = matched.join('\n');
        if (matched.length >= MAX_GLOB_RESULTS) out += `\n…[capped at ${MAX_GLOB_RESULTS}]`;
        return out;
      },
    },
  ],
};
