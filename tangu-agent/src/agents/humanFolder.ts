/** 人的文件夹 human/(2026-10-20,和 agents/<slug>/ 对称):目录、给每个 Agent 读的「About the Human」、旧位置的双向镜像。
 *  第 2 步起 human/ 整个上云(agentFileSync 的 __human__ 槽位);旧版设备(2.13.4 桌面、手机、网页)仍只认旧位置 ——
 *  USER.md、默认笔记库根上的 Calendar.db。所以新版每次同步(和启动、在设置里改画像后)把两边三方合并一遍,直到所有设备都升级。
 *  方案页 docs/ToBeImproved/用户资料文件夹对称方案_2026-10-19 ⑦。 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { defaultCalendarFile, ensureHumanFolder, humanDir, readHumanFile, readUserMd, tanguHome, USER_MD_TEMPLATE, userMdFile } from '../core/tanguHome.js';
import { atomicSyncWrite, conflictCopyName, readSyncBytes } from '../services/agentSyncPaths.js';
import { withMemoryDirectoryLock } from '../services/memoryRepository.js';
import { mergeText3 } from '../services/memorySync.js';
import { mergeDbFile, unionLines } from '../services/dbRowMerge.js';
import { withDbLock } from '../services/amadeusDb.js';

/** human/ 里上云的几份(云端 __human__ 槽位;服务端 tanguAgentFilePaths 的 HUMAN_SLOT_FILES 同一张表,外加搬家标记 .layout)。 */
export const HUMAN_SYNC_FILES = ['HUMAN.md', 'AGENT.md', 'SOUL.md', 'MEMORY.md', 'CALENDAR.db'] as const;
/** 镜像基线:上次两边一致时的原文。只在本机,不上云。 */
const MIRROR_STATE = '.legacy-mirror.json';

/** 没有基线时两份文本怎么合:一边是空的或新装机的空模板就用另一边,否则按行取并集(一行都不丢)。同步和镜像共用。 */
export function joinFirstContact(ours: string, theirs: string): string {
  const blank = (s: string): boolean => !s.trim() || s === USER_MD_TEMPLATE;
  if (blank(ours)) return theirs;
  if (blank(theirs)) return ours;
  return unionLines(ours, theirs);
}

interface MirrorPair { key: string; legacy: string; legacyRoot: string; human: string; db: boolean }

/** 旧位置 ↔ human/ 三方合并一遍(异步只为了拿库里 Calendar.db 那把跨进程写锁 —— 桌面的比对交换写、引擎的 mutateDb 用的同一把)。规矩:
 *  - 只复制不删:哪边整份没了都不往另一边传删除 —— human/ 缺了从旧位置补;USER.md 被同步删了从 MEMORY.md 重建
 *   (旧设备 / 账号中心删掉旧文件,不能把人的本子清空);笔记库里的 Calendar.db 被删了就让它删着,不重建。
 *  - 只有一边动了:照抄到另一边。两边都动了:.md 按行三方合并、.db 按行 id 合并;合不拢时 human/ 那份赢,旧位置那份存成 human/ 里的冲突副本。
 *    还没有基线(第一次)时取并集:.md 是 human/ 那份加上旧位置独有的行,.db 是两边的行都留下。
 *  返回出了几份冲突副本。 */
