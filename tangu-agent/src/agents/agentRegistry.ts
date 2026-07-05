/**
 * 本地 Normal Agent 注册表 —— 用户可自定义的对话型 agent(人格 = SOUL.md + config.toml 开发指令 + 模型 + 工具)。
 *
 * 单元:`~/.tangu/agents/<slug>/`(文件夹)——
 *   config.toml   codex 风参数 + developer_instructions(该 agent 做什么/怎么做/必读什么)
 *   SOUL.md       人格设定(Hermes 风)
 *   MEMORY.md     该 agent 自己的长期记忆(记忆层维护,见 localMemoryBrain)
 *   LOG/<date>.md 该 agent 的按日日志
 *   Library/      参考资料(按 config.toml library_order 约束阅读顺序)
 *
 * 用户经设置 UI / TUI / 直接编辑文件增改;Agent 经 manage_agent 自创建(created_by=agent)。激活:
 * 写会话 agent_config.agentSlug,agentLoop 解析后注入并把 slug 穿透到记忆层。仅本地形态;
 * microserver/worker 不触本模块。mtime 缓存(config.toml + SOUL.md),改文件即时生效。
 * 旧扁平 <slug>.md 首次访问时惰性迁移成文件夹(原文件留 .bak)。
 */
import { promises as fs } from 'node:fs';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { agentsDir, memoryDir, userMdFile, DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { DEFAULT_AGENT_AVATAR_B64, DEFAULT_AGENT_AVATAR_MIME } from './defaultAvatar.js';
import { loadSpecialAgentsConfig, DEFAULT_MUSE_PROMPT } from '../services/specialAgentsConfig.js';

export type ThinkLevel = 'off' | 'low' | 'medium' | 'high' | '';
export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto' | '';

export interface NormalAgentDef {
  slug: string;
  name: string;
  /** 版本号(来自 config.toml version,缺省 1.0.0);市场「可更新」检查用。 */
  version: string;
  description: string;
  /** 覆盖会话模型（''=不覆盖）。 */
  model: string;
  /** 启用的 custom/MCP 工具 id 白名单（[]=不限制，继承会话设置）。 */
  tools: string[];
  thinkingLevel: ThinkLevel;
  /** 最大循环轮数（null=用默认）。 */
  maxIterations: number | null;
  approvalMode: ApprovalMode;
  /** system = 内置系统 agent(如 Muse):UI 显示「后台」徽章,启用期间禁删。 */
  createdBy: 'user' | 'agent' | 'system';
  createdAt: string;
  /** developer_instructions —— 该 agent 的开发指令 / system prompt 主体(来自 config.toml)。 */
  systemPrompt: string;
  /** 人格设定正文(来自 SOUL.md)。 */
  soul?: string;
  /** Library 阅读优先级顺序(文件名列表,来自 config.toml library_order)。 */
  libraryOrder?: string[];
  /** 头像文件名(位于该 agent 的 Library/ 下,来自 config.toml avatar)。 */
  avatar?: string;
  /** 共用默认 Agent 的记忆/日志:true=记忆/日志读写默认 agent 文件夹;默认/false=该 agent 有专属。 */
  shareDefaultMemory?: boolean;
  /** 开启云同步:该 agent 的全部文件(定义/记忆/日志/Library)跨设备完全镜像(newest-wins);默认/false=纯本地。 */
  cloudSync?: boolean;
  /** 该 agent 支持/出现于哪些 app(小写,如 ["echo"]);空=不限制(由调用方默认)。来自 config.toml apps。 */
  apps?: string[];
}

/** 记忆/日志作用域 slug:共用默认 → DEFAULT_AGENT_SLUG;否则该 agent 自己。 */
export function resolveMemorySlug(def: NormalAgentDef): string {
  return def.shareDefaultMemory ? DEFAULT_AGENT_SLUG : def.slug;
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

/** 解析旧扁平 agent 文件（frontmatter 单行标量 + tools 列表 + 正文)。容错:缺字段回退默认。迁移源。 */
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
    version: meta.version || '1.0.0',
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

/** 序列化为旧扁平 <slug>.md 文件内容(保留供测试/兼容;现役落盘走 config.toml)。 */
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

// ── TOML 文件夹格式(config.toml + SOUL.md;codex 风键)──

/** 解析 config.toml + SOUL.md 正文 → NormalAgentDef。容错:解析失败/缺字段回退默认。 */
export function parseAgentConfig(slug: string, tomlRaw: string, soul: string): NormalAgentDef {
  let meta: Record<string, any> = {};
  try { meta = (parseToml(tomlRaw) as Record<string, any>) || {}; } catch { meta = {}; }
  const str = (v: any): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const tools = Array.isArray(meta.tools)
    ? meta.tools.filter((t: any) => typeof t === 'string' && t.trim()).slice(0, 100)
    : [];
  const libraryOrder = Array.isArray(meta.library_order)
    ? meta.library_order.filter((t: any) => typeof t === 'string' && t.trim())
    : [];
  const apps = Array.isArray(meta.apps)
    ? meta.apps.filter((t: any) => typeof t === 'string' && t.trim()).map((t: string) => t.trim().toLowerCase())
    : [];
  const effort = str(meta.model_reasoning_effort);
  const think = (THINK.includes(effort as ThinkLevel) ? effort : '') as ThinkLevel;
  const appr = str(meta.approval_mode);
  const approval = (APPROVAL.includes(appr as ApprovalMode) ? appr : '') as ApprovalMode;
  const maxIter = Number(meta.max_iterations);
  return {
    slug,
    name: str(meta.name) || slug,
    version: str(meta.version) || '1.0.0', // 市场「可更新」检查用;缺省 1.0.0
    description: str(meta.description),
    model: str(meta.model),
    tools,
    thinkingLevel: think,
    maxIterations: Number.isFinite(maxIter) && maxIter > 0 ? Math.min(200, Math.floor(maxIter)) : null,
    approvalMode: approval,
    createdBy: meta.created_by === 'agent' ? 'agent' : meta.created_by === 'system' ? 'system' : 'user',
    createdAt: str(meta.created_at),
    systemPrompt: str(meta.developer_instructions).trim(),
    soul: soul.trim(),
    libraryOrder,
    avatar: str(meta.avatar) || undefined,
    shareDefaultMemory: !!meta.share_default_memory,
    cloudSync: !!meta.cloud_sync,
    apps,
  };
}

/** 读 <dir>/config.toml + <dir>/SOUL.md 组装 def。 */
export async function parseAgentFolder(slug: string, dir: string): Promise<NormalAgentDef> {
  const tomlRaw = await fs.readFile(path.join(dir, 'config.toml'), 'utf-8').catch(() => '');
  const soul = await fs.readFile(path.join(dir, 'SOUL.md'), 'utf-8').catch(() => '');
  return parseAgentConfig(slug, tomlRaw, soul);
}

/** 序列化 def 为 config.toml 内容(SOUL/MEMORY/LOG/Library 不在此,各自单独落盘)。 */
export function serializeAgentConfig(def: NormalAgentDef): string {
  const obj: Record<string, unknown> = { name: def.name };
  if (def.version) obj.version = def.version;
  if (def.description) obj.description = def.description;
  if (def.model) obj.model = def.model;
  if (def.thinkingLevel) obj.model_reasoning_effort = def.thinkingLevel;
  if (def.approvalMode) obj.approval_mode = def.approvalMode;
  if (def.maxIterations != null) obj.max_iterations = def.maxIterations;
  if (def.tools.length) obj.tools = def.tools;
  if (def.libraryOrder && def.libraryOrder.length) obj.library_order = def.libraryOrder;
  if (def.apps && def.apps.length) obj.apps = def.apps;
  if (def.avatar) obj.avatar = def.avatar;
  if (def.shareDefaultMemory) obj.share_default_memory = true;
  if (def.cloudSync) obj.cloud_sync = true;
  obj.created_by = def.createdBy;
  obj.created_at = def.createdAt || new Date().toISOString();
  const di = def.systemPrompt || '';
  // developer_instructions 常多行:用 TOML 多行字面串(''')——用户手编 config.toml 时可原样换行、无需转义,
  // 避免「在基本串 "..." 里直接敲回车 → 非法 TOML → 整个 agent 解析失败」。仅当含 ''' 或以 ' 结尾(破坏闭合)
  // 时回退 smol-toml 的转义单行串。'''\n 后的首换行被 TOML 裁掉,故内容原样保真。
  if (di.includes('\n') && !di.includes("'''") && !di.endsWith("'")) {
    return stringifyToml(obj) + `developer_instructions = '''\n${di}'''\n`;
  }
  obj.developer_instructions = di;
  return stringifyToml(obj);
}

// ── mtime 缓存(各 agent 子目录的 config.toml + SOUL.md 指纹)──
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
    if (e.isDirectory()) {
      if (!isValidSlug(e.name)) continue;
      for (const f of ['config.toml', 'SOUL.md']) {
        try {
          const st = await fs.stat(path.join(dir, e.name, f));
          parts.push(`${e.name}/${f}:${st.mtimeMs}`);
        } catch { /* ignore */ }
      }
    } else if (e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('.md.bak')) {
      // 遗留扁平 agent(迁移前):纳入指纹,改了即时反映。
      try {
        const st = await fs.stat(path.join(dir, e.name));
        parts.push(`${e.name}:${st.mtimeMs}`);
      } catch { /* ignore */ }
    } else if (e.isFile() && e.name === '.meta.json') {
      // 顺序 / 默认 agent 变更也要让列表缓存失效。
      try {
        const st = await fs.stat(path.join(dir, e.name));
        parts.push(`.meta:${st.mtimeMs}`);
      } catch { /* ignore */ }
    }
  }
  return parts.sort().join('|');
}

