/** 把一张图(任何 fetch 得到的地址)写进系统剪贴板。剪贴板只认 PNG,别的格式先画一遍。
 *  text 同一项里带上 text/plain:Amadeus 自己粘贴时拿回库内引用,不再导入一份(见 amadeus/lib/attachmentClipboard)。
 *  图片以 Promise 交给 ClipboardItem:WebKit 要求 write() 在用户手势里同步调起,取图的等待放进条目里。 */
export function writeImageToClipboard(src: string, text?: string): Promise<void> {
  const png = fetch(src).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.blob()
  }).then(toPng)
  const item: Record<string, Blob | Promise<Blob>> = { 'image/png': png }
  if (text) item['text/plain'] = new Blob([text], { type: 'text/plain' })
  return navigator.clipboard.write([new ClipboardItem(item)])
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'))
}
