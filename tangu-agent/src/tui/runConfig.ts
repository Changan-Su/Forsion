/**
 * TUI 运行配置的纯逻辑:slash 解析、run 的 agentConfig 与会话存值、/resume 恢复、/agent 激活、
 * 完全放行确认、/model 参数解析、插话认领 / 收尾抢救、起 run 的中止窗口。
 *
 * 从 app.tsx 抽出来是为了「改回去就红」—— 这些分支跑偏时既不报类型错也不崩,只是静默做错事。
 * 单测见 tui.commands.test.ts。
 */
import { canonicalCommandName, APPROVAL_MODE_IDS } from '../core/commandCatalog.js';
import { isThinkingLevel, normalizeThinkingLevel } from '../llm/modelCapabilities.js';
import { resolveModelQuery, type CatalogModel } from '../services/modelCatalog.js';
import type { NormalAgentDef } from '../agents/agentRegistry.js';
import type { ThinkingLevel } from '../core/types.js';
import type { ApprovalMode } from './types.js';
import type { PickerItem } from './picker.js';
import { L } from './i18n.js';

export interface MutableConfig {
  model: string;
  cwd: string;
  execMode: 'host' | 'sandbox';
  approvalMode: ApprovalMode;
  tokenBudget?: number;
  thinkingLevel: ThinkingLevel;
  seedSystem?: string;
  /** 最大循环轮数(/loop 调节;缺省由后端取默认 90,后端 clamp 1-200)。 */
  maxIterations?: number;
  /** 计划模式(/plan 切换):只读工具集 + exit_plan_mode,批准后自动关闭。 */
  planMode?: boolean;
  /** 本会话启用的技能 id(/skill <id> 切换;/skills 列出)。 */
  enabledSkillIds?: string[];
  /** 当前启用的 Normal Agent slug(/agent <slug>;仅用于 /agents 显示 ✓,seedSystem 已注入)。 */
  activeAgentSlug?: string;
}

/** 运行中发出的消息:steer(已交引擎、等注入)或 follow-up(引擎暂不收,等运行结束自动发)。 */
export interface QueuedMessage {
  id: string;
  /** 用户气泡显示的原文。 */
  display: string;
  /** 真正发给模型的内容(@文件 已展开)。 */
  message: string;
}

export const isApprovalMode = (v: unknown): v is ApprovalMode => typeof v === 'string' && (APPROVAL_MODE_IDS as string[]).includes(v);

/**
 * TUI 自己的审批档存在会话 agent_config 的这个键里,**不写** `approvalMode`:
 * 后者是桌面输入区 run 审批时现读的共享档(approvals.ts storedApprovalMode)—— TUI 写它,
 * 桌面同一会话正在跑的 run 当场被改档(TUI 的 full-auto 放开桌面、TUI 的 auto-edit 让桌面沙箱会话突然弹审批)。
 * 引擎口径本就是「TUI / 通道各自定档」,这里把反方向也堵上:TUI 的档只供 TUI 自己 /resume 恢复。
 */
export const TUI_APPROVAL_KEY = 'tuiApprovalMode';

/** 切到 full-auto(且当前不是)才要多一道确认;其余档直接切。 */
export const needsFullAutoConfirm = (current: ApprovalMode, next: ApprovalMode): boolean => next === 'full-auto' && current !== 'full-auto';

/** 引擎会话存值里的轮数 → 合法值(与 agentLoop 归一同口径);非法 / 缺省 → undefined(走默认)。 */
export const storedMaxIterations = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(200, Math.max(1, Math.floor(n))) : undefined;
};

/** `/effort high` → { cmd: '/think', rest: 'high' }。别名归一在这里做,runSlash 只认正名。 */
export function parseSlash(line: string): { cmd: string; rest: string } {
  const t = line.trim();
  const sp = t.search(/\s/);
  const raw = (sp >= 0 ? t.slice(0, sp) : t).toLowerCase();
  return { cmd: canonicalCommandName(raw), rest: sp >= 0 ? t.slice(sp + 1).trim() : '' };
}