/** 内置默认 Normal Agent 预设。xyra = 默认 agent(承载迁移自旧全局记忆/日志)。 */
export const DEFAULT_AGENTS: Array<Pick<NormalAgentDef, 'slug' | 'name' | 'description' | 'systemPrompt'> & Partial<NormalAgentDef>> = [
  {
    slug: DEFAULT_AGENT_SLUG,
    name: 'Tangu Arioso',
    description: 'Tangu 默认助手,承载你的长期记忆与日志',
    thinkingLevel: 'low',
    systemPrompt:
      "You are Tangu Arioso — the user's default AI assistant. Reliable, restrained, and pragmatic: answer accurately and clearly, think through multi-step tasks before acting, " +
      'and state uncertainty honestly rather than making things up. You have your own long-term memory and logs: use remember to record user facts/preferences worth keeping long-term, ' +
      "and use log_event to record completed work/conclusions in the current day's log.",
    soul:
      '# Tangu Arioso\n\nCalm, focused, and warm. Like a long-term companion assistant: remembers the user\'s preferences and history, and thinks things through before acting.\n' +
      "Speaks concisely without rambling; when uncertain, says so honestly without fabricating; respects the user's time and replies in the user's language by default.",
  },
  {
    slug: 'general-assistant',
    name: '通用助手',
    description: '严谨可靠的全能助手,适合日常问答与多步任务',
    thinkingLevel: 'low',
    systemPrompt:
      'You are a helpful, rigorous, and reliable general-purpose assistant. Strive for accurate, clear, well-organized answers; state uncertainty honestly rather than making things up. ' +
      "For multi-step tasks, briefly outline your approach before acting, and verify with tools when needed. Reply in the user's language by default.",
  },
  {
    slug: 'code-reviewer',
    name: '代码审查员',
    description: '专注质量、安全与可维护性的代码审查',
    thinkingLevel: 'medium',
    systemPrompt:
      'You are a senior code reviewer. When reviewing code, focus on: correctness and edge cases, security vulnerabilities, concurrency and performance, readability and naming, ' +
      'and error handling and test coverage. Give concrete, actionable changes graded as "Critical / Suggestion / Nit", and explain why; understand the context and existing style before commenting. ' +
      'Do not speculate, do not give empty praise — point things out only when there is a real issue.',
  },
  {
    slug: 'writing-polish',
    name: '写作润色',
    description: '把文字改得清晰、流畅、有力,保留原意与语气',
    thinkingLevel: 'low',
    systemPrompt:
      "You are a writing editor. Your task is to make the text clearer, smoother, and more persuasive while preserving the author's original meaning and tone: " +
      'cut redundancy, tighten logic, unify terminology, and fix grammatical errors. Unless asked, do not change facts or opinions; provide the revised version, and you may append one or two notes on the key changes.',
  },
];

