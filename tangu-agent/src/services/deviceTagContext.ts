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
import { parse as parseToml } from 'smol-toml';
import { APPLIES_TO, deviceNameKey, filterTaggedText, foldNote, labelFor, osOfPlatform, renameDeviceTag, sameDeviceName, tagOf, validTagName, withTag, type AppliesTo, type DeviceTagContext } from '../contracts/deviceTags.js';
import { atomicWriteMemoryFile, createMemoryRepository, MemoryRepositoryError, readMemoryFile, withMemoryDirectoryLock } from './memoryRepository.js';

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
  let selfId = '';
  try { const raw = JSON.parse(readFileSync(fDevice, 'utf8')); if (typeof raw?.id === 'string') selfId = raw.id; } catch { /* 没登记过 */ }
  let others: string[] = [];
  try {
    const raw = JSON.parse(readFileSync(fList, 'utf8'));
    if (Array.isArray(raw?.devices)) {
      const seen = new Set([deviceNameKey(self)]);
      for (const d of raw.devices) {
        if (selfId && d?.id === selfId) continue;
        // aliases = 那台以前用过的名字(Extend 抄设备表时记下):它改名后、改过的文件还没同步过来之前,`[旧名]` 仍认得是它(Codex 评审 11-06)
        const names = [d?.name, ...(Array.isArray(d?.aliases) ? d.aliases : [])].filter((n): n is string => typeof n === 'string').map((n) => n.trim());
        for (const name of names) {
          if (!validTagName(name) || seen.has(deviceNameKey(name))) continue;
          seen.add(deviceNameKey(name)); others.push(name);
        }
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
const LOCAL_PATH = /(?:^|[\s"'`(\[（「:：=,，])(?:~[\\/]|\/(?:Users|home|Volumes|mnt|media|opt|srv|private|var|tmp|etc|usr|Library|Applications|root|data|workspace|workspaces|nix|snap|run)\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/;
export function hasLocalPath(text: string): boolean { return LOCAL_PATH.test(String(text ?? '')); }

// ── 改名:这台把自己写过的 `[旧名]` 换成 `[新名]`(普通改动,照常同步)──
// 上次打标用的名字记在 <tangu home>/device-name.json(`from` = 还可能留在文件里、没换完的旧名);发现变了就把每个 Agent 的
// MEMORY.md / SOUL.md / HARNESS.md / config.toml 里行首的旧名换掉。全换成了才清掉 `from`;中途失败(记忆正被别的写者拿着)
// 记下所有没换完的旧名,过一会儿再换 —— 连着改两次名(A→B 没换完又改成 C),A 和 B 都换成 C。换过的再换一遍是空操作。
const seenFile = (): string => path.join(tanguHome(), 'device-name.json');
let reconciling: Promise<RenameResult | null> | null = null;
export interface RenameResult { from: string[]; to: string; files: string[]; pending: string[]; skipped: string[] }
interface Seen { name: string; from: string[] }

function readSeen(): Seen | null {
  try {
    const raw = JSON.parse(readFileSync(seenFile(), 'utf8'));
    if (typeof raw?.name !== 'string' || !raw.name.trim()) return null;
    return { name: raw.name, from: Array.isArray(raw.from) ? raw.from.filter((n: unknown): n is string => typeof n === 'string' && validTagName(n)) : [] };
  } catch { return null; }
}
function writeSeen(name: string, from: string[] = []): void {
  const file = seenFile(), tmp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  try { writeFileSync(tmp, JSON.stringify({ name, ...(from.length ? { from } : {}), at: Date.now() }), { mode: 0o600 }); renameSync(tmp, file); }
  finally { try { unlinkSync(tmp); } catch { /* 已改名 */ } }
}

const renameAll = (text: string, from: readonly string[], to: string): string => from.reduce((t, f) => renameDeviceTag(t, f, to), text);
/** 把 TOML 解析结果里每个字符串都按同样规则换一遍:用来核对原文上的替换没有改坏别的东西。 */
const mapStrings = (v: unknown, fn: (s: string) => string): unknown => typeof v === 'string' ? fn(v) : Array.isArray(v) ? v.map((x) => mapStrings(x, fn))
  : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)])) : v;
const VALUE_START = /(=[ \t]*("""|\'\'\'|"|')[ \t]*)\[([^\[\]\n]{1,64})\]([ \t]+)/g;
/** config.toml:行首的标签(多行字符串里)+ 值开头的标签(`instructions = "[旧名] …"`)。换完解析一遍,和「解析后每个字符串各自换」
 *  逐项相同才算数;对不上(名字里的引号 / 反斜杠在这种字符串里写不进去)返回 null,不写,别把指令改坏。 */
function renameInToml(text: string, from: readonly string[], to: string): string | null {
  let next = renameAll(text, from, to);
  next = next.replace(VALUE_START, (m, pre: string, q: string, label: string, ws: string) =>
    from.some((f) => sameDeviceName(label, f)) ? `${pre}[${q[0] === '"' ? to.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : to}]${ws}` : m);
  if (next === text) return text;
  try {
    const want = mapStrings(parseToml(text), (v) => renameAll(v, from, to));
    return JSON.stringify(parseToml(next)) === JSON.stringify(want) ? next : null;
  } catch { return null; }
}

function renameInAgent(dir: string, from: readonly string[], to: string, out: { files: string[]; pending: string[]; skipped: string[] }): void {
  const slug = path.basename(dir);
  // 整个 Agent 文件夹一把锁(和记忆仓库、桌面同步写 agents/<slug>/ 用的同一把 .memory.lock):读、换、写之间别人插不进来,
  // 不会拿旧的读数盖掉同步刚写下的新内容(Codex 评审 11-06)。锁被别人拿着 = 这次不换,稍后重试。
  try {
    withMemoryDirectoryLock(dir, () => {
      if (existsSync(path.join(dir, 'MEMORY.md'))) {
        const repo = createMemoryRepository(dir);
        const snap = repo.snapshot();
        const next = renameAll(snap.content, from, to);
        if (next !== snap.content) {
          // 证据跟着走:新行认旧条目的 id(否则改个名,每条记忆的来历就丢了)
          const before = snap.content.split('\n'), after = next.split('\n');
          const provenance = after.flatMap((line, i) => line !== before[i] ? [{ fact: line, sourceIds: snap.entries.filter((e) => e.content === before[i]).map((e) => e.id) }] : []);
          repo.commit({ expectedVersion: snap.version, content: next, source: { kind: 'migration' }, provenance });
          out.files.push(`${slug}/MEMORY.md`);
        }
      }
      for (const file of ['SOUL.md', 'HARNESS.md', 'config.toml']) {
        const text = readMemoryFile(dir, file);
        if (text === null) continue;
        const next = file === 'config.toml' ? renameInToml(text, from, to) : renameAll(text, from, to);
        if (next === null) { out.skipped.push(`${slug}/${file}`); continue; }
        if (next === text) continue;
        atomicWriteMemoryFile(dir, file, next); out.files.push(`${slug}/${file}`);
      }
    });
  } catch (e) {
    // 被别的写者拿着 / 刚被改过 / 提交到一半等引擎补完 = 稍后重试;别的(不安全路径、坏文件、读不了)重试也没用,记下、不再换
    const code = (e as { code?: unknown })?.code;
    if (e instanceof MemoryRepositoryError && ['MEMORY_BUSY', 'MEMORY_VERSION_CONFLICT', 'MEMORY_PROJECTION_CONFLICT'].includes(e.code)) { out.pending.push(slug); return; }
    if (e instanceof MemoryRepositoryError || typeof code === 'string') { out.skipped.push(slug); console.warn(`[device-tags] cannot rename tags in ${slug}:`, (e as Error).message); return; }
    throw e;
  }
}

/** 看这台的名字变了没有;变了就换标签。第一次(没记过)只记下当前名字。并发调用合成一次。 */
export function reconcileDeviceRename(): Promise<RenameResult | null> {
  if (reconciling) return reconciling;
  reconciling = (async () => {
    const now = deviceTagContext().self;
    if (!now) return null;
    const seen = readSeen();
    if (seen === null || !validTagName(seen.name)) { writeSeen(now); return null; }
    const from = [...new Set([...seen.from, seen.name].filter((n) => validTagName(n) && !(sameDeviceName(n, now) && n.trim() === now.trim())))];
    if (!from.length) { if (seen.name !== now || seen.from.length) writeSeen(now); return null; }
    const out = { files: [] as string[], pending: [] as string[], skipped: [] as string[] };
    const root = agentsDir();
    let dirs: string[] = [];
    try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9-]{0,63}$/.test(d.name)).map((d) => path.join(root, d.name)); } catch { /* 还没有 Agent */ }
    for (const dir of dirs) renameInAgent(dir, from, now, out);
    writeSeen(now, out.pending.length ? from : []);
    if (out.files.length || out.pending.length || out.skipped.length) {
      console.log(`[device-tags] renamed [${from.join('], [')}] → [${now}] in ${out.files.length} file(s)${out.pending.length ? `; retry later: ${out.pending.join(', ')}` : ''}${out.skipped.length ? `; left as is (cannot be rewritten safely): ${out.skipped.join(', ')}` : ''}`);
    }
    return { from, to: now, ...out };
  })().finally(() => { reconciling = null; });
  return reconciling;
}

/** 本机引擎启动时调一次:先对一遍,再盯着设备文件(同步页上改了名,几秒内就换,不等下一个 run)。 */
let watching: string | null = null;
export function startDeviceRenameWatch(): () => void {
  const file = path.join(forsionSharedDir(), DEVICE_FILE);
  // 有没换完的(锁被拿着):30 秒后再来,直到换完;设备文件不再变也会重试(Codex 评审 11-06)
  let retry: NodeJS.Timeout | null = null;
  const run = (): void => {
    if (retry) { clearTimeout(retry); retry = null; }
    void reconcileDeviceRename().then((r) => { if (r?.pending.length) { retry = setTimeout(run, 30_000); retry.unref?.(); } })
      .catch((e) => console.warn('[device-tags] rename check failed:', (e as Error)?.message || e));
  };
  run();
  if (watching !== file) {
    if (watching) unwatchFile(watching);
    watchFile(file, { interval: 3000, persistent: false }, run);
    watching = file;
  }
  return () => { if (watching) unwatchFile(watching); watching = null; };
}
