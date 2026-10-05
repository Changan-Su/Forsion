/**
 * app_settings / update_app_settings 的事实层:agent 能读、能改本机 config.json 里**哪些段的哪些字段**。
 *
 * 为什么要有这一层(方案 9.3):config.json 把普通设置和机密放在同一个文件里,所以整份文件在 agent 的凭据禁区
 * (文件工具 / 命令行都读写不了)—— agent 因此答不出「语音页有哪些选项、现在是什么值」,也办不了「把朗读音色换成 X」。
 * 这里按段开一个窄口:
 *   - **表里没有的段、段里没有的字段,对模型不存在**(default-deny;明天新加的段默认不可见,要开放就在表里加一行);
 *   - `secrets` 里的字段只报「已配置 / 未配置」,读不出值,也写不进去;
 *   - 写入一律走 `updateSection`(跨进程锁内读最新段 → 合并 → 原子落盘),段里不认识的键原样保留;
 *   - 整批校验通过才写(一个字段不合法 = 一个都不写)。
 * 审批、远程 / 通道限制在工具与审批闸那边(tools/builtin/appSettings.ts、services/approvals.ts、services/remoteOrigin.ts)。
 */
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { getRawSection, updateSection } from '../core/config.js';
import { ZHIPU_ENGINES } from '../adapters/standalone/localSearch.js';
import { protectedLocalWrite } from '../tools/fsPolicy.js';
import { remoteCwdForbidden, withinRemoteCwdProtected } from '../sandbox/hostSandboxProtection.js';
import { chatModels, listModelCatalog, resolveModelQuery, type CatalogModel } from './modelCatalog.js';
import { deps } from '../seams/runtime.js';
import type { AppProfile } from '../seams/appProfile.js';

type Field =
  /** 模型目录里的对话模型 id(可给不完整的名字,落盘的是解析出的完整 id);'' = 跟随缺省。 */
  | { t: 'model'; vision?: boolean; note: string }
  | { t: 'text'; max: number; note: string }
  | { t: 'number'; min: number; max: number; def: number; note: string }
  | { t: 'bool'; note: string }
  | { t: 'enum'; values: readonly string[]; def: string; note: string }
  /** 已存在的目录的绝对路径;'' = 内置缺省。 */
  | { t: 'dir'; note: string };

interface Section {
  title: string;
  /** run_ui_command `open-settings` 的落点 id(desktop settingsSearchIndex 里的条目)。 */
  open: string;
  /** 改了之后何时生效(写进回执,别让模型猜)。 */
  effect: string;
  fields: Record<string, Field>;
  /** 字段名 → 给模型看的名字。只报「已配置 / 未配置」。 */
  secrets?: Record<string, string>;
  /** 只读字段 → 为什么(给模型看)。现值照常读得到,改要用户自己在设置里改。 */
  locked?: Record<string, string>;
  /** 段本身是一个标量(`"workspace": "/path"`):对外用这个字段名读写。 */
  scalar?: string;
}

const CALL_LOCKED = 'a call voice only works with the call model it belongs to (cloned voices are tied to one exact model), so the user picks both in Settings';

/** 可读可改的段(顺序 = 输出顺序)。字段形状与 desktop/electron/main.ts 的 loadConfig / applyHomePatch 同表。
 *  ponytail: 只认 config.json。很老的安装里某段还没写进 config.json 时,桌面端回落到旧 shell 文件的值,这里读到的是缺省;
 *  写入时整段从此以 config.json 为准 —— 与桌面端自己改这一项时(applyHomePatch)是同一个行为。 */