/** 随 run 下发的 agentConfig(引擎按它定档;不读会话存值 —— 见 agentLoop approvalModeSessionId)。 */
export function buildRunAgentConfig(c: MutableConfig, groupAgents: string[] | null): Record<string, unknown> {
  // thinkingLevel 显式下发,**含 off**:缺键时引擎回落默认 medium(旧版这里跳过 off → /think off 从不生效)。
  const ac: Record<string, unknown> = { execMode: c.execMode, cwd: c.cwd, approvalMode: c.approvalMode, thinkingLevel: c.thinkingLevel };
  if (c.seedSystem) ac.systemPrompt = c.seedSystem;
  if (c.tokenBudget) ac.tokenBudget = c.tokenBudget;
  if (c.maxIterations) ac.maxIterations = c.maxIterations;
  if (c.planMode) ac.planMode = true;
  if (c.enabledSkillIds?.length) ac.enabledSkillIds = c.enabledSkillIds;
  // 激活的 Normal Agent 身份必须随 run 下发:少了它,引擎把身份解析成默认 agent(xyra)——
  // 记忆/HARNESS/agent 级技能全落错文件夹,manage_agent 的「不能改自己人格」守卫也拦不住自己
  // (Codex 复核 #2)。persona/model 等 TUI 已显式带上,引擎激活 only-if-unset 不会双重注入。
  if (c.activeAgentSlug) ac.agentSlug = c.activeAgentSlug;
  // 群聊就绪 → 本条消息走多 Agent 群聊(agentLoop 据 groupChat+capabilities.groupChat 分流到 runGroupChat)。
  if (groupAgents && groupAgents.length >= 2) {
    ac.groupChat = true;
    ac.groupAgents = groupAgents;
  }
  return ac;
}

/** 起 run 前写进会话的设置(按键合并;null = 删键)。审批档只写 TUI 专属键,见 TUI_APPROVAL_KEY。 */
export function runSessionPatch(c: MutableConfig): Record<string, unknown> {
  const p: Record<string, unknown> = {
    thinkingLevel: c.thinkingLevel,
    [TUI_APPROVAL_KEY]: c.approvalMode,
    planMode: c.planMode === true, // 关也写 false(不写 null):null = 删键,语义同关,但写死值更不怕与别端的 PATCH 交错
  };
  // 循环上限只写 TUI 自己设过的:写 null = 删键,会把同会话在桌面设的上限在 TUI 跑一轮时静默抹掉
  if (c.maxIterations != null) p.maxIterations = c.maxIterations;
  return p;
}

export interface SessionSettingsIO {
  /** 会话行不存在就建(INSERT … ON CONFLICT DO NOTHING):否则后面的 UPDATE 落空。 */
  ensure: (sid: string, model: string) => Promise<unknown>;
  /** agent_config 按键合并写(引擎侧 patchSessionAgentConfig,与桌面 PATCH 同锁)。 */
  patch: (sid: string, patch: Record<string, unknown>) => Promise<unknown>;
  /** chat_sessions.model_id。 */
  setModel: (sid: string, model: string) => Promise<unknown>;
}

export interface SessionSettingsWriter {
  /** 建会话行(启动 / /new):排进同一队列,紧跟着的 /think、/approval 不会先于建行落空。 */
  ensure(sid: string, model: string): Promise<void>;
  /** 起 run 前:建行 → 写本端设置(runSessionPatch)+ 模型。 */
  runStart(sid: string, c: MutableConfig): Promise<void>;
  /** /think、/approval 等单键改档。 */
  patch(sid: string, patch: Record<string, unknown>): Promise<void>;
  /** /model:建行 → 写模型。 */
  model(sid: string, id: string): Promise<void>;
}

