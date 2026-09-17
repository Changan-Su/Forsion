/**
 * 云端多租户(hostExec=false)的 per-user Normal Agents 存储。
 * 底座 = brain.agentFiles seam(服务端 tangu_agent_files 表,键 user_id+slug+rel_path);文件形状与本地
 * 文件夹版完全一致(config.toml + SOUL.md + Library/avatar.*、哨兵 __meta__/.meta.json),桌面
 * agentFileSync 双向可见。合并/解析全部复用 agentRegistry 的纯函数(buildAgentDef/parse/serialize),
 * 与本地一份语义。仅 routes/agents.ts 的云端分支使用;run 侧水合是既有另一条链路
 * (agentActivation → brain.agents.getAgent),本模块不参与。
 */
import { deps } from '../seams/runtime.js';
import type { AgentFilesBrain } from '../seams/cloudBrain.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import {
  DEFAULT_AGENTS, builtinAgentDef, buildAgentDef, parseAgentConfig, serializeAgentConfig, isValidSlug,
  AVATAR_MIME_EXT, AVATAR_EXT_MIME, AVATAR_MAX_BYTES,
  isRetiredBuiltin, normalizeAgentsMeta, sortAgentDefs, upgradeAriosoPersona,
  type NormalAgentDef, type SaveAgentInput, type AgentsMeta,
} from './agentRegistry.js';
import { builtinAgentAvatar } from './builtinAvatars.js';

/** 云端 agents 可用 = 非 host-exec profile 且注入了 agentFiles seam(旧云端/未注入 → 路由回落 404)。 */
export function cloudAgentsEnabled(): boolean {
  const d = deps();
  return !d.profile.capabilities.hostExec && !!d.brain.agentFiles;
}

const files = (): AgentFilesBrain => deps().brain.agentFiles!;
const DEVICE_ID = 'cloud-api';

const putText = (userId: string, slug: string, relPath: string, content: string): Promise<{ mtimeMs: number }> =>
  files().putFile(userId, slug, relPath, {
    content, isBinary: false, size: Buffer.byteLength(content, 'utf8'), mtimeMs: Date.now(), deviceId: DEVICE_ID,
  });

async function readText(userId: string, slug: string, relPath: string): Promise<string | null> {
  const f = await files().getFile(userId, slug, relPath).catch(() => null);
  return f && !f.deleted && !f.isBinary && f.content != null ? f.content : null;
}

/** 云端读一个 agent。文件未命中(从未存在或已墓碑)→ **内置预设兜底**(纯内存虚拟 def):
 *  Picker 选虚拟预设后 PATCH/头像的「读现有」由此命中,显式编辑才物化落库
 *  ——绝不因为「看了一眼列表」就往用户的 Forsion AI Brain 写数据。 */
export async function cloudGetAgent(userId: string, slug: string): Promise<NormalAgentDef | null> {
  if (!slug || !isValidSlug(slug)) return null;
  const cfg = await readText(userId, slug, 'config.toml');
  if (cfg == null) return builtinAgentDef(slug);
  const soul = (await readText(userId, slug, 'SOUL.md')) ?? '';
  try {
    return upgradeAriosoPersona(parseAgentConfig(slug, cfg, soul));
  } catch {
    return null;
  }
}

/** manifest 按 config.toml 分桶:live=未墓碑(真实存在),tombstoned=墓碑过(用户删过 → 虚拟预设不复活)。
 *  哨兵 __user__/__meta__ 排除。 */
async function slugStates(userId: string): Promise<{ live: Set<string>; tombstoned: Set<string> }> {
  const manifest = await files().getManifest(userId);
  const live = new Set<string>();
  const tombstoned = new Set<string>();
  for (const a of manifest) {
    if (a.slug.startsWith('__') || !isValidSlug(a.slug)) continue;
    const cfg = a.files.find((f) => f.relPath === 'config.toml');
    if (!cfg) continue;
    (cfg.deleted ? tombstoned : live).add(a.slug);
  }
  return { live, tombstoned };
}

export async function cloudListAgents(userId: string): Promise<NormalAgentDef[]> {
  const { live, tombstoned } = await slugStates(userId);
  const defs: NormalAgentDef[] = [];
  for (const slug of live) {
    const d = await cloudGetAgent(userId, slug);
    if (d) defs.push(d);
  }
  // 缺席且没被删过的内置预设 → 合成虚拟条目(零落库;run 侧有同源 builtinAgentDef 兜底,人格照常生效)。
  for (const a of DEFAULT_AGENTS) {
    if (live.has(a.slug) || tombstoned.has(a.slug)) continue;
    const d = builtinAgentDef(a.slug);
    if (d) defs.push(d);
  }
  const meta = await cloudReadAgentsMeta(userId);
  return sortAgentDefs(defs.filter((a) => !isRetiredBuiltin(a)), meta.order);
}

export async function cloudSaveAgent(userId: string, slug: string, input: SaveAgentInput): Promise<NormalAgentDef> {
  const existing = await cloudGetAgent(userId, slug);
  const def = buildAgentDef(slug, existing, input);
  await putText(userId, slug, 'config.toml', serializeAgentConfig(def));
  await putText(userId, slug, 'SOUL.md', def.soul || '');
  return def;
}

/** 墓碑该 agent 的全部文件(含 MEMORY/LOG/Library)。默认 agent 禁删,与本地一致;muse 的
 *  「启用中禁删」是本地 special 配置语义,云端不适用。 */
