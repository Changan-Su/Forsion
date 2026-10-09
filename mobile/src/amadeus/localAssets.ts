/**
 * 手机本地库的资源地址(2026-10-09):笔记里 `![](.amadeus/x.png)` 这类引用,显示时换成 WebView 能直接加载的地址,
 * 存盘时再换回来 —— 成对装进共享接缝(desktop/shared/amadeus/assets.ts 的 setAssetUrlBuilder)。
 *
 * 此前本地库没有装自己的一对,用的是默认的 `amadeus-asset://v/…`:安卓上没有任何东西接这个协议(原生层没有
 * 拦截器,页面内容安全策略也不放),图片一直显示不出;先开过云端库再切过来时,用的还是云桥留下的那一对,
 * 本地图片被指到云端、存盘时云端地址被写进本地笔记。
 *
 * 地址 = `<库根的可加载地址>/<库内路径,按段百分号编码>`。库根的可加载地址由调用方给(安卓上是
 * Capacitor.convertFileSrc 的结果:`https://localhost/_capacitor_file_/<应用私有目录>/vault`,与页面同源,
 * 不用动内容安全策略;带 Range 的请求回 206、正文从要的起点开始但不按终点截断 —— 模拟器上实测,
 * 仪器 npm run emu:localasset)。本模块**不 import Capacitor**:桌面的单测会加载手机本地桥,那里没有装它。
 *
 * ⚠️ 两条纪律(单测 desktop/frontend/src/services/mobileLocalAssets.test.ts):
 *   · **库内路径逐字保留,不做规范化**。`笔记夹/../附件/x.png` 这种引用,显示地址里原样带着 `..`(浏览器发请求时
 *     自己会折叠),存盘时才能逐字换回 `../附件/x.png`;在这里折叠掉 = 存回去变成 `附件/x.png`,下次按页目录拼就找不到了。
 *   · 折叠之后逃出库根的引用不给可加载地址(退回默认协议 —— 加载不出,存盘往返照样是好的),与桌面协议处理器的 403 对齐。
 */
import { ASSET_SCHEME, setAssetUrlBuilder } from '@amadeus-shared/assets'

/** 折叠 `.` / `..` 之后是不是逃出了库根。 */
function escapesVault(ref: string): boolean {
  let depth = 0
  for (const seg of ref.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { if (--depth < 0) return true } else depth += 1
  }
  return false
}

/** 库内路径 → 可加载地址;库根地址还没拿到 / 空引用 / 逃出库根 = null。 */
export function localAssetUrl(base: string, ref: string): string | null {
  const r = ref.replace(/\\/g, '/')
  if (!base || !r || escapesVault(r)) return null
  return `${base}/${r.split('/').map(encodeURIComponent).join('/')}`
}

/** localAssetUrl 的逆:只认以库根地址开头的;别的一律 null(它的结果会被写回笔记正文)。 */
export function localAssetRef(base: string, url: string): string | null {
  if (!base || !url.startsWith(`${base}/`)) return null
  const rest = url.slice(base.length + 1)
  // 构建时从不带查询串 / 片段(名字里的 `?` `#` 都编码了)。带着的不是我们构建的:认了的话 `a.png?v=1` 会被当成
  // 文件名写回去,下次按 `a.png%3Fv%3D1` 去取另一个文件(评审 2026-10-09)。
  if (/[?#]/.test(rest)) return null
  try {
    const ref = rest.split('/').map(decodeURIComponent).join('/')
    return ref && !escapesVault(ref) ? ref : null
  } catch {
    return null // 不合法的百分号序列:不是我们构建出来的
  }
}

/** 装进共享接缝。`base` 现取:建桥是同步的,库根的可加载地址要等开库时才拿得到 —— 那之前退回默认协议
 *  (显示不出,存盘往返是好的)。**每次建桥都要调**:资源地址是模块级的全局状态,别的桥装过的不会自己撤。 */
export function installLocalAssetUrls(base: () => string): void {
  setAssetUrlBuilder(
    (ref) => localAssetUrl(base(), ref) ?? `${ASSET_SCHEME}://v/${encodeURIComponent(ref)}`,
    (url) => localAssetRef(base(), url),
  )
}