export const APP_SETTINGS: Readonly<Record<string, Section>> = {
  cloud: {
    title: 'Default model',
    open: 'default-models',
    effect: 'New conversations start on it. Conversations that already exist keep their own model (use update_session_settings for the current one).',
    fields: { defaultModel: { t: 'model', note: 'model for new conversations; "" = the account default' } },
  },
  models: {
    title: 'Auxiliary models',
    open: 'default-models',
    effect: 'Applies from the next run.',
    fields: {
      background: { t: 'model', note: 'model for background work such as the memory judge and Muse; "" = follow the default' },
      vision: { t: 'model', vision: true, note: 'model that describes images when the main model cannot see them; "" = follow the default' },
      visionMode: { t: 'enum', values: ['auto', 'always', 'off'], def: 'auto', note: 'when the vision model steps in: auto = only if the main model has no vision' },
    },
  },
  tts: {
    title: 'Read-aloud and voice call',
    open: 'voice',
    effect: 'Applies from the next read-aloud or the next call.',
    fields: {
      modelId: { t: 'text', max: 200, note: 'read-aloud model as "<providerId>/<model>"; "" turns read-aloud off' },
      voice: { t: 'text', max: 120, note: 'read-aloud voice id (provider-specific); "" = the provider default' },
      speed: { t: 'number', min: 0.5, max: 2, def: 1, note: 'read-aloud speed' },
      autoSpeak: { t: 'bool', note: 'read new replies aloud automatically' },
      realtimeModel: { t: 'text', max: 200, note: 'voice-call model as "<providerId>/<model>"; "" = voice call is off' },
      realtimeVoice: { t: 'text', max: 120, note: 'voice-call voice id; "" = the model default' },
    },
    locked: { realtimeModel: CALL_LOCKED, realtimeVoice: CALL_LOCKED },
  },
  asr: {
    title: 'Voice input',
    open: 'voice',
    effect: 'Applies from the next dictation.',
    fields: {
      modelId: { t: 'text', max: 200, note: 'speech-to-text model for the cloud backend; "" = the app default' },
      backend: { t: 'enum', values: ['local', 'cloud'], def: 'cloud', note: 'local = on-device model (the user must have downloaded it in Settings), cloud = the model above' },
    },
  },
  webSearch: {
    title: 'Web search',
    open: 'web-search',
    effect: 'Applies from the next search.',
    fields: {
      provider: { t: 'enum', values: ['auto', 'bocha', 'tavily', 'zhipu', 'duckduckgo'], def: 'auto', note: 'search service used by web_search; a keyed service needs its key to be set' },
      zhipuEngine: { t: 'enum', values: ZHIPU_ENGINES, def: 'search_pro_quark', note: 'Zhipu search tier' },
    },
    secrets: { bochaApiKey: 'Bocha', tavilyApiKey: 'Tavily', zhipuApiKey: 'Zhipu' },
  },
  workspace: {
    title: 'Default workspace folder',
    open: 'workspace-dir',
    effect: 'New conversations without a project start in it; conversations that are already open keep theirs.',
    scalar: 'path',
    fields: { path: { t: 'dir', note: 'absolute path of an existing folder; "" = the built-in default' } },
  },
};

/** 只读段:提供方目录(id + 模型名)。 */
export const PROVIDERS_SECTION = 'providers';
export const WRITABLE_SECTIONS: readonly string[] = Object.keys(APP_SETTINGS);
export const READABLE_SECTIONS: readonly string[] = [...WRITABLE_SECTIONS, PROVIDERS_SECTION];