/**
 * TUI 对会话设置的所有写,按会话串行、**按发出顺序**落库。
 *
 * 为什么要排队:起 run 的那次写要先等建行(ensure)才发得出去,而 /think、/approval 的单键写是立刻发的 ——
 * 用户在建行那几毫秒里改档,单键写先落、起 run 那份(起跑时截的旧档)后落,把新档盖回旧档:
 * 界面显示新档,/resume 却恢复旧档(Codex 评审 tui #2)。引擎侧的 session:config 锁只保证单次读改写原子,
 * 管不了「谁先发出」;所以在 TUI 这头按发出顺序排好再交给它。
 * 各步失败都吞掉(会话存值是 /resume 的便利,不能因为写库失败卡住起跑),也不阻塞队列里后面的写。
 */
export function createSessionSettingsWriter(io: SessionSettingsIO): SessionSettingsWriter {
  const tails = new Map<string, Promise<void>>();
  const enqueue = (sid: string, job: () => Promise<unknown>): Promise<void> => {
    const next = (tails.get(sid) ?? Promise.resolve()).then(job).then(
      () => undefined,
      () => undefined,
    );
    tails.set(sid, next);
    void next.then(() => {
      if (tails.get(sid) === next) tails.delete(sid);
    });
    return next;
  };
  const quiet = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);
  return {
    ensure: (sid, model) => enqueue(sid, () => io.ensure(sid, model)),
    runStart: (sid, c) =>
      enqueue(sid, async () => {
        await quiet(io.ensure(sid, c.model));
        await Promise.all([quiet(io.patch(sid, runSessionPatch(c))), quiet(io.setModel(sid, c.model))]);
      }),
    patch: (sid, p) => enqueue(sid, () => io.patch(sid, p)),
    model: (sid, id) =>
      enqueue(sid, async () => {
        await quiet(io.ensure(sid, id));
        await io.setModel(sid, id);
      }),
  };
}

export interface ResumePlan {
  /** 直接 patch 进本地配置的部分(Agent 另查:定义要异步读盘)。 */
  patch: Partial<MutableConfig>;
  agentSlug?: string;
  /** 存值是 full-auto 而当前不是:不静默带回来(会话可能是别处开的完全放行)。 */
  heldBackFullAuto: boolean;
}

/**
 * /resume:会话存值 → 本地配置。审批档先认 TUI 自己记的(TUI_APPROVAL_KEY),没有才参考会话共享档
 * (桌面写的 approvalMode);两者都不会静默恢复成 full-auto。
 */
export function resumePlan(
  saved: { modelId?: string; agentConfig?: Record<string, unknown> | null },
  current: Pick<MutableConfig, 'approvalMode' | 'thinkingLevel'>,
): ResumePlan {
  const ac = saved.agentConfig ?? {};
  const patch: Partial<MutableConfig> = {
    seedSystem: undefined,
    activeAgentSlug: undefined,
    planMode: ac.planMode === true,
    maxIterations: storedMaxIterations(ac.maxIterations),
  };
  if (saved.modelId) patch.model = saved.modelId;
  if (ac.thinkingLevel !== undefined && ac.thinkingLevel !== null) patch.thinkingLevel = normalizeThinkingLevel(ac.thinkingLevel, current.thinkingLevel);
  const stored = isApprovalMode(ac[TUI_APPROVAL_KEY]) ? ac[TUI_APPROVAL_KEY] : isApprovalMode(ac.approvalMode) ? ac.approvalMode : undefined;
  let heldBackFullAuto = false;
  if (stored) {
    if (needsFullAutoConfirm(current.approvalMode, stored)) heldBackFullAuto = true;
    else patch.approvalMode = stored;
  }
  const agentSlug = typeof ac.agentSlug === 'string' && ac.agentSlug ? ac.agentSlug : undefined;
  return { patch, agentSlug, heldBackFullAuto };
}

/**
 * /agent <slug>:Agent 定义 → 本地配置。审批档**不**进 patch —— 定义里的 approval_mode 模型自己能写
 * (manage_agent),直接套上就是一条绕过「开启完全放行？」确认的侧门;由调用方走 requestApprovalMode。
 */
