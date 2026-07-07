/**
 * agent 文件工具：基于 Penzor Cloud（cloudStorageService）的 path↔fileId 解析层。
 *
 * 云端文件规范（每个 app 的 Penzor 空间内）：
 *   <appId>/workspace/<sessionId>/...   ← 每会话工作区（agent 读写 + 客户端可上传）
 *   <appId>/.agent/skills/<skillId>/SKILL.md  ← 物化的技能
 *
 * appId 用 run 所属 app（AI Studio = 'ai-studio'），与用户在该 app 的其它文件同处一个云空间，
 * 但收在 workspace/.agent 专用子树下。非 .md 文件写入传非 markdown mime，绕过 front-matter 解析。
 */
import { deps } from '../seams/runtime.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ── 注入依赖的 lazy 别名:把 Penzor cloudStorageService 收敛到 brain.storage(保持调用点不变)──
const cloudStorageService = {
  listDirectory: (...a: any[]) => (deps().brain.storage.listDirectory as any)(...a),
  createDirectory: (...a: any[]) => (deps().brain.storage.createDirectory as any)(...a),
  getFileContent: (...a: any[]) => (deps().brain.storage.getFileContent as any)(...a),
  updateFileContent: (...a: any[]) => (deps().brain.storage.updateFileContent as any)(...a),
  uploadFile: (...a: any[]) => (deps().brain.storage.uploadFile as any)(...a),
  deleteItem: (...a: any[]) => (deps().brain.storage.deleteItem as any)(...a),
};

export function mimeForName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  // Office（二进制，给正确 mime：前端图标正确 + 不会被当文本预览成乱码）
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
  if (lower.endsWith('.zip')) return 'application/zip';
  // .py/.ts/.js/.txt/其它 → text/plain：非 markdown 即不触发 front-matter 解析
  return 'text/plain';
}