/** 默认工作目录决定以后每个新会话的免审批写入范围 —— 审批闸据此把它当保护配置(每次都问,完全通行也问)。 */
export function touchesWorkspaceSetting(args: unknown): boolean {
  return String((args as { section?: unknown } | null | undefined)?.section ?? '').trim() === 'workspace';
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const lit = (v: unknown): string => JSON.stringify(v);

/** 段的原始对象(标量段包成 { <scalar>: 值 });段缺失 / 形状不对 → {}。 */
function rawOf(name: string, spec: Section): Record<string, unknown> {
  const raw = getRawSection(name);
  if (spec.scalar) return { [spec.scalar]: typeof raw === 'string' ? raw : '' };
  return isObj(raw) ? raw : {};
}

/** 某字段此刻的有效值(没写过 = 缺省)。 */
function current(raw: Record<string, unknown>, key: string, f: Field): string | number | boolean {
  const v = raw[key];
  if (f.t === 'number') return typeof v === 'number' && Number.isFinite(v) ? v : f.def;
  if (f.t === 'bool') return v === true;
  if (f.t === 'enum') return typeof v === 'string' && f.values.includes(v) ? v : f.def;
  return typeof v === 'string' ? v : '';
}

function allowed(f: Field): string {
  if (f.t === 'enum') return f.values.join(' | ');
  if (f.t === 'number') return `${f.min}–${f.max}`;
  if (f.t === 'bool') return 'true | false';
  return '';
}

function renderSection(name: string, spec: Section): string[] {
  const raw = rawOf(name, spec);
  const out = [`[${name}] ${spec.title} — open-settings "${spec.open}"`];
  for (const [key, f] of Object.entries(spec.fields)) {
    const a = allowed(f);
    const why = spec.locked?.[key];
    out.push(`  ${key} = ${lit(current(raw, key, f))}${a && !why ? `  (${a})` : ''} — ${f.note}${why ? ` [read-only here: ${why}]` : ''}`);
  }
  if (spec.secrets) {
    const keys = Object.entries(spec.secrets).map(([k, label]) => `${label} ${typeof raw[k] === 'string' && (raw[k] as string).trim() ? 'set' : 'not set'}`);
    out.push(`  API keys: ${keys.join(' · ')} (only the user can enter keys, in Settings)`);
  }
  return out;
}

const MAX_MODELS_PER_PROVIDER = 40;
function renderProviders(): string[] {
  const list = deps().brain.models.listDirectProviders?.() ?? [];
  const out = [`[${PROVIDERS_SECTION}] Model providers (read-only; ids and model names only) — open-settings "model-providers"`];
  if (!list.length) out.push('  (no direct provider is configured on this computer)');
  for (const p of list) {
    const part = (label: string, ids?: string[]): string =>
      ids?.length ? `${label}: ${ids.slice(0, MAX_MODELS_PER_PROVIDER).join(', ')}${ids.length > MAX_MODELS_PER_PROVIDER ? `, … (${ids.length} in total)` : ''}` : '';
    const parts = [part('chat', p.modelIds), part('image', p.imageModelIds), part('read-aloud', p.ttsModelIds)].filter(Boolean);
    out.push(`  ${p.providerId} — ${parts.join('; ') || 'no models listed'}`);
  }
  return out;
}

/** app_settings 的返回文本。section 缺省 = 全部(每段只有几行)。 */
export function renderAppSettings(opts: { section?: string; writable: boolean }): string {
  const want = (opts.section || '').trim();
  if (want && !READABLE_SECTIONS.includes(want)) {
    return `Error: unknown section "${want}". Sections you can read: ${READABLE_SECTIONS.join(', ')}. Every other setting is outside this tool — tell the user where to change it (run_ui_command open-settings).`;
  }
  const out: string[] = [
    'Forsion app settings stored on this computer (config.json).',
    opts.writable
      ? 'Change them with update_app_settings (one section per call; the user confirms each change).'
      : 'This session can read them but not change them.',
    'Settings that are not listed here (API keys, sign-in, MCP, hooks, channels, sandbox, remote access, approval rules, plugins, appearance) cannot be read or changed with this tool.',
    '',
  ];
  for (const [name, spec] of Object.entries(APP_SETTINGS)) {
    if (want && want !== name) continue;
    out.push(...renderSection(name, spec), `  ${spec.effect}`, '');
  }
  if (!want || want === PROVIDERS_SECTION) out.push(...renderProviders(), '');
  return out.join('\n').trimEnd();
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

async function catalogModels(profile: AppProfile): Promise<CatalogModel[]> {
  try { return chatModels((await listModelCatalog(profile)).models); } catch { return []; }
}

/** 校验一个字段的新值;返回归一后的值或一句英文报错。 */
async function validate(key: string, f: Field, v: unknown, models: () => Promise<CatalogModel[]>): Promise<{ value: string | number | boolean } | { error: string }> {
  if (f.t === 'bool') return typeof v === 'boolean' ? { value: v } : { error: `${key} must be true or false` };
  if (f.t === 'number') {
    return typeof v === 'number' && Number.isFinite(v) && v >= f.min && v <= f.max ? { value: v } : { error: `${key} must be a number between ${f.min} and ${f.max}` };
  }
  if (typeof v !== 'string') return { error: `${key} must be a string` };
  const s = v.trim();
  if (CONTROL_CHARS.test(s)) return { error: `${key} contains control characters` };
  if (f.t === 'enum') return f.values.includes(s) ? { value: s } : { error: `${key} must be one of: ${f.values.join(', ')}` };
  if (f.t === 'text') return s.length <= f.max ? { value: s } : { error: `${key} is too long (max ${f.max} characters)` };
  if (f.t === 'model') {
    if (!s) return { value: '' };
    const all = await models();
    if (!all.length) return { error: `${key}: the model catalog is unavailable right now, so "${s}" cannot be checked — try again later` };
    const pool = f.vision ? all.filter((m) => m.supportsVision !== false) : all;
    const hit = resolveModelQuery(s, pool);
    if (hit.kind === 'hit') return { value: hit.model.id };
    if (hit.kind === 'ambiguous') return { error: `${key}: "${s}" matches several models (${hit.candidates.slice(0, 8).map((m) => m.id).join(', ')}) — use an exact id` };
    return { error: `${key}: no ${f.vision ? 'vision-capable ' : ''}model matches "${s}" (call session_settings to list the models)` };
  }
  // dir
  if (!s) return { value: '' };
  if (!path.isAbsolute(s)) return { error: `${key} must be an absolute path` };
  const abs = path.resolve(s);
  try { if (!statSync(abs).isDirectory()) return { error: `${key}: ${abs} is not a folder` }; } catch { return { error: `${key}: ${abs} does not exist — the user has to create it first` }; }
  // 工作目录 = 以后每个新会话在「替我批准」档下免审批的可写根。与远程会话的 cwd 同一套禁区(remoteCwdForbidden:根目录、家目录及其祖先、
  // 受保护目录及其祖先、应用配置区),再加受保护目录**里面**的任何一层(withinRemoteCwdProtected:引擎包目录、Forsion / 引擎家目录、
  // 凭据目录 —— agent 定义 / 技能 / 插件 / 审批代码都在里面)。用户要选这些地方,自己在设置里选。
  // 存的是解析后的真实路径:存软链的话,之后把链接改指家目录,免审批的可写根就跟着换了(校验过的是当时的目标)。
  const real = realDir(abs);
  if (remoteCwdForbidden(real) || withinRemoteCwdProtected(real) || protectedLocalWrite(real)) {
    return { error: `${key}: ${real} cannot be set as the workspace by you (it is the home folder or above it, or it holds the app itself, its configuration or credentials) — only the user can pick it, in Settings` };
  }
  return { value: real };
}

function realDir(abs: string): string {
  try { return realpathSync.native(abs); } catch { return abs; }
}

export interface AppSettingsUpdate {
  ok: boolean;
  /** 给模型的回执(英文)。 */
  text: string;
  /** 实际改动的字段(空 = 没写盘)。 */
  changed: string[];
}

/** 校验并写入一段的若干字段。整批校验通过才写;值没变的字段不算改动(全都没变 = 不写盘)。
 *  @param beforeWrite 落盘前最后问一次(返回一句拒绝理由 = 不写)。校验要查模型目录(网络请求),这段时间里 run 可能被远端染色;
 *  它在所有 await 之后、与写入同一拍里调用。 */
export async function updateAppSettings(profile: AppProfile, sectionName: unknown, values: unknown, beforeWrite?: () => string | null): Promise<AppSettingsUpdate> {
  const fail = (text: string): AppSettingsUpdate => ({ ok: false, text: `Error: ${text}`, changed: [] });
  const name = String(sectionName ?? '').trim();
  const spec = APP_SETTINGS[name];
  if (!spec) {
    return fail(name === PROVIDERS_SECTION
      ? 'providers are read-only here — only the user can add or change a provider or its key, in Settings (run_ui_command open-settings "model-providers").'
      : `unknown section "${name}". Sections you can change: ${WRITABLE_SECTIONS.join(', ')}.`);
  }
  if (!isObj(values) || !Object.keys(values).length) return fail('`values` must be an object with at least one field, e.g. {"voice": "alloy"}.');

  let cache: Promise<CatalogModel[]> | undefined;
  const models = (): Promise<CatalogModel[]> => (cache ??= catalogModels(profile));
  const next: Record<string, string | number | boolean> = {};
  const errors: string[] = [];
  for (const [key, v] of Object.entries(values)) {
    const f = Object.hasOwn(spec.fields, key) ? spec.fields[key] : undefined;
    if (!f) {
      errors.push(spec.secrets && Object.hasOwn(spec.secrets, key)
        ? `${key}: API keys can only be entered by the user, in Settings`
        : `${key} is not a field of ${name} (fields: ${Object.keys(spec.fields).join(', ')})`);
      continue;
    }
    if (spec.locked && Object.hasOwn(spec.locked, key)) {
      errors.push(`${key} is read-only here: ${spec.locked[key]} (run_ui_command open-settings "${spec.open}")`);
      continue;
    }
    const r = await validate(key, f, v, models);
    if ('error' in r) errors.push(r.error); else next[key] = r.value;
  }
  // 没填密钥的搜索服务切不过去:agent 填不了密钥,切过去只会让下一次搜索悄悄回落到别的服务。
  const keyed = name === 'webSearch' && typeof next.provider === 'string' ? `${next.provider}ApiKey` : '';
  if (keyed && spec.secrets && Object.hasOwn(spec.secrets, keyed)) {
    const k = rawOf(name, spec)[keyed];
    if (!(typeof k === 'string' && k.trim())) errors.push(`provider: ${spec.secrets[keyed]} has no API key yet — the user has to enter it in Settings first (run_ui_command open-settings "${spec.open}")`);
  }
  if (errors.length) return fail(`nothing was changed.\n- ${errors.join('\n- ')}`);
  const denied = beforeWrite?.();
  if (denied) return fail(denied);

  const changed: string[] = [];
  const notes: string[] = [];
  try {
    updateSection(name, (cur) => {
      if (spec.scalar) {
        const before = typeof cur === 'string' ? cur : '';
        const after = String(next[spec.scalar]);
        if (before === after) return undefined;
        changed.push(spec.scalar);
        notes.push(`${spec.scalar}: ${lit(before)} → ${lit(after)}`);
        return after;
      }
      if (cur !== undefined && !isObj(cur)) throw new Error(`the "${name}" section of config.json is not an object`);
      const base: Record<string, unknown> = cur ?? {};
      const out = { ...base };
      for (const [key, v] of Object.entries(next)) {
        const before = current(base, key, spec.fields[key]);
        if (before === v) continue;
        out[key] = v;
        changed.push(key);
        notes.push(`${key}: ${lit(before)} → ${lit(v)}`);
      }
      return changed.length ? out : undefined;
    });
  } catch (e) {
    return fail(`could not save — nothing was changed (${(e as Error)?.message || String(e)}).`);
  }
  if (!changed.length) return { ok: true, text: `Nothing to change: ${name} already has ${Object.keys(next).length === 1 ? 'that value' : 'those values'}.`, changed };
  return { ok: true, text: `Saved ${name} — ${notes.join('; ')}.\n${spec.effect}`, changed };
}

/** 审批卡上「改什么」那几行:现值 → 新值(现值由闸门读,模型给不了)。不校验 —— 校验在执行时,卡上照原样显示模型要写的东西。 */
export function describeAppSettingsChange(sectionName: unknown, values: unknown): string {
  const name = String(sectionName ?? '').trim();
  const spec = APP_SETTINGS[name];
  if (!spec || !isObj(values)) return '';
  const raw = rawOf(name, spec);
  return Object.entries(values).map(([key, v]) => {
    const f = Object.hasOwn(spec.fields, key) ? spec.fields[key] : undefined;
    // 目录:卡上写出它实际指向哪(模型给的可能是软链;落盘的是解析后的路径)。
    const real = f?.t === 'dir' && typeof v === 'string' && path.isAbsolute(v.trim()) ? realDir(path.resolve(v.trim())) : '';
    return `${name}.${key}: ${f ? lit(current(raw, key, f)) : '(not a setting)'} → ${lit(v)}${real && real !== v ? ` (resolves to ${real})` : ''}`;
  }).join('\n');
}
