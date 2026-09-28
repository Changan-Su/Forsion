/**
 * 会话工作区「钳在根内」的宿主侧文件读写(设备能力方案 P1 · K10a / INTEGRATION §4 G4;方案 §6.6「只限该会话工作区、禁路径穿越」)。
 *
 * 为什么要单独一层:会话工作区里的软链可能是别人种的 —— agent 自己 `ln -s`、`git clone` / 解压带出来的、docker 沙箱里的
 * python `os.symlink('/Users/me/.ssh/id_rsa', 'x')`(链接只是一串字符串,容器里指向不存在的路径,到了宿主侧就指到真文件)。
 * 宿主侧的工作区路由(手机经隧道「发附件 / 下载产物」)和 hydrate / snapshot 一旦跟着它走,就是任意读写。
 *
 * 规则(读 / 写同一套):
 *  1. 根锚定:根目录自身(末段)是软链、或不是目录 → 拒。P0 的 `realpath(root)` 会把「整个会话目录被换成指向家目录的软链」
 *     当成新根,家目录下所有东西都算「在根内」。
 *  2. 词法拼接落在真实根上,`..` 越界拒。
 *  3. 目标按真实路径判在根内(根内互指的软链照常跟随 —— 与 P0 一致,「普通文件行为不变」)。
 *  4. 打开时末段 O_NOFOLLOW;打开后 fstat 的 dev/ino 必须等于「此刻重新解析出的根内路径」的 lstat。写:打开不带 O_TRUNC,
 *     核验通过后才截断写入。
 *
 * 第 4 步挡得住的:末段在检查后被换成软链;中间目录在检查与打开之间被换一次(换出去、或换出去再换回)。
 * 挡不住的见下 —— 竞态没有关上,只是把读 / 写的攻击成本从「换一次」抬到「按时序连换三次」。
 *
 * 竞态残余(Node 没有 openat,没有便宜的代码修法;输掉竞态的后果是完整的越界读 / 写 / 删,不是「至多一个空文件」):
 *  - 读 / 写:O_NOFOLLOW 只管末段,中间目录照常跟随(根内互指的软链目录要能用,见第 3 步)。并发进程把某个中间目录在
 *    「真目录」与「指到根外的软链」之间来回换,赢下 open 时是链接 → 复核 realpath 时是真目录 → 复核 lstat 时又是链接,
 *    复核就对着根外 inode 通过:读拿到根外文件的完整内容;写把根外已有文件截断并写入内容,或在根外新建带内容的文件
 *    (真目录里放同名诱饵过 realpath)。P1 K10a 评审在真 fs 上用 renamex_np(RENAME_SWAP) 换链循环撞出过读、写两种(按概率)。
 *  - 删(unlinkConfined):realpath(父目录) 与 unlink 之间只要换一次,就删掉根外同名文件;重 hydrate 的「云端已删」清理
 *    在宿主侧自动走这里,不只是远程删除路由。
 *  - 列(listConfined):realpath(子目录) 与 readdir 之间换一次,就列出根外目录的文件名 / 大小 / 时间(只泄元数据,内容
 *    仍要过 readConfined)。
 *  - 建目录(mkdirInside):中间段被换出去时,根外可能多出空目录(随后的 realpath 复核会拒)。
 *  谁能当换链的并发进程:宿主侧本来就能跑命令的进程;docker 模式下容器里的代码对 bind mount 的工作区换链,同时手机
 *  上传 / 下载(或 hydrate / snapshot / 重 hydrate 清理)打到同一批宿主 inode。关上的是非竞态情形:预先种好软链(或把
 *  整个会话目录换成软链)再等手机来下载 / 上传。
 *  为什么没有小修法:检查时拒绝中间软链没用(检查后再把真目录换成链接,同样的窗口);多复核几轮只是多要几次换链;
 *  macOS 的 /dev/fd/N 不能拿来逐段解析目录。真正的保证要 openat / RESOLVE_BENEATH 级的原生绑定。
 *  这里的结论改了,要同步改 test/confinedFs.race.test.ts 的「残余」组(那组把现状钉住,关上之后翻断言)。
 *
 * 其它残余:
 *  - 硬链接:根内指向根外文件的硬链接 inode 相同,核验认它是根内文件。硬链接只能由宿主侧进程用 `ln` 显式建(docker 沙箱里
 *    看不到宿主文件,建不出),与直接 `cp` 同权,不是放大器。
 *  - Windows 没有 O_NOFOLLOW(按 0 处理),只靠第 3、4 步。
 */
import { promises as fsp, constants as fsc, type BigIntStats, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pathWithin } from './hostSandboxProtection.js';