// 归一化 agent 给的工作区路径，使其严格落在「本会话工作区根」内：
//   - 去空白/空段；过滤 '.'/'..' 防目录穿越（写权限只在 workspace/<sessionId> 内）。
//   - 剥掉容器内的工作区前缀（/workspace/... 与 /mnt/data/... 都指向工作区根），
//     这样 run_python 里写的 /mnt/data/x 与 read_file('/mnt/data/x') 指向同一文件，
//     也避免 '/workspace/x' 被再套一层 workspace 目录。
function splitPath(p: string): string[] {
  let segs = String(p || '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
  if (segs[0] === 'workspace') segs = segs.slice(1);
  else if (segs[0] === 'mnt' && segs[1] === 'data') segs = segs.slice(2);
  return segs;
}

/** 会话工作区根：<appId>/workspace/<sessionId>/...（加上调用方给的子路径段）。 */
function wsSegments(sessionId: string, sub: string[]): string[] {
  return ['workspace', sessionId, ...sub];
}

/** 解析（可选创建）目录链，返回最终目录 fileId（ROOT 为根）。 */
async function resolveDir(
  userId: string,
  appId: string,
  segments: string[],
  create: boolean,
): Promise<string> {
  let parent = 'ROOT';
  for (const seg of segments) {
    const items: any[] = await cloudStorageService.listDirectory(parent, userId, appId);
    const dir = items.find((i) => i.name === seg && i.fileType === 'directory');
    if (dir) {
      parent = dir.id;
    } else if (create) {
      try {
        const created: any = await cloudStorageService.createDirectory(userId, appId, parent, seg);
        parent = created.id;
      } catch (e) {
        // 并发创建竞态（多个 materialize/snapshot 同时建同名目录撞唯一约束）：
        // 重列父目录，命中已存在的同名目录则复用，否则上抛。
        const retry: any[] = await cloudStorageService.listDirectory(parent, userId, appId);
        const found = retry.find((i) => i.name === seg && i.fileType === 'directory');
        if (found) parent = found.id;
        else throw e;
      }
    } else {
      throw new Error(`directory not found: ${seg}`);
    }
  }
  return parent;
}

const READ_FILE_MAX_CHARS = 100_000;
const READ_FILE_MAX_LINES = 2000;

/** read_file 分页(云工作区):cat -n 风格每行前缀「行号 + Tab」(1-based)+ [lines a-b of N] 头。
 *  与 host paginate 同款:行号给模型坐标、逼它精确复制缩进,好让 apply_patch 的上下文/edit 唯一命中,
 *  从而做局部编辑而非整文件覆写。offset 仍 0-based 入参,显示行号 1-based。 */
function paginateText(text: string, offset?: number, limit?: number): string {
  const lines = text.split('\n');
  const total = lines.length;
  const start = Math.min(Math.max(0, offset ?? 0), total);
  const cappedLimit = Math.min(limit ?? READ_FILE_MAX_LINES, READ_FILE_MAX_LINES);
  const end = Math.min(start + cappedLimit, total);
  let body = lines.slice(start, end).map((l, i) => String(start + i + 1).padStart(6) + '\t' + l).join('\n');
  let trimmed = false;
  if (body.length > READ_FILE_MAX_CHARS) { body = body.slice(0, READ_FILE_MAX_CHARS); trimmed = true; }
  const more = trimmed ? '\n…[truncated; narrow your limit]'
    : end < total ? `\n…[${total - end} more line(s) below; read with offset:${end}]` : '';
  return `[lines ${start + 1}-${end} of ${total}]\n` + body + more;
}

export async function listFiles(userId: string, appId: string, sessionId: string, path: string): Promise<string> {
  let parent: string;
  try {
    parent = await resolveDir(userId, appId, wsSegments(sessionId, splitPath(path)), false);
  } catch {
    return '(empty directory)'; // 工作区尚未创建
  }
  const items: any[] = await cloudStorageService.listDirectory(parent, userId, appId);
  if (!items.length) return '(empty directory)';
  return items
    .map((i) => (i.fileType === 'directory' ? `[dir]  ${i.name}/` : `[file] ${i.name} (${i.fileSize || 0} bytes)`))
    .join('\n');
}

export async function readFile(userId: string, appId: string, sessionId: string, path: string, offset?: number, limit?: number): Promise<string> {
  const all = wsSegments(sessionId, splitPath(path));
  const name = all.pop();
  if (!name) throw new Error('invalid path');
  const parent = await resolveDir(userId, appId, all, false);
  const items: any[] = await cloudStorageService.listDirectory(parent, userId, appId);
  const file = items.find((i) => i.name === name && i.fileType === 'file');
  if (!file) throw new Error(`file not found: ${path}`);
  const { content } = await cloudStorageService.getFileContent(file.id, userId);
  return paginateText(content.toString('utf-8'), offset, limit);
}

/** 写文本文件（agent write_file）。 */
export async function writeFile(
  userId: string,
  appId: string,
  sessionId: string,
  path: string,
  contentStr: string,
): Promise<string> {
  await writeFileRaw(userId, appId, sessionId, path, Buffer.from(contentStr, 'utf-8'));
  return `wrote ${path}`;
}

/** 写任意字节（供客户端 workspace 上传，支持二进制）。存在则更新，否则新建。 */
export async function writeFileRaw(
  userId: string,
  appId: string,
  sessionId: string,
  path: string,
  buffer: Buffer,
  mimeType?: string,
): Promise<void> {
  const all = wsSegments(sessionId, splitPath(path));
  const name = all.pop();
  if (!name) throw new Error('invalid path');
  const parent = await resolveDir(userId, appId, all, true);
  const items: any[] = await cloudStorageService.listDirectory(parent, userId, appId);
  const existing = items.find((i) => i.name === name && i.fileType === 'file');
  if (existing) {
    await cloudStorageService.updateFileContent(existing.id, userId, buffer);
    return;
  }
  await cloudStorageService.uploadFile(userId, appId, parent, name, buffer, mimeType || mimeForName(name), false);
}

// ── 本地工作区目录直读写（per-run 模式：hydrate 一次到本地目录，全程本地操作，run 结束 snapshot 一次）──
// 避免每个文件工具调用都打远程 OSS（cn-beijing 单次往返 ~1-2s），大幅提速。

/** 列出本地工作区目录某子路径下的文件/子目录（输出与 Penzor 版一致）。 */
export async function listFilesLocal(baseDir: string, sub: string): Promise<string> {
  const dir = path.join(baseDir, ...splitPath(sub));
  let entries: any[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return '(empty directory)';
  }
  if (!entries.length) return '(empty directory)';
  const lines: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) lines.push(`[dir]  ${e.name}/`);
    else {
      let size = 0;
      try { size = (await fs.stat(path.join(dir, e.name))).size; } catch { /* ignore */ }
      lines.push(`[file] ${e.name} (${size} bytes)`);
    }
  }
  return lines.join('\n');
}

