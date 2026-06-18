/**
 * 本地 Normal Agent 注册表 —— 用户可自定义的对话型 agent（人格 = system prompt + 模型 + 工具 + 设置）。
 *
 * 单元：`~/.tangu/agents/<slug>.md`（YAML frontmatter + 正文人格），镜像 skills 的 SKILL.md 范式
 * （参考 hermes 的 SOUL.md / personalities）。用户经设置 UI / TUI slash 增改；Agent 经 manage_agent
 * 工具自创建（created_by=agent）。激活：写入会话 agent_config.agentSlug，agentLoop 解析后注入。
 * 仅 standalone/TUI/desktop（本地）形态；microserver/worker 不触本模块。mtime 缓存，改文件即时生效。
 */
import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { agentsDir } from '../core/tanguHome.js';

export type ThinkLevel = 'off' | 'low' | 'medium' | 'high' | '';
export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto' | '';

export interface NormalAgentDef {
  slug: string;
  name: string;
  description: string;
  /** 覆盖会话模型（''=不覆盖）。 */
  model: string;
  /** 启用的 custom/MCP 工具 id 白名单（[]=不限制，继承会话设置）。 */
  tools: string[];
  thinkingLevel: ThinkLevel;
  /** 最大循环轮数（null=用默认）。 */
  maxIterations: number | null;
  approvalMode: ApprovalMode;
  createdBy: 'user' | 'agent';
  createdAt: string;
  /** 正文 = 该 agent 的 system prompt / 人格。 */
  systemPrompt: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(name: string): string {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || 'agent';
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

const THINK: ThinkLevel[] = ['off', 'low', 'medium', 'high'];
const APPROVAL: ApprovalMode[] = ['readonly', 'auto-edit', 'full-auto'];

/** 解析 agent 文件（frontmatter 单行标量 + tools 列表 + 正文）。容错：缺字段回退默认。 */
export function parseAgentFile(slug: string, raw: string): NormalAgentDef {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta: Record<string, string> = {};
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      if (/^\s/.test(line)) continue;
      const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      meta[kv[1].toLowerCase()] = v;
    }
  }
  const toolsRaw = meta.tools || '';
  const tools = toolsRaw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  const thinking = (THINK.includes(meta.thinkinglevel as ThinkLevel) ? meta.thinkinglevel : '') as ThinkLevel;
  const approval = (APPROVAL.includes(meta.approvalmode as ApprovalMode) ? meta.approvalmode : '') as ApprovalMode;
  const maxIter = Number(meta.maxiterations);
  return {
    slug,
    name: meta.name || slug,
    description: meta.description || '',
    model: meta.model || '',
    tools,
    thinkingLevel: thinking,
    maxIterations: Number.isFinite(maxIter) && maxIter > 0 ? Math.min(200, Math.floor(maxIter)) : null,
    approvalMode: approval,
    createdBy: meta.created_by === 'agent' ? 'agent' : 'user',
    createdAt: meta.created_at || '',
    systemPrompt: body.trim(),
  };
}

/** 序列化为 <slug>.md 文件内容。 */
export function serializeAgent(def: NormalAgentDef): string {
  const esc = (s: string) => String(s ?? '').replace(/\r?\n/g, ' ').trim();
  const fm: string[] = ['---'];
  fm.push(`name: ${esc(def.name)}`);
  if (def.description) fm.push(`description: ${esc(def.description)}`);
  if (def.model) fm.push(`model: ${esc(def.model)}`);
  if (def.tools.length) fm.push(`tools: ${def.tools.map((t) => esc(t)).join(', ')}`);
  if (def.thinkingLevel) fm.push(`thinkingLevel: ${def.thinkingLevel}`);
  if (def.maxIterations != null) fm.push(`maxIterations: ${def.maxIterations}`);
  if (def.approvalMode) fm.push(`approvalMode: ${def.approvalMode}`);
  fm.push(`created_by: ${def.createdBy}`);
  fm.push(`created_at: ${def.createdAt || new Date().toISOString()}`);
  fm.push('---', '');
  return fm.join('\n') + (def.systemPrompt || '').trim() + '\n';
}

