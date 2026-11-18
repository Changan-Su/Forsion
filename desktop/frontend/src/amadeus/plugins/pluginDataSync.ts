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

import { isJsonText, isPluginDataUnreadable } from './pluginLocalData'

const LOAD_WAIT_MS = 3000
const INDEX_TTL_MS = 60_000
const stateKey = (id: string) => `forsion.pluginSync.${id}`
const offKey = (id: string) => `forsion.pluginSync.off.${id}`
/** 蓬洲云「同步」页「插件数据」那一行:这台设备上所有插件一起关(每个插件自己的开关照旧,两个都开才同步)。 */
export const PLUGIN_SYNC_ALL_OFF_KEY = 'forsion.pluginSync.off'

/**
 * v = 本机这份对应的云端版本(0 = 没对上过);owner = 对上的是哪个账号;
 * gen = 本机保存的代号(每存一次 +1,同一毫秒存两次也分得开);dirty = 最近一次还没推上去的保存的编辑时刻。
 * unverified = 本机这份是读失败之后插件按默认值存下来的、还没和云端对过:之后的保存都不记 dirty、不推,
 *   下一次连上云端时云端那份赢(宿主先另存本机这份),云端没有才按第一次上传。落在这里而不只在内存:
 *   之后离线读成功、或者重启,都不能把这份默认值洗成「本机更新」在冲突里盖掉云端那份完好的。
 *   按第一次上传时(dirty 也在)记号照样留着,传成了才清;传的时候撞上别的设备刚建的那份(409)→ 让给云端,不比编辑时刻。
 */
interface SyncState { v: number; owner?: string; gen: number; dirty?: number; unverified?: true }

function readState(id: string): SyncState {
  try {
    const s = JSON.parse(localStorage.getItem(stateKey(id)) || 'null')
    if (s && Number.isInteger(s.v)) {
      return {
        v: s.v, gen: Number.isInteger(s.gen) ? s.gen : 0, ...(typeof s.owner === 'string' ? { owner: s.owner } : {}),
        ...(typeof s.dirty === 'number' ? { dirty: s.dirty } : {}), ...(s.unverified === true ? { unverified: true as const } : {}),
      }
    }
  } catch { /* 坏了当没对过 */ }
  return { v: 0, gen: 0 }
}
function writeState(id: string, s: SyncState): void {
  try { localStorage.setItem(stateKey(id), JSON.stringify(s)) } catch { /* 配额满:下次按没对过处理,最坏多拉一次 */ }
}

/** 卸载不留设置时随偏好收走的同步键(状态、开关);留着的话状态记着 v=N,重装后本机没文件也不会去拉云端那份。
 *  快照里版本号清零:云端那份可能被删后又被别的设备重建,版本号从 1 重来会撞上(同号不同内容),恢复后要和云端重新比一次。 */
export function pluginSyncSnapshot(id: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    if (localStorage.getItem(stateKey(id)) != null) out[stateKey(id)] = JSON.stringify({ ...readState(id), v: 0 })
    const off = localStorage.getItem(offKey(id))
    if (off != null) out[offKey(id)] = off
  } catch { /* 没有 localStorage:没东西可收 */ }
  return out
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

/** 本机那份。read:没写过 → null;读不出来 → 抛 PluginDataUnreadableError(pluginLocalData.ts),
 *  同步绝不把读不出来当「本机没有」去拉云端盖它,也不把它推上去。
 *  write 的 backup:宿主写之前先把本机现有那份另存(拷不出来就不写、抛出去);拉云端盖 unverified 的本机那份时用。 */
export interface LocalData { read(): Promise<string | null>; write(text: string, opts?: { backup?: boolean }): Promise<void> }

const chains = new Map<string, Promise<void>>()

