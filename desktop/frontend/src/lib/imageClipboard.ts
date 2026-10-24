/** 把一张图(任何 fetch 得到的地址)写进系统剪贴板。剪贴板只认 PNG,别的格式先画一遍。
 *  text 同一项里带上 text/plain:Amadeus 自己粘贴时拿回库内引用,不再导入一份(见 amadeus/lib/attachmentClipboard)。
 *  图片以 Promise 交给 ClipboardItem:WebKit 要求 write() 在用户手势里同步调起,取图的等待放进条目里。 */
export function writeImageToClipboard(src: string, text?: string): Promise<void> {
  const mine = ++generation
  const png = fetch(src).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.blob()
  }).then(toPng).then((b) => {
    // 取图期间用户又复制 / 剪切了别的:这份就作废,不能晚到一步把新内容盖掉
    if (generation !== mine) throw new Error('superseded')
    return b
  })
  const item: Record<string, Blob | Promise<Blob>> = { 'image/png': png }
  if (text) item['text/plain'] = new Blob([text], { type: 'text/plain' })
  return navigator.clipboard.write([new ClipboardItem(item)])
}

/** 每次复制 / 剪切(捕获期,先于编辑器自己的 copy 处理)都翻一页;写图时记下页码,取完图对不上就放弃。 */
let generation = 0
if (typeof document !== 'undefined') {
  for (const type of ['copy', 'cut']) document.addEventListener(type, () => { generation++ }, true)
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  // createImageBitmap 不解 SVG:退回 <img> 解码
  const bmp: ImageBitmap | HTMLImageElement = await createImageBitmap(blob).catch(() => decodeImage(blob))
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'))
}

async function decodeImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}