/** 写一个默认 agent 的骨架(目录 + Library/ + 缺失的 config.toml / SOUL.md);幂等,不覆盖已有文件。
 *  不建 MEMORY.md / LOG/(由记忆层按需建——提前建空 MEMORY.md 会让 migrateGlobalMemoryToXyra 误判已迁移)。 */
async function writeAgentScaffold(a: (typeof DEFAULT_AGENTS)[number]): Promise<void> {
  const adir = path.join(agentsDir(), a.slug);
  mkdirSync(path.join(adir, 'Library'), { recursive: true }); // 建 agent 目录 + Library(头像/资料)
  if (!existsSync(path.join(adir, 'config.toml'))) {
    const def: NormalAgentDef = {
      slug: a.slug, name: a.name, version: '1.0.0', description: a.description || '', model: a.model || '',
      tools: a.tools || [], thinkingLevel: a.thinkingLevel || '', maxIterations: a.maxIterations ?? null,
      approvalMode: a.approvalMode || '', createdBy: a.createdBy || 'user', createdAt: new Date().toISOString(),
      systemPrompt: a.systemPrompt, soul: a.soul || '', libraryOrder: [],
    };
    await fs.writeFile(path.join(adir, 'config.toml'), serializeAgentConfig(def), 'utf-8');
  }
  if (!existsSync(path.join(adir, 'SOUL.md'))) {
    await fs.writeFile(path.join(adir, 'SOUL.md'), a.soul || '', 'utf-8');
  }
}

// ── Muse 系统 agent(Special Agent 的文件夹化身份;由 muse supervisor 按需播种/自愈)──

export const MUSE_AGENT_SLUG = 'muse';

