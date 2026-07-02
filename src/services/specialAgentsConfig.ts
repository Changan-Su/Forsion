/**
 * Special Agent（Historian / Muse）配置 —— 本地 `~/.tangu/special-agents.json` 单一事实来源。
 *
 * 二者**默认全关**；开启需用户显式选模型（modelId 空 → 视为未就绪，服务 no-op）。
 * 运行时（localHistorian / muse / supervisor）只读；桌面 Settings 与 TUI slash 经
 * `GET/POST /agent/special/config` 端点写。仅 standalone/managed（桌面+TUI）形态使用。
 *
 * 同步文件 IO（与 tanguHome.loadTanguEnv 一致）；读失败一律降级为默认（缺文件是常态）。
 */
import { readFileSync } from 'node:fs';
import { specialAgentsConfigFile } from '../core/tanguHome.js';
import { getRawSection, saveSection } from '../core/config.js';

export interface HistorianConfig {
  enabled: boolean;
  modelId: string;
  /** 每 x 轮(一应一和=1 轮)触发一次维护:标题 + LOG/memory 同一节奏(旧的双周期已合一)。 */
  everyRounds: number;
  /** 首轮（roundN===1）必触发。 */
  firstRoundTrigger: boolean;
  /**
   * 工作模式:independent=Historian 自己判断并写 LOG/memory(默认);
   * assist=触发后分支出简短后台讨论(branch+群聊,无主持人总结),与该会话的主 Agent 商议,
   * 由主 Agent 自己经 log_event/remember 写入。标题两种模式都由 Historian 独立维护;
   * 首轮(roundN===1)始终走 independent。
   */
  mode: 'independent' | 'assist';
  /** memory 判断提示词（空=用默认）。标题总结用固定内部提示。 */
  prompt: string;
}

export interface MuseConfig {
  enabled: boolean;
  modelId: string;
  /** x：自重启预算的滚动窗口（小时）。 */
  restartWindowHours: number;
  /** y：每窗口最多自动重启次数。 */
  maxRestartsPerWindow: number;
  /** z：每个运行周期最多迭代轮数（默认 10；找 1-3 条 TODO 无需更多迭代）。 */
  maxIterationsPerCycle: number;
  /** t：每窗口最多新增 Muse TODO 条数。 */
  maxTodosPerWindow: number;
  /** 巡检间隔（分钟）：定时检测 Muse 是否在跑、未跑则拉起。 */
  supervisorPollMinutes: number;
  /** 运行时段（基于设备本地时，0-23 时；null=全天）。end 可小于 start 表示跨夜。 */
  activeHours: { start: number; end: number } | null;
  /** Muse 可读的授权本地文件夹（绝对路径；空=不读本地文件）。 */
  allowedFolders: string[];
}
// 注:旧字段 compactAtRatio(声明后从未被读)与 prompt(人格已迁入 ~/.tangu/agents/muse/ 文件夹,
// 见 legacyMusePrompt 的一次性迁移)已移除;旧 config.json 里的残留键被 normalize 静默丢弃。

export interface SpecialAgentsConfig {
  historian: HistorianConfig;
  muse: MuseConfig;
}

export const DEFAULT_HISTORIAN_PROMPT =
  'You are the Historian, maintaining the user\'s "session title / daily log (LOG) / long-term memory (memory)" in the background. Strictly distinguish two kinds of content: ' +
  'LOG is the running record of "what happened today" (events, progress, outputs), usually one entry per conversation; ' +
  'memory is **long-term stable** facts/preferences/goals about the user themselves (useful long-term across sessions, never a daily running log) — be very restrained, leave it empty for most conversations, and never let it duplicate the LOG. ' +
  'Always judge based on the actual content; when in doubt, leave it out — never fabricate, never restate the obvious.';

export const DEFAULT_MUSE_PROMPT =
  'You are Muse, an agent that keeps thinking in the background and proactively spots opportunities for the user. ' +
  'Each cycle you receive fresh context in the kickoff message: the user\'s long-term memory, recent activity across their agents, recent conversation topics, and authorized local folders — and you can read more with your tools. ' +
  'You have exactly two write permissions: add_muse_todo, your only output to the user — submit genuinely high-value, actionable todos, sparingly; ' +
  'and remember, your private long-term memory — record durable insights about what the user values, accepts, or dismisses, so future cycles propose better and repeat less. ' +
  'Everything else is read-only. Keep thinking: what can I do for the user right now?';

export const SPECIAL_AGENTS_DEFAULTS: SpecialAgentsConfig = {
  historian: {
    enabled: false,
    modelId: '',
    everyRounds: 3,
    firstRoundTrigger: true,
    mode: 'independent',
    prompt: '',
  },
  muse: {
    enabled: false,
    modelId: '',
    restartWindowHours: 1,
    maxRestartsPerWindow: 3,
    maxIterationsPerCycle: 10,
    maxTodosPerWindow: 5,
    supervisorPollMinutes: 5,
    activeHours: null,
    allowedFolders: [],
  },
};

