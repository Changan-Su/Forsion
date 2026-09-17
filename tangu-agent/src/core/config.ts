/**
 * ~/.tangu/config.json —— Tangu 本地实例配置的**单一事实来源(唯一真源)**。
 *
 * 一处编辑、CLI 友好:cloud / database / server / sandbox / workspace / providers / mcp /
 * engines / enginePrefs / specialAgents / plugins / browser / wechat / notes / tts 全段集中于此文件。
 *
 * 设计(刻意保持 generic,避免与各 section 模块循环依赖):
 *   - 本模块只做「config.json 的通用 JSON 读写 + 段取用」,**不** import 任何 section 模块,
 *     **不**做 per-section 归一化(归一化留在各 section 模块自己,如 mcp/config、specialAgentsConfig)。
 *   - 读取语义:config.json **存在即权威**——`getRawSection(name)` 返回该段原始值;返回 undefined
 *     表示该段缺失,调用方据此回落自己的 legacy 文件读取(过渡期 / 单测)。
 *   - 写入语义:`saveSection(name, value)` 一律落 config.json(深合并保留其他段)→ 唯一真源。
 *   - 迁移:`migrateLegacyConfig()` 首启把散落的 auth/providers/mcp/engines/engine-prefs/
 *     special-agents JSON 收进 config.json,旧文件 rename 为 `*.bak`(可回滚,不删)。
 *     `.env` **不动**(仍由 loadTanguEnv 载入 process.env;env 始终可覆盖 config.json,运维逃生口)。
 *
 * 仅 standalone/TUI/desktop 形态使用;microserver/worker 不读本目录。0600(含 token/apiKey)。
 *
 * 并发:桌面主进程、引擎、CLI 三个进程同写这一份文件。写一律走 `updateConfigFile`:持跨进程写锁做
 * 「读 → 改 → 写临时文件 → rename」;读不加锁(rename 原子替换,读者看不到半截 JSON)。
 * 段级读改写用 `updateSection(name, fn)`(fn 在锁内拿最新段值);锁外读段、改完再 saveSection 会盖掉别的进程同时的改动。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, rmSync, openSync, closeSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  configFile, authFile, providersFile, mcpConfigFile,
  enginesFile, enginePrefsFile, specialAgentsConfigFile,
} from './tanguHome.js';

/** config.json 是否存在(存在即权威)。 */
export function configExists(): boolean {
  return existsSync(configFile());
}

/** 读整个 config.json;不存在 / 坏 JSON → null(坏 JSON 由桌面编辑器另行提示)。 */
export function loadRawConfig(): Record<string, any> | null {
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 取某段原始值。config.json 不存在或该段缺失 → undefined(调用方回落 legacy 文件)。
 * 注意:段「存在但为空」(如 `{ "mcp": {} }`)返回 `{}`(权威空),**不**回落。
 */
export function getRawSection(name: string): any {
  const c = loadRawConfig();
  if (!c) return undefined;
  return c[name];
}

// ── 跨进程写锁。与 desktop/electron/configWrite.ts 的 lockedUpdateJson 是同一协议,改一边必须改另一边:
//    锁 = `<config.json>.lock`,O_EXCL 建出即持有,内容 = 本次持有的唯一 token;持锁只包同步的
//    「读 → 改 → 写临时文件 → 核 token → rename」(微秒级,不让出事件循环);锁 mtime 超 LOCK_STALE_MS =
//    持锁进程死在临界区 → rename 到一旁再删;等锁超 LOCK_WAIT_MS 抛错,绝不硬写。
//    偷锁会被骗:判陈旧与 rename 之间锁已被别人偷走重建(ABA),或持锁进程被挂起 / 合盖睡眠超过 5s —— 活锁被挪走。
//    所以提交前核锁里还是自己的 token,不是就抛错不落盘;放锁也只删自己的。代价 = 这种交错下一次写入失败(抛给调用方)。
//    残余窗口:「核 token → rename」与「核 token → 删锁」之间的微秒 —— 持锁者恰好停在这两处超过 5s 才会撞上。
//    ponytail: 陈旧判定靠 mtime(墙钟),不查持锁 pid 是否存活。等锁用 Atomics.wait 同步睡,锁真被占满 10s 时
//    整个引擎进程(HTTP / 通道 / 定时器)跟着停 10s;正常持锁只有微秒级。
const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 10_000;
/** Windows 上锁文件处于「删除挂起」时 CREATE_NEW 报 EPERM/EACCES,按「被占」处理;POSIX 上它们是真权限错误,立刻抛。 */
const LOCK_BUSY = new Set(process.platform === 'win32' ? ['EEXIST', 'EPERM', 'EACCES'] : ['EEXIST']);

function stealIfStale(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return;
    const aside = `${lock}.stale-${process.pid}-${randomUUID()}`;
    renameSync(lock, aside);
    rmSync(aside, { force: true });
  } catch { /* 锁刚被释放 / 被别人先偷走:回去重抢 */ }
}

