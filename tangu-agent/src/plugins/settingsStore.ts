/**
 * 插件设置/数据存储。
 *   全局:   ~/.tangu/plugins-config/<id>/{settings.json, files/<name>}
 *   按 agent: ~/.tangu/agents/<slug>/plugins/{<id>.json, <id>-files/<name>}
 * 启用状态 = 全局 settings.json 的 `__enabled`。读取值时用 schema default 兜底。
 * 运行时解析作用域:标量 全局 ⊕ 按 agent(agent 覆盖);image-list「该 agent 有非空则整组用其,否则全局」。
 * 同步缓存(sync 读供工具门禁 / wechatRemote);写后更新缓存(单进程)。
 */
import { promises as fsp } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tanguHome, agentsDir } from '../core/tanguHome.js';
import { getRawSection, saveSection } from '../core/config.js';
import { getPluginMeta } from './registry.js';

export type Scope = 'global' | { agentSlug: string };

const ENABLED_KEY = '__enabled';
const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};

function sanitizeId(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('invalid plugin id');
  return id;
}
function sanitizeFileName(n: string): string {
  const s = String(n || '').trim();
  if (!s || s.length > 200 || s.includes('/') || s.includes('\\') || s.includes('\0') || s.includes('..') || path.basename(s) !== s) {
    throw new Error('invalid file name');
  }
  return s;
}
function sanitizeSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error('invalid slug');
  return slug;
}
const extOf = (n: string): string => (n.split('.').pop() || '').toLowerCase();

function settingsFileOf(id: string, scope: Scope): string {
  sanitizeId(id);
  return scope === 'global'
    ? path.join(tanguHome(), 'plugins-config', id, 'settings.json')
    : path.join(agentsDir(), sanitizeSlug(scope.agentSlug), 'plugins', `${id}.json`);
}
function filesDirOf(id: string, scope: Scope): string {
  sanitizeId(id);
  return scope === 'global'
    ? path.join(tanguHome(), 'plugins-config', id, 'files')
    : path.join(agentsDir(), sanitizeSlug(scope.agentSlug), 'plugins', `${id}-files`);
}
function cacheKey(id: string, scope: Scope): string {
  return scope === 'global' ? id : `${id}:${scope.agentSlug}`;
}

const cache = new Map<string, Record<string, any>>();

// 全局插件设置(含 __enabled)→ config.json 的 plugins.global[id](唯一真源);per-agent 留 agent 文件夹。
// 惰性迁移:某 id 未入 config → 回落 legacy ~/.tangu/plugins-config/<id>/settings.json,写时落 config。
function readRaw(id: string, scope: Scope): Record<string, any> {
  const k = cacheKey(id, scope);
  const c = cache.get(k);
  if (c) return c;
  let obj: Record<string, any> = {};
  if (scope === 'global') {
    const fromCfg = getRawSection('plugins')?.global?.[id];
    if (fromCfg && typeof fromCfg === 'object') obj = fromCfg;
    else { try { obj = JSON.parse(readFileSync(settingsFileOf(id, 'global'), 'utf8')) || {}; } catch { obj = {}; } }
  } else {
    try { obj = JSON.parse(readFileSync(settingsFileOf(id, scope), 'utf8')) || {}; } catch { obj = {}; }
  }
  cache.set(k, obj);
  return obj;
}
async function writeRaw(id: string, scope: Scope, obj: Record<string, any>): Promise<void> {
  if (scope === 'global') {
    const sec = (getRawSection('plugins') as any) || {};
    saveSection('plugins', { ...sec, global: { ...(sec.global || {}), [id]: obj } });
    cache.set(cacheKey(id, scope), obj);
    return;
  }
  const f = settingsFileOf(id, scope);
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, JSON.stringify(obj, null, 2), 'utf8');
  cache.set(cacheKey(id, scope), obj);
}

