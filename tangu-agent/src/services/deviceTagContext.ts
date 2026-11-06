/**
 * 本机的「适用范围」上下文(按条标设备名,2026-11-06):本机名、本机系统、账号里别台的名字;以及改名后把这台写过的 `[旧名]` 换成 `[新名]`。
 * 标签的写法和挑法在 contracts/deviceTags.ts(宿主、前端共用);这里只管读盘。
 *
 * - 本机名与每轮环境说明同一来源(hostEnvironment.deviceName:同步页上起的名字,没起过 = 主机名的缺省写法),不另写一份。
 * - 别台的名字来自 Extend 抄下来的设备表 `<forsion 共享域>/content-sync-devices.json`;读不到 = 不认识别台,带别台名字的行照常当正文。
 * - 两个文件按 mtime + 大小缓存:同步页上改了名,下一个 run 就用新名字。
 * - 只有本机引擎(hostExec)有「这台电脑」;云端 run 用 NO_DEVICE,标了的一律折起来。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { agentsDir, forsionSharedDir, tanguHome } from '../core/tanguHome.js';
import { deviceName } from '../tools/hostEnvironment.js';
import { APPLIES_TO, deviceNameKey, filterTaggedText, foldNote, labelFor, osOfPlatform, renameDeviceTag, tagOf, validTagName, withTag, type AppliesTo, type DeviceTagContext } from '../contracts/deviceTags.js';
import { atomicWriteMemoryFile, createMemoryRepository, MemoryRepositoryError, readMemoryFile } from './memoryRepository.js';

export const NO_DEVICE: DeviceTagContext = Object.freeze({ self: null, os: null, others: Object.freeze([]) as readonly string[] });
export const DEVICE_FILE = 'content-sync-device.json';
export const DEVICE_LIST_FILE = 'content-sync-devices.json';

const stamp = (file: string): string => { try { const s = statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } };
let cache: { key: string; ctx: DeviceTagContext } | null = null;

/** 这台电脑的标签上下文。 */
export function deviceTagContext(sharedDir: string = forsionSharedDir(), platform: string = process.platform): DeviceTagContext {
  const fDevice = path.join(sharedDir, DEVICE_FILE), fList = path.join(sharedDir, DEVICE_LIST_FILE);
  const key = `${sharedDir}|${platform}|${stamp(fDevice)}|${stamp(fList)}`;
  if (cache?.key === key) return cache.ctx;
  const self = deviceName(sharedDir);
  let others: string[] = [];
  try {
    const raw = JSON.parse(readFileSync(fList, 'utf8'));
    if (Array.isArray(raw?.devices)) {
      const seen = new Set([deviceNameKey(self)]);
      for (const d of raw.devices) {
        const name = typeof d?.name === 'string' ? d.name.trim() : '';
        if (!validTagName(name) || seen.has(deviceNameKey(name))) continue;
        seen.add(deviceNameKey(name)); others.push(name);
      }
    }
  } catch { others = []; /* 没登录同步 / 读不懂:不认识别台,当正文 */ }
  const ctx: DeviceTagContext = Object.freeze({ self: validTagName(self) ? self : null, os: osOfPlatform(platform), others: Object.freeze(others) as readonly string[] });
  cache = { key, ctx };
  return ctx;
}
/** 一次 run 用哪份:本机引擎 = 这台;云端 / worker = 不在任何一台电脑上。 */
export function runTagContext(hostExec: boolean): DeviceTagContext { return hostExec ? deviceTagContext() : NO_DEVICE; }

/** 一份自由格式的文字(指令、人格、给旁路用的整份记忆)按本机挑,别台的折成末尾一行。没有标了别台的 → 原样返回。 */
export function textForThisDevice(text: string, ctx: DeviceTagContext, noun: 'entry' | 'part' = 'part'): string {
  const f = filterTaggedText(text, ctx);
  return f.skipped.length ? `${f.text.replace(/\s+$/, '')}\n${foldNote(f.skipped, noun)}` : text;
}

/**
 * 界面 / 接口写一条记忆时的适用范围(remember 工具另有一份带模型口径报错的,见 tools/builtin/memoryLog.ts):
 * appliesTo 给了 → 换上本机名 / 本机系统的标签("all" = 去掉);没给 → 原样,改一条(update)时沿用旧条目的标签。
 * 返回 null = appliesTo 不认得,或这里不是一台电脑却要「只在这台」。
 */
export function factWithScope(fact: string, appliesTo: unknown, ctx: DeviceTagContext, oldContent?: string | null): string | null {
  if (appliesTo === undefined || appliesTo === null || appliesTo === '') {
    if (oldContent == null || tagOf(fact, ctx)) return fact;
    const label = tagOf(oldContent, ctx);
    return label ? withTag(fact, label, ctx) : fact;
  }
  if (!(APPLIES_TO as readonly unknown[]).includes(appliesTo)) return null;
  if (appliesTo === 'all') return withTag(fact, null, ctx);
  const label = labelFor(appliesTo as AppliesTo, ctx);
  return label ? withTag(fact, label, ctx) : null;
}

/** 一句话里有没有本机绝对路径(`/Users/…`、`/home/…`、`~/…`、`C:\…`、`\\host\share`):这种事实到了别的电脑上不成立,
 *  Historian / Dream 整理出来的不进所有设备共用的 Agent 记忆(进项目记忆,或标上这台)。网址里的路径不算。 */