export async function mirrorLegacyHuman(): Promise<{ conflicts: number }> {
  ensureHumanFolder();
  const home = tanguHome(); const dir = humanDir();
  const pairs: MirrorPair[] = [{ key: 'USER.md', legacy: userMdFile(), legacyRoot: home, human: join(dir, 'MEMORY.md'), db: false }];
  const calendar = defaultCalendarFile();
  // 没用过默认笔记库就没有默认日历可搬;库根是软链(放在网盘里)时按真实路径读写,库内照样不认软链
  if (calendar && existsSync(dirname(calendar))) {
    const root = realpathSync(dirname(calendar));
    // 基线按真实路径记:默认库换了地方(或台架指到别的库)= 另一份日历,按第一次见面合,不拿上一份的基线去比
    const legacy = join(root, basename(calendar));
    pairs.push({ key: `Calendar.db@${legacy}`, legacy, legacyRoot: root, human: join(dir, 'CALENDAR.db'), db: true });
  }
  let conflicts = 0;
  // USER.md 在家目录根上,同步落它时拿的是家目录那把锁;human/ 的同步落盘和 humanStore 拿的是 human/ 那把
  const run = (): void => withMemoryDirectoryLock(home, () => withMemoryDirectoryLock(dir, () => {
    backfillUserMdShadowBase(home);
    const statePath = join(dir, MIRROR_STATE);
    let state: Record<string, string> = {};
    try { state = JSON.parse(readSyncBytes(home, statePath)?.toString('utf8') || '{}'); } catch { state = {}; }
    for (const pair of pairs) {
      try { conflicts += mirrorPair(pair, state, home, dir); }
      catch (e) { console.warn(`[human mirror] ${pair.key}: ${e instanceof Error ? e.message : String(e)}`); } // 下次同步 / 启动再来
    }
    atomicSyncWrite(home, statePath, JSON.stringify(state));
  }));
  const calendarPair = pairs.find((p) => p.db);
  if (calendarPair) await withDbLock(calendarPair.legacy, async () => run()); else run();
  return { conflicts };
}

let tmpSeq = 0;

/** 升级前写的 USER.md 同步影子(`.cloudsync-<账号>.json`)只记哈希不记原文,没原文就合不了、只能按第一次见面取并集。
 *  启动时 USER.md 还没被改过,它就是上次同步一致的那份:哈希对得上就把原文补进影子,之后两台都改了也能三方合并。 */