function schemaDefaults(id: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of getPluginMeta(id)?.settings?.fields || []) {
    if (f.type === 'image-list') out[f.key] = [];
    else if ((f as any).default !== undefined) out[f.key] = (f as any).default;
  }
  return out;
}
function stripMeta(o: Record<string, any>): Record<string, any> {
  const { [ENABLED_KEY]: _omit, ...rest } = o;
  return rest;
}

// ── 启用(全局)──
export function isPluginEnabledSync(id: string): boolean {
  const g = readRaw(id, 'global');
  return ENABLED_KEY in g ? !!g[ENABLED_KEY] : !!getPluginMeta(id)?.defaultEnabled;
}
export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await writeRaw(id, 'global', { ...readRaw(id, 'global'), [ENABLED_KEY]: !!enabled });
}

// ── 单作用域设置(供面板读写;含 default 兜底)──
export function getScopeSettings(id: string, scope: Scope): Record<string, any> {
  return { ...schemaDefaults(id), ...stripMeta(readRaw(id, scope)) };
}
export async function setScopeSettings(id: string, scope: Scope, patch: Record<string, any>): Promise<Record<string, any>> {
  await writeRaw(id, scope, { ...readRaw(id, scope), ...patch });
  return getScopeSettings(id, scope);
}

// ── 运行时解析(全局 ⊕ 按 agent)──
export function getPluginSettingsSync(id: string, opts?: { agentSlug?: string }): Record<string, any> {
  let merged = { ...schemaDefaults(id), ...stripMeta(readRaw(id, 'global')) };
  if (opts?.agentSlug) {
    const ag = stripMeta(readRaw(id, { agentSlug: opts.agentSlug }));
    for (const f of getPluginMeta(id)?.settings?.fields || []) {
      if (!(f.key in ag)) continue;
      if (f.type === 'image-list') { if (Array.isArray(ag[f.key]) && ag[f.key].length) merged[f.key] = ag[f.key]; }
      else merged[f.key] = ag[f.key];
    }
  }
  return merged;
}
/** image-list 数据落在哪个作用域(用于读对应 blob)。该 agent 有非空 → agent,否则 global。 */
export function resolveImageListScope(id: string, field: string, agentSlug?: string): Scope {
  if (agentSlug) {
    const ag = readRaw(id, { agentSlug });
    if (Array.isArray(ag[field]) && ag[field].length) return { agentSlug };
  }
  return 'global';
}

// ── blob(image-list 图片)──
export interface PluginFileMeta { name: string; size: number; mimeType: string }
export async function listPluginFiles(id: string, scope: Scope): Promise<PluginFileMeta[]> {
  const dir = filesDirOf(id, scope);
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out: PluginFileMeta[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile()) out.push({ name, size: st.size, mimeType: MIME_BY_EXT[extOf(name)] || 'application/octet-stream' });
    } catch { /* ignore */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
export async function readPluginFile(id: string, scope: Scope, name: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const safe = sanitizeFileName(name);
  try {
    return { buffer: await fsp.readFile(path.join(filesDirOf(id, scope), safe)), mimeType: MIME_BY_EXT[extOf(safe)] || 'application/octet-stream' };
  } catch { return null; }
}
export async function writePluginFile(id: string, scope: Scope, name: string, buf: Buffer): Promise<string> {
  const safe = sanitizeFileName(name);
  if (!buf?.length) throw new Error('empty file');
  if (buf.length > MAX_BLOB_BYTES) throw new Error('file too large (max 5MB)');
  const dir = filesDirOf(id, scope);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, safe), buf);
  return safe;
}
export async function deletePluginFile(id: string, scope: Scope, name: string): Promise<void> {
  await fsp.rm(path.join(filesDirOf(id, scope), sanitizeFileName(name)), { force: true });
}

/** 路由层解析 ?scope=global|agent:<slug> → Scope。 */
export function parseScope(raw: string | undefined): Scope {
  const s = String(raw || 'global');
  if (s === 'global' || s === '') return 'global';
  if (s.startsWith('agent:')) return { agentSlug: sanitizeSlug(s.slice('agent:'.length)) };
  throw new Error('invalid scope');
}
