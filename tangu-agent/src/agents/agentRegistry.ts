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
import { builtinAgentAvatar } from './builtinAvatars.js';
import { LEGACY_PERSONAS, LEGACY_MUSE_PROMPTS, LEGACY_MUSE_DESCRIPTION } from './legacyPersonas.js';
import { ARIOSO_SYSTEM_PROMPT, ARIOSO_SOUL, ARIA_SYSTEM_PROMPT, ARIA_SOUL, RECITA_SYSTEM_PROMPT, RECITA_SOUL } from './personaPrompts.js';
import { CODING_AGENT_VERSION, CODING_SYSTEM_PROMPT, CODING_SOUL } from './codingPrompt.js';
import { loadSpecialAgentsConfig, legacyMusePrompt, DEFAULT_MUSE_PROMPT } from '../services/specialAgentsConfig.js';
import { THINKING_LEVELS } from '../llm/modelCapabilities.js';
import { normalizeCompactionLayer } from '../services/compactionSettings.js';
// ⚠️ 与 approvals.ts 互相 import(它 import 本文件的 getAgent / slugify 等):两边都只在函数体里用对方的导出,
// 所以求值顺序无关紧要。别在本文件顶层调用 normalizeApprovalMode(模块未求值完 → TDZ)。
import { normalizeApprovalMode } from '../services/approvals.js';
import type { ThinkingLevel } from '../core/types.js';

/** 循环轮数缺省(会话/Agent 都没给时 agentLoop 用它)与 **Agent 级下限**:Agent 定义里低于下限的 max_iterations
 *  视为误设 —— 一个写了 3 的 agent,每回合两次工具调用就被迫收尾,用户只看到「空话空转」(09-13 用户导出实证)。
 *  三处同口径:激活时忽略并告警(agentActivation)、保存时清空并告警(buildAgentDef)、路由与 manage_agent 显式拒绝。
 *  会话级 /loop 不套下限:那是用户显式意图(/loop 1 单发)。桌面 AgentsTab 的 min 与此同步。 */
export const DEFAULT_MAX_ITERATIONS = 90;
export const AGENT_MAX_ITERATIONS_MIN = 10;

/** agent 定义里的思考档位。`''` = 未声明(跟随会话默认),其余同 core 的 ThinkingLevel 七档。 */
export type ThinkLevel = ThinkingLevel | '';
export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto' | 'custom' | '';

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
  enabledSkillIds?: string[];
  enabledMcpServers?: string[];
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
  /** 允许读用户活动日志(read_activity 工具);默认/false=仅 Muse 可读。 */
  activityAccess?: boolean;
  /** 上下文压缩旋钮(config.toml 的 `[compaction]` 表,已归一化;字段见 services/compactionSettings)。
   *  作为 run 级层并入 agentConfig.compaction,压过 config.json 的同名段。 */
  compaction?: Record<string, unknown>;
  /** 内置工具名单模式:'deny'=toolsList 内禁用(其余可用);'allow'=仅 toolsList 可用;缺省=不限制。
   *  只约束无门禁的内置工具(见 toolRegistry.resolveTools);区别于 tools=自定义工具选择。 */
  toolsMode?: 'allow' | 'deny';
  /** 配合 toolsMode 的内置工具名单(config.toml tools_list)。 */
  toolsList?: string[];
  /** 该 agent 支持/出现于哪些 app(小写,如 ["echo"]);空=不限制(由调用方默认)。来自 config.toml apps。 */
  apps?: string[];
  /** 本地 agent 的 Library 绝对路径(私聊会话的 cwd);云端 agent 无此字段 ⇒ 不能开私聊(私聊 host-only)。 */
  libraryDir?: string;
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

const THINK: ThinkLevel[] = [...THINKING_LEVELS];
const APPROVAL: ApprovalMode[] = ['readonly', 'auto-edit', 'full-auto', 'custom'];

/** 审批档原值的首尾空白先剥(与 projectContext 同口径):`"auto-edit "` = auto-edit、`"   "` = 空(跟随会话)。非字符串原样交给 normalizeApprovalMode。 */
const trimApproval = (v: unknown): unknown => (typeof v === 'string' ? v.trim() : v);

const warnedUnparsedApproval = new Set<string>(); // unparsedApprovalMode 的告警去重(slug|原值)