/** 读取本地工作区某文件文本（截断 100k）。 */
export async function readFileLocal(baseDir: string, sub: string, offset?: number, limit?: number): Promise<string> {
  const segs = splitPath(sub);
  if (!segs.length) throw new Error('invalid path');
  const abs = path.join(baseDir, ...segs);
  const buf = await fs.readFile(abs).catch(() => { throw new Error(`file not found: ${sub}`); });
  return paginateText(buf.toString('utf-8'), offset, limit);
}

/** 读取本地工作区某文件的**完整**文本(不分页,供 apply_patch 应用补丁);不存在返回 null。 */
export async function readFileRawLocal(baseDir: string, sub: string): Promise<string | null> {
  const segs = splitPath(sub);
  if (!segs.length) return null;
  try {
    return (await fs.readFile(path.join(baseDir, ...segs))).toString('utf-8');
  } catch {
    return null;
  }
}

/** 写入本地工作区某文件（中间目录自动建）。 */
export async function writeFileLocal(baseDir: string, sub: string, content: string): Promise<string> {
  const segs = splitPath(sub);
  if (!segs.length) throw new Error('invalid path');
  const abs = path.join(baseDir, ...segs);
  await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
  await fs.writeFile(abs, content, 'utf-8');
  return `wrote ${sub}`;
}

// ── run_python 沙箱的 workspace hydrate / snapshot ──────────────────────────
// 把 Penzor 的 <appId>/workspace/<sessionId>/ 子树同步进宿主临时目录（执行前 hydrate），
// 执行后把新增/变更文件回写 Penzor（snapshot）。变更检测用 sha256。带规模上限防滥用。

const WS_MAX_FILES = Number(process.env.AGENT_WS_MAX_FILES) || 300;
const WS_MAX_FILE_BYTES = Number(process.env.AGENT_WS_MAX_FILE_BYTES) || 5 * 1024 * 1024;
// 远程往返（cn-beijing OSS 单次 ~1-2s）是 hydrate/snapshot 的主成本：并发化，避免线性叠加。
const HYDRATE_CONCURRENCY = Math.max(1, Number(process.env.AGENT_WS_HYDRATE_CONCURRENCY) || 8);
const SNAPSHOT_CONCURRENCY = Math.max(1, Number(process.env.AGENT_WS_SNAPSHOT_CONCURRENCY) || 6);

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 并发上限地跑一批异步任务（固定 worker 数从队列取）。 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const n = Math.min(limit, items.length);
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * 把会话工作区（<appId>/workspace/<sessionId>/）递归写入 destDir。
 * 返回 manifest：相对路径 → sha256（供 snapshot 做变更检测）。工作区不存在则返回空表。
 */
