/**
 * publish_web_page —— 把工作区里的一个网页文件或一个静态文件夹发成 Forsion Connect 链接(<云端>/apps/<handle>/<slug>/),或下线。
 *
 * 为什么住在引擎核心、挨着 forsion_account:理由同那份头注(云端执行节点只加载节点自己的插件、chat 预设藏插件工具),
 * 网页 / 手机的对话在云端节点上跑,放 Extend 就用不了。
 *
 * 口径:
 *   - 走 brain.cloud.request → server microserver/connect:POST /api/connect/apps(和 Coding Space 发布对话框同一个接口,
 *     同一个 slug 再发 = 整份换新)、DELETE /api/connect/apps/:slug。云端节点的派生令牌在 server dispatchToken.ts 登记了这几条。
 *   - 每次都问(approval:'always'),可见性同 forsion_account_action(actionable:无人值守 / 代批 / 通道 / 远程污点 / 子代理都不给)。
 *     slug 必填:它决定换掉哪一页,要先出现在审批卡上,不由这里按文件名猜。
 *   - 打包规则对齐 Extend connect.ts 的 collectProjectFiles:跳过点开头的、软链、node_modules、.d.ts;上限同 server(300 个 / 单个 5MB / 共 20MB)。
 *     不编译 TS / JSX(桌面发布对话框会),碰到就在结果里提醒。凭据文件(checkReadPath)整次拒发,不悄悄跳过。
 *   - 链接用服务端给的 publicUrl(节点经内网地址调进来,自己拼不出);老 server 没这个字段就给相对路径。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import type { CloudAccountBrain, CloudResponse } from '../../seams/cloudBrain.js';
import { resolvePath } from '../hostExec.js';
import { checkReadPath } from '../fsPolicy.js';
import { actionable, cloud, failure, formatBytes } from './forsionAccount.js';

// = server connectService MAX_FILES / MAX_FILE_BYTES / MAX_TOTAL_BYTES / isValidSlug
const MAX_FILES = 300;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})?[a-z0-9]$/;
const UPLOAD_TIMEOUT_MS = 300_000; // 同 Extend connect:publish
const SKIP_DIRS = new Set(['node_modules']);
const UNCOMPILED = /\.(?:tsx?|jsx|mts|cts)$/i;
const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

type Parsed =
  | { ok: true; action: 'publish'; path: string; slug: string; name: string; entry?: string }
  | { ok: true; action: 'unpublish'; slug: string }
  | { ok: false; error: string };

export function parseWebPublish(args: any): Parsed {
  const action = args?.action === undefined ? 'publish' : args.action;
  const slug = typeof args?.slug === 'string' ? args.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) return { ok: false, error: 'slug must be 3-32 lowercase letters, digits or hyphens, not starting or ending with a hyphen' };
  if (action === 'unpublish') return { ok: true, action, slug };
  if (action !== 'publish') return { ok: false, error: 'action must be publish or unpublish' };
  const p = typeof args?.path === 'string' ? args.path.trim() : '';
  if (!p) return { ok: false, error: 'path is required to publish' };
  const given = typeof args?.name === 'string' ? args.name.trim() : '';
  const name = (given || path.basename(p).replace(/\.html?$/i, '') || slug).slice(0, 80);
  const entry = typeof args?.entry === 'string' && args.entry.trim() ? args.entry.trim().replace(/^\.\//, '') : undefined;
  return { ok: true, action, path: p, slug, name, entry };
}

/** 审批卡上的那句:发哪个路径、换到哪个 slug、谁能看。 */
export function webPublishPreview(args: any): string {
  const a = parseWebPublish(args);
  if (!a.ok) return `Publish web page: invalid request (${a.error})`;
  if (a.action === 'unpublish') return `Take down your Forsion web page "${a.slug}". Its link stops working and its files are deleted from your cloud drive.`;
  return `Publish ${a.path} as a Forsion web page "${a.name}" (link name: ${a.slug}).\n` +
    'Anyone with the link can open it. The files go to your Forsion cloud drive and count toward its storage. ' +
    `If you already have a page called ${a.slug}, it is replaced.`;
}

interface PackedFile { path: string; content_b64: string; content_type: string; size: number }
type Packed = { files: PackedFile[]; total: number; uncompiled: string[]; htmlAtTop: string[] };