/** 把本机这份推上去(按插件串行;推的是推送那一刻的本机内容)。失败留着 dirty,下次 loadData 再推。 */
export function pushPluginData(id: string, local: LocalData): Promise<void> {
  const run = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const st = readState(id)
      // 没有待推的编辑(已对上;或换了账号,本机这份不归这个账号)。unverified 的那份只有 loadSyncedPluginData 认定
      // 云端没有(或云端那份坏了)时才记 dirty,按第一次上传推(见 SyncState)
      if (st.dirty === undefined) return
      // 本机读不出来(坏文件 / 读错误,local.read 抛 PluginDataUnreadableError):不推半截内容、不改状态,dirty 留着。
      // 调用方都是 `void pushPluginData(…)`,这里绝不能 reject。
      let text: string | null
      try { text = await local.read() } catch { return }
      if (text == null) return
      // 读本机这段时间里插进来一次读失败后的保存(记号是读的时候才打上的):读到的可能就是那份默认值,不推
      if (readState(id).unverified && !st.unverified) return
      const r = await cloud(itemPath(id), 'PUT', {
        value: text, base: st.v, editedAt: st.dirty ?? Date.now(), ...(st.owner ? { owner: st.owner } : {}),
      })
      if (!r) return
      if (r.status === 200 && Number.isInteger(r.json?.version)) {
        markOk()
        index = null
        const cur = readState(id)
        // 推的过程中又来了读失败后的保存(之前没有记号;或者传的正是 unverified 那份、在途时记号被重新打过 ——
        // notePluginDataUnverifiedWrite 会抹掉 dirty):新存的那份还没和云端对过,状态不动,下次 loadData 云端那份赢、
        // 宿主先另存本机这份。在途时来的是正常编辑(notePluginDataEdit 留着 dirty)不算:记号照清,那次编辑接着推。
        if (cur.unverified && (!st.unverified || cur.dirty !== st.dirty)) return
        // 推的过程中又存了一次(代号变了):那次还没推,dirty 留着,后面排着的那次推送会推它。
        // 传上去的是 unverified 那份(按第一次上传):云端现在就是这份,对上了,记号清掉
        const { dirty: _pushed, unverified: _checked, ...rest } = cur
        writeState(id, { ...rest, v: r.json.version, ...(typeof r.json.owner === 'string' ? { owner: r.json.owner } : {}), ...(cur.gen !== st.gen ? { dirty: cur.dirty } : {}) })
        return
      }
      if (r.status !== 409) return // 401 没登录 / 413 太大 / 5xx:留在本机
      if (r.json?.code === 'owner_mismatch') { index = null; return } // 换了账号:下次 loadData 重新认主
      if (!Number.isInteger(r.json?.version)) return
      if (r.json.version === 0) { writeState(id, { ...st, v: 0 }); continue } // 云端那份没了:按新建重推
      if (st.unverified) {
        // 本机这份还没和云端对过,而云端已经有别人写的那份:让给云端(不比编辑时刻 —— 这份是按默认值起来的),
        // 记号留着,下次 loadData 拉云端那份(宿主先另存本机这份)
        index = null
        const cur = readState(id)
        if (!cur.unverified || cur.owner !== st.owner) return // 在途时已被拉取对上 / 换了账号:那是之后的状态,不动它
        const { dirty: _yield, ...rest } = cur
        writeState(id, rest)
        return
      }
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
 * 卸载且不留设置:清掉云端那份。**要在 dropPluginPrefs 之前调**(同步状态在这里同步读走)。
 * 带 base / owner:云端比本机新(别的设备写过)或换了账号就不删 —— 恢复只靠回收站里的本机那份,它不比云端旧才删得起。
 * 恢复后 loadSyncedPluginData 看到云端没了,按第一次上传推回去;别的设备还装着时同样会推回来,这是预期(插件按设备装)。
 * 失败(离线 / 没登录 / 老服务端 404)= 副本留着,重装时会拉回来。
 */
export function dropPluginCloudData(id: string): Promise<void> {
  const st = readState(id)
  if (!st.owner || !st.v) return Promise.resolve() // 没对上过云端:这台设备不替别处决定
  index = null
  return cloud(`${itemPath(id)}?base=${st.v}&owner=${encodeURIComponent(st.owner)}`, 'DELETE').then(() => {})
}

/**
 * ctx.saveData **写本机之前**调(插件声明了 syncData 就调,不管这台设备开没开同步 —— 关着期间的修改重新打开后
 * 也要认得出是本机更新的):记下这次编辑。拉取在落盘前会核对代号,所以必须先记、后写。
 */
export function notePluginDataEdit(id: string): () => void {
  const st = readState(id)
  // 本机这份还没和云端对过(unverified):只记代号(拉取照样核对),不记「本机更新」—— 不推、不在冲突里赢过云端
  if (st.unverified) {
    writeState(id, { ...st, gen: st.gen + 1 })
    return () => {}
  }
  const stamp = Date.now()
  writeState(id, { ...st, gen: st.gen + 1, dirty: stamp })
  // 撤回:本机这次没写成(宿主拒写 / 写失败)→ 不能留着一个「本机更新」的记号,否则文件恢复后它会把旧内容推上去盖掉云端。
  // 只撤自己记的那一下(之后又有别的保存就不动)。
  // ponytail: 两次重叠的保存都没写成时,后一次撤回会把前一次(同样没写成)的记号放回来;要精确得按次记,先不做
  return () => {
    const cur = readState(id)
    if (cur.gen !== st.gen + 1 || cur.dirty !== stamp) return
    const { dirty: _mine, ...rest } = cur
    writeState(id, st.dirty !== undefined ? { ...rest, dirty: st.dirty } : rest)
  }
}

/**
 * 本机那份读不出来(且没能从云端恢复)之后,插件仍然 saveData:这次写**不算本机的编辑** —— 不记 dirty、不推,
 * 对上的云端版本清零,记上 unverified(见 SyncState)。这样下次连得上云端时云端那份赢(宿主先另存这份按默认值起来的数据),
 * 云端没有就按第一次上传。否则这次写会在 409 里以「本机编辑更晚」赢过云端,把云端唯一完好的那份盖掉(服务端只留一版)。
 * 写之前调;返回撤回:宿主拒写(原件拷不出来)时原样放回之前的版本、dirty —— 原件还在,它没推的编辑不能就此作废。
 */
export function notePluginDataUnverifiedWrite(id: string): () => void {
  const st = readState(id)
  const gen = st.gen + 1
  writeState(id, { v: 0, gen, ...(st.owner ? { owner: st.owner } : {}), unverified: true })
  return () => {
    const cur = readState(id)
    if (cur.gen !== gen || !cur.unverified) return // 之后又有别的保存 / 对账:不动
    writeState(id, { ...st, gen })
  }
}

/**
 * 本机内容坏了(读得出字节、不是合法 JSON)且云端有一份:拉云端那份写回本机。写之前宿主先把坏的本机原件另存
 * (桌面 <id>.json.unreadable-<时间>、手机同名槽备份;拷不出原件就拒写)。本机没推的那次编辑在坏文件里,
 * 已经读不出来了,云端那份是现存最好的;dirty 一并清掉。拉不到 / 换了账号 / 写不进去 → undefined,调用方照实报读失败。
 * gen0 = 读本机**之前**的代号:读完到写云端那份之间插件又存过(别的视图),就不拿云端的盖它,重读本机。
 */
async function restoreFromCloud(id: string, local: LocalData, gen0: number): Promise<string | null | undefined> {
  const idx = await remoteIndex()
  if (!idx) return undefined
  const st = readState(id)
  if (st.owner && st.owner !== idx.owner) return undefined // 云端那份属于另一个账号
  const r = idx.items[id]
  if (!r || !Number.isInteger(r.version)) return undefined
  const got = await within(cloud(itemPath(id)), LOAD_WAIT_MS)
  if (got?.status !== 200 || typeof got.json?.value !== 'string' || !Number.isInteger(got.json?.version)) return undefined
  // 等云端时插件又存了(那次写让本机读得出来了):不拿云端的盖它,回本机刚存的;还是读不出来就照实抛
  if (readState(id).gen !== gen0) return local.read()
  // 一律先另存本机那份:读完到写之间桌面上可能刚写完一次保存(代号在写之前就记了,这里核不出来)
  try { await local.write(got.json.value, { backup: true }) } catch { return undefined }
  const cur = readState(id) // 写盘这段时间里又存了一次:那次的记号留着(同拉取那条路)
  writeState(id, cur.gen === gen0 ? { v: got.json.version, owner: idx.owner, gen: gen0 } : { ...cur, v: got.json.version, owner: idx.owner })
  return got.json.value
}

/** ctx.loadData 用:返回本机内容,云端有更新的那份时先拉下来写进本机再返回。等云端最多 LOAD_WAIT_MS。 */
export async function loadSyncedPluginData(id: string, local: LocalData): Promise<string | null> {
  // 本机读不出来绝不当「本机没有」往下对账。内容坏了(invalid-json)且云端有完好的一份 → 拉下来恢复;
  // 读出错(read-failed:本机那份可能是好的、还比云端新)或恢复不成 → 照实抛。
  const gen0 = readState(id).gen
  let mine: string | null
  try {
    mine = await local.read()
  } catch (e) {
    if (isPluginDataUnreadable(e) && e.reason === 'invalid-json') {
      const restored = await restoreFromCloud(id, local, gen0)
      if (restored !== undefined) return restored
    }
    throw e
  }
  const idx = await remoteIndex()
  if (!idx) return mine // 连不上:unverified 记号留着,下次再对
  let st = readState(id)
  // 本机这份还没和云端对过(见 SyncState):云端有就拉下来盖它(宿主先另存),没有才按第一次上传。换账号会清掉状态,先记下来
  const tainted = st.unverified === true
  const r = idx.items[id]
  const push = () => { void pushPluginData(id, local) }
  let mustPull = false
  if (st.owner && st.owner !== idx.owner) {
    // 换了账号:本机这份(连同没推的修改)属于上一个账号,不往这个账号传;这个账号云端有就拉下来
    // ponytail: 本机只有一份文件、不分账号 —— 换号后已在跑的插件手里仍是上一个账号的数据,它下一次 saveData 会进这个账号;
    //   要彻底分开得按账号分本机文件。服务端的 owner 校验另兜一层(PUT 带着认主时的账号,对不上就拒)。
    // unverified 记号留着:新账号那份没拉成时,下一次保存不能当「本机更新」推进新账号
    st = { v: 0, gen: st.gen, owner: idx.owner, ...(tainted ? { unverified: true as const } : {}) }
    writeState(id, st)
    if (!r) return mine
    mustPull = true
  } else if (!st.owner) {
    st = { ...st, owner: idx.owner }
    writeState(id, st)
  }
  // 云端还没有(或被清掉了):按第一次上传,本机这份记作一次待推的编辑(base = 0;云端那份坏了时 base = 它的版本)。
  // unverified 的那份记号留着,传成了才清;传的时候云端已经有别人的那份 → 让给云端(见 pushPluginData)
  const firstUpload = (base: number): string | null => {
    const cur = readState(id)
    if (mine != null) { writeState(id, { ...cur, v: base, dirty: cur.dirty ?? Date.now() }); push() } else if (cur.unverified) {
      const { unverified: _nothingLocal, ...rest } = cur
      writeState(id, rest)
    }
    return mine
  }
  if (!mustPull) {
    if (!r || !Number.isInteger(r.version)) return firstUpload(0)
    if (!tainted) {
      if (r.version <= st.v) { if (st.dirty !== undefined) push(); return mine } // 本机不比云端旧
      if (mine != null && st.dirty !== undefined && st.dirty > editedAt(r)) { push(); return mine } // 本机没推的那次编辑更晚
    }
  }
  const got = await within(cloud(itemPath(id)), LOAD_WAIT_MS)
  if (got?.status !== 200 || typeof got.json?.value !== 'string' || !Number.isInteger(got.json?.version)) return mine
  // 等云端的这段时间里插件又存了(代号变了):本机那次更新,不拿云端的盖它,交给推送去对账
  if (readState(id).gen !== st.gen) { push(); return local.read() }
  // 本机还没对过、云端那份本身坏了(不是合法 JSON,写不进本机):当云端没有,推本机这份 —— 否则每次都拉不成、记号永远清不掉
  // (换了账号时状态已经清过、没有记号:照旧,不把上一个账号的本机这份推进新账号)
  if (readState(id).unverified && !isJsonText(got.json.value)) return firstUpload(got.json.version)
  await (tainted ? local.write(got.json.value, { backup: true }) : local.write(got.json.value))
  const cur = readState(id) // 写盘这段时间里又存了一次:那次的 dirty 留着,以拉到的版本为基去推
  writeState(id, cur.gen === st.gen ? { v: got.json.version, owner: idx.owner, gen: st.gen } : { ...cur, v: got.json.version, owner: idx.owner })
  return got.json.value
}
