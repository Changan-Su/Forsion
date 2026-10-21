/**
 * 插件私有数据(ctx.loadData / ctx.saveData 那份 JSON)随 Forsion 账号跨设备同步。
 *
 * 条件:manifest `syncData: true`、用户没在设置里关掉(每台设备各自的开关)、宿主有 cloudFetch(桌面 / 手机;网页版没有)。
 * 本地优先:读写照旧先走本机那份,云端在旁边对账 —— 没登录(401)/ 断网 / 超时一律当没有云端,下次 loadData 再对。
 * 冲突整份取较新的,不做字段级合并(插件的数据结构宿主读不懂):服务端 version 做乐观锁,落空时比两边的**编辑时刻**
 * (不是上传时刻:离线改的那份可能很晚才传上去)。被覆盖的那份服务端留一版(GET /plugin-data/:id/previous)。
 * 同步状态绑账号:换了账号,本机这份不往新账号传,新账号云端有就拉下来。
 * 服务端只存不读(server microserver/plugin-data),这份内容不进任何模型上下文。
 */

const LOAD_WAIT_MS = 3000
const INDEX_TTL_MS = 60_000
const stateKey = (id: string) => `forsion.pluginSync.${id}`
const offKey = (id: string) => `forsion.pluginSync.off.${id}`
/** 蓬洲云「同步」页「插件数据」那一行:这台设备上所有插件一起关(每个插件自己的开关照旧,两个都开才同步)。 */
export const PLUGIN_SYNC_ALL_OFF_KEY = 'forsion.pluginSync.off'

/**
 * v = 本机这份对应的云端版本(0 = 没对上过);owner = 对上的是哪个账号;
 * gen = 本机保存的代号(每存一次 +1,同一毫秒存两次也分得开);dirty = 最近一次还没推上去的保存的编辑时刻。
 */
interface SyncState { v: number; owner?: string; gen: number; dirty?: number }

function readState(id: string): SyncState {
  try {
    const s = JSON.parse(localStorage.getItem(stateKey(id)) || 'null')
    if (s && Number.isInteger(s.v)) {
      return { v: s.v, gen: Number.isInteger(s.gen) ? s.gen : 0, ...(typeof s.owner === 'string' ? { owner: s.owner } : {}), ...(typeof s.dirty === 'number' ? { dirty: s.dirty } : {}) }
    }
  } catch { /* 坏了当没对过 */ }
  return { v: 0, gen: 0 }
}
function writeState(id: string, s: SyncState): void {
  try { localStorage.setItem(stateKey(id), JSON.stringify(s)) } catch { /* 配额满:下次按没对过处理,最坏多拉一次 */ }
}

const LAST_OK_KEY = 'forsion.pluginSync.lastOk'
const markOk = (): void => { try { localStorage.setItem(LAST_OK_KEY, String(Date.now())) } catch { /* ignore */ } }
/** 蓬洲云同步页「插件数据」那一行:几个插件改了还没传上去、上次和云端对上是什么时候。
 *  ponytail: 云端那份更新、本机没推的改动让给云端时不计数(服务端留着被覆盖的上一版);要提示再在 loadSyncedPluginData 里记 */
export function pluginSyncSummary(ids: string[]): { pending: number; lastAt: number | null } {
  let at = 0
  try { at = Number(localStorage.getItem(LAST_OK_KEY)) || 0 } catch { /* ignore */ }
  return { pending: ids.filter((id) => readState(id).dirty !== undefined).length, lastAt: at > 0 ? at : null }
}

