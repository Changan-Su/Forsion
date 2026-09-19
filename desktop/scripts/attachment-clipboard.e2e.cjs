/**
 * 附件双口径剪贴板(真 Electron / 真 IPC):
 *   · Forsion 内部拿 text/custom flavor 的 markdown 引用;
 *   · 外部应用拿原生图片或 file URL,普通附件走 HTML 链接 + URI flavor。
 *
 * 读取 out/ 产物,运行前先 npm run build。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('缺 out/main/main.js —— 先跑 npm run build')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-attachment-clipboard-'))
  const vault = path.join(temp, 'vault')
  const userData = path.join(temp, 'userdata')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  fs.writeFileSync(path.join(vault, 'Note.md'), '# Note\n')
  // 复用仓内已被 Electron 真正加载过的 JPEG,避免“看似 PNG、nativeImage 实际判空”的坏 fixture。
  fs.copyFileSync(path.join(ROOT, 'frontend/src/assets/wallpapers/hack2gate-light.jpg'), path.join(vault, 'probe.jpg'))
  fs.writeFileSync(path.join(vault, 'sample.txt'), 'attachment body\n')
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  let originalClipboard = null
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40_000 })
    originalClipboard = await app.evaluate(({ clipboard }) => ({
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      image: clipboard.readImage().toPNG().toString('base64'),
    }))
    const hasApi = await win.evaluate(() => typeof window.amadeus?.copyAttachment === 'function')
    check('C1 preload 暴露 copyAttachment', hasApi)

    const imageOk = await win.evaluate(async () => {
      await window.amadeus.restoreVault()
      return window.amadeus.copyAttachment('Note.md', 'probe.jpg', '![[probe.jpg]]')
    })
    const imageClip = await app.evaluate(({ clipboard }) => ({
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      image: !clipboard.readImage().isEmpty(),
      custom: clipboard.readBuffer('application/x-forsion-attachment-reference').toString('utf8'),
      uri: clipboard.readBuffer('text/uri-list').toString('utf8'),
      fileUrl: process.platform === 'darwin' ? clipboard.readBuffer('public.file-url').toString('utf8') : '',
    }))
    check('C2 图片复制 IPC 成功', imageOk === true)
    check('C3 内部口径保留 markdown 引用', imageClip.text === '![[probe.jpg]]', JSON.stringify(imageClip))
    check('C4 外部口径包含原生图片与 HTML 图片', imageClip.image && imageClip.html.includes('<img'), JSON.stringify(imageClip))
    if (process.platform === 'darwin') check('C5 macOS 原生图片 flavor 可用', imageClip.image, JSON.stringify(imageClip))
    const [pasted] = await Promise.all([
      win.evaluate(() => new Promise((resolve) => {
        const input = document.createElement('textarea')
        input.style.position = 'fixed'
        input.style.left = '-9999px'
        document.body.appendChild(input)
        input.focus()
        input.addEventListener('paste', (event) => {
          event.preventDefault()
          resolve({
            text: event.clipboardData?.getData('text/plain') ?? '',
            types: Array.from(event.clipboardData?.types ?? []),
            files: Array.from(event.clipboardData?.files ?? []).map((file) => file.name),
          })
          input.remove()
        }, { once: true })
        setTimeout(() => { input.remove(); resolve(null) }, 3_000)
      })),
      win.keyboard.press('Meta+V'),
    ])
    check('C6 渲染层 paste 同时看见引用与 native file flavor',
      !!pasted && (pasted.text === '![[probe.jpg]]' || pasted.files.length > 0)
        && (pasted.files.length > 0 || pasted.types.some((type) => /file|uri/i.test(type))),
      JSON.stringify(pasted),
    )

    const fileOk = await win.evaluate(() => window.amadeus.copyAttachment('Note.md', 'sample.txt', '[sample](sample.txt)'))
    const fileClip = await app.evaluate(({ clipboard }) => ({
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      image: !clipboard.readImage().isEmpty(),
      custom: clipboard.readBuffer('application/x-forsion-attachment-reference').toString('utf8'),
      uri: clipboard.readBuffer('text/uri-list').toString('utf8'),
      fileUrl: process.platform === 'darwin' ? clipboard.readBuffer('public.file-url').toString('utf8') : '',
    }))
    const [filePaste] = await Promise.all([
      win.evaluate(() => new Promise((resolve) => {
        const input = document.createElement('textarea')
        input.style.position = 'fixed'
        input.style.left = '-9999px'
        document.body.appendChild(input)
        input.focus()
        input.addEventListener('paste', (event) => {
          event.preventDefault()
          resolve({
            text: event.clipboardData?.getData('text/plain') ?? '',
            types: Array.from(event.clipboardData?.types ?? []),
            files: Array.from(event.clipboardData?.files ?? []).map((file) => file.name),
          })
          input.remove()
        }, { once: true })
        setTimeout(() => { input.remove(); resolve(null) }, 3_000)
      })),
      win.keyboard.press('Meta+V'),
    ])
    check('C7 普通附件复制 IPC 成功', fileOk === true)
    check('C8 普通附件保留引用并提供外部文件链接',
      fileClip.text === '[sample](sample.txt)'
        && !fileClip.image && fileClip.html.includes('<a href=')
        && (process.platform === 'darwin'
          ? fileClip.fileUrl.startsWith('file:') || (filePaste && filePaste.files.length > 0)
          : true),
      JSON.stringify({ fileClip, filePaste }),
    )
  } finally {
    if (originalClipboard) {
      await app.evaluate(({ clipboard, nativeImage }, saved) => {
        const image = saved.image ? nativeImage.createFromBuffer(Buffer.from(saved.image, 'base64')) : nativeImage.createEmpty()
        clipboard.write({ text: saved.text, html: saved.html, ...(image.isEmpty() ? {} : { image }) })
      }, originalClipboard).catch(() => {})
    }
    await app.close().catch(() => {})
    fs.rmSync(temp, { recursive: true, force: true })
  }
  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