export function agentActivation(
  def: Pick<NormalAgentDef, 'slug' | 'systemPrompt' | 'model' | 'thinkingLevel' | 'maxIterations' | 'approvalMode'>,
  current: MutableConfig,
): { patch: Partial<MutableConfig>; approvalRequest?: ApprovalMode } {
  const patch: Partial<MutableConfig> = {
    seedSystem: def.systemPrompt,
    activeAgentSlug: def.slug,
    model: def.model || current.model,
    thinkingLevel: isThinkingLevel(def.thinkingLevel) ? def.thinkingLevel : current.thinkingLevel,
    maxIterations: def.maxIterations || current.maxIterations,
  };
  // NormalAgentDef.approvalMode 未设时是 ''(agentRegistry 解析口径),先过 isApprovalMode。
  const approvalRequest = isApprovalMode(def.approvalMode) && def.approvalMode !== current.approvalMode ? def.approvalMode : undefined;
  return { patch, approvalRequest };
}

/** 「开启完全放行？」确认框:光标默认停在「取消」(Codex 的摩擦),Enter 一按不会误开。 */
export function fullAutoConfirmPicker(): { title: string; subtitle: string; tone: 'warn'; items: PickerItem<'cancel' | 'yes'>[]; initialValue: 'cancel' } {
  return {
    title: L('开启完全放行？', 'Enable full access?'),
    subtitle: L(
      'agent 将不再询问就改文件、跑命令（受保护路径仍会拒绝）。只在你信任当前任务与工作目录时开启。',
      'The agent will edit files and run commands without asking (protected paths are still refused). Only enable it if you trust this task and working directory.',
    ),
    tone: 'warn',
    items: [
      { label: L('取消', 'Cancel'), value: 'cancel' },
      { label: L('是，开启完全放行', 'Yes, enable full access'), value: 'yes' },
    ],
    initialValue: 'cancel',
  };
}

/**
 * 没选模型时的提示:启动首屏 / 发消息 / 起 run / /compact 共用这一句。英文用户没配模型时第一眼看到的就是它,
 * 所以必须双语(旧版四处各写一份纯中文)。
 */
export const noModelNotice = (): string =>
  L(
    '未设置模型：先用 /model 选择（不带参数打开选择器；也可直接写 <provider>/<model> 完整 id）',
    'No model set: pick one with /model first (no argument opens the picker; a full <provider>/<model> id also works)',
  );

export type ModelArgOutcome =
  | { kind: 'usage' }
  | { kind: 'numeric' }
  | { kind: 'unverified'; id: string }
  | { kind: 'hit'; model: CatalogModel }
  /** asTyped:用户敲的是 `<provider>/<model>` 完整 id、目录里只有近似的 → 调用方提示可用 `=<id>` 原样采用。 */
  | { kind: 'ambiguous'; asTyped?: string }
  | { kind: 'none'; catalogError: string | null };

/**
 * /model <参数>:
 *   `=<id>`   逃生口,目录外的 id 原样接受(不校验);
 *   纯数字    拒绝 —— 选择器不显示序号,当子串匹配会静默切到某个恰好含该数字的模型并记成默认;
 *   目录为空  退回旧行为(原样接受),别把用户卡死;
 *   `<provider>/<model>` 完整 id:
 *             目录里 id / name 精确对上 → 命中;
 *             只有子串近似(哪怕唯一,如 `openai/gpt-5` 之于目录里的 `openai/gpt-5-mini`)→ ambiguous + asTyped,
 *               开已过滤的选择器让用户挑,**不许**像短名那样唯一子串直接切过去 —— 那会静默换成另一个模型并记成默认;
 *               用户要的若就是目录外的这个 id,按提示写 `=<id>`;
 *             一个都对不上 → 按旧行为原样接受(调用方提示「未经目录校验」):只配了 base URL、没列模型的
 *               直连 provider 本来就不进目录,旧版 `/model provider/model` 一直能用;
 *   none      带上目录拉取错误(云端挂了 / 没登录时目录只剩本机直连,「没匹配」多半是云端 id)。
 */
