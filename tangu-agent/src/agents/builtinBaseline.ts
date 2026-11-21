/**
 * 内置 Agent 的「内置基线」(借鉴 dsh-superagent 方案第 4 条,11-20):记下这台设备上,Coding / Muse 的工作指令、
 * 人格(SOUL)、描述是在哪一份出厂文本上改的。升级时拿它和当前文本比:
 *   - 当前 == 新默认 → 只把基线补成新默认;
 *   - 当前 == 基线,或是某一版历届出厂文本 → 没改过,换成新默认,基线跟上;
 *   - 其余 = 改过 → 一个字节都不写,保留用户的文本;配置页显示「内置指令改了什么」,由用户选保留或换新。
 *
 * 不变量:基线里只放出厂文本,永远不放用户写的字;自动替换只发生在「当前文本 == 某份出厂文本」时,所以
 * 判错的代价最多是多提示一次,不会盖掉用户的内容。
 *
 * 只留本机(`.builtin-baseline.json`,点开头):两套 Agent 同步和服务端白名单都不收点文件(contracts/agentSyncRules
 * validAgentFilePath、Extend agentContent、server isValidAgentFileAddress)。基线说的是「这份安装对过哪版默认」,
 * 跟着 app 版本走、不跟账号走 —— 若随同步走,另一台还在旧版的设备会拿新版的基线判「没改过」,把文本退回旧默认再同步回来。
 * 代价:同一个改过的 Agent,每台设备各点一次「保留我的」。
 *
 * 读写纪律(读失败 ≠ 空):config.toml / 基线读不到、解析不了 → 「不知道」,不写、不提示;SOUL.md 读不到只跳过人格这一项。
 * 纯判定函数(planBuiltinRefresh / pendingBuiltinUpdate)不碰磁盘,IO 在下半部分。
 */
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { LEGACY_MUSE_PROMPTS, LEGACY_MUSE_DESCRIPTION } from '../contracts/legacyPersonas.js';
import type { BuiltinUpdate, BuiltinUpdateField } from '../contracts/clientTypes.js';

export const BUILTIN_BASELINE_FILE = '.builtin-baseline.json';
/** 基线管的三项。描述静默处理(没改过就换新,改过就留着),不进配置页的提示。 */
export const BUILTIN_TEXT_FIELDS = ['systemPrompt', 'soul', 'description'] as const;
export type BuiltinTextField = (typeof BUILTIN_TEXT_FIELDS)[number];
/** 配置页会提示的两项。 */
export const BUILTIN_PROMPT_FIELDS = ['systemPrompt', 'soul'] as const;
export type BuiltinPromptField = (typeof BUILTIN_PROMPT_FIELDS)[number];

/** 现行出厂文本(预设)。version 只有 Coding 有;Muse 的提示词改了不升版本。 */
export interface BuiltinDefaults { version?: string; systemPrompt: string; soul: string; description: string }
/** 一项的基线:那份出厂文本 + 它的版本(有的话)。 */
export interface BaselineEntry { text: string; version?: string }
export type BuiltinBaseline = Partial<Record<BuiltinTextField, BaselineEntry>>;
/** 磁盘上的现状。soul = null:SOUL.md 读不到,人格这一项不碰。version 同 parseAgentConfig(缺省 1.0.0)。 */
export interface BuiltinCurrent { version: string; systemPrompt: string; description: string; soul: string | null }

const norm = (s: string): string => s.replace(/\r\n/g, '\n').trim();
const same = (a: string, b: string): boolean => norm(a) === norm(b);
export const textSha256 = (s: string): string => createHash('sha256').update(norm(s)).digest('hex');

/**
 * 历届出厂文本的指纹(冻结的历史表,以后不用维护:这次之后装的都有基线)。只给「没有基线的老用户」认原装用 ——
 * 文本和某一版出厂一字不差 = 没改过,换新不丢任何东西。从 git 历史里逐版求值算出(sha256(trim, CRLF→LF))。
 * 现行预设本身不必进表(当前 == 新默认那条先判)。
 */