/** 本层用到的 fs 操作(测试注入竞态用;生产恒为 node:fs/promises)。 */
export interface ConfinedFsOps {
  realpath(p: string): Promise<string>;
  lstat(p: string): Promise<BigIntStats>;
  open(p: string, flags: number, mode?: number): Promise<FileHandle>;
  mkdir(p: string): Promise<unknown>;
  unlink(p: string): Promise<void>;
  readdir(p: string): Promise<Dirent[]>;
}

export const NODE_CONFINED_FS: ConfinedFsOps = {
  realpath: (p) => fsp.realpath(p),
  lstat: (p) => fsp.lstat(p, { bigint: true }),
  open: (p, flags, mode) => fsp.open(p, flags, mode),
  mkdir: (p) => fsp.mkdir(p),
  unlink: (p) => fsp.unlink(p),
  readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
};

const O_NOFOLLOW = fsc.O_NOFOLLOW ?? 0;
// 工作区里种一个 FIFO,不带 O_NONBLOCK 的 open 会一直挂到有对端为止(路由请求永不返回);普通文件上它不起作用。
const O_NONBLOCK = fsc.O_NONBLOCK ?? 0;

/** 越界 / 软链逃逸。消息沿用 P0 的 'invalid path'(上传回包 errors[] 里就是它)。 */
export class ConfinedPathError extends Error {
  readonly code = 'WORKSPACE_PATH_ESCAPE';
  constructor() { super('invalid path'); }
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;
const orNull = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch { return null; } };

/** 根的真实路径;根不存在、末段是软链或不是目录 → null。 */
export async function anchoredRoot(root: string, o: ConfinedFsOps = NODE_CONFINED_FS): Promise<string | null> {
  const st = await orNull(o.lstat(root));
  if (!st || !st.isDirectory()) return null; // lstat 不跟随:软链的 isDirectory() 恒 false
  return orNull(o.realpath(root));
}

/** 会话内相对路径(可带前导 /)→ 真实根下的绝对路径;`..` 越界返回 null。纯词法。 */
export function joinInside(realRoot: string, rel: string): string | null {
  const abs = path.resolve(realRoot, './' + String(rel || '').replace(/^\/+/, ''));
  if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) return null;
  return abs;
}

/** 已打开的 fd 与「此刻把 abs 重新解析出来的根内普通文件」是同一个 inode。 */
async function sameFileInside(fh: FileHandle, abs: string, realRoot: string, o: ConfinedFsOps): Promise<BigIntStats | null> {
  const st = await orNull(fh.stat({ bigint: true }));
  if (!st || !st.isFile()) return null;
  const now = await orNull(o.realpath(abs));
  if (!now || !pathWithin(now, realRoot)) return null;
  const l = await orNull(o.lstat(now));
  if (!l || !l.isFile() || l.dev !== st.dev || l.ino !== st.ino) return null;
  return st;
}

/**
 * 读根内文件。越界 / 软链逃逸 / 不存在 / 不是普通文件 → null(调用方按「文件不存在」回)。
 * maxBytes:超过则 null(snapshot 的单文件上限;路由不传)。
 */