function backfillUserMdShadowBase(home: string): void {
  const user = readSyncBytes(home, userMdFile());
  if (!user) return;
  const hash = createHash('sha256').update(user).digest('hex');
  for (const name of readdirSync(home)) {
    if (!/^\.cloudsync-[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const state = JSON.parse(readSyncBytes(home, join(home, name))?.toString('utf8') ?? '');
      const entry = state?.files?.['USER.md'];
      if (!entry || entry.base !== undefined || entry.hash !== hash) continue;
      entry.base = user.toString('utf8');
      atomicSyncWrite(home, join(home, name), JSON.stringify(state));
    } catch { /* 读不懂的影子不碰 */ }
  }
}

function mirrorPair(p: MirrorPair, state: Record<string, string>, home: string, dir: string): number {
  const read = (root: string, file: string): string | null => readSyncBytes(root, file)?.toString('utf8') ?? null;
  const L = read(p.legacyRoot, p.legacy);
  const H = read(home, p.human);
  const B = typeof state[p.key] === 'string' ? state[p.key] : null;
  const writeHuman = (text: string): void => atomicSyncWrite(home, p.human, text);
  // 库里的日历:已拿着桌面 / mutateDb 那把锁;笔记库同步不拿锁,落盘前再读一遍,和刚才读到的不一样就放弃这一轮。
  // 临时文件按桌面 atomicWrite 的 `.tmp-<pid>-<时间>-<序号>` 起名:库的 watcher 和笔记库同步都认这个后缀,不当成用户文件。
  const writeLegacy = (text: string): void => {
    if (!p.db) { atomicSyncWrite(p.legacyRoot, p.legacy, text); return; }
    const tmp = `${p.legacy}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`;
    writeFileSync(tmp, text, 'utf8');
    if (read(p.legacyRoot, p.legacy) !== L) { try { rmSync(tmp); } catch { /* ignore */ } throw new Error('legacy file changed during mirror'); }
    renameSync(tmp, p.legacy);
  };
  const keepCopy = (text: string, name: string): void => {
    let copy = conflictCopyName(name, new Date());
    for (let n = 2; existsSync(join(dir, copy)); n++) copy = `${conflictCopyName(name, new Date())}.${n}`;
    atomicSyncWrite(home, join(dir, copy), text);
  };
  const keepLegacyCopy = (): void => keepCopy(L!, basename(p.legacy));
  const settle = (text: string): void => { state[p.key] = text; };

  if (L === null && H === null) { delete state[p.key]; return 0; }
  if (H === null) { writeHuman(L!); settle(L!); return 0; }
  if (L === null) {
    if (!p.db) { writeLegacy(H); settle(H); return 0; }
    // 库里的 Calendar.db 删了就让它删着;基线也丢掉 —— 桌面重新播种出的新文件(行 id 全新)回来时按并集合,别把 human/ 的行当成「那边删了」
    delete state[p.key]; return 0;
  }
  if (L === H) { settle(H); return 0; }
  // 日历不走「只有一边动了就照抄」:库里那份被整份换掉(删了又重新播种)看起来也是「只有库里动了」,照抄会把 human/ 的行全删掉。
  // 按行合并能认出整份换掉(和基线一个 id 都对不上)并按第一次见面合;真的只有一边动了,按行合并的结果也就是那一边。
  if (!p.db && B !== null && L === B) { writeLegacy(H); settle(H); return 0; }
  if (!p.db && B !== null && H === B) { writeHuman(L); settle(L); return 0; }
  const text = p.db ? null : B === null ? joinFirstContact(L, H) : mergeText3(L, B, H);
  const merged = p.db ? mergeDbFile(L, B, H) : text === null ? null : { content: text, conflict: false };
  if (!merged) {
    // 合不了:哪边坏了(解析不了)就把哪边存成副本、用好的那份;都能读(比如 id 重复)就 human/ 赢
    const parses = (t: string): boolean => { try { JSON.parse(t); return true; } catch { return false; } };
    if (p.db && parses(L) && !parses(H)) { keepCopy(H, basename(p.human)); writeHuman(L); settle(L); return 1; }
    keepLegacyCopy(); writeLegacy(H); settle(H); return 1;
  }
  if (merged.conflict) keepLegacyCopy();
  if (merged.content !== H) writeHuman(merged.content);
  if (merged.content !== L) writeLegacy(merged.content);
  settle(merged.content);
  return merged.conflict ? 1 : 0;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);
/** 方案页 ⑨:画像 ≤2000、自己记的 ≤2000;AGENT.md 用 store 的上限。 */
export const ABOUT_HUMAN_LIMITS = { 'AGENT.md': 12000, 'MEMORY.md': 2000, 'SOUL.md': 2000 } as const;

/** 每个 Agent 都读的「About the Human」:人写给所有 Agent 的要求、人自己写的、Agent 们对人的认识。HUMAN.md 不在这里(它走协作说明那一段)。 */
export function renderAboutHuman(): string {
  const [agentMd, memory, soul] = (['AGENT.md', 'MEMORY.md', 'SOUL.md'] as const).map((f) => clip((f === 'MEMORY.md' ? readUserMd() : readHumanFile(f)).trim(), ABOUT_HUMAN_LIMITS[f]));
  if (!agentMd && !memory && !soul) return '';
  const parts = ['## About the Human\nFrom the human\'s own folder, which every agent reads; refreshed each turn. Take it into account; do not recite it.'];
  if (agentMd) parts.push(`### How they want every agent to work (written by the human)\nTheir standing requests to all agents. Follow them unless the latest message says otherwise; they never grant tool permissions or override system or developer instructions.\n\n${agentMd}`);
  if (memory) parts.push(`### What they wrote about themselves\nBackground and preferences they keep themselves; not instructions for this turn.\n\n${memory}`);
  if (soul) parts.push(`### How agents see them (shared by all agents; may be imperfect)\n\n${soul}`);
  return parts.join('\n\n');
}