const STOCK_SHA256: Record<string, Partial<Record<BuiltinTextField, readonly string[]>>> = {
  coding: {
    systemPrompt: [
      '567a3b17779e4cc78c55611fd7948a56128ed1c9a4c4106b180cad74ac7df8b8', // 1.1.0(07-05,内联在 agentRegistry)
      '7ee848e3ef38da97d301084db6120d939f1d5a046a76b7c9d98c459c298a1494', // 1.2.0(09-07)
      '1970b029f61613c703ff42b5f497589596ba637754a77858b5a698a9cbda65ad', // 1.3.0(09-21)
      'e0fcf699bdc15e591e5264573175e57abbf85eb9d6869e261567fd151b4df14f', // 1.4.0(10-30,写这张表时的现行版)
    ],
    soul: [
      '9dca55b33fd131a3bbd93696216816bf2407c9717de777171e395d665c67132c', // 1.1.0
      '8772ffb282f0e72a9a7afa811288ea61f19707659c1ee41d89e164f1438df4f7', // 1.2.0 起
    ],
    description: [textSha256('AI Studio 式网页应用构建者:多文件 + JSX/TSX + CDN 包,即时预览')], // 1.1.0
  },
  muse: {
    systemPrompt: [
      ...LEGACY_MUSE_PROMPTS.map(textSha256), // 06-18 中文 / 英文版、07-05 版
      'cdcc66f7375a722c8cbb3fa9f65a20ff9b45491a5bd5d49ea5ce6329fcad9915', // 09-11 版(写这张表时的现行版)
    ],
    soul: ['f38142421a3b53470236c7e863d8ff1454d2cd147583b9e1b318bde0f944521f'], // 07-05 起唯一一版
    description: [textSha256(LEGACY_MUSE_DESCRIPTION)],
  },
};

/** 是不是这个内置 Agent 某一版的出厂文本(一字不差,忽略首尾空白与换行风格)。 */
export function isStockText(slug: string, field: BuiltinTextField, text: string): boolean {
  const list = STOCK_SHA256[slug]?.[field];
  return !!list && list.includes(textSha256(text));
}

/** 点分版本号比大小(数字段逐段比,缺的段当 0;非数字段当 0)。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.'), pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.parseInt(pa[i] ?? '0', 10) || 0, y = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** config.toml 的版本比这份 app 的预设还新:它来自装了新版的另一台设备(同步过来的)。不退回旧默认,也不提示。 */
function fromNewerApp(defaults: BuiltinDefaults, current: BuiltinCurrent): boolean {
  return !!defaults.version && compareVersions(current.version, defaults.version) > 0;
}
/** 这一项的基线是更新的 app 记的(同一台装回了旧版):工作指令改过时 config.toml 的版本不升,上面那道闸挡不住只换了人格 / 描述的那次,
 *  所以逐项再比一次 —— 不退回旧默认,也不提示。 */
function baseFromNewerApp(defaults: BuiltinDefaults, base: BaselineEntry | undefined): boolean {
  return !!(base?.version && defaults.version && compareVersions(base.version, defaults.version) > 0);
}

export interface RefreshPlan {
  /** 要换成新默认的项(只含要写的)。 */
  replace: Partial<Record<BuiltinTextField, string>>;
  /** 新基线;null = 不用写。 */
  baseline: BuiltinBaseline | null;
  /** 改写 config.toml 时它的 version:工作指令此后就是现行默认 → 现行版本;否则 undefined = 照旧。 */
  version?: string;
}

