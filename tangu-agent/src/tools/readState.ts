/**
 * 读后指纹(G3-02):按会话记住 agent 上次「看到」的文件内容指纹,write_file 整篇覆盖前据此判断
 * 盘上是否在那之后被改过(用户在编辑器里接着写、别的会话/进程落了盘)。不一致就拒写,让模型重读。
 *
 * 口径:
 * - 指纹 = 全文 sha1(与 checkpoints.ts 的 postHash 同算法)。按内容不按 mtime:编辑器原子写出同样字节
 *   不算改动,不会平白拒一次。
 * - read_file 记全文指纹(offset/limit 分页读也照样读了整份 buffer,记的是整份)。
 * - agent 自己的写(write_file / edit_file / multi_edit / apply_patch)刷新指纹 —— 否则「读 → 局部改 →
 *   write_file」会被自己的改动误拒。局部改前盘上已经不是模型看到的那份时**不刷新**:它只改了自己
 *   认得的那一小段,整篇视图仍是旧的,之后的 write_file 还得先重读。
 * - 从没读过(无记录)= 不设闸:新建文件、模型经别的途径拿到内容的写照旧放行(见残余风险:run_bash cat /
 *   引擎重启丢记录 / 同会话子代理共用一份)。
 *
 * 叶子模块:只依赖 node:crypto —— hostExec 与 builtin/applyPatch 都要 import 它,不能反向成环。
 */
import { createHash } from 'node:crypto';

const MAX_SESSIONS = 200;
const MAX_PATHS_PER_SESSION = 2000;

/** sessionId → (绝对路径 → 指纹)。Map 保插入序,当 LRU 用:每次触碰删了重插。 */
const sessions = new Map<string, Map<string, string>>();

type Scope = { sessionId?: string };

export function contentFingerprint(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

function scope(ctx: Scope, create: boolean): Map<string, string> | undefined {
  const key = ctx.sessionId || '';
  let m = sessions.get(key);
  if (m) {
    sessions.delete(key);
    sessions.set(key, m);
  } else if (create) {
    m = new Map();
    sessions.set(key, m);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  }
  return m;
}

function put(ctx: Scope, abs: string, fp: string): void {
  const m = scope(ctx, true)!;
  m.delete(abs);
  m.set(abs, fp);
  if (m.size > MAX_PATHS_PER_SESSION) m.delete(m.keys().next().value as string);
}

/** 模型读到了这份全文。 */
export function noteRead(ctx: Scope, abs: string, data: Buffer | string): void {
  put(ctx, abs, contentFingerprint(data));
}

/** 上次读到(或自己写下)的指纹;没读过 = undefined(不设闸)。 */
export function readFingerprint(ctx: Scope, abs: string): string | undefined {
  return scope(ctx, false)?.get(abs);
}

/**
 * agent 自己写完了 abs。before = 这次写之前工具读到的盘上内容(write_file 整篇覆盖不需要 → 省略):
 * 有记录且 before 与之不符 = 模型的整篇视图本来就过期了,保持过期,不刷新。
 */
export function noteAgentWrite(ctx: Scope, abs: string, written: string, before?: string | null): void {
  if (before != null) {
    const known = readFingerprint(ctx, abs);
    if (known !== undefined && known !== contentFingerprint(before)) return;
  }
  put(ctx, abs, contentFingerprint(written));
}

/** 文件被 agent 删掉/挪走:丢掉记录(之后同路径的写就是新建)。 */
export function forgetRead(ctx: Scope, abs: string): void {
  scope(ctx, false)?.delete(abs);
}