export async function cloudDeleteAgent(userId: string, slug: string): Promise<boolean> {
  if (!isValidSlug(slug) || slug === DEFAULT_AGENT_SLUG) return false;
  const manifest = await files().getManifest(userId);
  const entry = manifest.find((a) => a.slug === slug);
  const t = Date.now();
  if (entry) {
    for (const f of entry.files) {
      if (f.deleted) continue;
      await files().deleteFile(userId, slug, f.relPath, t, DEVICE_ID).catch(() => { /* 单文件失败不中断 */ });
    }
    return true;
  }
  // 从未物化的虚拟预设:也要「删得掉」——落一个 config.toml 墓碑(deleteFile 对不存在行是 upsert),
  // 列表按 tombstoned 不再合成;Brain 数据页按「有未墓碑文件才显示」滤掉孤儿墓碑,不会出现空壳。
  if (DEFAULT_AGENTS.some((a) => a.slug === slug)) {
    await files().deleteFile(userId, slug, 'config.toml', t, DEVICE_ID).catch(() => { /* ignore */ });
  }
  return true;
}

// ── 头像:Library/avatar.<ext> + config.avatar 引用,校验规则与本地 saveAgentAvatar 一致 ──

/** 全字段回填的 profile 更新(buildAgentDef 对 description 等字段不保留 existing → 必须显式全传,本地同款)。 */
const fullInput = (cur: NormalAgentDef, patch: Partial<SaveAgentInput>): SaveAgentInput => ({
  slug: cur.slug, name: cur.name, description: cur.description, model: cur.model, tools: cur.tools,
  thinkingLevel: cur.thinkingLevel, maxIterations: cur.maxIterations, approvalMode: cur.approvalMode,
  systemPrompt: cur.systemPrompt, soul: cur.soul, avatar: cur.avatar, createdBy: cur.createdBy,
  ...patch,
});

export async function cloudSaveAgentAvatar(userId: string, slug: string, base64: string, mimeType: string): Promise<string> {
  const ext = AVATAR_MIME_EXT[String(mimeType).toLowerCase()];
  if (!ext) throw new Error('unsupported image type (png/jpeg/gif/webp only)');
  const raw = base64.includes(',') && base64.trimStart().startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('empty image');
  if (buf.length > AVATAR_MAX_BYTES) throw new Error('image too large (max 1MB)');
  const cur = await cloudGetAgent(userId, slug);
  if (!cur) throw new Error('agent not found');
  const filename = `avatar.${ext}`;
  if (cur.avatar && cur.avatar !== filename) {
    // 旧头像扩展名不同 → 墓碑,避免 avatar.png / avatar.webp 堆积
    await files().deleteFile(userId, slug, cur.avatar.includes('/') ? cur.avatar : `Library/${cur.avatar}`, Date.now(), DEVICE_ID).catch(() => { /* ignore */ });
  }
  await files().putFile(userId, slug, `Library/${filename}`, {
    contentBase64: buf.toString('base64'), isBinary: true, size: buf.length, mtimeMs: Date.now(), deviceId: DEVICE_ID,
  });
  await cloudSaveAgent(userId, slug, fullInput(cur, { avatar: filename }));
  return filename;
}

export async function cloudReadAgentAvatar(userId: string, slug: string): Promise<{ data: Buffer; mimeType: string } | null> {
  const cur = await cloudGetAgent(userId, slug);
  if (!cur?.avatar) return null;
  const rel = cur.avatar.includes('/') ? cur.avatar : `Library/${cur.avatar}`;
  const f = await files().getFile(userId, slug, rel).catch(() => null);
  // 虚拟内置头像零落库;显式删除后的墓碑或空 avatar 不回退。
  if (!f && cur.avatar === 'avatar.jpg') return builtinAgentAvatar(slug);
  if (!f || f.deleted || !f.isBinary || !f.contentBase64) return null;
  const ext = (cur.avatar.split('.').pop() || '').toLowerCase();
  return { data: Buffer.from(f.contentBase64, 'base64'), mimeType: AVATAR_EXT_MIME[ext] || 'application/octet-stream' };
}

export async function cloudDeleteAgentAvatar(userId: string, slug: string): Promise<boolean> {
  const cur = await cloudGetAgent(userId, slug);
  if (!cur) throw new Error('agent not found');
  if (cur.avatar) {
    await files().deleteFile(userId, slug, cur.avatar.includes('/') ? cur.avatar : `Library/${cur.avatar}`, Date.now(), DEVICE_ID).catch(() => { /* ignore */ });
  }
  await cloudSaveAgent(userId, slug, fullInput(cur, { avatar: '' }));
  return true;
}

// ── 全局 meta(列表顺序 + 默认 agent):哨兵 __meta__/.meta.json。桌面 agentFileSync 同步同一份
//   → defaultSlug / 顺序跨端共享,LWW 由 putFile 的 mtimeMs 守卫。──

export async function cloudReadAgentsMeta(userId: string): Promise<AgentsMeta> {
  try {
    const raw = await readText(userId, '__meta__', '.meta.json');
    if (raw == null) return { order: [], defaultSlug: DEFAULT_AGENT_SLUG };
    const m = JSON.parse(raw);
    return normalizeAgentsMeta(m);
  } catch {
    return { order: [], defaultSlug: DEFAULT_AGENT_SLUG };
  }
}

export async function cloudWriteAgentsMeta(userId: string, patch: Partial<AgentsMeta>): Promise<AgentsMeta> {
  const cur = await cloudReadAgentsMeta(userId);
  const next = normalizeAgentsMeta({
    order: Array.isArray(patch.order) ? patch.order.filter((s) => typeof s === 'string' && isValidSlug(s)) : cur.order,
    defaultSlug: patch.defaultSlug != null && isValidSlug(patch.defaultSlug) ? patch.defaultSlug : cur.defaultSlug,
  });
  await putText(userId, '__meta__', '.meta.json', JSON.stringify(next, null, 2));
  return next;
}
