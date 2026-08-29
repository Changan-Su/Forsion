// Serves vault asset files (images / pdf / audio / video) to the renderer over a custom,
// vault-clamped protocol:
//   amadeus-asset://v/<encoded vault-relative path>

import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { protocol } from 'electron'
import { ASSET_SCHEME } from '@amadeus-shared/assets'

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  // 内联预览:PDF 必须给真 MIME(octet-stream 会触发下载而非 Chromium 内置阅读器)。
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  // 3D 模型:插件(检视台之类)经 fetch 拿 ArrayBuffer 自己解析,MIME 只求诚实。
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
}

/** Must run BEFORE app 'ready'. */
export function registerAssetSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      // ⚠️ `corsEnabled` 不是可有可无:少了它,即使响应带 `Access-Control-Allow-Origin: *`,
      // Chromium 也**不把这个 scheme 当成能参与 CORS 的**——于是 `<video crossOrigin="anonymous">`
      // 直接加载失败(真 Electron 实测 `readyState=0`),而画进 canvas 的图一律污染画布、
      // `toDataURL()` 抛 SecurityError(截帧的失败形态)。台架(普通 Chromium + data: URL)
      // 结构性照不到这一条,只有 e2e:mediaembed 的 E1v/E3 能钉住。
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}

/** Find the first file with `basename` anywhere in the vault (for Obsidian-style `![[pic.png]]`).
 *  ponytail: linear walk on cache-miss (browser caches the served image); add a basename index if slow. */
async function findByBasename(root: string, basename: string): Promise<string | null> {
  const target = basename.toLowerCase()
  const walk = async (dir: string): Promise<string | null> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        const hit = await walk(abs)
        if (hit) return hit
      } else if (e.isFile() && e.name.toLowerCase() === target) {
        return abs
      }
    }
    return null
  }
  return walk(root)
}

/** Must run AFTER app 'ready'. */
export function registerAssetProtocol(getVaultRoot: () => string | null): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const root = getVaultRoot()
    if (!root) return new Response('no vault', { status: 404 })

    let vaultRel: string
    try {
      vaultRel = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''))
    } catch {
      return new Response('bad url', { status: 400 })
    }

    let abs = path.resolve(root, vaultRel)
    const rel = path.relative(root, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return new Response('forbidden', { status: 403 })
    }

    // 先 stat 定身份与大小 —— **绝不再整文件 readFile**。旧实现把整个文件读进内存再切片,
    // 一小时 4K 录屏(GB 级)会:① 每次拖进度条 = 一次整片读盘 + 2× 内存峰值;
    // ② 超过 Node Buffer 上限时 readFile 抛 ERR_FS_FILE_TOO_LARGE,被 catch 吞掉 → 走 basename
    // 兜底 → 404 → 嵌入变裂块,**无任何报错**。视频时间戳锚点把 seek 变成了主动线用法,这条从
    // 「够用」变成了必修。
    let st: import('node:fs').Stats
    try {
      st = await fs.stat(abs)
      if (!st.isFile()) throw new Error('not a file')
    } catch {
      // Bare basename (e.g. `![[pic.png]]`) → locate it anywhere in the vault.
      const found = vaultRel.includes('/') ? null : await findByBasename(root, path.basename(vaultRel))
      if (!found) return new Response('not found', { status: 404 })
      abs = found
      try {
        st = await fs.stat(abs)
      } catch {
        return new Response('not found', { status: 404 })
      }
    }
    const size = st.size
    const ext = path.extname(abs).slice(1).toLowerCase()
    const mime = MIME[ext] ?? 'application/octet-stream'
    // 截帧要把 <video> 画进 canvas —— 自定义 scheme 与渲染器不同源,没有这个头 canvas 会被污染,
    // toBlob 直接抛 SecurityError。协议本身已 vault 夹紧(上面的 `..` 闸),放开读取无新增暴露面。
    const cors = { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' }
    const body = (from: number, to: number): ReadableStream =>
      Readable.toWeb(createReadStream(abs, { start: from, end: to })) as ReadableStream

    // 音视频拖进度条 / PDF 阅读器分页都靠 Range;Chromium 只发单区间,支持 bytes=a-b / a- / -n 三形。
    const range = request.headers.get('range')
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start = m[1] === '' ? size - Number(m[2]) : Number(m[1])
      const end = Math.min(m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1, size - 1)
      start = Math.max(0, start)
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...cors, 'Content-Range': `bytes */${size}` } })
      }
      return new Response(body(start, end), {
        status: 206,
        headers: {
          ...cors,
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        },
      })
    }
    if (size === 0) return new Response(new Uint8Array(0), { headers: { ...cors, 'Content-Type': mime } })
    return new Response(body(0, size - 1), {
      headers: { ...cors, 'Content-Type': mime, 'Content-Length': String(size) },
    })
  })
}
