/**
 * 系统文件选择器选中的文档 → `File`(Android;原生半身 NativeFilePickerPlugin.kt)。
 *
 * 纯逻辑、**不 import capacitor**(同 saveDownload.ts):`toUrl` / `fetch` 由 nativeFiles.ts 注入,
 * scripts/picked-files.test.cjs 直接在 node 里跑。
 *
 * 为什么不让原生把字节递过来:Capacitor 桥把一次调用整个当一条 JSON 字符串 —— 此前原生把最多 60 MB 的文件读成字节数组、
 * 转 base64、作为**一条**消息过桥,JS 再解 base64、再拷一遍,峰值是文件大小的好几倍(评审 2026-10-02)。
 * 现在原生只回 `{ uri, name, type, size }`,字节由 WebView 自己经 Capacitor 的本地服务器流式取
 * (`Capacitor.convertFileSrc('content://…')` → `https://localhost/_capacitor_content_/…`,WebViewLocalServer 用
 * ContentResolver.openInputStream 供流),一次只处理一个文件,内存里只有最终那份 File。
 *
 * 上限两头都卡:原生按内容提供方**报告**的大小先筛一遍(FilePickPlan.kt,同样三个数);这里按**实际到手**的字节再卡 ——
 * 报告值可能缺席、也可能不对,所以是边读边数,超了当场停读,绝不先整个读进来再量。
 * 被拒的文件(太大 / 太多 / 读不了)一律进 skipped,由调用方提示,不静默丢。
 */
export const PICK_MAX_FILES = 20
/** = 输入框工作区文件的上限(MAX_WS_BYTES)。 */
export const PICK_MAX_FILE_BYTES = 25 * 1024 * 1024
export const PICK_MAX_TOTAL_BYTES = 60 * 1024 * 1024

export interface PickedDoc {
  uri: string
  name: string
  type?: string
  /** 内容提供方报告的大小;-1 / 缺席 = 未知。 */
  size?: number
}

export interface LoadPickedDeps {
  /** `content://…` → WebView 能 fetch 的地址(Capacitor.convertFileSrc)。 */
  toUrl(uri: string): string
  fetch(url: string): Promise<Response>
  limits?: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number }
}

const isDoc = (v: unknown): v is PickedDoc => {
  const d = v as PickedDoc | null
  return !!d && typeof d === 'object' && typeof d.name === 'string' && typeof d.uri === 'string' && d.uri.startsWith('content://')
}

/** 流式读完一个响应体;超过 budget 字节 → 取消读取并返回 null(已读的块随即丢弃)。 */
async function readCapped(res: Response, budget: number): Promise<Uint8Array<ArrayBuffer>[] | null> {
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return chunks
    received += value.byteLength
    if (received > budget) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value as Uint8Array<ArrayBuffer>)
  }
}

/** 逐个取回选中的文档。`docs` 是原生回的原始值(不可信,逐项校验);返回可用的 File 与被拒文件的名字(保持选择顺序)。 */
export async function loadPickedFiles(docs: unknown, deps: LoadPickedDeps): Promise<{ files: File[]; skipped: string[] }> {
  const maxFiles = deps.limits?.maxFiles ?? PICK_MAX_FILES
  const maxFile = deps.limits?.maxFileBytes ?? PICK_MAX_FILE_BYTES
  const maxTotal = deps.limits?.maxTotalBytes ?? PICK_MAX_TOTAL_BYTES
  const files: File[] = []
  const skipped: string[] = []
  let total = 0
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (!isDoc(doc)) continue
    const budget = Math.min(maxFile, maxTotal - total)
    const reported = typeof doc.size === 'number' && doc.size >= 0 ? doc.size : null
    if (files.length >= maxFiles || budget <= 0 || (reported !== null && reported > budget)) {
      skipped.push(doc.name)
      continue
    }
    let chunks: Uint8Array<ArrayBuffer>[] | null = null
    try {
      const res = await deps.fetch(deps.toUrl(doc.uri))
      chunks = res.ok ? await readCapped(res, budget) : null
    } catch {
      chunks = null // 提供方读失败 / 授权已失效:这一个跳过,其余照常
    }
    if (!chunks) {
      skipped.push(doc.name)
      continue
    }
    const file = new File(chunks, doc.name, { type: typeof doc.type === 'string' ? doc.type : '' })
    total += file.size
    files.push(file)
  }
  return { files, skipped }
}