/** Muse 的内置骨架。人格/指令英文(硬编码模型提示纪律);每周期的动态上下文(预算/用户记忆快照/
 *  活动摘要)由 muse.ts 注入 kickoff 消息,不在此处。 */
const MUSE_AGENT_PRESET: (typeof DEFAULT_AGENTS)[number] = {
  slug: MUSE_AGENT_SLUG,
  name: 'Muse',
  description: '后台缪斯:持续观察你的活动,主动发现值得做的事(经 Muse TODO 提交)',
  createdBy: 'system',
  systemPrompt: DEFAULT_MUSE_PROMPT,
  soul:
    '# Muse\n\nA quiet observer with a spark of initiative. Muse watches the flow of the user\'s work and life from the background, ' +
    'connects scattered threads across conversations and files, and surfaces the few things genuinely worth doing next.\n' +
    'Curious but restrained: proposes only what is actionable and valuable now, learns from what the user accepts or dismisses, ' +
    'and would rather stay silent than waste the user\'s attention.',
};

/**
 * 确保 Muse 系统 agent 文件夹存在(幂等,绝不覆盖已有文件——用户对 SOUL/指令的修改被尊重)。
 * legacyPrompt = 旧 specialAgents.muse.prompt 自定义值,仅首次创建时一次性迁移为 developer_instructions。
 */
export async function ensureMuseAgent(legacyPrompt?: string): Promise<void> {
  if (existsSync(path.join(agentsDir(), MUSE_AGENT_SLUG, 'config.toml'))) return;
  const preset = { ...MUSE_AGENT_PRESET };
  if (legacyPrompt && legacyPrompt.trim()) preset.systemPrompt = legacyPrompt.trim();
  await writeAgentScaffold(preset);
  cache = null;
}

/** 默认 agent 显式删头像的标记:存在则 ensureXyraDefaults 不再自动补种(由 deleteAgentAvatar 写入)。 */
const avatarRemovedMarker = (): string => path.join(agentsDir(), DEFAULT_AGENT_SLUG, '.avatar-removed');

/** 让已存在的默认 agent 平滑跟随内置默认(每次启动幂等运行):
 *  ① 品牌改名:把 name/systemPrompt/SOUL 里的字面 "Tangu Xyra" → "Tangu Arioso"(只动这串,不碰用户其余文字;
 *     已是新名则 no-op,用户改过名则不含该串、不受影响)。
 *  ② 默认头像自愈:只要「没有可用头像文件」(config.avatar 未设,或指向的文件已丢失=旧 marker 误判/被外部删)
 *     就补种内置默认头像;唯一例外是用户经设置显式删过(.avatar-removed)。这样 config 指向却丢文件的 404 会自动修复。 */
async function ensureXyraDefaults(): Promise<void> {
  const cur = await getAgent(DEFAULT_AGENT_SLUG);
  if (!cur) return;
  const rebrand = (s: string | undefined): string => (s || '').split('Tangu Xyra').join('Tangu Arioso');
  const name = rebrand(cur.name), systemPrompt = rebrand(cur.systemPrompt), soul = rebrand(cur.soul);
  if (name !== cur.name || systemPrompt !== cur.systemPrompt || soul !== cur.soul) {
    await saveAgent({
      slug: DEFAULT_AGENT_SLUG, name, description: cur.description, model: cur.model, tools: cur.tools,
      thinkingLevel: cur.thinkingLevel, maxIterations: cur.maxIterations, approvalMode: cur.approvalMode,
      systemPrompt, soul, avatar: cur.avatar, createdBy: cur.createdBy,
      shareDefaultMemory: cur.shareDefaultMemory, cloudSync: cur.cloudSync,
    });
  }
  if (existsSync(avatarRemovedMarker())) return; // 用户显式删过 → 尊重,不补种
  const a = await getAgent(DEFAULT_AGENT_SLUG);
  const avatarFile = a?.avatar
    ? path.join(agentsDir(), DEFAULT_AGENT_SLUG, a.avatar.includes('/') ? a.avatar : path.join('Library', a.avatar))
    : null;
  const avatarOk = !!avatarFile && existsSync(avatarFile);
  if (!avatarOk) {
    await saveAgentAvatar(DEFAULT_AGENT_SLUG, DEFAULT_AGENT_AVATAR_B64, DEFAULT_AGENT_AVATAR_MIME).catch(() => { /* ignore */ });
  }
}

/** 首启播种默认 agent 为文件夹。**默认 agent(xyra)无视 .seeded marker 总是补齐**——老用户(旧扁平时代
 *  已写过 .seeded)升级后也保证有完整的 xyra(config.toml + SOUL.md + Library);其余默认 agent 受 marker
 *  守护(删了不复活)。 */
