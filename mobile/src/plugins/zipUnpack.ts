/**
 * 安装包解压的容量闸(Android App 的市场安装用,纯逻辑,单测见 mobile/scripts/plugin-host.test.cjs)。
 *
 * 为什么不能「解完再量」:`zipObject.async('uint8array')` 把一个条目**整个**解进内存才返回 —— 一个几十 KB、内含
 * 一条超大条目的包,在量到上限之前就把 WebView 撑爆了(评审 2026-10-02)。三道闸,由便宜到贵:
 *   1. countCentralHeaders:**解析之前**数包里「中央目录文件头」签名的个数(jszip 为每个条目建对象,条目数本身也是炸弹;
 *      不信包尾 EOCD 里声明的条目数 —— 它可以撒谎,而 jszip 是「签名对得上就一直读」,读完才核对);
 *   2. checkDeclaredSizes:解析之后、解压之前,按中央目录里**声明**的解压大小判单条与累计;
 *   3. inflateCapped / unpackCapped:声明值可以撒谎(中央目录写 10 字节、实际解出 1 GB;jszip 要到流末尾才发现对不上),
 *      所以解压时再按**实际字节**流式计量,一超上限就停流、丢掉已解的块 —— 永远不持有超过上限的数据。
 */
import type JSZip from 'jszip'

/** 解压量超限。message 是原因码,上屏文案由调用方套(mobilemarket.tooLarge)。 */
export class UnpackLimitError extends Error {
  constructor() {
    super('unpacked size limit exceeded')
    this.name = 'UnpackLimitError'
  }
}

/**
 * 字节里「中央目录文件头」签名(PK\x01\x02)出现的次数,数到 limit + 1 就停。
 * 它是 jszip 会建多少个条目对象的**上界**:每个条目的中央目录记录都以这个签名开头,jszip 逐个签名往下读。
 * (偶然撞上签名的压缩数据、包里内嵌的另一个 zip 会让它偏大 —— 只会更保守;目录条目也算一条。)
 */
export function countCentralHeaders(bytes: Uint8Array, limit: number): number {
  let n = 0
  for (let at = bytes.indexOf(0x50); at >= 0 && at + 3 < bytes.length; at = bytes.indexOf(0x50, at + 1)) {
    if (bytes[at + 1] === 0x4b && bytes[at + 2] === 0x01 && bytes[at + 3] === 0x02 && ++n > limit) break
  }
  return n
}

/** jszip 从中央目录读到的「声明解压大小」(读包得到的条目才有;其它来源 → null)。 */
export function declaredUnpackedSize(file: JSZip.JSZipObject): number | null {
  const size = (file as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null
}

/** 声明大小的前置闸:任何一条、或累计超过 maxBytes → 抛 UnpackLimitError。此时一个字节都还没解压。 */
export function checkDeclaredSizes(files: readonly JSZip.JSZipObject[], maxBytes: number): void {
  let total = 0
  for (const f of files) {
    total += declaredUnpackedSize(f) ?? 0
    if (total > maxBytes) throw new UnpackLimitError()
  }
}

/**
 * 流式解一个条目,实际字节超过 budget 立即停:pause 让 jszip 不再排下一拍(DataWorker 只在未暂停时续 tick),
 * 已到手的块当场丢掉;同一拍里 inflate 还会同步吐完的那几块(每块 ≤ 16 KB)直接忽略,不累积。
 */
export function inflateCapped(file: JSZip.JSZipObject, budget: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    let settled = false
    const stream = (file as unknown as { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> }).internalStream('uint8array')
    stream
      .on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > budget) {
          settled = true
          chunks.length = 0
          stream.pause()
          reject(new UnpackLimitError())
          return
        }
        chunks.push(chunk)
      })
      .on('error', (e) => {
        if (settled) return
        settled = true
        reject(e)
      })
      .on('end', () => {
        if (settled) return
        settled = true
        const out = new Uint8Array(size)
        let off = 0
        for (const c of chunks) { out.set(c, off); off += c.length }
        resolve(out)
      })
      .resume()
  })
}

/** 按计划逐条解压,累计实际字节封顶 maxBytes(先过声明闸,再流式计量)。超限 → UnpackLimitError。 */
export async function unpackCapped<P extends { name: string }>(
  zip: JSZip, plan: readonly P[], maxBytes: number,
): Promise<Array<P & { data: Uint8Array }>> {
  checkDeclaredSizes(plan.map((p) => zip.files[p.name]), maxBytes)
  const out: Array<P & { data: Uint8Array }> = []
  let used = 0
  for (const entry of plan) {
    const data = await inflateCapped(zip.files[entry.name], maxBytes - used)
    used += data.length
    out.push({ ...entry, data })
  }
  return out
}