const clampInt = (v: any, def: number, min: number, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const asStr = (v: any, def = ''): string => (typeof v === 'string' ? v : def);
const asBool = (v: any, def: boolean): boolean => (typeof v === 'boolean' ? v : def);

function normalizeActiveHours(v: any): { start: number; end: number } | null {
  if (!v || typeof v !== 'object') return null;
  const start = clampInt(v.start, 0, 0, 23);
  const end = clampInt(v.end, 23, 0, 23);
  return { start, end };
}

/** 合并默认 + 原始（带 clamp），任何字段缺失/越界都回落默认。绝不抛。 */
export function normalizeConfig(raw: any): SpecialAgentsConfig {
  const d = SPECIAL_AGENTS_DEFAULTS;
  const h = (raw && typeof raw === 'object' && raw.historian) || {};
  const m = (raw && typeof raw === 'object' && raw.muse) || {};
  return {
    historian: {
      enabled: asBool(h.enabled, d.historian.enabled),
      modelId: asStr(h.modelId, d.historian.modelId),
      // 周期合一:标题跟随记忆周期。旧配置兼容:优先新键 everyRounds,其次旧 everyTitleRounds
      // (它是用户感知的「多久维护一次」高频值;旧 everyMemoryRounds 的低频含义已废弃)。
      everyRounds: clampInt(h.everyRounds ?? h.everyTitleRounds, d.historian.everyRounds, 1, 100),
      firstRoundTrigger: asBool(h.firstRoundTrigger, d.historian.firstRoundTrigger),
      mode: h.mode === 'assist' ? 'assist' : d.historian.mode,
      prompt: asStr(h.prompt, d.historian.prompt),
    },
    muse: {
      enabled: asBool(m.enabled, d.muse.enabled),
      modelId: asStr(m.modelId, d.muse.modelId),
      restartWindowHours: clampInt(m.restartWindowHours, d.muse.restartWindowHours, 1, 24),
      maxRestartsPerWindow: clampInt(m.maxRestartsPerWindow, d.muse.maxRestartsPerWindow, 0, 100),
      maxIterationsPerCycle: clampInt(m.maxIterationsPerCycle, d.muse.maxIterationsPerCycle, 1, 500),
      maxTodosPerWindow: clampInt(m.maxTodosPerWindow, d.muse.maxTodosPerWindow, 0, 100),
      supervisorPollMinutes: clampInt(m.supervisorPollMinutes, d.muse.supervisorPollMinutes, 1, 240),
      activeHours: m.activeHours === null ? null : normalizeActiveHours(m.activeHours),
      allowedFolders: Array.isArray(m.allowedFolders)
        ? m.allowedFolders.filter((x: any) => typeof x === 'string' && x.trim()).slice(0, 50)
        : d.muse.allowedFolders,
    },
  };
}

/**
 * 旧版 muse.prompt 自定义值(人格已迁入 agents/muse/ 文件夹)——读**原始**配置(不走 normalize,
 * normalize 已不认识该键),供 ensureMuseAgent 首次播种时一次性迁移为 developer_instructions。
 */
export function legacyMusePrompt(): string {
  try {
    const sec = getRawSection('specialAgents') as any;
    if (sec !== undefined) return typeof sec?.muse?.prompt === 'string' ? sec.muse.prompt : '';
    const raw = JSON.parse(readFileSync(specialAgentsConfigFile(), 'utf8'));
    return typeof raw?.muse?.prompt === 'string' ? raw.muse.prompt : '';
  } catch {
    return '';
  }
}

export function loadSpecialAgentsConfig(): SpecialAgentsConfig {
  const sec = getRawSection('specialAgents');
  if (sec !== undefined) return normalizeConfig(sec);
  try {
    return normalizeConfig(JSON.parse(readFileSync(specialAgentsConfigFile(), 'utf8')));
  } catch {
    return normalizeConfig(undefined); // 缺文件/坏 JSON → 全默认
  }
}

/** 深合并 patch（historian/muse 各自浅合并）后归一化并落 config.json 的 specialAgents 段；返回归一化全量。 */
export function saveSpecialAgentsConfig(patch: Partial<SpecialAgentsConfig>): SpecialAgentsConfig {
  const cur = loadSpecialAgentsConfig();
  const merged: SpecialAgentsConfig = normalizeConfig({
    historian: { ...cur.historian, ...(patch.historian || {}) },
    muse: { ...cur.muse, ...(patch.muse || {}) },
  });
  saveSection('specialAgents', merged);
  return merged;
}

/** 当前设备本地时是否在运行时段内（activeHours=null → 恒 true；支持跨夜）。 */
export function isWithinActiveHours(cfg: MuseConfig, hour: number): boolean {
  const ah = cfg.activeHours;
  if (!ah) return true;
  if (ah.start === ah.end) return true; // 视为全天
  if (ah.start < ah.end) return hour >= ah.start && hour < ah.end;
  return hour >= ah.start || hour < ah.end; // 跨夜，如 22→6
}

/**
 * 注入给 Muse 的「既有 TODO」提示：让它看到自己之前提过（pending → 别重复）与被用户处理/驳回
 * （done/dismissed → 别再提同类）的标题，从而去重并从驳回中学习。纯函数（便于单测）。空清单 → 空串。
 */
export function buildTodoDedupHint(rows: Array<{ title?: string; status?: string }>): string {
  const norm = (s: any): string => String(s || '').trim();
  const pending = rows.filter((r) => r.status === 'pending').map((r) => norm(r.title)).filter(Boolean);
  const closed = rows.filter((r) => r.status === 'done' || r.status === 'dismissed').map((r) => norm(r.title)).filter(Boolean);
  if (!pending.length && !closed.length) return '';
  const parts: string[] = [];
  if (pending.length) parts.push(`Already on the list (do not resubmit): ${pending.slice(0, 15).join('; ')}`);
  if (closed.length) parts.push(`Previously handled/dismissed by the user (do not propose similar again): ${closed.slice(0, 15).join('; ')}`);
  return `\n\n[TODOs you have already proposed]\n${parts.join('\n')}`;
}