async function seedDefaultAgentsOnce(): Promise<void> {
  mkdirSync(agentsDir(), { recursive: true });
  const xyra = DEFAULT_AGENTS.find((a) => a.slug === DEFAULT_AGENT_SLUG);
  if (xyra) await writeAgentScaffold(xyra);
  await ensureXyraDefaults().catch(() => { /* ignore */ });
  const marker = path.join(agentsDir(), '.seeded');
  if (existsSync(marker)) return;
  for (const a of DEFAULT_AGENTS) {
    if (a.slug === DEFAULT_AGENT_SLUG) continue; // 已处理
    await writeAgentScaffold(a);
  }
  await fs.writeFile(marker, new Date().toISOString(), 'utf-8');
}

/** 旧扁平 <slug>.md → <slug>/(config.toml + 空 SOUL.md);原文件留 .bak。幂等、非破坏。 */
export async function migrateFlatToFolder(slug: string): Promise<void> {
  const flat = path.join(agentsDir(), `${slug}.md`);
  if (!existsSync(flat)) return;
  const adir = path.join(agentsDir(), slug);
  if (existsSync(path.join(adir, 'config.toml'))) return; // 已迁移
  const def = parseAgentFile(slug, await fs.readFile(flat, 'utf-8'));
  mkdirSync(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'config.toml'), serializeAgentConfig(def), 'utf-8');
  if (!existsSync(path.join(adir, 'SOUL.md'))) await fs.writeFile(path.join(adir, 'SOUL.md'), '', 'utf-8');
  await fs.rename(flat, `${flat}.bak`).catch(() => { /* ignore */ });
}

async function migrateFlatAgentsOnce(): Promise<void> {
  let entries;
  try { entries = await fs.readdir(agentsDir(), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name.endsWith('.md.bak')) continue;
    const slug = e.name.slice(0, -3);
    if (!isValidSlug(slug)) continue;
    await migrateFlatToFolder(slug).catch(() => { /* ignore */ });
  }
}

