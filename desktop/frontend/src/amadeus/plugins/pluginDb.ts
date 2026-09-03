/** 插件的多维表读-改-写接缝(`ctx.app.mutateDb`,2026-09-02):比对交换,不是整文件覆盖。
 *
 *  为什么要有它:插件只有 `readFile/writeFile`,改一张活表只能整文件读-改-写 —— 读与写之间自动化
 *  (引擎每路径串行 + 原子落位)或用户(dbStore 防抖 CAS)写进去的行会被盖掉,而且盖得零报错
 *  (pc-erp 0.1.2 的「升级表结构」被 codex 抓的正是这条)。桌面本来就有 `db:write-cas`(带版本票据的
 *  比对交换 + 冲突重读重放),这里把同一条路交给插件:读端走 `readDatabase`(主进程 zod 校验,宿主认为
 *  corrupt 的文件**不进 fn**),写端 `writeDatabaseCas`,冲突就重读再套一次 fn。
 *
 *  语义:`fn(db) => DbFile | null`,null = 这次不写(幂等升级「已是最新」就该返 null,别写一份相同字节);
 *  fn 必须是纯函数(冲突重放会再调它)。不做跨文件事务 —— 一次只改一张表。
 *  没有 CAS 写口的宿主(云端 / 移动端桥)直接 `{ ok:false, error }`,让插件走自己的回落路,别在这里
 *  偷偷降级成无票据覆盖 —— 那等于把 codex 抓的洞换个地方开。 */
import type { DbFile } from '@amadeus-shared/db/schema'

export interface MutateDbResult {
  ok: boolean
  /** 重试耗尽仍撞版本(别人在高频写这张表)。 */
  conflict?: boolean
  /** 宿主读不懂这张表(zod 拒) —— fn 没被调用,文件一字未动。 */
  corrupt?: boolean
  error?: string
}

/** 只依赖这三个桥方法,单测直接注入。 */
export interface MutateDbApi {
  readDatabase(pagePath: string, ref: string): Promise<{ status: 'ok'; path: string; data: DbFile; version?: string } | { status: 'corrupt' | 'missing' }>
  writeDatabaseCas?(path: string, data: DbFile, version: string): Promise<{ ok: boolean; version: string }>
}

// ponytail: 重试 3 次够用 —— 撞 3 次说明有人在按键级高频写这张表,让插件下次再来比在这里死磕稳。
export const MUTATE_DB_RETRIES = 3

/** 在途吊销(读/回调/等写这几拍里插件被禁用)的统一回执。已提交的那次写**不回滚**,但不再发起新的写。 */
const revoked = (): MutateDbResult => ({ ok: false, error: 'plugin disabled mid-flight' })

export async function mutateDbCas(
  api: MutateDbApi | undefined,
  path: string,
  fn: (db: DbFile) => DbFile | null,
  retries = MUTATE_DB_RETRIES,
  /** 插件活性(宿主传按代次判活的闭包;缺省恒真 = 纯逻辑单测与非插件调用方)。
   *  为什么不只在入口判一次:读盘、CAS 冲突重读、等写各是一次 await —— 用户在这几拍里把插件关掉,
   *  只判入口的话 fn 照跑、CAS 照提交,「禁用后在飞的插件改不动用户文件」这条纪律就破了(codex 二轮 high)。 */
  isLive: () => boolean = () => true,
): Promise<MutateDbResult> {
  if (!api?.readDatabase) return { ok: false, error: 'host has no database bridge' }
  if (!api.writeDatabaseCas) return { ok: false, error: 'host has no CAS write (writeDatabaseCas)' }
  if (!/\.db$/i.test(path)) return { ok: false, error: 'mutateDb only accepts a vault-relative .db path' }
  let lastVersion = ''
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r: Awaited<ReturnType<MutateDbApi['readDatabase']>>
    try {
      r = await api.readDatabase(path, path)
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) }
    }
    if (r.status === 'corrupt') return { ok: false, corrupt: true, error: 'host rejected the file (schema)' }
    if (r.status !== 'ok') return { ok: false, error: 'file missing or no vault is open' }
    if (!r.version) return { ok: false, error: 'host gave no version ticket' } // 无票据 = 没法比对,不退化成覆盖
    if (!isLive()) return revoked() // 读回来这一刻插件已被吊销 → 回调根本不调(它的副作用也不该发生)
    let next: DbFile | null
    try {
      next = fn(structuredClone(r.data))
    } catch (e) {
      return { ok: false, error: `fn threw: ${String((e as Error)?.message || e)}` }
    }
    if (next === null) return { ok: true }
    if (!isLive()) return revoked() // fn 自己可能耗时;写出去之前再确认一次,别让已撤销的插件落盘
    const w = await api.writeDatabaseCas(r.path, next, r.version)
    if (w.ok) return { ok: true }
    lastVersion = w.version
  }
  return { ok: false, conflict: true, error: `version conflict after ${retries} retries (latest ${lastVersion})` }
}