export function pluginDataSyncOn(p: { id: string; syncData?: boolean } | undefined): boolean {
  if (!p?.syncData || typeof window === 'undefined' || !window.tangu?.cloudFetch) return false
  try { return localStorage.getItem(PLUGIN_SYNC_ALL_OFF_KEY) !== '1' && localStorage.getItem(offKey(p.id)) !== '1' } catch { return true }
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
const editedAt = (m: any): number => (typeof m?.editedAt === 'number' ? m.editedAt : Date.parse(m?.updatedAt ?? '') || 0)
const itemPath = (id: string) => `/plugin-data/${encodeURIComponent(id)}`

// 云端清单(只有元数据,不带内容):INDEX_TTL_MS 内各插件激活共用一份;拉失败不缓存,下一次 loadData 再试。
type Index = { owner: string; items: Record<string, { version: number; updatedAt: string; editedAt?: number }> }
let index: Promise<Index | null> | null = null
let indexAt = 0
function remoteIndex(): Promise<Index | null> {
  if (!index || Date.now() - indexAt > INDEX_TTL_MS) {
    const p = cloud('/plugin-data').then((r) =>
      r?.status === 200 && typeof r.json?.owner === 'string' && r.json.items && typeof r.json.items === 'object' ? (markOk(), r.json as Index) : null)
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
      if (st.dirty === undefined) return // 没有待推的编辑(已对上;或换了账号,本机这份不归这个账号)
      const text = await local.read()
      if (text == null) return
      const r = await cloud(itemPath(id), 'PUT', {
        value: text, base: st.v, editedAt: st.dirty ?? Date.now(), ...(st.owner ? { owner: st.owner } : {}),
      })
      if (!r) return
      if (r.status === 200 && Number.isInteger(r.json?.version)) {
        markOk()
        const cur = readState(id)
        // 推的过程中又存了一次(代号变了):那次还没推,dirty 留着,后面排着的那次推送会推它
        const { dirty: _pushed, ...rest } = cur
        writeState(id, { ...rest, v: r.json.version, ...(typeof r.json.owner === 'string' ? { owner: r.json.owner } : {}), ...(cur.gen !== st.gen ? { dirty: cur.dirty } : {}) })
        index = null
        return
      }
      if (r.status !== 409) return // 401 没登录 / 413 太大 / 5xx:留在本机
      if (r.json?.code === 'owner_mismatch') { index = null; return } // 换了账号:下次 loadData 重新认主
      if (!Number.isInteger(r.json?.version)) return
      if (r.json.version === 0) { writeState(id, { ...st, v: 0 }); continue } // 云端那份没了:按新建重推
      // 别的设备先写了。本机这次编辑更晚 → 以云端当前版本为基再写一次;否则让给云端,下次 loadData 拉下来
      // ponytail: 比的是两台设备各自的时钟,偏得离谱时可能选错;被覆盖的那份服务端留着上一版
      if (st.dirty === undefined || st.dirty < editedAt(r.json)) return
      writeState(id, { ...st, v: r.json.version })
    }
  }
  const next = (chains.get(id) ?? Promise.resolve()).then(run, run)
  chains.set(id, next)
  return next
}

/**
 * ctx.saveData **写本机之前**调(插件声明了 syncData 就调,不管这台设备开没开同步 —— 关着期间的修改重新打开后
 * 也要认得出是本机更新的):记下这次编辑。拉取在落盘前会核对代号,所以必须先记、后写。
 */
export function notePluginDataEdit(id: string): void {
  const st = readState(id)
  writeState(id, { ...st, gen: st.gen + 1, dirty: Date.now() })
}

/** ctx.loadData 用:返回本机内容,云端有更新的那份时先拉下来写进本机再返回。等云端最多 LOAD_WAIT_MS。 */
export async function loadSyncedPluginData(id: string, local: LocalData): Promise<string | null> {
  const mine = await local.read()
  const idx = await remoteIndex()
  if (!idx) return mine
  let st = readState(id)
  const r = idx.items[id]
  const push = () => { void pushPluginData(id, local) }
  let mustPull = false
  if (st.owner && st.owner !== idx.owner) {
    // 换了账号:本机这份(连同没推的修改)属于上一个账号,不往这个账号传;这个账号云端有就拉下来
    // ponytail: 本机只有一份文件、不分账号 —— 换号后已在跑的插件手里仍是上一个账号的数据,它下一次 saveData 会进这个账号;
    //   要彻底分开得按账号分本机文件。服务端的 owner 校验另兜一层(PUT 带着认主时的账号,对不上就拒)。
    st = { v: 0, gen: st.gen, owner: idx.owner }
    writeState(id, st)
    if (!r) return mine
    mustPull = true
  } else if (!st.owner) {
    st = { ...st, owner: idx.owner }
    writeState(id, st)
  }
  if (!mustPull) {
    if (!r || !Number.isInteger(r.version)) { // 云端还没有(或被清掉了):按第一次上传,本机这份记作一次待推的编辑
      if (mine != null) { writeState(id, { ...st, v: 0, dirty: st.dirty ?? Date.now() }); push() }
      return mine
    }
    if (r.version <= st.v) { if (st.dirty !== undefined) push(); return mine } // 本机不比云端旧
    if (mine != null && st.dirty !== undefined && st.dirty > editedAt(r)) { push(); return mine } // 本机没推的那次编辑更晚
  }
  const got = await within(cloud(itemPath(id)), LOAD_WAIT_MS)
  if (got?.status !== 200 || typeof got.json?.value !== 'string' || !Number.isInteger(got.json?.version)) return mine
  // 等云端的这段时间里插件又存了(代号变了):本机那次更新,不拿云端的盖它,交给推送去对账
  if (readState(id).gen !== st.gen) { push(); return local.read() }
  await local.write(got.json.value)
  const cur = readState(id) // 写盘这段时间里又存了一次:那次的 dirty 留着,以拉到的版本为基去推
  writeState(id, cur.gen === st.gen ? { v: got.json.version, owner: idx.owner, gen: st.gen } : { ...cur, v: got.json.version, owner: idx.owner })
  return got.json.value
}