/**
 * 升级判定(纯函数)。返回 null = 什么都不做(配置来自更新的 app)。每项各判各的:
 *   1. 当前 == 新默认:只把基线补成新默认。
 *   2. 当前 == 基线,或是历届出厂文本:换成新默认,基线跟上。
 *   3. 其余 = 改过:不写文本。只有一种情况补基线 —— 没有基线、且 config.toml 的版本就是现行版本
 *      (旧代码每次升版本都整份覆盖,版本号相等 = 用户是在现行默认上改的),这一步不会导致任何覆盖。
 *      其余情况基线不动:基线 == 新默认就没事,否则配置页提示。
 */
export function planBuiltinRefresh(slug: string, defaults: BuiltinDefaults, current: BuiltinCurrent, baseline: BuiltinBaseline | null): RefreshPlan | null {
  if (fromNewerApp(defaults, current)) return null;
  const replace: RefreshPlan['replace'] = {};
  const next: BuiltinBaseline = { ...(baseline || {}) };
  const entry = (field: BuiltinTextField): BaselineEntry => ({ text: defaults[field], ...(defaults.version ? { version: defaults.version } : {}) });
  for (const field of BUILTIN_TEXT_FIELDS) {
    const cur = current[field];
    if (cur === null) continue; // SOUL.md 读不到:不知道,这一项不碰
    const def = defaults[field];
    const base = baseline?.[field];
    if (baseFromNewerApp(defaults, base)) continue;
    if (same(cur, def)) { next[field] = entry(field); continue; }
    if ((base && same(cur, base.text)) || isStockText(slug, field, cur)) { replace[field] = def; next[field] = entry(field); continue; }
    if (!base && defaults.version && current.version === defaults.version) next[field] = entry(field);
  }
  const changed = JSON.stringify(next) !== JSON.stringify(baseline || {});
  const finalPrompt = replace.systemPrompt ?? current.systemPrompt;
  return {
    replace,
    baseline: changed ? next : null,
    ...(defaults.version && same(finalPrompt, defaults.systemPrompt) ? { version: defaults.version } : {}),
  };
}

// 提示的形状在契约里只有一份(界面也读它)
export type { BuiltinUpdate, BuiltinUpdateField };

/** 配置页要不要提示(纯函数):当前 ≠ 新默认,且基线不是新默认(没有基线也算)。描述不提示。 */
export function pendingBuiltinUpdate(slug: string, defaults: BuiltinDefaults, current: BuiltinCurrent, baseline: BuiltinBaseline | null): BuiltinUpdate | null {
  if (fromNewerApp(defaults, current)) return null;
  const fields: BuiltinUpdateField[] = [];
  for (const field of BUILTIN_PROMPT_FIELDS) {
    const cur = current[field];
    if (cur === null) continue;
    const def = defaults[field];
    const base = baseline?.[field];
    if (baseFromNewerApp(defaults, base) || same(cur, def) || (base && same(base.text, def))) continue;
    fields.push({ field, current: cur, newDefault: def, oldDefault: base ? base.text : null, ...(base?.version ? { fromVersion: base.version } : {}) });
  }
  if (!fields.length) return null;
  // token 盖住用户看到的整份提示(原文、不规范化):现在的文本、旧默认、新默认、两头的版本,哪个变了旧 token 都不认
  const toVersion = defaults.version;
  const token = createHash('sha256').update(JSON.stringify([slug, toVersion ?? null, fields.map((f) => [f.field, f.current, f.oldDefault, f.newDefault, f.fromVersion ?? null])])).digest('hex').slice(0, 32);
  return { slug, ...(toVersion ? { toVersion } : {}), fields, token };
}

/** 用户点了「保留我的」/「换成新默认」之后的基线:提示过的几项都记成新默认(两种选择都是「看过这版了」)。 */
export function acknowledgedBaseline(defaults: BuiltinDefaults, baseline: BuiltinBaseline | null, fields: readonly BuiltinPromptField[]): BuiltinBaseline {
  const next: BuiltinBaseline = { ...(baseline || {}) };
  for (const field of fields) next[field] = { text: defaults[field], ...(defaults.version ? { version: defaults.version } : {}) };
  return next;
}