/**
 * config.toml **整份解析失败**时的审批档兜底(fail-closed)。最常见的手改错误恰恰是 `approval_mode = readonly`
 * 忘了引号 —— 非法 TOML,旧口径整份当空对象 → 审批档 '' = 跟随会话(host 上是 auto-edit),想收紧反而放宽。
 * 现在:文件里有一行非空的 approval_mode(不论写的是哪一档,文件已不可信)→ readonly 并告警;
 * 没有这一行、或值是空串(`approval_mode = ""`)→ ''(与「空 = 跟随会话」同口径)。
 * 只认行首的顶层键写法;`[ \t]*` 不跨行,免得 `approval_mode =` 后换行把下一行的值算进来。
 */
function unparsedApprovalMode(slug: string, tomlRaw: string): ApprovalMode {
  const m = /^[ \t]*["']?approval_mode["']?[ \t]*=[ \t]*(.*)$/m.exec(tomlRaw);
  if (!m) return '';
  const value = m[1].replace(/[ \t]+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!value) return '';
  // 告警按「slug|原值」进程内去重:云端 cloudGetAgent / httpBrain 水合每次请求都重解析,坏文件不修会刷屏(同 approvals.warnUnknownMode)
  const key = `${slug}|${m[1].trim()}`;
  if (!warnedUnparsedApproval.has(key)) {
    if (warnedUnparsedApproval.size > 200) warnedUnparsedApproval.clear(); // 只防无界增长
    warnedUnparsedApproval.add(key);
    console.warn(`[tangu] agent ${slug} 的 config.toml 解析失败,其中 approval_mode = ${m[1].trim()} 按 readonly 处理(修好 TOML 语法后恢复)`);
  }
  return 'readonly';
}

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
  // 未知非空档 → readonly + 告警(H5,同 parseAgentConfig);空 / 纯空白 / 缺席 = ''(跟随会话);首尾空白先剥(同 projectContext)
  const approval: ApprovalMode = normalizeApprovalMode(trimApproval(meta.approvalmode), `agent ${slug} (legacy .md)`) ?? '';
  const maxIter = Number(meta.maxiterations);
  return {
    slug,
    name: meta.name || slug,
    version: meta.version || '1.0.0',
    description: meta.description || '',
    model: meta.model || '',
    tools,
    enabledSkillIds: Array.isArray(meta.enabled_skill_ids) ? meta.enabled_skill_ids.filter((v: unknown) => typeof v === 'string') : undefined,
    enabledMcpServers: Array.isArray(meta.enabled_mcp_servers) ? meta.enabled_mcp_servers.filter((v: unknown) => typeof v === 'string') : undefined,
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
  let unparsed = false;
  try { meta = (parseToml(tomlRaw) as Record<string, any>) || {}; } catch { meta = {}; unparsed = true; }
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
  // 审批档(H5 fail-closed):空 / 纯空白 / 缺席 = ''(跟随会话);四个 id 原样(首尾空白先剥,同 projectContext);
  // **其它非空值**(拼错、新客户端才认识的档、非字符串)→ readonly 并告警。旧口径静默写成 '' = 跟随会话 ——
  // 用户手改 config.toml 想收紧,拼错一个字反而放宽。整份解析失败另走 unparsedApprovalMode(少个引号同样不许放宽)。
  const approval: ApprovalMode = unparsed
    ? unparsedApprovalMode(slug, tomlRaw)
    : normalizeApprovalMode(trimApproval(meta.approval_mode), `agent ${slug} config.toml`) ?? '';
  const maxIter = Number(meta.max_iterations);
  return {
    slug,
    name: str(meta.name) || slug,
    version: str(meta.version) || '1.0.0', // 市场「可更新」检查用;缺省 1.0.0
    description: str(meta.description),
    model: str(meta.model),
    tools,
    enabledSkillIds: Array.isArray(meta.enabled_skill_ids) ? meta.enabled_skill_ids.filter((v: unknown) => typeof v === 'string') : undefined,
    enabledMcpServers: Array.isArray(meta.enabled_mcp_servers) ? meta.enabled_mcp_servers.filter((v: unknown) => typeof v === 'string') : undefined,
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
    activityAccess: !!meta.activity_access,
    toolsMode: meta.tools_mode === 'allow' || meta.tools_mode === 'deny' ? meta.tools_mode : undefined,
    toolsList: Array.isArray(meta.tools_list)
      ? meta.tools_list.filter((t: any) => typeof t === 'string' && t.trim()).slice(0, 200)
      : undefined,
    apps,
    ...(meta.compaction && typeof meta.compaction === 'object' && Object.keys(normalizeCompactionLayer(meta.compaction)).length
      ? { compaction: normalizeCompactionLayer(meta.compaction) as Record<string, unknown> }
      : {}),
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
  if (def.enabledSkillIds) obj.enabled_skill_ids = def.enabledSkillIds;
  if (def.enabledMcpServers) obj.enabled_mcp_servers = def.enabledMcpServers;
  if (def.libraryOrder && def.libraryOrder.length) obj.library_order = def.libraryOrder;
  if (def.apps && def.apps.length) obj.apps = def.apps;
  if (def.avatar) obj.avatar = def.avatar;
  if (def.shareDefaultMemory) obj.share_default_memory = true;
  if (def.cloudSync) obj.cloud_sync = true;
  if (def.activityAccess) obj.activity_access = true;
  if (def.toolsMode && def.toolsList) { // allow+空数组=全禁,合法;缺 mode 不落盘
    obj.tools_mode = def.toolsMode;
    obj.tools_list = def.toolsList;
  }
  obj.created_by = def.createdBy;
  obj.created_at = def.createdAt || new Date().toISOString();
  // [compaction] 表单独串在**最后**:TOML 里表头之后的裸键都归该表,developer_instructions 必须先于它落盘。
  const tables = def.compaction && Object.keys(def.compaction).length ? '\n' + stringifyToml({ compaction: def.compaction }) : '';
  const di = def.systemPrompt || '';
  // developer_instructions 常多行:用 TOML 多行字面串(''')——用户手编 config.toml 时可原样换行、无需转义,
  // 避免「在基本串 "..." 里直接敲回车 → 非法 TOML → 整个 agent 解析失败」。仅当含 ''' 或以 ' 结尾(破坏闭合)
  // 时回退 smol-toml 的转义单行串。'''\n 后的首换行被 TOML 裁掉,故内容原样保真。
  if (di.includes('\n') && !di.includes("'''") && !di.endsWith("'")) {
    return stringifyToml(obj) + `developer_instructions = '''\n${di}'''\n` + tables;
  }
  obj.developer_instructions = di;
  return stringifyToml(obj) + tables;
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

type BuiltinAgentPreset = Pick<NormalAgentDef, 'slug' | 'name' | 'description' | 'systemPrompt'> & Partial<NormalAgentDef>;

export const MUSE_AGENT_SLUG = 'muse';

/** Muse 的内置骨架。人格/指令英文(硬编码模型提示纪律);每周期的动态上下文(预算/用户记忆快照/
 *  活动摘要)由 muse.ts 注入 kickoff 消息,不在此处。 */
const MUSE_AGENT_PRESET: BuiltinAgentPreset = {
  slug: MUSE_AGENT_SLUG,
  name: 'Muse',
  description: 'A quiet background observer that finds worthwhile next steps',
  createdBy: 'system',
  systemPrompt: DEFAULT_MUSE_PROMPT,
  soul:
    '# Muse\n\nA quiet observer with a spark of initiative. Muse watches the flow of the user\'s work and life from the background, ' +
    'connects scattered threads across conversations and files, and surfaces the few things genuinely worth doing next.\n' +
    'Curious but restrained: proposes only what is actionable and valuable now, learns from what the user accepts or dismisses, ' +
    'and would rather stay silent than waste the user\'s attention.',
};


/** 内置名册共五位。xyra 保持既有标识,以延续 Arioso 的会话、记忆与日志。 */
export const DEFAULT_AGENTS: BuiltinAgentPreset[] = [
  {
    slug: DEFAULT_AGENT_SLUG, name: 'Arioso', version: '1.1.0',
    description: 'Quiet warmth and clear judgment, with memory of what matters to you',
    // 思考档统一 medium(09-19 用户拍板):从前 Arioso / Aria 预设 low,而会话没指定档位时 agentActivation 用 Agent 的档位 ——
    // 默认 Agent 实际跑 low,输入区药丸却按「未指定 = 中」显示。老装机由 migrateDefaultEffortOnce 翻一次。
    thinkingLevel: 'medium', systemPrompt: ARIOSO_SYSTEM_PROMPT, soul: ARIOSO_SOUL,
  },
  {
    slug: 'aria', name: 'Aria',
    description: 'Emotional insight, expressive writing, and imaginative collaboration',
    thinkingLevel: 'medium', systemPrompt: ARIA_SYSTEM_PROMPT, soul: ARIA_SOUL,
  },
  {
    slug: 'recita', name: 'Recita',
    description: 'Critical thinking, grounded decisions, and practical next steps',
    thinkingLevel: 'medium', systemPrompt: RECITA_SYSTEM_PROMPT, soul: RECITA_SOUL,
  },
  {
    // Coding Space 的默认 agent:像 Google AI Studio 的 app builder。预览端(codePreview.ts)按需转译
    // .ts/.tsx/.jsx(sucrase,vite-dev 式,无打包/无 npm install),裸依赖走 importmap→esm.sh。
    slug: 'coding',
    name: 'Coding',
    version: CODING_AGENT_VERSION, // 提示词更新即 bump → refreshBuiltinAgent 覆盖旧版(保留用户 model/thinking)
    description: 'Build and refine working web apps with a project brief, live preview, Forsion AI, and verified repairs',
    thinkingLevel: 'medium',
    systemPrompt: CODING_SYSTEM_PROMPT,
    soul: CODING_SOUL,
  },
  MUSE_AGENT_PRESET,
];

/** 内置预设的完整 def(纯内存,不落盘):云端虚拟条目(cloudAgentStore 列表合成)与 run 侧
 *  水合兜底(agentActivation)共用。非预设 slug → null。 */
export function builtinAgentDef(slug: string): NormalAgentDef | null {
  const a = DEFAULT_AGENTS.find((x) => x.slug === slug);
  if (!a) return null;
  return { ...buildAgentDef(a.slug, null, {
    slug: a.slug, name: a.name, description: a.description, model: a.model, tools: a.tools,
    thinkingLevel: a.thinkingLevel, maxIterations: a.maxIterations, approvalMode: a.approvalMode,
    systemPrompt: a.systemPrompt, soul: a.soul, createdBy: a.createdBy || 'user',
  }), version: a.version || '1.0.0', avatar: builtinAgentAvatar(a.slug) ? 'avatar.jpg' : undefined };
}

/** 写一个默认 agent 的骨架(目录 + Library/ + 缺失的 config.toml / SOUL.md);幂等,不覆盖已有文件。
 *  不建 MEMORY.md / LOG/(由记忆层按需建——提前建空 MEMORY.md 会让 migrateGlobalMemoryToXyra 误判已迁移)。 */
async function writeAgentScaffold(a: (typeof DEFAULT_AGENTS)[number]): Promise<void> {
  const adir = path.join(agentsDir(), a.slug);
  mkdirSync(path.join(adir, 'Library'), { recursive: true }); // 建 agent 目录 + Library(头像/资料)
  if (!existsSync(path.join(adir, 'config.toml'))) {
    const def: NormalAgentDef = {
      slug: a.slug, name: a.name, version: a.version || '1.0.0', description: a.description || '', model: a.model || '',
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

/** 内置(系统维护)agent 的提示词升级:磁盘版本 ≠ 预设版本时,用预设覆盖 systemPrompt/soul/version/描述,
 *  但**保留全部用户配置**(含工具权限、头像、同步与记忆作用域)。仅对预设声明了 version 的 agent 生效。 */
async function refreshBuiltinAgent(a: (typeof DEFAULT_AGENTS)[number]): Promise<void> {
  if (!a.version) return;
  const adir = path.join(agentsDir(), a.slug);
  const cfgPath = path.join(adir, 'config.toml');
  const txt = await fs.readFile(cfgPath, 'utf-8').catch(() => null);
  if (txt === null) return;
  const cur = parseAgentConfig(a.slug, txt, '');
  if (cur.version === a.version) return; // 已是最新
  const def: NormalAgentDef = {
    ...cur, // 白名单覆盖维护字段，避免未来新增用户配置在升级时被静默清空。
    slug: a.slug, name: a.name, version: a.version, description: a.description || '',
    systemPrompt: a.systemPrompt, soul: a.soul || '',
  };
  await fs.writeFile(cfgPath, serializeAgentConfig(def), 'utf-8');
  await fs.writeFile(path.join(adir, 'SOUL.md'), a.soul || '', 'utf-8');
}

// ── Muse 系统 agent(Special Agent 的文件夹化身份;由 muse supervisor 按需播种/自愈)──


/**
 * 确保 Muse 系统 agent 文件夹存在(幂等,绝不覆盖已有文件——用户对 SOUL/指令的修改被尊重)。
 * legacyPrompt = 旧 specialAgents.muse.prompt 自定义值,仅首次创建时一次性迁移为 developer_instructions。
 */
export async function ensureMuseAgent(legacyPrompt?: string): Promise<void> {
  const adir = path.join(agentsDir(), MUSE_AGENT_SLUG);
  if (existsSync(path.join(adir, 'config.toml'))) {
    // 已有文件夹:只把**原装旧指令**换成现行预设(见 upgradeMusePrompt),其余一个字段都不动。
    const cur = await parseAgentFolder(MUSE_AGENT_SLUG, adir);
    const upgraded = upgradeMusePrompt(cur);
    if (upgraded !== cur) {
      await fs.writeFile(path.join(adir, 'config.toml'), serializeAgentConfig(upgraded), 'utf-8');
      cache = null;
    }
    return;
  }
  const preset = { ...MUSE_AGENT_PRESET };
  if (legacyPrompt && legacyPrompt.trim()) preset.systemPrompt = legacyPrompt.trim();
  await writeAgentScaffold(preset);
  cache = null;
}

/** Muse 逐字段升级:工作指令 / 描述还是**一字未改的历史原装**才换成现行预设;用户写过的原样保留。
 *  没变化时返回同一个对象(调用方按引用判断要不要写盘)。 */
export function upgradeMusePrompt(cur: NormalAgentDef): NormalAgentDef {
  if (cur.slug !== MUSE_AGENT_SLUG) return cur;
  const stalePrompt = LEGACY_MUSE_PROMPTS.includes((cur.systemPrompt || '').trim());
  const staleDescription = cur.description === LEGACY_MUSE_DESCRIPTION;
  if (!stalePrompt && !staleDescription) return cur;
  return {
    ...cur,
    systemPrompt: stalePrompt ? MUSE_AGENT_PRESET.systemPrompt : cur.systemPrompt,
    description: staleDescription ? MUSE_AGENT_PRESET.description : cur.description,
  };
}

/** 内置头像显式删除后不复活;自定义头像和独立的记忆保持原样。 */
const avatarRemovedMarker = (slug: string): string => path.join(agentsDir(), slug, '.avatar-removed');

/** Arioso 逐字段升级:只替换原装文案,保留用户写过的人格、名字及所有配置。云端也复用此纯函数。 */
export function upgradeAriosoPersona(cur: NormalAgentDef): NormalAgentDef {
  if (cur.slug !== DEFAULT_AGENT_SLUG) return cur;
  const old = LEGACY_PERSONAS[0];
  const preset = DEFAULT_AGENTS[0];
  const rebrand = (s = ''): string => s.split('Tangu Xyra').join('Tangu Arioso');
  return {
    ...cur,
    name: rebrand(cur.name) === old.name ? preset.name : cur.name,
    description: cur.description === old.description ? preset.description : cur.description,
    systemPrompt: rebrand(cur.systemPrompt).trim() === old.systemPrompt.trim() ? preset.systemPrompt : cur.systemPrompt,
    soul: rebrand(cur.soul).trim() === old.soul?.trim() ? preset.soul : cur.soul,
    version: cur.version === '1.0.0' ? preset.version! : cur.version,
  };
}

/** 旧内置身份按固定 slug 退出名册,不以历史提示词/用户配置作为例外。文件保留供历史会话读取。 */
export function isRetiredBuiltin(def: Pick<NormalAgentDef, 'slug'>): boolean {
  return ['general-assistant', 'code-reviewer', 'writing-polish'].includes(def.slug);
}

/** 用户排序优先;缺省按内置名册顺序,其后为用户创建的 agent。 */
export function sortAgentDefs(defs: NormalAgentDef[], order: string[]): NormalAgentDef[] {
  const defaults = DEFAULT_AGENTS.map((a) => a.slug);
  const rank = (slug: string): number => {
    const explicit = order.indexOf(slug);
    if (explicit >= 0) return explicit;
    const builtin = defaults.indexOf(slug);
    return order.length + (builtin >= 0 ? builtin : defaults.length);
  };
  return defs.sort((a, b) => rank(a.slug) - rank(b.slug) || a.name.localeCompare(b.name));
}

async function ensureBuiltinAvatar(slug: string): Promise<void> {
  const avatar = builtinAgentAvatar(slug);
  if (!avatar || existsSync(avatarRemovedMarker(slug))) return;
  const cur = await getAgent(slug);
  if (!cur) return;
  const preset = DEFAULT_AGENTS.find((a) => a.slug === slug);
  if (slug !== DEFAULT_AGENT_SLUG && !cur.avatar && cur.systemPrompt !== preset?.systemPrompt) return;
  const filename = cur.avatar
    ? path.join(agentsDir(), slug, cur.avatar.includes('/') ? cur.avatar : path.join('Library', cur.avatar))
    : null;
  if (filename && existsSync(filename)) return;
  await saveAgentAvatar(slug, avatar.data.toString('base64'), avatar.mimeType);
}

/** 思考档默认值 low → medium 的一次性迁移(09-19):只碰播种时写过 low 的两个内置 Agent(Arioso / Aria),磁盘上仍是 low 才翻。
 *  「用户特意选了 low」与「播种写下的 low」在磁盘上分不清,所以只翻这一次(独立标记文件);此后用户再调回 low 永久保留。
 *  用户自建的 Agent 不碰。 */
export async function migrateDefaultEffortOnce(): Promise<void> {
  const marker = path.join(agentsDir(), '.effort-medium-v1');
  if (existsSync(marker)) return;
  for (const slug of [DEFAULT_AGENT_SLUG, 'aria']) {
    const adir = path.join(agentsDir(), slug);
    if (!existsSync(path.join(adir, 'config.toml'))) continue;
    const cur = await parseAgentFolder(slug, adir);
    if (cur.thinkingLevel === 'low') {
      await fs.writeFile(path.join(adir, 'config.toml'), serializeAgentConfig({ ...cur, thinkingLevel: 'medium' }), 'utf-8');
      cache = null;
    }
  }
  await fs.writeFile(marker, new Date().toISOString(), 'utf-8');
}

/** Arioso/Coding 保持原来的补齐语义;Aria/Recita/Muse 独立播种标记让已有安装也能获得新名册,
 *  此后尊重用户删除。Muse 的身份可见不代表开启后台功能。 */
async function seedDefaultAgentsOnce(): Promise<void> {
  mkdirSync(agentsDir(), { recursive: true });
  const arioso = DEFAULT_AGENTS[0];
  await writeAgentScaffold(arioso);
  const adir = path.join(agentsDir(), DEFAULT_AGENT_SLUG);
  const cur = await parseAgentFolder(DEFAULT_AGENT_SLUG, adir);
  const upgraded = upgradeAriosoPersona(cur);
  if (JSON.stringify(upgraded) !== JSON.stringify(cur)) {
    await fs.writeFile(path.join(adir, 'config.toml'), serializeAgentConfig(upgraded), 'utf-8');
    if (upgraded.soul !== cur.soul) await fs.writeFile(path.join(adir, 'SOUL.md'), upgraded.soul || '', 'utf-8');
  }
  const coding = DEFAULT_AGENTS.find((a) => a.slug === 'coding')!;
  await writeAgentScaffold(coding);
  await refreshBuiltinAgent(coding);
  const marker = path.join(agentsDir(), '.seeded-personas-v1');
  if (!existsSync(marker)) {
    for (const a of DEFAULT_AGENTS) {
      if (a.slug === MUSE_AGENT_SLUG) await ensureMuseAgent(legacyMusePrompt());
      else await writeAgentScaffold(a);
    }
    await fs.writeFile(marker, new Date().toISOString(), 'utf-8');
  }
  await migrateDefaultEffortOnce();
  for (const slug of [DEFAULT_AGENT_SLUG, 'aria', 'recita']) await ensureBuiltinAvatar(slug);
  const oldMarker = path.join(agentsDir(), '.seeded');
  if (!existsSync(oldMarker)) await fs.writeFile(oldMarker, new Date().toISOString(), 'utf-8');
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

export function normalizeAgentsMeta(meta: Partial<AgentsMeta>): AgentsMeta {
  return {
    order: Array.isArray(meta?.order) ? meta.order.filter((slug) => typeof slug === 'string' && isValidSlug(slug) && !isRetiredBuiltin({ slug })) : [],
    defaultSlug: typeof meta?.defaultSlug === 'string' && isValidSlug(meta.defaultSlug) && !isRetiredBuiltin({ slug: meta.defaultSlug })
      ? meta.defaultSlug : DEFAULT_AGENT_SLUG,
  };
}

export function readAgentsMeta(): AgentsMeta {
  try {
    const m = JSON.parse(readFileSync(agentsMetaFile(), 'utf8'));
    return normalizeAgentsMeta(m);
  } catch {
    return { order: [], defaultSlug: DEFAULT_AGENT_SLUG };
  }
}

export async function writeAgentsMeta(patch: Partial<AgentsMeta>): Promise<AgentsMeta> {
  const cur = readAgentsMeta();
  const next = normalizeAgentsMeta({
    order: Array.isArray(patch.order) ? patch.order.filter((s) => typeof s === 'string' && isValidSlug(s)) : cur.order,
    defaultSlug: patch.defaultSlug != null && isValidSlug(patch.defaultSlug) ? patch.defaultSlug : cur.defaultSlug,
  });
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
      try { defs.push({ ...(await parseAgentFolder(slug, path.join(dir, slug))), libraryDir: libDirOf(slug) }); } catch { /* 跳过坏目录 */ }
    } else if (e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('.md.bak')) {
      // 防御:遗留扁平(ensureAgentsReady 已迁移,正常到不了这)→ 迁移后读。
      const slug = e.name.slice(0, -3);
      if (!isValidSlug(slug)) continue;
      try { await migrateFlatToFolder(slug); defs.push({ ...(await parseAgentFolder(slug, path.join(dir, slug))), libraryDir: libDirOf(slug) }); } catch { /* ignore */ }
    }
  }
  // 按 meta.order 排(order 内按序在前,order 外按 name 在后)。
  const meta = readAgentsMeta();
  const visible = sortAgentDefs(defs.filter((a) => !isRetiredBuiltin(a)), meta.order);
  cache = { stamp, defs: visible };
  return visible;
}

export async function getAgent(slug: string): Promise<NormalAgentDef | null> {
  if (!slug || !isValidSlug(slug)) return null;
  await ensureAgentsReady();
  const adir = path.join(agentsDir(), slug);
  if (existsSync(path.join(adir, 'config.toml'))) {
    try { return { ...(await parseAgentFolder(slug, adir)), libraryDir: libDirOf(slug) }; } catch { return null; }
  }
  // 遗留扁平:迁移后再读
  if (existsSync(path.join(agentsDir(), `${slug}.md`))) {
    try { await migrateFlatToFolder(slug); return { ...(await parseAgentFolder(slug, adir)), libraryDir: libDirOf(slug) }; } catch { return null; }
  }
  return null;
}

export interface SaveAgentInput {
  slug?: string;
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  enabledSkillIds?: string[] | null;
  enabledMcpServers?: string[] | null;
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
  /** 允许读用户活动日志;缺省保留已有。 */
  activityAccess?: boolean;
  /** 内置工具名单模式;null=清除(回到不限制),缺省保留已有。 */
  toolsMode?: 'allow' | 'deny' | null;
  /** 内置工具名单;null=清除,缺省保留已有。 */
  toolsList?: string[] | null;
}

/** existing + input → 完整 def 的合并语义(校验/裁剪/缺省保留已有字段)。纯函数:本地 saveAgent 与
 *  云端 cloudAgentStore 共用同一份,防两处合并规则漂移。 */
/** 保存时的 Agent 级轮数:低于下限清空并告警,**不 throw** —— saveAgentAvatar / ensureXyraDefaults / cloudSaveAgentAvatar
 *  都把磁盘上的旧值原样透传再存,抛错会让「上传头像」因一个不相干的旧值失败。显式拒绝在 routes/agents 与 manage_agent 两个入口做。 */
function clampAgentMaxIterations(slug: string, v: number | string | null | undefined): number | null {
  const n = typeof v === 'string' ? Number(v) : v; // REST 客户端可能传 "50":路由校验用 Number 放行、这里再按非数清空就成了静默丢值(Codex 09-13 #7)
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n < AGENT_MAX_ITERATIONS_MIN) {
    console.warn(`[tangu] agent ${slug}: max_iterations=${n} 低于下限 ${AGENT_MAX_ITERATIONS_MIN},已清空(回落默认 ${DEFAULT_MAX_ITERATIONS})`);
    return null;
  }
  return Math.min(200, Math.floor(n));
}

/** 运行期取 Agent 定义的轮数上限:低于下限视为误设 → null 并告警。agentActivation / groupChat / automation 三处同口径
 *  (Codex 09-13 #3:只在激活处套下限,群聊和自动化仍会照跑磁盘上的 3);解析层 parseAgentConfig 仍忠实于磁盘值,UI 才看得见误设。 */
export function agentCapOf(def: Pick<NormalAgentDef, 'slug' | 'maxIterations'>): number | null {
  const v = def.maxIterations;
  if (v == null || !(v > 0)) return null;
  if (v < AGENT_MAX_ITERATIONS_MIN) {
    console.warn(`[tangu] agent ${def.slug}: config.toml max_iterations=${v} 低于下限 ${AGENT_MAX_ITERATIONS_MIN},忽略(回落默认 ${DEFAULT_MAX_ITERATIONS})`);
    return null;
  }
  return v;
}

export function buildAgentDef(slug: string, existing: NormalAgentDef | null, input: SaveAgentInput): NormalAgentDef {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  if (!input.name?.trim()) throw new Error('name required');
  // systemPrompt 仅**新建**必填;更新已有 agent(含上传头像 saveAgentAvatar 走的就是这条)允许空/省略 → 保留原值。
  // 否则 systemPrompt 恰为空(或配置损坏读成空)的 agent 会被彻底锁死,连头像都改不了。
  if (!existing && !input.systemPrompt?.trim()) throw new Error('systemPrompt required');
  const def: NormalAgentDef = {
    slug,
    enabledSkillIds: input.enabledSkillIds === undefined ? existing?.enabledSkillIds : input.enabledSkillIds === null ? undefined : [...new Set(input.enabledSkillIds.filter((v) => typeof v === 'string' && v.trim()))].slice(0, 500),
    enabledMcpServers: input.enabledMcpServers === undefined ? existing?.enabledMcpServers : input.enabledMcpServers === null ? undefined : [...new Set(input.enabledMcpServers.filter((v) => typeof v === 'string' && v.trim()))].slice(0, 200),
    name: input.name.trim().slice(0, 120),
    version: existing?.version || '1.0.0', // 保留原版本;新建默认 1.0.0
    description: (input.description || '').trim().slice(0, 300),
    model: (input.model || '').trim(),
    tools: Array.isArray(input.tools) ? input.tools.filter((t) => typeof t === 'string' && t.trim()).slice(0, 100) : [],
    thinkingLevel: THINK.includes(input.thinkingLevel as ThinkLevel) ? (input.thinkingLevel as ThinkLevel) : '',
    maxIterations: clampAgentMaxIterations(slug, input.maxIterations),
    approvalMode: APPROVAL.includes(input.approvalMode as ApprovalMode) ? (input.approvalMode as ApprovalMode) : '',
    createdBy: existing?.createdBy || input.createdBy || 'user',
    createdAt: existing?.createdAt || new Date().toISOString(),
    systemPrompt: (input.systemPrompt != null ? String(input.systemPrompt) : existing?.systemPrompt || '').trim().slice(0, 100_000),
    soul: (input.soul != null ? String(input.soul) : existing?.soul || '').slice(0, 100_000),
    libraryOrder: existing?.libraryOrder || [],
    apps: existing?.apps,
    compaction: existing?.compaction,
    avatar: input.avatar !== undefined ? (input.avatar ? String(input.avatar) : undefined) : existing?.avatar,
    shareDefaultMemory: input.shareDefaultMemory !== undefined ? input.shareDefaultMemory : existing?.shareDefaultMemory,
    cloudSync: input.cloudSync !== undefined ? input.cloudSync : existing?.cloudSync,
    activityAccess: input.activityAccess !== undefined ? input.activityAccess : existing?.activityAccess,
    toolsMode: input.toolsMode !== undefined
      ? (input.toolsMode === 'allow' || input.toolsMode === 'deny' ? input.toolsMode : undefined)
      : existing?.toolsMode,
    toolsList: input.toolsList !== undefined
      ? (Array.isArray(input.toolsList)
        ? input.toolsList.filter((t) => typeof t === 'string' && t.trim()).slice(0, 200)
        : undefined)
      : existing?.toolsList,
  };
  return def;
}

/** 新建/更新一个 agent(落盘 <slug>/config.toml + SOUL.md)。保留已有 createdAt/createdBy/libraryOrder,绝不动 MEMORY/LOG/Library。 */
export async function saveAgent(input: SaveAgentInput): Promise<NormalAgentDef> {
  const slug = input.slug && isValidSlug(input.slug) ? input.slug : slugify(input.name);
  const existing = await getAgent(slug);
  const def = buildAgentDef(slug, existing, input);
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

// ── 头像(存进该 agent 的 Library/,config.avatar 引用;≤1MB)。常量导出供云端 cloudAgentStore 共用。──
export const AVATAR_MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};
export const AVATAR_EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
export const AVATAR_MAX_BYTES = 1_048_576; // 1MB

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
  if (builtinAgentAvatar(slug)) await fs.rm(avatarRemovedMarker(slug), { force: true });
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
  // 内置头像均尊重用户显式删除。
  if (builtinAgentAvatar(slug)) {
    await fs.writeFile(avatarRemovedMarker(slug), new Date().toISOString(), 'utf-8').catch(() => { /* ignore */ });
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

export function libDirOf(slug: string): string {
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
