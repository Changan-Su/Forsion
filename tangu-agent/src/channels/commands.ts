/**
 * 通道(微信 / Telegram / QQ)的 slash 命令面:解析 + 分发 + 回复文案。
 *
 * 目录单源:能用哪些命令、叫什么、描述是什么,全来自 core/commandCatalog.ts 里 surfaces 含 'channel' 的条目;
 * 这里只补通道特有的东西 —— 旧别名(/n /ls /sw /切换 …)、纯文本交互(编号列表 + 回数字)、以及通道
 * 不能照搬桌面语义的几条(/approval 只读、/agent 不带管理子命令)。
 *
 * 依赖全部经 ChannelCommandRuntime 注入(service.ts 造真的,测试给假的):本文件不碰 DB / agentLoop,
 * 也不 import service.ts(那会成环)。
 *
 * 口径:
 *   - 所有命令作用于该 peer 当前连接的会话;改模型 / 思考档 / 轮数从**下一条消息**起生效
 *     (已在跑或排队的 run 在 createRun 时定格了 modelId 与 agentConfig)。思考档例外:正在跑的 run 经
 *     requestRunThinking 在下一次请求前取走覆盖值。
 *   - 审批档**绝不**能从通道改:通道消息没有发送者身份,群聊里谁都能发 /approval full-auto。
 *   - 未知的 /x 一律回「未知命令」,绝不当普通消息转给模型(模型会据此编工具调用,hermes 同款理由)。
 */
import { APPROVAL_MODE_META, canonicalCommandName, commandsFor, type CommandSpec } from '../core/commandCatalog.js';
import { THINKING_LEVELS, normalizeThinkingLevel, type ThinkingLevel } from '../llm/modelCapabilities.js';
import { effectiveThinkingOn, resolveModelQuery, type CatalogModel } from '../services/modelCatalog.js';
import type { NormalAgentDef } from '../agents/agentRegistry.js';
import { channelMsg, clipReply, type ChannelLocale } from './messages.js';
import type { ApprovalMode, ChannelKind } from './types.js';

/** 列表回数字的有效期(/model 列出后 10 分钟内回「3」即选第 3 个)。 */
export const PICK_TTL_MS = 10 * 60_000;
/** /model 列表最多列几条(再多就提示用关键词筛;微信单条 ~2000 字)。 */
const MAX_LISTED_MODELS = 30;
/** 列表正文的字符预算(留给表头 / 提示两三百字)。 */
const LIST_BUDGET = 1300;
const MAX_LISTED_SESSIONS = 20;

// ── 解析 ──────────────────────────────────────────────────────────────────

/**
 * 通道历史别名 → 目录正名。目录里的别名(/list /switch /effort /permissions …)由 canonicalCommandName 处理,
 * 这里只收目录没有的:旧通道的缩写与中文命令(微信用户打中文最顺手)。
 */
const LEGACY_ALIASES: Record<string, string> = {
  '/n': '/new', '/新建': '/new',
  '/ls': '/sessions', '/列表': '/sessions',
  '/sw': '/resume', '/切换': '/resume',
  '/h': '/help', '/帮助': '/help', '/?': '/help', '/？': '/help',
  '/语音': '/voice', '/文字': '/text',
  '/agentlist': '/agents',
  '/停止': '/stop', '/模型': '/model', '/状态': '/status',
};

const CHANNEL_COMMANDS = commandsFor('channel');
const CHANNEL_COMMAND_NAMES = new Set(CHANNEL_COMMANDS.map((c) => c.name));

export interface ParsedChannelCommand {
  /** 目录正名(如 /think);不是通道命令 → null(调用方回「未知命令」)。 */
  name: string | null;
  /** 用户敲的命令词(小写、去掉 @bot 后缀),回显用。 */
  token: string;
  arg: string;
}