const LOCAL_PATH = /(?:^|[\s"'`(\[（「:：=,，])(?:~[\\/]|\/(?:Users|home|Volumes|mnt|media|opt|srv|private|var|tmp|etc|usr|Library|Applications|root)\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/;
export function hasLocalPath(text: string): boolean { return LOCAL_PATH.test(String(text ?? '')); }

// ── 改名:这台把自己写过的 `[旧名]` 换成 `[新名]`(普通改动,照常同步)──
// 上次打标用的名字记在 <tangu home>/device-name.json;发现变了就把每个 Agent 的 MEMORY.md / SOUL.md / HARNESS.md / config.toml 里
// 行首的 `[旧名]` 换掉。全换成了才记下新名字,中途失败(记忆正被别的写者拿着)下次接着换 —— 换过的再换一遍是空操作。
const seenFile = (): string => path.join(tanguHome(), 'device-name.json');
let reconciling: Promise<RenameResult | null> | null = null;
export interface RenameResult { from: string; to: string; files: string[]; pending: string[] }

function readSeen(): string | null {
  try { const raw = JSON.parse(readFileSync(seenFile(), 'utf8')); return typeof raw?.name === 'string' && raw.name.trim() ? raw.name : null; }
  catch { return null; }
}
function writeSeen(name: string): void {
  const file = seenFile(), tmp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  try { writeFileSync(tmp, JSON.stringify({ name, at: Date.now() }), { mode: 0o600 }); renameSync(tmp, file); }
  finally { try { unlinkSync(tmp); } catch { /* 已改名 */ } }
}
/** TOML 字符串里塞不下的名字(引号 / 反斜杠要转义)就不改 config.toml,别把指令改坏。 */
const tomlSafe = (name: string): boolean => !/["'\\]/.test(name);

function renameInAgent(dir: string, from: string, to: string, files: string[], pending: string[]): void {
  const slug = path.basename(dir);
  if (existsSync(path.join(dir, 'MEMORY.md'))) {
    try {
      const repo = createMemoryRepository(dir);
      const snap = repo.snapshot();
      const next = renameDeviceTag(snap.content, from, to);
      if (next !== snap.content) {
        // 证据跟着走:新行认旧条目的 id(否则改个名,每条记忆的来历就丢了)
        const before = snap.content.split('\n'), after = next.split('\n');
        const provenance = after.flatMap((line, i) => line !== before[i] ? [{ fact: line, sourceIds: snap.entries.filter((e) => e.content === before[i]).map((e) => e.id) }] : []);
        repo.commit({ expectedVersion: snap.version, content: next, source: { kind: 'migration' }, provenance });
        files.push(`${slug}/MEMORY.md`);
      }
    } catch (e) {
      if (e instanceof MemoryRepositoryError) { pending.push(`${slug}/MEMORY.md`); return; }
      throw e;
    }
  }
  for (const file of ['SOUL.md', 'HARNESS.md', 'config.toml']) {
    if (file === 'config.toml' && !tomlSafe(to)) continue;
    let text: string | null;
    try { text = readMemoryFile(dir, file); } catch { pending.push(`${slug}/${file}`); continue; }
    if (text === null) continue;
    const next = renameDeviceTag(text, from, to);
    if (next === text) continue;
    try { atomicWriteMemoryFile(dir, file, next); files.push(`${slug}/${file}`); } catch { pending.push(`${slug}/${file}`); }
  }
}

/** 看这台的名字变了没有;变了就换标签。第一次(没记过)只记下当前名字。并发调用合成一次。 */
export function reconcileDeviceRename(): Promise<RenameResult | null> {
  if (reconciling) return reconciling;
  reconciling = (async () => {
    const now = deviceTagContext().self;
    if (!now) return null;
    const seen = readSeen();
    if (seen === now) return null;
    if (seen === null || !validTagName(seen)) { writeSeen(now); return null; }
    const files: string[] = [], pending: string[] = [];
    const root = agentsDir();
    let dirs: string[] = [];
    try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9-]{0,63}$/.test(d.name)).map((d) => path.join(root, d.name)); } catch { /* 还没有 Agent */ }
    for (const dir of dirs) renameInAgent(dir, seen, now, files, pending);
    if (!pending.length) writeSeen(now);
    if (files.length || pending.length) console.log(`[device-tags] renamed [${seen}] → [${now}] in ${files.length} file(s)${pending.length ? `; retry later: ${pending.join(', ')}` : ''}`);
    return { from: seen, to: now, files, pending };
  })().finally(() => { reconciling = null; });
  return reconciling;
}

/** 本机引擎启动时调一次:先对一遍,再盯着设备文件(同步页上改了名,几秒内就换,不等下一个 run)。 */
let watching: string | null = null;
export function startDeviceRenameWatch(): () => void {
  const file = path.join(forsionSharedDir(), DEVICE_FILE);
  const run = (): void => { void reconcileDeviceRename().catch((e) => console.warn('[device-tags] rename check failed:', (e as Error)?.message || e)); };
  run();
  if (watching !== file) {
    if (watching) unwatchFile(watching);
    watchFile(file, { interval: 3000, persistent: false }, run);
    watching = file;
  }
  return () => { if (watching) unwatchFile(watching); watching = null; };
}