export async function hydrateWorkspaceToDir(
  userId: string,
  appId: string,
  sessionId: string,
  destDir: string,
): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();
  let rootId: string;
  try {
    rootId = await resolveDir(userId, appId, wsSegments(sessionId, []), false);
  } catch {
    return manifest; // 尚无工作区
  }

  // Phase 1：BFS 遍历树（listDirectory 是元数据调用）→ 建目录 + 收集待下载文件节点。
  const fileNodes: Array<{ id: string; rel: string }> = [];
  const queue: Array<{ id: string; rel: string }> = [{ id: rootId, rel: '' }];
  while (queue.length) {
    const node = queue.shift()!;
    let items: any[];
    try {
      items = await cloudStorageService.listDirectory(node.id, userId, appId);
    } catch {
      continue;
    }
    for (const it of items) {
      const rel = node.rel ? `${node.rel}/${it.name}` : it.name;
      if (it.fileType === 'directory') {
        await fs.mkdir(path.join(destDir, rel), { recursive: true }).catch(() => {});
        queue.push({ id: it.id, rel });
      } else if (it.fileType === 'file') {
        if (fileNodes.length >= WS_MAX_FILES) continue;
        if ((it.fileSize || 0) > WS_MAX_FILE_BYTES) continue;
        fileNodes.push({ id: it.id, rel });
      }
    }
  }

  // Phase 2：并发下载文件内容（最重的一段；串行会按文件数线性叠加远程往返）。
  await mapLimit(fileNodes, HYDRATE_CONCURRENCY, async (f) => {
    try {
      const { content } = await cloudStorageService.getFileContent(f.id, userId);
      const abs = path.join(destDir, f.rel);
      await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
      await fs.writeFile(abs, content);
      manifest.set(f.rel, sha256(content)); // Map.set 同步、单线程无竞态
    } catch { /* 跳过坏文件 */ }
  });
  return manifest;
}

/** 递归列出本地目录下所有文件的相对路径。 */
async function walkLocal(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let entries: any[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      // 跳过点目录：库缓存/配置（.cache/.config/.mpl/.local…）与内部产物目录（.agent）
      // 不回流到用户云端工作区。会话内 read_file 仍走本地目录，不受影响。
      if (e.name.startsWith('.')) continue;
      out.push(...(await walkLocal(abs, base)));
    } else if (e.isFile()) {
      out.push(path.relative(base, abs));
    }
  }
  return out;
}

/**
 * 把 srcDir 下相对 beforeManifest 新增/变更的文件回写 Penzor 工作区。
 * 变更文件并发上传，成功后**更新 beforeManifest**（以 posix 相对路径为键）——使同一会话内的
 * 重复 snapshot 增量化（只回写自上次以来的新变更）。返回回写的相对路径列表。
 * 不做删除（安全起见，沙箱删文件不影响云端）。
 */
export async function snapshotDirToWorkspace(
  userId: string,
  appId: string,
  sessionId: string,
  srcDir: string,
  beforeManifest: Map<string, string>,
): Promise<string[]> {
  const rels = await walkLocal(srcDir);
  // 先本地 diff（读文件 + sha256，本地操作快）收集变更；manifest 统一用 posix 相对路径键。
  const pending: Array<{ posixRel: string; buf: Buffer; hash: string }> = [];
  for (const rel of rels) {
    if (pending.length >= WS_MAX_FILES) break;
    const abs = path.join(srcDir, rel);
    let buf: Buffer;
    try {
      const st = await fs.stat(abs);
      if (st.size > WS_MAX_FILE_BYTES) continue;
      buf = await fs.readFile(abs);
    } catch {
      continue;
    }
    const posixRel = rel.split(path.sep).join('/');
    const hash = sha256(buf);
    if (beforeManifest.get(posixRel) === hash) continue; // 未变
    pending.push({ posixRel, buf, hash });
  }
  // 并发上传变更文件，成功者更新基线 manifest。
  const changed: string[] = [];
  await mapLimit(pending, SNAPSHOT_CONCURRENCY, async (p) => {
    try {
      await writeFileRaw(userId, appId, sessionId, p.posixRel, p.buf);
      beforeManifest.set(p.posixRel, p.hash);
      changed.push(p.posixRel);
    } catch { /* 单文件失败不阻断 */ }
  });
  return changed;
}

// 进程内去重：同一 (user, app, skill, 内容hash) 本进程已物化过就跳过，
// 避免每个 run 都把 10 万+字的 SKILL.md 重新上传 + 重复 listDirectory（拖慢 + 打 DB/OSS）。
const materializedCache = new Set<string>();

// ── 供 AI Studio 前端"云模式 workspace 视图"读取会话云端工作区 ──

export interface WorkspaceMeta { path: string; size: number; mimeType: string; updatedAt: number; }