/** 打包;出错回给模型的那句(以 Error: 开头)。 */
async function pack(root: string, single: boolean): Promise<Packed | string> {
  const out: Packed = { files: [], total: 0, uncompiled: [], htmlAtTop: [] };
  const add = async (abs: string, rel: string): Promise<string | null> => {
    const verdict = checkReadPath(abs);
    if (!verdict.ok) return `Error: ${verdict.reason} Nothing was published.`;
    if (out.files.length >= MAX_FILES) return `Error: more than ${MAX_FILES} files (hidden files and node_modules are already skipped). Publish a smaller folder, such as the build output.`;
    const buf = await fs.readFile(abs);
    if (buf.length > MAX_FILE_BYTES) return `Error: ${rel} is larger than 5 MB.`;
    out.total += buf.length;
    if (out.total > MAX_TOTAL_BYTES) return 'Error: the files add up to more than 20 MB.';
    if (UNCOMPILED.test(rel) && !rel.endsWith('.d.ts')) out.uncompiled.push(rel);
    if (!rel.includes('/') && /\.html?$/i.test(rel)) out.htmlAtTop.push(rel);
    const ext = path.extname(rel).toLowerCase();
    out.files.push({ path: rel, content_b64: buf.toString('base64'), content_type: MIME[ext] ?? 'application/octet-stream', size: buf.length });
    return null;
  };
  if (single) return (await add(root, path.basename(root))) ?? out;
  const walk = async (dir: string, rel: string): Promise<string | null> => {
    for (const ent of (await fs.readdir(dir, { withFileTypes: true })).sort((x, y) => x.name.localeCompare(y.name))) {
      if (ent.name.startsWith('.') || ent.isSymbolicLink()) continue; // .git / .env / .DS_Store;软链可能指到文件夹外
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      const err = ent.isDirectory() ? (SKIP_DIRS.has(ent.name) ? null : await walk(abs, relPath))
        : ent.isFile() && !ent.name.endsWith('.d.ts') ? await add(abs, relPath) : null;
      if (err) return err;
    }
    return null;
  };
  return (await walk(root, '')) ?? out;
}

const code = (r: CloudResponse): string => String(r.json?.code ?? '');
const detail = (r: CloudResponse): string => String(r.json?.detail ?? '').slice(0, 200);

/** 名额满了:列出已有的 slug,让模型去换一页或先下线一页。 */
async function limitReached(c: CloudAccountBrain, ctx: ToolContext, r: CloudResponse): Promise<string> {
  const list = await c.request({ path: '/api/connect/apps', signal: ctx.signal });
  const slugs = Array.isArray(list.json?.apps) ? list.json.apps.map((a: any) => String(a.slug)) : [];
  return `Error: the user's plan allows ${r.json?.limit ?? '?'} published page(s) and all are used${slugs.length ? ` (${slugs.join(', ')})` : ''}. ` +
    'Publish to one of these slugs to replace that page, take one down with action unpublish, or the user can upgrade their plan.';
}