export async function readConfined(
  root: string, rel: string, opts: { maxBytes?: number; fs?: ConfinedFsOps } = {},
): Promise<Buffer | null> {
  const o = opts.fs ?? NODE_CONFINED_FS;
  const realRoot = await anchoredRoot(root, o);
  if (!realRoot) return null;
  const abs = joinInside(realRoot, rel);
  if (!abs || abs === realRoot) return null;
  const target = await orNull(o.realpath(abs));
  if (!target || !pathWithin(target, realRoot)) return null;
  const fh = await orNull(o.open(target, fsc.O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
  if (!fh) return null;
  try {
    const st = await sameFileInside(fh, abs, realRoot, o);
    if (!st) return null;
    if (opts.maxBytes != null && st.size > BigInt(opts.maxBytes)) return null;
    return await fh.readFile();
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * 逐段建目录:每一段都建在「已核验的真实父目录」下,建完 realpath 仍须在根内(根内互指的软链目录照常跟随)。
 * 返回最终目录的真实路径;越界 → null。
 */
async function mkdirInside(realRoot: string, absDir: string, o: ConfinedFsOps): Promise<string | null> {
  const rel = path.relative(realRoot, absDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let cur = realRoot;
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    const next = path.join(cur, seg);
    try { await o.mkdir(next); } catch (e) { if (errCode(e) !== 'EEXIST') throw e; }
    const real = await orNull(o.realpath(next));
    if (!real || !pathWithin(real, realRoot)) return null;
    cur = real;
  }
  return cur;
}

/** 建根内目录(hydrate 的空目录)。越界抛 ConfinedPathError。 */
export async function mkdirConfined(root: string, rel: string, o: ConfinedFsOps = NODE_CONFINED_FS): Promise<void> {
  const realRoot = await anchoredRoot(root, o);
  const abs = realRoot && joinInside(realRoot, rel);
  if (!realRoot || !abs || !(await mkdirInside(realRoot, abs, o))) throw new ConfinedPathError();
}

/**
 * 写根内文件(中间目录自动建;已存在则覆盖)。越界 / 软链逃逸(含悬空软链)抛 ConfinedPathError。
 * 末段是根内互指的软链 → 写到它指向的根内文件(与 P0 一致)。
 */
export async function writeConfined(
  root: string, rel: string, data: Buffer | string, opts: { fs?: ConfinedFsOps } = {},
): Promise<void> {
  const o = opts.fs ?? NODE_CONFINED_FS;
  const realRoot = await anchoredRoot(root, o);
  if (!realRoot) throw new ConfinedPathError();
  const abs = joinInside(realRoot, rel);
  if (!abs || abs === realRoot) throw new ConfinedPathError();
  const realParent = await mkdirInside(realRoot, path.dirname(abs), o);
  if (!realParent) throw new ConfinedPathError();
  const lexTarget = path.join(realParent, path.basename(abs));

  for (let attempt = 0; ; attempt++) {
    let existing: BigIntStats | null = null;
    try { existing = await o.lstat(lexTarget); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    let target = lexTarget;
    if (existing?.isSymbolicLink()) {
      const r = await orNull(o.realpath(lexTarget)); // 悬空软链 → null:不许跟着它在别处建文件
      if (!r || !pathWithin(r, realRoot)) throw new ConfinedPathError();
      target = r;
    }
    const create = !existing;
    let fh: FileHandle;
    try {
      // 不带 O_TRUNC:核验通过前绝不动内容。新建用 O_EXCL,与并发创建者撞了就重来一次。
      fh = await o.open(target, fsc.O_WRONLY | O_NOFOLLOW | O_NONBLOCK | (create ? fsc.O_CREAT | fsc.O_EXCL : 0), 0o666);
    } catch (e) {
      if (create && errCode(e) === 'EEXIST' && attempt === 0) continue;
      if (errCode(e) === 'ELOOP') throw new ConfinedPathError(); // 末段在检查后被换成了软链
      throw e;
    }
    try {
      if (!(await sameFileInside(fh, abs, realRoot, o))) throw new ConfinedPathError();
      await fh.truncate(0);
      await fh.writeFile(data);
      return;
    } finally {
      await fh.close().catch(() => {});
    }
  }
}

/**
 * 删根内条目。父目录按真实路径钳;末段是软链只删链接本身(unlink 不跟随)。越界 / 不存在 → false。
 * 竞态残余:realpath(父目录) 与 unlink 之间中间目录被换成指到根外的软链,删的是根外同名文件(见头注释)。
 * 调用方不只是远程删除路由,还有 sessionSandbox 重 hydrate 的「云端已删」清理(宿主侧自动触发)。
 */
export async function unlinkConfined(root: string, rel: string, o: ConfinedFsOps = NODE_CONFINED_FS): Promise<boolean> {
  const realRoot = await anchoredRoot(root, o);
  const abs = realRoot && joinInside(realRoot, rel);
  if (!realRoot || !abs || abs === realRoot) return false;
  const realParent = await orNull(o.realpath(path.dirname(abs)));
  if (!realParent || !pathWithin(realParent, realRoot)) return false;
  return o.unlink(path.join(realParent, path.basename(abs))).then(() => true, () => false);
}

export interface ConfinedEntry { rel: string; size: number; mtimeMs: number }

/**
 * 递归列根内普通文件(posix 相对路径)。根内互指的软链文件照列(大小 / 时间取目标);指到根外的、
 * 悬空的、指向目录的软链不列;不跟软链目录往下走。
 * 竞态残余:子目录在 realpath 复核与 readdir 之间被换成软链,会列出根外目录的元数据(见头注释)。
 */
export async function listConfined(root: string, o: ConfinedFsOps = NODE_CONFINED_FS): Promise<ConfinedEntry[]> {
  const realRoot = await anchoredRoot(root, o);
  if (!realRoot) return [];
  const out: ConfinedEntry[] = [];
  const walk = async (realDir: string, rel: string): Promise<void> => {
    const entries = await orNull(o.readdir(realDir));
    for (const e of entries || []) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(realDir, e.name);
      if (e.isDirectory()) {
        const real = await orNull(o.realpath(p)); // 读目录前复核:两次 readdir 之间被换成软链的子目录不跟(复核之后再换挡不住)
        if (real && pathWithin(real, realRoot)) await walk(real, r);
        continue;
      }
      const real = e.isSymbolicLink() ? await orNull(o.realpath(p)) : p;
      if (!real || !pathWithin(real, realRoot)) continue;
      const st = await orNull(o.lstat(real));
      if (st?.isFile()) out.push({ rel: r, size: Number(st.size), mtimeMs: Number(st.mtimeNs) / 1e6 });
    }
  };
  await walk(realRoot, '');
  return out;
}