/** 一次性把旧全局 ~/.tangu/memory/* 复制进默认 agent(xyra)。复制非移动 → 可逆,旧目录留备份。幂等。 */
export async function migrateGlobalMemoryToXyra(): Promise<void> {
  const xyraDir = path.join(agentsDir(), DEFAULT_AGENT_SLUG);
  const xyraMem = path.join(xyraDir, 'MEMORY.md');
  if (existsSync(xyraMem)) return; // 已迁移(xyra 已有记忆)
  const oldDir = memoryDir();
  const oldMem = path.join(oldDir, 'MEMORY.md');
  const oldLog = path.join(oldDir, 'log');
  const oldMeta = path.join(oldDir, '.sync.json');
  if (!existsSync(oldMem) && !existsSync(oldLog)) return; // 全新装,无可迁移
  mkdirSync(xyraDir, { recursive: true });
  if (existsSync(oldMem)) await fs.copyFile(oldMem, xyraMem).catch(() => { /* ignore */ });
  if (existsSync(oldLog)) {
    const newLog = path.join(xyraDir, 'LOG');
    mkdirSync(newLog, { recursive: true });
    try {
      for (const f of await fs.readdir(oldLog)) {
        if (f.endsWith('.md')) await fs.copyFile(path.join(oldLog, f), path.join(newLog, f)).catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }
  }
  if (existsSync(oldMeta)) await fs.copyFile(oldMeta, path.join(xyraDir, '.sync.json')).catch(() => { /* ignore */ });
}

const USER_MD_TEMPLATE =
  '# User Profile (USER.md)\n\n' +
  '> Every Agent reads this profile. Record long-term information about yourself here; Agents may also add to it based on conversations.\n\n' +
  '## Name / What to call you\n\n' +
  '## Preferences\n- \n\n' +
  '## Level / Background\n\n' +
  '## Long-term needs / Goals\n';

/** 首次缺失时播种 USER.md 模板(全局用户画像,供用户发现并填写)。 */
async function seedUserMdOnce(): Promise<void> {
  const f = userMdFile();
  if (existsSync(f)) return;
  await fs.writeFile(f, USER_MD_TEMPLATE, 'utf-8');
}

let readyChecked = false;
/** 首次访问:迁移扁平 agent → 文件夹、播种默认 agent + USER.md、迁移旧全局记忆 → xyra。幂等、绝不抛。 */
async function ensureAgentsReady(): Promise<void> {
  if (readyChecked) return;
  readyChecked = true;
  try { mkdirSync(agentsDir(), { recursive: true }); } catch { /* ignore */ }
  await migrateFlatAgentsOnce().catch(() => { /* ignore */ });
  await seedDefaultAgentsOnce().catch(() => { /* ignore */ });
  await seedUserMdOnce().catch(() => { /* ignore */ });
  await migrateGlobalMemoryToXyra().catch(() => { /* ignore */ });
  cache = null;
}

/** 解析本 run 的 active agent slug:合法 slug 用之,否则回默认 agent(记忆/日志据此选文件夹)。 */
export function resolveActiveSlug(slug?: string): string {
  return slug && isValidSlug(slug) ? slug : DEFAULT_AGENT_SLUG;
}

// ── 全局 meta(列表顺序 + 默认 agent;~/.tangu/agents/.meta.json)──
export interface AgentsMeta { order: string[]; defaultSlug: string }
const agentsMetaFile = (): string => path.join(agentsDir(), '.meta.json');

export function readAgentsMeta(): AgentsMeta {
  try {
    const m = JSON.parse(readFileSync(agentsMetaFile(), 'utf8'));
    return {
      order: Array.isArray(m.order) ? m.order.filter((s: any) => typeof s === 'string') : [],
      defaultSlug: typeof m.defaultSlug === 'string' && m.defaultSlug ? m.defaultSlug : DEFAULT_AGENT_SLUG,
    };
  } catch {
    return { order: [], defaultSlug: DEFAULT_AGENT_SLUG };
  }
}

export async function writeAgentsMeta(patch: Partial<AgentsMeta>): Promise<AgentsMeta> {
  const cur = readAgentsMeta();
  const next: AgentsMeta = {
    order: Array.isArray(patch.order) ? patch.order.filter((s) => typeof s === 'string' && isValidSlug(s)) : cur.order,
    defaultSlug: patch.defaultSlug != null && isValidSlug(patch.defaultSlug) ? patch.defaultSlug : cur.defaultSlug,
  };
  mkdirSync(agentsDir(), { recursive: true });
  await fs.writeFile(agentsMetaFile(), JSON.stringify(next, null, 2), 'utf-8');
  cache = null; // 顺序变 → 列表缓存失效
  return next;
}

export async function listAgents(): Promise<NormalAgentDef[]> {
  await ensureAgentsReady();
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
    if (e.isDirectory()) {
      const slug = e.name;
      if (!isValidSlug(slug)) continue;
      if (!existsSync(path.join(dir, slug, 'config.toml'))) continue;
      try { defs.push(await parseAgentFolder(slug, path.join(dir, slug))); } catch { /* 跳过坏目录 */ }
    } else if (e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('.md.bak')) {
      // 防御:遗留扁平(ensureAgentsReady 已迁移,正常到不了这)→ 迁移后读。
      const slug = e.name.slice(0, -3);
      if (!isValidSlug(slug)) continue;
      try { await migrateFlatToFolder(slug); defs.push(await parseAgentFolder(slug, path.join(dir, slug))); } catch { /* ignore */ }
    }
  }
  // 按 meta.order 排(order 内按序在前,order 外按 name 在后)。
  const order = readAgentsMeta().order;
  const idx = (s: string): number => { const i = order.indexOf(s); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  defs.sort((a, b) => { const d = idx(a.slug) - idx(b.slug); return d !== 0 ? d : a.name.localeCompare(b.name); });
  cache = { stamp, defs };
  return defs;
}

export async function getAgent(slug: string): Promise<NormalAgentDef | null> {
  if (!slug || !isValidSlug(slug)) return null;
  await ensureAgentsReady();
  const adir = path.join(agentsDir(), slug);
  if (existsSync(path.join(adir, 'config.toml'))) {
    try { return await parseAgentFolder(slug, adir); } catch { return null; }
  }
  // 遗留扁平:迁移后再读
  if (existsSync(path.join(agentsDir(), `${slug}.md`))) {
    try { await migrateFlatToFolder(slug); return await parseAgentFolder(slug, adir); } catch { return null; }
  }
  return null;
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
  /** 人格(SOUL.md);缺省保留已有。 */
  soul?: string;
  /** 头像文件名(Library 内);缺省保留已有。 */
  avatar?: string;
  createdBy?: 'user' | 'agent' | 'system';
  /** 共用默认 Agent 记忆/日志;缺省保留已有。 */
  shareDefaultMemory?: boolean;
  /** 开启云同步(跨设备镜像);缺省保留已有。 */
  cloudSync?: boolean;
}

/** 新建/更新一个 agent(落盘 <slug>/config.toml + SOUL.md)。保留已有 createdAt/createdBy/libraryOrder,绝不动 MEMORY/LOG/Library。 */
export async function saveAgent(input: SaveAgentInput): Promise<NormalAgentDef> {
  const slug = input.slug && isValidSlug(input.slug) ? input.slug : slugify(input.name);
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  if (!input.name?.trim()) throw new Error('name required');
  const existing = await getAgent(slug);
  // systemPrompt 仅**新建**必填;更新已有 agent(含上传头像 saveAgentAvatar 走的就是这条)允许空/省略 → 保留原值。
  // 否则 systemPrompt 恰为空(或配置损坏读成空)的 agent 会被彻底锁死,连头像都改不了。
  if (!existing && !input.systemPrompt?.trim()) throw new Error('systemPrompt required');
  const def: NormalAgentDef = {
    slug,
    name: input.name.trim().slice(0, 120),
    version: existing?.version || '1.0.0', // 保留原版本;新建默认 1.0.0
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
    systemPrompt: (input.systemPrompt != null ? String(input.systemPrompt) : existing?.systemPrompt || '').trim().slice(0, 100_000),
    soul: (input.soul != null ? String(input.soul) : existing?.soul || '').slice(0, 100_000),
    libraryOrder: existing?.libraryOrder || [],
    avatar: input.avatar !== undefined ? (input.avatar ? String(input.avatar) : undefined) : existing?.avatar,
    shareDefaultMemory: input.shareDefaultMemory !== undefined ? input.shareDefaultMemory : existing?.shareDefaultMemory,
    cloudSync: input.cloudSync !== undefined ? input.cloudSync : existing?.cloudSync,
  };
  const adir = path.join(agentsDir(), slug);
  mkdirSync(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'config.toml'), serializeAgentConfig(def), 'utf-8');
  await fs.writeFile(path.join(adir, 'SOUL.md'), def.soul || '', 'utf-8');
  cache = null; // 失效缓存
  return def;
}