/** fn 拿到 stillMine():提交(rename)前调用,锁已不是自己的就别落盘。 */
function withConfigLock<T>(file: string, fn: (stillMine: () => boolean) => T): T {
  const lock = `${file}.lock`;
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = performance.now() + LOCK_WAIT_MS; // 单调时钟:墙钟回拨不拉长等待
  mkdirSync(dirname(file), { recursive: true }); // config.json 在共享域(home=…/tangu 时为其父目录)
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, 'wx');
    } catch (e) {
      if (!LOCK_BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      stealIfStale(lock);
      if (performance.now() > deadline) throw new Error(`config.json 的写锁被占超过 ${LOCK_WAIT_MS / 1000}s,放弃本次写入:${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // 同步睡 5ms 再抢(对方持锁只有微秒级)
      continue;
    }
    try {
      writeSync(fd, token);
    } catch (e) { // 锁建出来了、token 没写进去(磁盘满):自己删掉,别留空锁让所有写者干等 5s
      try { closeSync(fd); } catch { /* ignore */ }
      rmSync(lock, { force: true });
      throw e;
    }
    closeSync(fd);
    break;
  }
  const mine = (): boolean => { try { return readFileSync(lock, 'utf8') === token; } catch { return false; } };
  try {
    return fn(mine);
  } finally {
    try { if (mine()) rmSync(lock, { force: true }); } catch { /* 删不掉(Windows 杀软占着)就留给 stale 回收 */ }
  }
}

/**
 * config.json 的读改写(唯一写入口,saveSection / migrateLegacyConfig 都走这里)。持跨进程写锁,
 * mutate 恰好执行一次;返回 undefined = 不写。临时文件唯一命名、建出来就是 0600,rename 原子落位(不对目录 fsync)。
 * ⚠️ **文件存在但解析不了 → 拒绝写入**:若当空配置兜底就会把整份 config.json 重写成只剩这一段 ——
 * providers 的 apiKey、云端 token、mcp 配置全没了,且不可撤销。宁可报错让人去修那个文件。
 */
export function updateConfigFile(
  mutate: (cur: Record<string, any> | null) => Record<string, any> | undefined,
): Record<string, any> | undefined {
  const file = configFile();
  return withConfigLock(file, (stillMine) => {
    let raw: string | null = null;
    try { raw = readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    let cur: Record<string, any> | null = null;
    if (raw !== null) {
      try { cur = JSON.parse(raw); } catch { /* 下面统一拒写 */ }
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
        throw new Error(`config.json 解析失败,拒绝写入(以免其余配置被整份覆盖):${file}`);
      }
    }
    const next = mutate(cur);
    if (next === undefined) return undefined;
    const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (!stillMine()) throw new Error(`config.json 的写锁在持有期间被当作陈旧锁回收(进程被挂起超过 ${LOCK_STALE_MS / 1000}s?),放弃本次写入:${file}`);
      renameSync(tmp, file);
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* 清不掉就留着,别盖掉原始错误 */ }
      throw e;
    }
    return next;
  });
}

/** 设置某段并落盘(其他段原样保留,以锁内读到的最新内容为底),返回写后的整份配置。
 *  ⚠️ value 若是锁外「读段 → 改」算出来的,别的进程在这之间改同一段会被盖掉 —— 读改写一律用 updateSection。 */
export function saveSection(name: string, value: any): Record<string, any> {
  return updateConfigFile((c) => ({ ...(c || {}), [name]: value }))!;
}

/** 段级读改写:fn 在锁内拿到该段最新原始值(缺失 = undefined),返回新段值;返回 undefined = 不写。
 *  fn 必须同步、无副作用(恰好执行一次,抛错 = 不写并抛给调用方)。返回 fn 的结果。 */
export function updateSection<T>(name: string, fn: (cur: any) => T | undefined): T | undefined {
  let out: T | undefined;
  updateConfigFile((c) => {
    out = fn(c?.[name]);
    return out === undefined ? undefined : { ...(c || {}), [name]: out };
  });
  return out;
}

/** 读一个 JSON 文件,失败返回 undefined。 */
function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/**
 * 首启一次性迁移:config.json 不存在时,把散落的 legacy JSON 收进来,旧文件 → `*.bak`。
 * 幂等(config.json 已存在 → 直接返回)。无任何 legacy 文件(全新安装)→ 不创建空 config.json
 * (留待首次 saveSection 创建)。`.env` 不迁移、不改动。
 */
export function migrateLegacyConfig(): void {
  if (configExists()) return;

  const c: Record<string, any> = {};

  const auth = readJson(authFile()); // { cloudUrl, token, model }
  if (auth && typeof auth === 'object') {
    c.cloud = { url: auth.cloudUrl || '', token: auth.token || '', defaultModel: auth.model || '' };
  }

  const prov = readJson(providersFile()); // 裸数组 或 { providers: [...] }
  const provArr = Array.isArray(prov) ? prov : Array.isArray(prov?.providers) ? prov.providers : undefined;
  if (provArr) c.providers = provArr;

  const mcp = readJson(mcpConfigFile()); // { mcpServers: {...} }
  if (mcp?.mcpServers && typeof mcp.mcpServers === 'object') c.mcp = { mcpServers: mcp.mcpServers };

  const eng = readJson(enginesFile()); // { engines: [...] }
  if (Array.isArray(eng?.engines)) c.engines = { engines: eng.engines };

  const prefs = readJson(enginePrefsFile()); // { [id]: { defaultModel } }
  if (prefs && typeof prefs === 'object') c.enginePrefs = prefs;

  const special = readJson(specialAgentsConfigFile()); // { historian, muse }
  if (special && typeof special === 'object') c.specialAgents = special;

  if (Object.keys(c).length === 0) return; // 全新安装:无可迁移内容,不落空文件

  // 锁内再确认一次仍不存在:并发的桌面 / CLI 抢先建了文件就以它为准、不迁移(同开头「已存在则跳过」)
  if (!updateConfigFile((cur) => (cur === null ? c : undefined))) return;

  // 旧文件 → .bak(停止被读、可恢复,不删)。
  for (const f of [authFile(), providersFile(), mcpConfigFile(), enginesFile(), enginePrefsFile(), specialAgentsConfigFile()]) {
    try { if (existsSync(f)) renameSync(f, `${f}.bak`); } catch { /* best-effort */ }
  }
}
