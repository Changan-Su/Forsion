/**
 * Special Agent（Historian / Muse）配置 —— 本地 `~/.tangu/special-agents.json` 单一事实来源。
 *
 * 二者**默认全关**；开启需用户显式选模型（modelId 空 → 视为未就绪，服务 no-op）。
 * 运行时（localHistorian / muse / supervisor）只读；桌面 Settings 与 TUI slash 经
 * `GET/POST /agent/special/config` 端点写。仅 standalone/managed（桌面+TUI）形态使用。
 *
 * 同步文件 IO（与 tanguHome.loadTanguEnv 一致）；读失败一律降级为默认（缺文件是常态）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { specialAgentsConfigFile } from '../core/tanguHome.js';

export interface HistorianConfig {
  enabled: boolean;
  modelId: string;
  /** x：每 x 轮（一应一和=1 轮）总结并更新会话标题。 */
  everyTitleRounds: number;
  /** y：每 y 轮判断是否更新用户 LOG / memory。 */
  everyMemoryRounds: number;
  /** 首轮（roundN===1）必触发。 */
  firstRoundTrigger: boolean;
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
  /** z：每个运行周期最多迭代轮数（默认 60）。 */
  maxIterationsPerCycle: number;
  /** t：每窗口最多新增 Muse TODO 条数。 */
  maxTodosPerWindow: number;
  /** 巡检间隔（分钟）：定时检测 Muse 是否在跑、未跑则拉起。 */
  supervisorPollMinutes: number;
  /** 上下文占用达此比例（0.8=80%）→ 自动压缩。 */
  compactAtRatio: number;
  /** 运行时段（基于设备本地时，0-23 时；null=全天）。end 可小于 start 表示跨夜。 */
  activeHours: { start: number; end: number } | null;
  /** 思考提示词（空=用默认）；运行时再追加 TODO 预算说明。 */
  prompt: string;
  /** Muse 可读的授权本地文件夹（绝对路径；空=不读本地文件）。 */
  allowedFolders: string[];
}

export interface SpecialAgentsConfig {
  historian: HistorianConfig;
  muse: MuseConfig;
}

export const DEFAULT_HISTORIAN_PROMPT =
  '你是 Historian，在后台维护用户的长期记忆。阅读最近的对话片段，判断是否包含值得长期留存的信息（稳定事实、关键结论、明确偏好、重要产出）。' +
  '若有，用一条简洁中文（≤60 字）概括以便写入用户 LOG/memory；若只是闲聊或一次性内容，仅回复 NOTHING。绝不臆造、不复述显而易见的内容。';

export const DEFAULT_MUSE_PROMPT =
  '你是 Muse，一个在后台持续思考、主动为用户发现机会的 agent。你可读取用户的记忆、日志、会话历史与授权的本地文件夹，' +
  '但你唯一的写权限是通过 add_muse_todo 工具向 Muse TODO 清单提交真正高价值、可执行的待办。持续思考：我现在能为用户做点什么？';

export const SPECIAL_AGENTS_DEFAULTS: SpecialAgentsConfig = {
  historian: {
    enabled: false,
    modelId: '',
    everyTitleRounds: 3,
    everyMemoryRounds: 3,
    firstRoundTrigger: true,
    prompt: '',
  },
  muse: {
    enabled: false,
    modelId: '',
    restartWindowHours: 1,
    maxRestartsPerWindow: 3,
    maxIterationsPerCycle: 60,
    maxTodosPerWindow: 5,
    supervisorPollMinutes: 5,
    compactAtRatio: 0.8,
    activeHours: null,
    prompt: '',
    allowedFolders: [],
  },
};

const clampInt = (v: any, def: number, min: number, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const clampRatio = (v: any, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : def;
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
      everyTitleRounds: clampInt(h.everyTitleRounds, d.historian.everyTitleRounds, 1, 100),
      everyMemoryRounds: clampInt(h.everyMemoryRounds, d.historian.everyMemoryRounds, 1, 100),
      firstRoundTrigger: asBool(h.firstRoundTrigger, d.historian.firstRoundTrigger),
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
      compactAtRatio: clampRatio(m.compactAtRatio, d.muse.compactAtRatio),
      activeHours: m.activeHours === null ? null : normalizeActiveHours(m.activeHours),
      prompt: asStr(m.prompt, d.muse.prompt),
      allowedFolders: Array.isArray(m.allowedFolders)
        ? m.allowedFolders.filter((x: any) => typeof x === 'string' && x.trim()).slice(0, 50)
        : d.muse.allowedFolders,
    },
  };
}

export function loadSpecialAgentsConfig(): SpecialAgentsConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(specialAgentsConfigFile(), 'utf8')));
  } catch {
    return normalizeConfig(undefined); // 缺文件/坏 JSON → 全默认
  }
}

/** 深合并 patch（historian/muse 各自浅合并）后归一化并落盘；返回归一化后的全量配置。 */
export function saveSpecialAgentsConfig(patch: Partial<SpecialAgentsConfig>): SpecialAgentsConfig {
  const cur = loadSpecialAgentsConfig();
  const merged: SpecialAgentsConfig = normalizeConfig({
    historian: { ...cur.historian, ...(patch.historian || {}) },
    muse: { ...cur.muse, ...(patch.muse || {}) },
  });
  const file = specialAgentsConfigFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
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