/** 入站文本归一:全角空格 → 半角、首尾去空白、全角斜杠「／」→ `/`(中文输入法常打出全角)。 */
export function normalizeChannelText(text: string): string {
  return String(text ?? '').replace(/　/g, ' ').trim().replace(/^／/, '/');
}

/** 解析 slash 命令;不以 / 开头 → null。Telegram 群里的 `/model@MyBot opus` 会去掉 `@MyBot`。 */
export function parseChannelCommand(text: string): ParsedChannelCommand | null {
  const t = normalizeChannelText(text);
  if (!t.startsWith('/')) return null;
  const m = /^(\S+)\s*([\s\S]*)$/.exec(t);
  const token = (m?.[1] || '/').toLowerCase().replace(/@[a-z0-9_]+$/i, '');
  const canonical = canonicalCommandName(LEGACY_ALIASES[token] || token);
  return { name: CHANNEL_COMMAND_NAMES.has(canonical) ? canonical : null, token, arg: (m?.[2] || '').trim() };
}

// ── /help ────────────────────────────────────────────────────────────────

/** 通道语义与目录描述不一致的几条(目录描述是 TUI / 桌面的)。 */
const CHANNEL_DESC: Record<string, { zh: string; en: string }> = {
  '/approval': { zh: '查看审批档(只能在桌面端的通道设置里改)', en: 'Show the approval mode (change it in the desktop channel settings)' },
  '/agent': { zh: '切换本会话的 Agent', en: 'Switch the agent for this session' },
  '/resume': { zh: '切换正在连接的会话', en: 'Switch the connected session' },
};
/** 参数提示覆盖(null = 通道里不带参数)。 */
const CHANNEL_ARG: Record<string, { zh: string; en: string } | null> = {
  '/approval': null,
  '/resume': { zh: '<序号|id>', en: '<number|id>' },
  '/think': { zh: '[档位]', en: '[level]' },
  '/loop': { zh: '[1-200]', en: '[1-200]' },
};
/** 目录参数提示是中文的,英文界面换成这些。 */
const ARG_EN: Record<string, string> = {
  '[关注点]': '[focus]', '[名称|序号]': '[name|number]', '<档位>': '<level>', '<id|序号>': '<id|number>',
  '<标题>': '<title>', '[序号]': '[number]', '[问题]': '[question]',
};

function argHint(c: CommandSpec, locale: ChannelLocale): string {
  if (c.name in CHANNEL_ARG) return CHANNEL_ARG[c.name]?.[locale] ?? '';
  if (!c.arg) return '';
  if (locale === 'zh') return c.arg;
  return ARG_EN[c.arg] ?? (/[一-鿿]/.test(c.arg) ? '' : c.arg);
}

/** /help:从目录生成(按当前语言出一种),外加三个裸关键词。 */
export function channelHelp(locale: ChannelLocale): string {
  const lines = CHANNEL_COMMANDS.map((c) => {
    const arg = argHint(c, locale);
    const aliases = c.aliases?.length ? ` (${c.aliases.join(' ')})` : '';
    return `${c.name}${arg ? ` ${arg}` : ''}${aliases} — ${CHANNEL_DESC[c.name]?.[locale] ?? c[locale]}`;
  });
  return clipReply([
    channelMsg(locale, 'helpTitle'), ...lines, '',
    channelMsg(locale, 'helpStop'), channelMsg(locale, 'helpApprove'), '',
    channelMsg(locale, 'helpNatural'),
  ].join('\n'));
}

// ── 运行时接缝 ────────────────────────────────────────────────────────────

export interface ChannelSessionView {
  modelId: string;
  title: string;
  agentConfig: Record<string, unknown>;
}

export interface ChannelUsage { tokens: number; runs: number; cost: number | null; cached: number }