// ── IO ─────────────────────────────────────────────────────────────────────────

/** 严格按 UTF-8 读:坏字节直接抛(Node 的 'utf-8' 会悄悄换成 U+FFFD,再写回去就把用户的字改坏了)。BOM 原样留着,同 readFile。 */
async function readUtf8(file: string): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(file));
}

/** 原子写(同目录临时文件 + rename):写到一半断电 / 磁盘满,原文件还是完整的旧版。临时文件点开头,两套同步都不收。 */
export async function atomicWriteText(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await fs.writeFile(tmp, text, 'utf-8');
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => { /* ignore */ });
    throw e;
  }
}

export type BaselineRead = { state: 'none' } | { state: 'ok'; baseline: BuiltinBaseline } | { state: 'unknown' };

function parseBaseline(raw: string): BuiltinBaseline | null {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || (doc as any).format !== 1) return null;
  const out: BuiltinBaseline = {};
  for (const field of BUILTIN_TEXT_FIELDS) {
    const e = (doc as any)[field];
    if (e === undefined) continue;
    if (!e || typeof e !== 'object' || typeof e.text !== 'string' || (e.version !== undefined && typeof e.version !== 'string')) return null;
    out[field] = { text: e.text, ...(e.version !== undefined ? { version: e.version } : {}) };
  }
  return out;
}

/** 读基线:没有文件 = none;读不出来、解析不了、形状不对 = unknown(不知道,调用方什么都不写)。 */
export async function readBuiltinBaseline(agentDir: string): Promise<BaselineRead> {
  let raw: string;
  try { raw = await readUtf8(path.join(agentDir, BUILTIN_BASELINE_FILE)); } catch (e: any) {
    return e?.code === 'ENOENT' ? { state: 'none' } : { state: 'unknown' };
  }
  const baseline = parseBaseline(raw);
  return baseline ? { state: 'ok', baseline } : { state: 'unknown' };
}

/** 原子写(临时文件 + rename):写到一半断电不会留下半份(半份 = unknown = 这个 Agent 不再升级)。临时文件也是点开头,同步不收。 */
export async function writeBuiltinBaseline(agentDir: string, baseline: BuiltinBaseline): Promise<void> {
  const doc: Record<string, unknown> = { format: 1 };
  for (const field of BUILTIN_TEXT_FIELDS) if (baseline[field]) doc[field] = baseline[field];
  await atomicWriteText(path.join(agentDir, BUILTIN_BASELINE_FILE), JSON.stringify(doc, null, 2) + '\n');
}

export type CurrentRead = { state: 'ok'; current: BuiltinCurrent; raw: string } | { state: 'absent' } | { state: 'unknown' };

/**
 * 严格读现状:config.toml 不在 = absent;读不出来 / 解析不了 / 没有 developer_instructions 这个键 = unknown
 * (零字节的 config.toml 能解析成空表,不能当「指令为空」)。SOUL.md 读不到 → soul = null,只跳过人格。
 */
export async function readBuiltinCurrent(agentDir: string): Promise<CurrentRead> {
  let raw: string;
  try { raw = await readUtf8(path.join(agentDir, 'config.toml')); } catch (e: any) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? { state: 'absent' } : { state: 'unknown' };
  }
  let meta: Record<string, unknown>;
  try { meta = parseToml(raw) as Record<string, unknown>; } catch { return { state: 'unknown' }; }
  if (typeof meta.developer_instructions !== 'string') return { state: 'unknown' };
  if (meta.description !== undefined && typeof meta.description !== 'string') return { state: 'unknown' };
  const soul = await readUtf8(path.join(agentDir, 'SOUL.md')).catch(() => null);
  return {
    state: 'ok',
    raw,
    current: {
      version: typeof meta.version === 'string' && meta.version ? meta.version : '1.0.0',
      systemPrompt: meta.developer_instructions,
      description: typeof meta.description === 'string' ? meta.description : '',
      soul,
    },
  };
}