export function resolveModelArg(arg: string, models: CatalogModel[], catalogError: string | null): ModelArgOutcome {
  const a = arg.trim();
  if (a.startsWith('=')) {
    const id = a.slice(1).trim();
    return id ? { kind: 'unverified', id } : { kind: 'usage' };
  }
  if (/^\d+$/.test(a)) return { kind: 'numeric' };
  if (!models.length) return { kind: 'unverified', id: a };
  const r = resolveModelQuery(a, models);
  if (isFullModelId(a)) {
    if (r.kind === 'hit' && exactModelMatch(a, r.model)) return { kind: 'hit', model: r.model };
    if (r.kind === 'none') return { kind: 'unverified', id: a };
    return { kind: 'ambiguous', asTyped: a }; // 唯一子串 / 多个候选:都开选择器,不替用户换模型
  }
  if (r.kind === 'hit') return { kind: 'hit', model: r.model };
  if (r.kind === 'ambiguous') return { kind: 'ambiguous' };
  return { kind: 'none', catalogError };
}

/**
 * 命中的是不是「精确」那一档(id 或 name 与输入相同),而不是子串近似。比较口径抄 resolveModelQuery:
 * 小写、空格 / 下划线折成连字符、`vendor:model` 也按 `vendor/model` 认 —— modelCatalog 没导出 norm,这里保持同步。
 */
function exactModelMatch(query: string, m: CatalogModel): boolean {
  const key = (s: string): string => s.toLowerCase().replace(/[\s_]+/g, '-');
  const q = key(query);
  const qs = [q, q.replace(/^([\w.-]+):(?!\/)/, '$1/')];
  return qs.includes(key(String(m.id ?? ''))) || qs.includes(key(String(m.name ?? '')));
}

/** `provider/model` 形的完整 id:两段都非空、不含空白(`codex/` 或 `/luna` 这种半截不算)。 */
const isFullModelId = (a: string): boolean => /^[^\s/]+\/\S*[^\s/]$/.test(a);

/**
 * turn_boundary:引擎注入的用户消息按 id 认领本端的待注入插话 → 显示用户敲的原文(@文件 展开前);
 * 不是本端发的(Stop hook 续跑等)照引擎落库的内容显示。返回剩下仍待注入的。
 */
export function claimInjectedSteers(pending: QueuedMessage[], injected: unknown[]): { texts: string[]; remaining: QueuedMessage[] } {
  const remaining = [...pending];
  const texts = injected.map((m: any) => {
    const i = remaining.findIndex((q) => q.id === m?.id);
    if (i < 0) return String(m?.content ?? '');
    const [q] = remaining.splice(i, 1);
    return q.display;
  });
  return { texts, remaining };
}

/**
 * done:引擎最后一次 drain 在模型收尾那一刻;之后到 AbortController 注销之间 enqueueSteer 仍返回 true,
 * 但已没人消费。cancel 取回(= 仍在引擎队列里、没进对话)的改作新消息,排在已有 follow-up **前面**(先发的先到)。
 */
export function rescueSteers(pending: QueuedMessage[], followUps: QueuedMessage[], cancel: (id: string) => boolean): { followUps: QueuedMessage[]; rescued: number } {
  const missed = pending.filter((q) => cancel(q.id));
  return { followUps: [...missed, ...followUps], rescued: missed.length };
}

/**
 * 起 run 的异步链:先写会话设置 → 建 run 行 → 入队。Esc 可能落在任何一步之间,那时引擎里还没有这个 run,
 * abortRun 抓不到 —— 所以每一步后看一眼 abortRequested:
 *   建行之前 → 不建了,返回 'aborted'(调用方收拾本地状态);
 *   建行期间 → 照常入队(enqueueRun 同步注册 AbortController / 进会话队列),再 abort 一次,
 *              引擎走正常中止路径发 error{aborted},run 行不会孤儿。
 */
export async function launchRun(steps: {
  persist: () => Promise<unknown>;
  create: () => Promise<unknown>;
  enqueue: () => void;
  abort: () => void;
  abortRequested: () => boolean;
}): Promise<'started' | 'aborted'> {
  await steps.persist();
  if (steps.abortRequested()) return 'aborted';
  await steps.create();
  steps.enqueue();
  if (steps.abortRequested()) steps.abort();
  return 'started';
}