/** 命令需要的全部外部能力(service.ts 实现;测试给假的)。 */
export interface ChannelCommandRuntime {
  kind: ChannelKind;
  locale: ChannelLocale;
  /** 通道 run 实际用的审批档(通道设置与绑定取更严的一档,见 service.channelRunApprovalMode)。 */
  approvalMode: ApprovalMode;
  /** 通道设置里的默认 Agent / 模型('' = 未设)。 */
  channelDefaults(): { agentSlug: string; modelId: string };
  /** 用户全局默认 Agent(通道默认也没设时兜底)。 */
  defaultAgentSlug(): string;
  /** 通道工作区目录(会话没存 cwd 时的兜底)。 */
  workspaceDir(): string;
  readSession(): Promise<ChannelSessionView | null>;
  patchConfig(patch: Record<string, unknown>): Promise<unknown>;
  setModel(modelId: string): Promise<void>;
  /** 能聊天的模型(chatModels(listModelCatalog(profile)),profile = 通道 run 用的那个)。 */
  listModels(): Promise<CatalogModel[]>;
  listAgents(): Promise<NormalAgentDef[]>;
  getAgent(slug: string): Promise<NormalAgentDef | null>;
  /** Agent 定义里生效的轮数上限(套过下限;null = 没设或被忽略)。 */
  agentLoopCap(def: NormalAgentDef): number | null;
  defaultLoopCap: number;
  newSession(title?: string): Promise<void>;
  listSessions(): Promise<Array<{ id: string; title: string; connected: boolean }>>;
  connectSession(sessionId: string): Promise<void>;
  compact(focus: string, modelId: string, agentConfig: Record<string, unknown>): Promise<{ ok: boolean; summarizedCount?: number; reason?: string }>;
  usage(): Promise<ChannelUsage>;
  /** 会话上有任何 run(含桌面发起的)或子代理在跑。 */
  sessionBusy(): boolean;
  /** 本 peer 发起、尚未结束的 run(在跑 + 排队)。 */
  peerRunIds(): string[];
  /** 停掉本 peer 的全部 run,返回停了几个。 */
  stopPeer(): number;
  /** 队首(正显示在聊天里等回复)的卡片是审批还是询问。 */
  pendingState(): { approval: boolean; inquiry: boolean };
  requestRunThinking(runId: string, level: ThinkingLevel): void;
  saveDefaultModel(modelId: string): void;
  setVoice(on: boolean, agentSlug: string): Promise<void>;
}

// ── 小工具 ────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const errMsg = (e: unknown): string => String((e as any)?.message || e);

function currentAgentSlug(rt: ChannelCommandRuntime, cfg: Record<string, unknown>): string {
  return str(cfg.agentSlug) || rt.channelDefaults().agentSlug || rt.defaultAgentSlug();
}

/** 请求的思考档:会话存值 → Agent 定义 → 引擎默认 medium(与 agentLoop / agentActivation 同一优先级)。 */
function requestedThinking(cfg: Record<string, unknown>, def: NormalAgentDef | null): ThinkingLevel {
  if (cfg.thinkingLevel != null && cfg.thinkingLevel !== '') return normalizeThinkingLevel(cfg.thinkingLevel, 'medium');
  if (def?.thinkingLevel) return normalizeThinkingLevel(def.thinkingLevel, 'medium');
  return 'medium';
}

/** 会话级轮数(与 agentLoop 同样的归一:非正数 / 非数 = 没设)。 */
function sessionLoop(cfg: Record<string, unknown>): number | null {
  const n = Number(cfg.maxIterations);
  return Number.isFinite(n) && n > 0 ? Math.min(200, Math.max(1, Math.floor(n))) : null;
}

const modelLabel = (m: CatalogModel): string => (m.source === 'direct' ? `${m.name || m.id} [${m.provider}]` : m.name || m.id);