export async function deleteAgent(slug: string): Promise<boolean> {
  if (!isValidSlug(slug)) return false;
  if (slug === DEFAULT_AGENT_SLUG) return false; // 不允许删默认 agent(含其记忆/日志)
  if (slug === MUSE_AGENT_SLUG) {
    // Muse 启用期间禁删(supervisor 会自愈重建,删了也白删且丢记忆);关闭 Muse 后允许删。
    try { if (loadSpecialAgentsConfig().muse.enabled) return false; } catch { /* 配置读失败不阻删 */ }
  }
  try {
    await fs.rm(path.join(agentsDir(), slug), { recursive: true, force: true });
    await fs.rm(path.join(agentsDir(), `${slug}.md`), { force: true }).catch(() => { /* 清理可能的遗留扁平 */ });
    cache = null;
    return true;
  } catch {
    return false;
  }
}

// ── 头像(存进该 agent 的 Library/,config.avatar 引用;≤1MB)──
const AVATAR_MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};
const AVATAR_EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
const AVATAR_MAX_BYTES = 1_048_576; // 1MB

/** 写头像进 <slug>/Library/avatar.<ext> 并更新 config.avatar;校验类型/大小;返回文件名。base64 容许带 data: 前缀。 */
export async function saveAgentAvatar(slug: string, base64: string, mimeType: string): Promise<string> {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  const ext = AVATAR_MIME_EXT[String(mimeType).toLowerCase()];
  if (!ext) throw new Error('unsupported image type (png/jpeg/gif/webp only)');
  const raw = base64.includes(',') && base64.trimStart().startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('empty image');
  if (buf.length > AVATAR_MAX_BYTES) throw new Error('image too large (max 1MB)');
  const cur = await getAgent(slug);
  if (!cur) throw new Error('agent not found');
  const libDir = path.join(agentsDir(), slug, 'Library');
  mkdirSync(libDir, { recursive: true });
  // 删旧 avatar.*(避免不同扩展名堆积)
  try {
    for (const f of await fs.readdir(libDir)) {
      if (/^avatar\.(png|jpe?g|gif|webp)$/i.test(f)) await fs.rm(path.join(libDir, f), { force: true }).catch(() => { /* ignore */ });
    }
  } catch { /* ignore */ }
  const filename = `avatar.${ext}`;
  await fs.writeFile(path.join(libDir, filename), buf);
  await saveAgent({
    slug, name: cur.name, description: cur.description, model: cur.model, tools: cur.tools,
    thinkingLevel: cur.thinkingLevel, maxIterations: cur.maxIterations, approvalMode: cur.approvalMode,
    systemPrompt: cur.systemPrompt, soul: cur.soul, avatar: filename, createdBy: cur.createdBy,
  });
  return filename;
}

/** 读头像二进制 + mime;无则 null。 */
export async function readAgentAvatar(slug: string): Promise<{ data: Buffer; mimeType: string } | null> {
  if (!isValidSlug(slug)) return null;
  const cur = await getAgent(slug);
  if (!cur?.avatar) return null;
  const rel = cur.avatar.includes('/') ? cur.avatar : path.join('Library', cur.avatar);
  const ext = (cur.avatar.split('.').pop() || '').toLowerCase();
  try {
    const data = await fs.readFile(path.join(agentsDir(), slug, rel));
    return { data, mimeType: AVATAR_EXT_MIME[ext] || 'application/octet-stream' };
  } catch {
    return null;
  }
}

