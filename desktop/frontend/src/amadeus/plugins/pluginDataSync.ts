/**
 * 插件私有数据(ctx.loadData / ctx.saveData 那份 JSON)随 Forsion 账号跨设备同步。
 *
 * 条件:manifest `syncData: true`、用户没在设置里关掉(每台设备各自的开关)、宿主有 cloudFetch(桌面 / 手机;网页版没有)。
 * 本地优先:读写照旧先走本机那份,云端在旁边对账 —— 没登录(401)/ 断网 / 超时一律当没有云端,下次 loadData 再对。
 * 冲突整份取较新的,不做字段级合并(插件的数据结构宿主读不懂):服务端 version 做乐观锁,落空时比「本机还没推上去的
 * 那次保存时刻」和云端 updatedAt。被覆盖的那份服务端留一版(GET /plugin-data/:id/previous)。
 * 服务端只存不读(server microserver/plugin-data),这份内容不进任何模型上下文。
 */

const LOAD_WAIT_MS = 3000
const stateKey = (id: string) => `forsion.pluginSync.${id}`
const offKey = (id: string) => `forsion.pluginSync.off.${id}`

/** v = 本机这份对应的云端版本(0 = 从没对上过);dirty = 本机最近一次还没推上去的保存时刻。 */
interface SyncState { v: number; dirty?: number }

function readState(id: string): SyncState {
  try {
    const s = JSON.parse(localStorage.getItem(stateKey(id)) || 'null')
    if (s && Number.isInteger(s.v)) return { v: s.v, ...(typeof s.dirty === 'number' ? { dirty: s.dirty } : {}) }
  } catch { /* 坏了当没对过 */ }
  return { v: 0 }
}
function writeState(id: string, s: SyncState): void {
  try { localStorage.setItem(stateKey(id), JSON.stringify(s)) } catch { /* 配额满:下次按没对过处理,最坏多拉一次 */ }
}

export function pluginDataSyncOn(p: { id: string; syncData?: boolean } | undefined): boolean {
  if (!p?.syncData || typeof window === 'undefined' || !window.tangu?.cloudFetch) return false
  try { return localStorage.getItem(offKey(p.id)) !== '1' } catch { return true }
}
export function pluginDataSyncUserOff(id: string): boolean {
  try { return localStorage.getItem(offKey(id)) === '1' } catch { return false }
}
export function setPluginDataSyncUserOff(id: string, off: boolean): void {
  try { off ? localStorage.setItem(offKey(id), '1') : localStorage.removeItem(offKey(id)) } catch { /* ignore */ }
}

type Reply = { status: number; json?: any }
async function cloud(path: string, method = 'GET', body?: unknown): Promise<Reply | null> {
  try {
    return await window.tangu!.cloudFetch!({ path, method, ...(body !== undefined ? { body } : {}) })
  } catch {
    return null
  }
}
const within = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])

// 云端清单(只有版本号,不带内容):INDEX_TTL_MS 内各插件激活共用一份;拉失败不缓存,下一次 loadData 再试。
const INDEX_TTL_MS = 60_000
let index: Promise<Record<string, { version: number; updatedAt: string }> | null> | null = null
let indexAt = 0
function remoteIndex() {
  if (!index || Date.now() - indexAt > INDEX_TTL_MS) {
    const p = cloud('/plugin-data').then((r) => (r?.status === 200 && r.json?.items && typeof r.json.items === 'object' ? r.json.items : null))
    index = p
    indexAt = Date.now()
    void p.then((v) => { if (!v && index === p) index = null })
  }
  return within(index, LOAD_WAIT_MS)
}

export interface LocalData { read(): Promise<string | null>; write(text: string): Promise<void> }

const chains = new Map<string, Promise<void>>()

/** 把本机这份推上去(按插件串行;推的是推送那一刻的本机内容)。失败留着 dirty,下次 loadData 再推。 */
export function pushPluginData(id: string, local: LocalData): Promise<void> {
  const run = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const st = readState(id)
      if (st.v > 0 && st.dirty === undefined) return // 已和云端对上、之后没再存过:没有要推的
      const text = await local.read()
      if (text == null) return
      const r = await cloud(`/plugin-data/${encodeURIComponent(id)}`, 'PUT', { value: text, base: st.v })
      if (!r) return
      if (r.status === 200 && Number.isInteger(r.json?.version)) {
        const cur = readState(id)
        // 推的过程中又存了一次:那次还没推,dirty 留着(后面排着的那次推送会推它)
        writeState(id, { v: r.json.version, ...(cur.dirty !== undefined && cur.dirty !== st.dirty ? { dirty: cur.dirty } : {}) })
        index = null
        return
      }
      if (r.status !== 409 || !Number.isInteger(r.json?.version)) return // 401 没登录 / 413 太大 / 5xx:留在本机
      if (r.json.version === 0) { writeState(id, { ...st, v: 0 }); continue } // 云端那份没了:按新建重推
      // 别的设备先写了。本机这次保存更晚(实际几乎总是)→ 以云端当前版本为基再写一次;否则让给云端,下次 loadData 拉下来
      // ponytail: 比的是本机时钟和服务端时钟,设备时钟偏得离谱时可能选错;被覆盖的那份服务端留着上一版
      const remoteAt = Date.parse(r.json.updatedAt ?? '') || 0
      if (st.dirty === undefined || st.dirty < remoteAt) return
      writeState(id, { ...st, v: r.json.version })
    }
  }
  const next = (chains.get(id) ?? Promise.resolve()).then(run, run)
  chains.set(id, next)
  return next
}

/** ctx.saveData 写完本机之后调:记下这次保存,后台推(调用方不必等)。 */
export function notePluginDataSaved(id: string, local: LocalData): Promise<void> {
  writeState(id, { ...readState(id), dirty: Date.now() })
  return pushPluginData(id, local)
}

/** ctx.loadData 用:返回本机内容,云端有更新的那份时先拉下来写进本机再返回。等云端最多 LOAD_WAIT_MS。 */
export async function loadSyncedPluginData(id: string, local: LocalData): Promise<string | null> {
  const mine = await local.read()
  const items = await remoteIndex()
  if (!items) return mine
  const st = readState(id)
  const r = items[id]
  const push = () => { void pushPluginData(id, local) }
  if (!r || !Number.isInteger(r.version)) { // 云端还没有(或被清掉了):按第一次上传
    if (mine != null) { writeState(id, { v: 0, ...(st.dirty !== undefined ? { dirty: st.dirty } : {}) }); push() }
    return mine
  }
  if (r.version <= st.v) { if (st.dirty !== undefined) push(); return mine } // 本机不比云端旧
  if (mine != null && st.dirty !== undefined && st.dirty > (Date.parse(r.updatedAt) || 0)) { push(); return mine } // 本机没推的那次更晚
  const got = await within(cloud(`/plugin-data/${encodeURIComponent(id)}`), LOAD_WAIT_MS)
  if (got?.status !== 200 || typeof got.json?.value !== 'string' || !Number.isInteger(got.json?.version)) return mine
  await local.write(got.json.value)
  writeState(id, { v: got.json.version })
  return got.json.value
}