/** 递归列出会话云端工作区 <appId>/workspace/<sessionId>/ 的所有文件（扁平相对路径 + 元信息）。 */
export async function listWorkspaceMetas(userId: string, appId: string, sessionId: string): Promise<WorkspaceMeta[]> {
  let rootId: string;
  try {
    rootId = await resolveDir(userId, appId, wsSegments(sessionId, []), false);
  } catch {
    return [];
  }
  const out: WorkspaceMeta[] = [];
  const queue: Array<{ id: string; rel: string }> = [{ id: rootId, rel: '' }];
  let count = 0;
  while (queue.length) {
    const node = queue.shift()!;
    let items: any[];
    try { items = await cloudStorageService.listDirectory(node.id, userId, appId); } catch { continue; }
    for (const it of items) {
      const rel = node.rel ? `${node.rel}/${it.name}` : it.name;
      if (it.fileType === 'directory') {
        queue.push({ id: it.id, rel });
      } else if (it.fileType === 'file') {
        if (count++ > 2000) continue;
        const updatedAt = it.updatedAt ? Number(it.updatedAt) : (it.updated_at ? Number(it.updated_at) : Date.now());
        // 按扩展名定 mime（存库 mime 在写入时多为 text/plain，不可靠）→ 前端图标/预览判断正确。
        out.push({ path: rel, size: Number(it.fileSize) || 0, mimeType: mimeForName(it.name), updatedAt });
      }
    }
  }
  return out;
}

/** 读取会话云端工作区某文件的原始字节 + mime（供前端预览/下载）。 */
export async function readWorkspaceFileRaw(userId: string, appId: string, sessionId: string, p: string): Promise<{ content: Buffer; mimeType: string } | null> {
  const all = wsSegments(sessionId, splitPath(p));
  const name = all.pop();
  if (!name) return null;
  let parent: string;
  try { parent = await resolveDir(userId, appId, all, false); } catch { return null; }
  const items: any[] = await cloudStorageService.listDirectory(parent, userId, appId);
  const file = items.find((i) => i.name === name && i.fileType === 'file');
  if (!file) return null;
  const { content } = await cloudStorageService.getFileContent(file.id, userId);
  // 按扩展名定 mime（存库 mime 写入时多为 text/plain，对二进制预览不可靠）。
  return { content, mimeType: mimeForName(name) };
}

/** 删除会话云端工作区某文件。 */
export async function deleteWorkspaceFile(userId: string, appId: string, sessionId: string, p: string): Promise<boolean> {
  const all = wsSegments(sessionId, splitPath(p));
  const name = all.pop();
  if (!name) return false;
  let parent: string;
  try { parent = await resolveDir(userId, appId, all, false); } catch { return false; }
  const items: any[] = await cloudStorageService.listDirectory(parent, userId, appId);
  const file = items.find((i) => i.name === name && i.fileType === 'file');
  if (!file) return false;
  await cloudStorageService.deleteItem(file.id, userId);
  return true;
}

/** 物化一个技能到 <appId>/.agent/skills/<skillId>/SKILL.md（与云空间规范对应）。幂等（进程内缓存）。 */
export async function materializeSkill(
  userId: string,
  appId: string,
  skillId: string,
  content: string,
): Promise<void> {
  const cacheKey = `${userId}:${appId}:${skillId}:${sha256(Buffer.from(content, 'utf-8'))}`;
  if (materializedCache.has(cacheKey)) return; // 本进程已物化同内容，跳过
  const parent = await resolveDir(userId, appId, ['.agent', 'skills', skillId], true);
  const items: any[] = await cloudStorageService.listDirectory(parent, userId, appId);
  const existing = items.find((i) => i.name === 'SKILL.md' && i.fileType === 'file');
  if (existing) {
    await cloudStorageService.updateFileContent(existing.id, userId, content);
  } else {
    await cloudStorageService.uploadFile(userId, appId, parent, 'SKILL.md', Buffer.from(content, 'utf-8'), 'text/markdown', false);
  }
  materializedCache.add(cacheKey);
}