/** 删除头像:移除 Library/avatar.* 并清空 config.avatar(保留其余字段)。无头像时也按成功返回。 */
export async function deleteAgentAvatar(slug: string): Promise<boolean> {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  const cur = await getAgent(slug);
  if (!cur) throw new Error('agent not found');
  const libDir = path.join(agentsDir(), slug, 'Library');
  try {
    for (const f of await fs.readdir(libDir)) {
      if (/^avatar\.(png|jpe?g|gif|webp)$/i.test(f)) await fs.rm(path.join(libDir, f), { force: true }).catch(() => { /* ignore */ });
    }
  } catch { /* 目录不存在 → 无文件可删 */ }
  await saveAgent({
    slug, name: cur.name, description: cur.description, model: cur.model, tools: cur.tools,
    thinkingLevel: cur.thinkingLevel, maxIterations: cur.maxIterations, approvalMode: cur.approvalMode,
    systemPrompt: cur.systemPrompt, soul: cur.soul, avatar: '', createdBy: cur.createdBy,
  });
  // 默认 agent:记下「用户显式删过」,否则下次启动 ensureXyraDefaults 会把内置默认头像补回来。
  if (slug === DEFAULT_AGENT_SLUG) {
    await fs.writeFile(avatarRemovedMarker(), new Date().toISOString(), 'utf-8').catch(() => { /* ignore */ });
  }
  return true;
}

// ── Library 文件管理(通用参考资料 + avatar)。设置面板增删改查;Agent 经文件工具读写同一目录。──
const LIBRARY_TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'text', 'json', 'jsonl', 'toml', 'yaml', 'yml', 'csv', 'tsv',
  'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'log',
  'ini', 'env', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'rb', 'php', 'sql',
]);
const LIBRARY_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', pdf: 'application/pdf',
};
const LIBRARY_MAX_BYTES = 5 * 1024 * 1024; // 5MB,与云端 tangu_agent_files 对齐
const extOf = (name: string): string => (name.split('.').pop() || '').toLowerCase();
// ponytail: isBinary 按扩展名白名单判定,非内容嗅探;够用,要更准再嗅探首字节 NUL
const isTextExt = (name: string): boolean => LIBRARY_TEXT_EXTS.has(extOf(name));

/** 文件名消毒:仅收 basename、拒空/含路径分隔/点穿越/超长。防路径穿越。 */
export function sanitizeLibraryName(name: string): string {
  const n = String(name || '').trim();
  if (!n || n.length > 255) throw new Error('invalid file name');
  if (n.includes('/') || n.includes('\\') || n.includes('\0') || n.includes('..')) throw new Error('invalid file name');
  if (path.basename(n) !== n) throw new Error('invalid file name');
  return n;
}

function libDirOf(slug: string): string {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  return path.join(agentsDir(), slug, 'Library');
}

export interface LibraryFileMeta { name: string; size: number; isBinary: boolean; mtimeMs: number }

export async function listLibraryFiles(slug: string): Promise<LibraryFileMeta[]> {
  const dir = libDirOf(slug);
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: LibraryFileMeta[] = [];
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, size: st.size, isBinary: !isTextExt(name), mtimeMs: Math.floor(st.mtimeMs) });
    } catch { /* ignore */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readLibraryFile(slug: string, name: string): Promise<{ name: string; isBinary: boolean; content?: string; dataBase64?: string; mimeType?: string } | null> {
  const dir = libDirOf(slug);
  const safe = sanitizeLibraryName(name);
  try {
    const buf = await fs.readFile(path.join(dir, safe));
    if (isTextExt(safe)) return { name: safe, isBinary: false, content: buf.toString('utf8') };
    return { name: safe, isBinary: true, dataBase64: buf.toString('base64'), mimeType: LIBRARY_MIME_BY_EXT[extOf(safe)] || 'application/octet-stream' };
  } catch { return null; }
}

export async function writeLibraryFile(slug: string, name: string, body: { content?: string; dataBase64?: string; isBinary?: boolean }): Promise<{ name: string }> {
  const dir = libDirOf(slug);
  const safe = sanitizeLibraryName(name);
  const buf = body.isBinary
    ? Buffer.from(String(body.dataBase64 || '').replace(/^data:[^,]*,/, ''), 'base64')
    : Buffer.from(String(body.content ?? ''), 'utf8');
  if (buf.length > LIBRARY_MAX_BYTES) throw new Error('file too large (max 5MB)');
  mkdirSync(dir, { recursive: true });
  await fs.writeFile(path.join(dir, safe), buf);
  return { name: safe };
}

export async function deleteLibraryFile(slug: string, name: string): Promise<void> {
  const dir = libDirOf(slug);
  const safe = sanitizeLibraryName(name);
  await fs.rm(path.join(dir, safe), { force: true });
}