async function publish(c: CloudAccountBrain, ctx: ToolContext, a: Extract<Parsed, { action: 'publish' }>): Promise<string> {
  let real: string;
  try { real = await fs.realpath(resolvePath(ctx, a.path)); } catch { return `Error: ${a.path} does not exist.`; }
  const st = await fs.stat(real);
  if (!st.isFile() && !st.isDirectory()) return `Error: ${a.path} is not a file or folder.`;
  const packed = await pack(real, st.isFile()).catch((e: any) => `Error: could not read the files (${e?.code || e?.message || e}).`);
  if (typeof packed === 'string') return packed;
  if (!packed.files.length) return `Error: ${a.path} has no files to publish (hidden files and node_modules are skipped).`;
  const entry = a.entry ?? (st.isFile() ? packed.files[0].path
    : packed.htmlAtTop.includes('index.html') ? 'index.html' : packed.htmlAtTop.length === 1 ? packed.htmlAtTop[0] : '');
  if (!entry) return `Error: the folder has no index.html; pass entry with the HTML file to open first${packed.htmlAtTop.length ? ` (top-level HTML files: ${packed.htmlAtTop.join(', ')})` : ''}.`;
  if (!packed.files.some((f) => f.path === entry)) return `Error: entry ${entry} is not among the files being published.`;

  const r = await c.request({
    path: '/api/connect/apps', method: 'POST', timeoutMs: UPLOAD_TIMEOUT_MS, signal: ctx.signal,
    body: { slug: a.slug, name: a.name, entry, files: packed.files },
  });
  if (r.status === 404 && !r.json?.code) return 'Error: web page publishing (Forsion Connect) is not enabled on this Forsion server.';
  if (code(r) === 'limit_reached') return limitReached(c, ctx, r);
  if (code(r) === 'quota_exceeded') return "Error: the user's Forsion cloud drive does not have enough free storage for these files.";
  if (code(r) === 'disabled') return `Error: the page ${a.slug} was disabled by a Forsion administrator and cannot be updated.`;
  if (code(r) === 'slug_taken') return `Error: the link name ${a.slug} is taken; pick another slug.`;
  if (code(r) === 'invalid') return `Error: Forsion rejected the files: ${detail(r)}`;
  if (r.status === 0 && r.error === 'timeout') return 'Error: the upload timed out; it is unknown whether the page was published. Check with forsion_account section web_pages before retrying.';
  const bad = failure(r);
  if (bad) return `Error: ${bad}`;
  const url = String(r.json?.publicUrl || r.json?.url || '');
  const lines = [
    `Published "${a.name}" at ${url} (${packed.files.length} file(s), ${formatBytes(packed.total)}, opens ${entry}).`,
    'Anyone with the link can open it. It runs sandboxed, so it cannot read visitors\' Forsion sign-in. Publishing again with the same slug replaces it.',
  ];
  if (packed.uncompiled.length) lines.push(`Note: ${packed.uncompiled.length} TypeScript/JSX file(s) were uploaded as-is and browsers cannot run them (${packed.uncompiled.slice(0, 5).join(', ')}). If the page needs them, build it and publish the build output folder instead.`);
  return lines.join('\n');
}

async function unpublish(c: CloudAccountBrain, ctx: ToolContext, slug: string): Promise<string> {
  const r = await c.request({ path: `/api/connect/apps/${slug}`, method: 'DELETE', signal: ctx.signal });
  if (r.status === 404) return `Error: the user has no published page called ${slug}.`;
  const bad = failure(r);
  return bad ? `Error: ${bad}` : `Took down the web page ${slug}; its link no longer works.`;
}

export const webPublishProvider: ToolProvider = {
  id: 'builtin:publish_web_page',
  tools: () => [
    {
      name: 'publish_web_page',
      deferred: true,
      deferGroup: 'publish_web_page',
      deferHint: 'Publish a web page or a folder of static files from the workspace to a Forsion link anyone with the link can open, update it, or take it down. The user confirms each time.',
      isEnabledFor: actionable,
      capabilities: { approval: 'always' },
      definition: {
        type: 'function',
        function: {
          name: 'publish_web_page',
          description:
            'Publish an HTML file, or a folder of static files (HTML, CSS, JS, images — for a built app, its build output folder), from the workspace as a web page on Forsion; or take a published page down. ' +
            'Only when the user asked to publish, share or deploy it; the user confirms every call. ' +
            "The page gets a link anyone with it can open; it runs sandboxed and cannot read visitors' Forsion sign-in. " +
            'Publishing to a slug the user already has replaces that page. Before picking a slug for a new page, check the existing ones with forsion_account section web_pages. ' +
            'Hidden files, node_modules and symlinks are skipped; at most 300 files, 5 MB each, 20 MB in total. TypeScript/JSX is not compiled.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['publish', 'unpublish'], description: 'Default: publish' },
              slug: { type: 'string', description: 'Link name, 3-32 lowercase letters, digits or hyphens; it becomes the end of the URL. Reuse a slug to update that page.' },
              path: { type: 'string', description: 'For publish: the HTML file or the folder to publish, relative to the working directory or absolute' },
              name: { type: 'string', description: "For publish: the page title in the user's page list (default: the file or folder name)" },
              entry: { type: 'string', description: 'For publish of a folder: the HTML file that opens first, relative to the folder (default: index.html, or the only top-level HTML file)' },
            },
            required: ['slug'],
          },
        },
      },
      execute: async (args, ctx) => {
        const c = cloud();
        if (!c) return 'Error: publishing web pages needs a Forsion account, which is not available in this kind of run.';
        if (!actionable(undefined, ctx)) return 'Error: Publishing needs the user to confirm it in the conversation on their own device; this run cannot do that.';
        const a = parseWebPublish(args);
        if (!a.ok) return `Error: ${a.error}`;
        return a.action === 'unpublish' ? unpublish(c, ctx, a.slug) : publish(c, ctx, a);
      },
    },
  ],
};