// ── mtime 缓存（目录浅扫，*.md 的 mtime 指纹）──
interface CacheEntry { stamp: string; defs: NormalAgentDef[] }
let cache: CacheEntry | null = null;

async function dirStamp(dir: string): Promise<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 'missing';
  }
  const parts: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    try {
      const st = await fs.stat(path.join(dir, e.name));
      parts.push(`${e.name}:${st.mtimeMs}`);
    } catch { /* ignore */ }
  }
  return parts.sort().join('|');
}

export async function listAgents(): Promise<NormalAgentDef[]> {
  const dir = agentsDir();
  const stamp = await dirStamp(dir);
  if (cache && cache.stamp === stamp) return cache.defs;
  const defs: NormalAgentDef[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    cache = { stamp, defs };
    return defs;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const slug = e.name.slice(0, -3);
    if (!isValidSlug(slug)) continue;
    try {
      defs.push(parseAgentFile(slug, await fs.readFile(path.join(dir, e.name), 'utf-8')));
    } catch { /* 跳过坏文件 */ }
  }
  defs.sort((a, b) => a.name.localeCompare(b.name));
  cache = { stamp, defs };
  return defs;
}

export async function getAgent(slug: string): Promise<NormalAgentDef | null> {
  if (!slug || !isValidSlug(slug)) return null;
  try {
    const raw = await fs.readFile(path.join(agentsDir(), `${slug}.md`), 'utf-8');
    return parseAgentFile(slug, raw);
  } catch {
    return null;
  }
}

export interface SaveAgentInput {
  slug?: string;
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  thinkingLevel?: ThinkLevel;
  maxIterations?: number | null;
  approvalMode?: ApprovalMode;
  systemPrompt: string;
  createdBy?: 'user' | 'agent';
}

/** 新建/更新一个 agent 定义（落盘 <slug>.md）。slug 缺省由 name 派生；保留已有 createdAt/createdBy。 */
export async function saveAgent(input: SaveAgentInput): Promise<NormalAgentDef> {
  const slug = input.slug && isValidSlug(input.slug) ? input.slug : slugify(input.name);
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  if (!input.name?.trim()) throw new Error('name required');
  if (!input.systemPrompt?.trim()) throw new Error('systemPrompt required');
  const existing = await getAgent(slug);
  const def: NormalAgentDef = {
    slug,
    name: input.name.trim().slice(0, 120),
    description: (input.description || '').trim().slice(0, 300),
    model: (input.model || '').trim(),
    tools: Array.isArray(input.tools) ? input.tools.filter((t) => typeof t === 'string' && t.trim()).slice(0, 100) : [],
    thinkingLevel: THINK.includes(input.thinkingLevel as ThinkLevel) ? (input.thinkingLevel as ThinkLevel) : '',
    maxIterations:
      input.maxIterations != null && Number.isFinite(input.maxIterations) && input.maxIterations > 0
        ? Math.min(200, Math.floor(input.maxIterations))
        : null,
    approvalMode: APPROVAL.includes(input.approvalMode as ApprovalMode) ? (input.approvalMode as ApprovalMode) : '',
    createdBy: existing?.createdBy || input.createdBy || 'user',
    createdAt: existing?.createdAt || new Date().toISOString(),
    systemPrompt: input.systemPrompt.trim().slice(0, 100_000),
  };
  const dir = agentsDir();
  mkdirSync(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${slug}.md`), serializeAgent(def), 'utf-8');
  cache = null; // 失效缓存
  return def;
}

export async function deleteAgent(slug: string): Promise<boolean> {
  if (!isValidSlug(slug)) return false;
  try {
    await fs.unlink(path.join(agentsDir(), `${slug}.md`));
    cache = null;
    return true;
  } catch {
    return false;
  }
}