/** 编号列表:条数与字符预算双封顶,返回列出的行。 */
function numbered<T>(items: T[], label: (it: T) => string, current: (it: T) => boolean, max: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < items.length && i < max; i++) {
    const line = `${i + 1}. ${current(items[i]) ? '● ' : ''}${label(items[i])}`;
    if (used + line.length + 1 > LIST_BUDGET) break;
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

async function safeGetAgent(rt: ChannelCommandRuntime, slug: string): Promise<NormalAgentDef | null> {
  return slug ? rt.getAgent(slug).catch(() => null) : null;
}

export function stopReply(locale: ChannelLocale, stopped: number): string {
  if (stopped <= 0) return channelMsg(locale, 'stopNone');
  return stopped === 1 ? channelMsg(locale, 'stopOne') : channelMsg(locale, 'stopMany', { n: stopped });
}

function approvalLine(locale: ChannelLocale, mode: ApprovalMode): { label: string; desc: string } {
  const meta = APPROVAL_MODE_META[mode] ?? APPROVAL_MODE_META.readonly; // 不认识的档按只读报(与引擎 fail-closed 同口径),不报成更宽的
  return locale === 'zh' ? { label: meta.zh, desc: meta.descZh } : { label: meta.en, desc: meta.descEn };
}

// ── 命令中心 ──────────────────────────────────────────────────────────────

/**
 * 每个通道服务一个实例:持有「刚列出的编号列表」(peer → 模型 id 列表 + 过期时刻),其余状态都在 runtime 里。
 */
export class ChannelCommandCenter {
  private readonly picks = new Map<string, { ids: string[]; expiresAt: number }>();

  private remember(key: string, ids: string[]): void {
    this.picks.set(key, { ids, expiresAt: Date.now() + PICK_TTL_MS });
  }
  private recall(key: string): string[] | null {
    const p = this.picks.get(key);
    if (!p) return null;
    if (p.expiresAt <= Date.now()) { this.picks.delete(key); return null; }
    return p.ids;
  }
  forget(key: string): void { this.picks.delete(key); }

  /**
   * 纯数字消息:10 分钟内刚列过模型 → 按序号选。没有待选列表 → null(调用方当普通消息)。
   * 调用方负责「有待批 / 待答时不走这里」(那时的数字属于它们)。
   */
  async tryPickNumber(rt: ChannelCommandRuntime, key: string, text: string): Promise<string | null> {
    if (!/^\d{1,3}$/.test(text) || !this.recall(key)) return null;
    return this.run(rt, () => this.cmdModel(rt, key, text));
  }

  async dispatch(rt: ChannelCommandRuntime, key: string, cmd: ParsedChannelCommand): Promise<string> {
    const L = rt.locale;
    if (!cmd.name) return channelMsg(L, 'unknownCommand', { cmd: cmd.token.length > 32 ? `${cmd.token.slice(0, 32)}…` : cmd.token });
    return this.run(rt, async () => {
      switch (cmd.name) {
        case '/help': return channelHelp(L);
        case '/stop': return stopReply(L, rt.stopPeer());
        case '/new': await rt.newSession(cmd.arg || undefined); this.forget(key); return channelMsg(L, 'newDone');
        case '/sessions': return this.cmdSessions(rt);
        case '/resume': return this.cmdResume(rt, cmd.arg);
        case '/status': return this.cmdStatus(rt);
        case '/model': return this.cmdModel(rt, key, cmd.arg);
        case '/think': return this.cmdThink(rt, cmd.arg);
        case '/approval': {
          const a = approvalLine(L, rt.approvalMode);
          return channelMsg(L, 'approvalShow', { label: a.label, desc: a.desc });
        }
        case '/loop': return this.cmdLoop(rt, cmd.arg);
        case '/compact': return this.cmdCompact(rt, cmd.arg);
        case '/cost': return this.cmdCost(rt);
        case '/agents': return this.cmdAgents(rt);
        case '/agent': return this.cmdAgent(rt, cmd.arg);
        case '/voice': case '/text': return this.cmdVoice(rt, cmd.name === '/voice');
        default: return channelMsg(L, 'unknownCommand', { cmd: cmd.token });
      }
    });
  }

  /** 命令抛错统一成一句可读回复(DB / 目录拉取失败别让驱动收到 reject)。 */
  private async run(rt: ChannelCommandRuntime, fn: () => Promise<string>): Promise<string> {
    try {
      return clipReply(await fn());
    } catch (e) {
      console.warn(`[${rt.kind}-channel] 命令执行失败:`, e);
      return channelMsg(rt.locale, 'commandFailed', { error: errMsg(e) });
    }
  }

  // ── 会话 ──

  private async cmdSessions(rt: ChannelCommandRuntime): Promise<string> {
    const L = rt.locale;
    const items = await rt.listSessions();
    if (!items.length) return channelMsg(L, 'sessionsEmpty');
    const lines = numbered(items, (s) => s.title || channelMsg(L, 'untitled'), (s) => s.connected, MAX_LISTED_SESSIONS);
    if (lines.length < items.length) lines.push(channelMsg(L, 'listMore', { n: items.length - lines.length }));
    return channelMsg(L, 'sessionsList', { lines: lines.join('\n') });
  }

  private async cmdResume(rt: ChannelCommandRuntime, arg: string): Promise<string> {
    const L = rt.locale;
    if (!arg) return this.cmdSessions(rt);
    const items = await rt.listSessions();
    const n = /^\d+$/.test(arg) ? Number(arg) : NaN;
    // 序号优先;否则按会话 id(前缀 ≥ 4 位,唯一命中才算)
    let idx = Number.isFinite(n) && n >= 1 && n <= items.length ? n - 1 : -1;
    if (idx < 0 && arg.length >= 4) {
      const hits = items.map((s, i) => (s.id.startsWith(arg) ? i : -1)).filter((i) => i >= 0);
      if (hits.length === 1) idx = hits[0];
    }
    if (idx < 0) return channelMsg(L, 'resumeInvalid', { n: items.length });
    await rt.connectSession(items[idx].id);
    return channelMsg(L, 'resumeDone', { n: idx + 1, title: items[idx].title || channelMsg(L, 'untitled') });
  }

  // ── /status ──

  private async cmdStatus(rt: ChannelCommandRuntime): Promise<string> {
    const L = rt.locale;
    const s = await rt.readSession();
    if (!s) return channelMsg(L, 'sessionMissing');
    const cfg = s.agentConfig;
    const slug = currentAgentSlug(rt, cfg);
    const def = await safeGetAgent(rt, slug);
    const modelId = s.modelId || rt.channelDefaults().modelId;
    const models = await rt.listModels().catch(() => [] as CatalogModel[]);
    const m = models.find((x) => x.id === modelId);
    const req = requestedThinking(cfg, def);
    const eff = m?.thinkingLevels?.length ? effectiveThinkingOn(req, m.thinkingLevels) : req;
    const a = approvalLine(L, rt.approvalMode);
    const loop = this.loopInfo(rt, cfg, def);
    const usage = await rt.usage().catch(() => null);
    const ps = rt.pendingState();
    const runs = rt.peerRunIds().length;
    // 桌面端在同一会话上发起的任务不在 peerRunIds 里,但 /compact 会因它拒绝 —— 这里也不能报「空闲」。
    const state = ps.approval ? channelMsg(L, 'stateApproval')
      : ps.inquiry ? channelMsg(L, 'stateInquiry')
      : runs ? channelMsg(L, 'stateRuns', { n: runs })
      : rt.sessionBusy() ? channelMsg(L, 'stateBusy')
      : channelMsg(L, 'stateIdle');
    return [
      channelMsg(L, 'statusTitle'),
      channelMsg(L, 'statusSession', { v: s.title || channelMsg(L, 'untitled') }),
      channelMsg(L, 'statusAgent', { v: def?.name && def.name !== slug ? `${def.name} (${slug})` : slug }),
      channelMsg(L, 'statusModel', { v: !modelId ? channelMsg(L, 'statusModelUnset') : m && m.name && m.name !== modelId ? `${modelLabel(m)} (${modelId})` : modelId }),
      channelMsg(L, 'statusThink', { v: `${req}${eff !== req ? channelMsg(L, 'thinkEff', { eff }) : ''}` }),
      channelMsg(L, 'statusApproval', { v: `${a.label} — ${a.desc}` }),
      channelMsg(L, 'statusLoop', { v: `${loop.n} (${loop.source})` }),
      channelMsg(L, 'statusCwd', { v: str(cfg.cwd) || rt.workspaceDir() }),
      ...(usage ? [channelMsg(L, 'statusUsage', { v: Math.round(usage.tokens).toLocaleString('en-US') })] : []),
      channelMsg(L, 'statusState', { v: state }),
    ].join('\n');
  }

  // ── /model ──

  private async cmdModel(rt: ChannelCommandRuntime, key: string, arg: string): Promise<string> {
    const L = rt.locale;
    const words = arg.split(/\s+/).filter(Boolean);
    const isDefaultFlag = (w: string): boolean => /^(--default|--默认|默认)$/i.test(w);
    const saveDefault = words.some(isDefaultFlag);
    const q = words.filter((w) => !isDefaultFlag(w)).join(' ');
    const s = await rt.readSession();
    if (!s) return channelMsg(L, 'sessionMissing');
    let models: CatalogModel[];
    try {
      models = await rt.listModels();
    } catch (e) {
      return channelMsg(L, 'modelFailed', { error: errMsg(e) });
    }
    const cur = s.modelId || rt.channelDefaults().modelId;

    if (!q) {
      if (saveDefault && cur) {
        rt.saveDefaultModel(cur);
        const m = models.find((x) => x.id === cur);
        return `${channelMsg(L, 'modelSame', { model: m ? modelLabel(m) : cur })}\n${channelMsg(L, 'modelDefaultSaved')}`;
      }
      if (!models.length) return channelMsg(L, 'modelEmpty');
      this.remember(key, models.map((m) => m.id));
      const lines = numbered(models, modelLabel, (m) => m.id === cur, MAX_LISTED_MODELS);
      const out = [channelMsg(L, 'modelListHead', { n: models.length }), ...lines];
      if (lines.length < models.length) out.push(channelMsg(L, 'modelListMore', { n: models.length - lines.length }));
      out.push('', channelMsg(L, 'modelListHint'));
      return out.join('\n');
    }

    if (/^\d{1,3}$/.test(q)) {
      const ids = this.recall(key) ?? models.map((m) => m.id);
      const n = Number(q);
      if (n < 1 || n > ids.length) return channelMsg(L, 'modelIndexInvalid', { n: ids.length });
      const target = models.find((m) => m.id === ids[n - 1]);
      if (!target) return channelMsg(L, 'modelNone', { q: ids[n - 1] }); // 列表之后目录变了
      return this.applyModel(rt, key, s, target, saveDefault);
    }

    const hit = resolveModelQuery(q, models);
    if (hit.kind === 'none') return channelMsg(L, 'modelNone', { q });
    if (hit.kind === 'ambiguous') {
      this.remember(key, hit.candidates.map((m) => m.id));
      const lines = numbered(hit.candidates, modelLabel, (m) => m.id === cur, MAX_LISTED_MODELS);
      if (lines.length < hit.candidates.length) lines.push(channelMsg(L, 'listMore', { n: hit.candidates.length - lines.length }));
      return channelMsg(L, 'modelAmbiguous', { q, lines: lines.join('\n') });
    }
    return this.applyModel(rt, key, s, hit.model, saveDefault);
  }

  private async applyModel(rt: ChannelCommandRuntime, key: string, s: ChannelSessionView, target: CatalogModel, saveDefault: boolean): Promise<string> {
    const L = rt.locale;
    this.forget(key);
    const name = modelLabel(target);
    const out: string[] = [];
    if (target.id === s.modelId) {
      out.push(channelMsg(L, 'modelSame', { model: name }));
    } else {
      await rt.setModel(target.id);
      out.push(channelMsg(L, 'modelSet', { model: name }));
      if (rt.peerRunIds().length || rt.sessionBusy()) out.push(channelMsg(L, 'modelBusy'));
      const req = requestedThinking(s.agentConfig, await safeGetAgent(rt, currentAgentSlug(rt, s.agentConfig)));
      const eff = effectiveThinkingOn(req, target.thinkingLevels);
      if (eff !== req) out.push(channelMsg(L, 'modelThinkClamp', { req, eff }));
    }
    if (saveDefault) {
      rt.saveDefaultModel(target.id);
      out.push(channelMsg(L, 'modelDefaultSaved'));
    }
    return out.join('\n');
  }

  // ── /think ──

  private async cmdThink(rt: ChannelCommandRuntime, arg: string): Promise<string> {
    const L = rt.locale;
    const s = await rt.readSession();
    if (!s) return channelMsg(L, 'sessionMissing');
    const modelId = s.modelId || rt.channelDefaults().modelId;
    const models = await rt.listModels().catch(() => [] as CatalogModel[]);
    const levels = models.find((m) => m.id === modelId)?.thinkingLevels;
    const effNote = (lv: ThinkingLevel): string => {
      const eff = effectiveThinkingOn(lv, levels);
      return eff !== lv ? channelMsg(L, 'thinkEff', { eff }) : '';
    };
    if (!arg) {
      const req = requestedThinking(s.agentConfig, await safeGetAgent(rt, currentAgentSlug(rt, s.agentConfig)));
      return channelMsg(L, 'thinkShow', {
        req, eff: effNote(req),
        levels: levels?.length ? levels.join(' / ') : channelMsg(L, 'thinkUnknownLevels'),
        all: THINKING_LEVELS.join('|'),
      });
    }
    // 两个不同兜底归一出同一档 = 认得这个写法(none / ultra 等别名也收);否则报错,不静默落兜底(与 update_session_settings 同法)
    const level = normalizeThinkingLevel(arg, 'off');
    if (level !== normalizeThinkingLevel(arg, 'max')) return channelMsg(L, 'thinkInvalid', { v: arg, all: THINKING_LEVELS.join(', ') });
    await rt.patchConfig({ thinkingLevel: level });
    const live = rt.peerRunIds();
    for (const id of live) rt.requestRunThinking(id, level);
    return channelMsg(L, live.length ? 'thinkSetLive' : 'thinkSet', { level, eff: effNote(level) });
  }

  // ── /loop ──

  private loopInfo(rt: ChannelCommandRuntime, cfg: Record<string, unknown>, def: NormalAgentDef | null): { n: number; source: string } {
    const L = rt.locale;
    const own = sessionLoop(cfg);
    if (own != null) return { n: own, source: channelMsg(L, 'loopSrcSession') };
    const cap = def ? rt.agentLoopCap(def) : null;
    if (cap != null) return { n: Math.min(200, cap), source: channelMsg(L, 'loopSrcAgent', { slug: def!.slug }) };
    return { n: rt.defaultLoopCap, source: channelMsg(L, 'loopSrcDefault') };
  }

  private async cmdLoop(rt: ChannelCommandRuntime, arg: string): Promise<string> {
    const L = rt.locale;
    const s = await rt.readSession();
    if (!s) return channelMsg(L, 'sessionMissing');
    const def = await safeGetAgent(rt, currentAgentSlug(rt, s.agentConfig));
    if (!arg) {
      const info = this.loopInfo(rt, s.agentConfig, def);
      return channelMsg(L, 'loopShow', { n: info.n, source: info.source });
    }
    if (/^(default|reset|off|默认|恢复默认)$/i.test(arg)) {
      await rt.patchConfig({ maxIterations: null });
      return channelMsg(L, 'loopReset', { n: this.loopInfo(rt, {}, def).n });
    }
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > 200) return channelMsg(L, 'loopInvalid');
    await rt.patchConfig({ maxIterations: n });
    return channelMsg(L, 'loopSet', { n });
  }

  // ── /compact /cost ──

  private async cmdCompact(rt: ChannelCommandRuntime, focus: string): Promise<string> {
    const L = rt.locale;
    // 与桌面 POST /agent/sessions/:id/compact 同一拒绝条件:在途 run 正往 chat_messages 落段
    if (rt.sessionBusy() || rt.peerRunIds().length) return channelMsg(L, 'compactBusy');
    const s = await rt.readSession();
    if (!s) return channelMsg(L, 'sessionMissing');
    const modelId = s.modelId || rt.channelDefaults().modelId;
    if (!modelId) return channelMsg(L, 'noModel');
    const r = await rt.compact(focus.slice(0, 2000), modelId, s.agentConfig);
    if (!r.ok) return r.reason === 'nothing to compact' ? channelMsg(L, 'compactNothing') : channelMsg(L, 'compactFailed', { reason: r.reason || 'unknown' });
    return channelMsg(L, 'compactDone', { n: r.summarizedCount ?? 0 });
  }

  private async cmdCost(rt: ChannelCommandRuntime): Promise<string> {
    const L = rt.locale;
    const u = await rt.usage();
    const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
    return channelMsg(L, 'costShow', {
      tokens: fmt(u.tokens),
      runs: u.runs,
      cost: u.cost != null && u.cost > 0 ? channelMsg(L, 'costPart', { cost: u.cost.toFixed(4) }) : '',
      cached: u.cached > 0 ? channelMsg(L, 'cachedPart', { cached: fmt(u.cached) }) : '',
    });
  }

  // ── Agent / 语音 ──

  private async cmdAgents(rt: ChannelCommandRuntime): Promise<string> {
    const L = rt.locale;
    const all = await rt.listAgents();
    if (!all.length) return channelMsg(L, 'agentsEmpty');
    const s = await rt.readSession();
    const cur = currentAgentSlug(rt, s?.agentConfig || {});
    const lines = all.map((a) => `${a.slug === cur ? '● ' : ''}${a.slug} — ${a.name}`);
    return channelMsg(L, 'agentsList', { lines: lines.join('\n') });
  }

  /** 切 Agent:写 agentSlug;Agent 定义带了模型 → 本会话模型也跟着切(与桌面激活 Agent 同口径)。 */
  private async cmdAgent(rt: ChannelCommandRuntime, arg: string): Promise<string> {
    const L = rt.locale;
    if (!arg) return channelMsg(L, 'agentUsage');
    const def = await rt.getAgent(arg);
    if (!def) return channelMsg(L, 'agentNotFound', { slug: arg });
    const s = await rt.readSession();
    if (!s) return channelMsg(L, 'sessionMissing');
    await rt.patchConfig({ agentSlug: def.slug });
    const out = [channelMsg(L, 'agentDone', { name: def.name, slug: def.slug })];
    const model = str(def.model);
    if (model && model !== s.modelId) {
      await rt.setModel(model);
      out.push(channelMsg(L, 'agentModel', { model }));
    }
    return out.join('\n');
  }

  private async cmdVoice(rt: ChannelCommandRuntime, on: boolean): Promise<string> {
    const L = rt.locale;
    const s = await rt.readSession();
    try {
      await rt.setVoice(on, currentAgentSlug(rt, s?.agentConfig || {}));
    } catch (e) {
      return channelMsg(L, 'toggleFailed', { error: errMsg(e) });
    }
    return channelMsg(L, on ? 'voiceOn' : 'voiceOff');
  }
}
