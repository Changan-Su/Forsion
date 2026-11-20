/**
 * 本地离线语音模型(SenseVoice)的听写在真 Electron 里边说边出字(npm run e2e:voicelocal)。
 * 隔离 profile + 真模型(软链本机已下载的 ~/.forsion-dev/models/sensevoice,或 FORSION_SENSEVOICE_DIR)+ 合成中文语音
 * 当麦克风(getUserMedia 换成 AudioBufferSource → MediaStreamDestination,不出声)。说话途中逐 100ms 采样输入框:
 * 停止前字就得长出来,停止后定稿只出现一次、不走整段转写。量的是 out/ 产物:改了源码先 `npx electron-vite build`。
 * 负对照:CBD_ROOT 指向没有这次改动的构建,「停止前就有字」那条应红。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { boot, launch, shotDir } = require('./lib/uiux-electron.cjs')

const MODEL = process.env.FORSION_SENSEVOICE_DIR || path.join(os.homedir(), '.forsion-dev', 'models', 'sensevoice')

function speechWav(dir) {
  const aiff = path.join(dir, 'speech.aiff'), wav = path.join(dir, 'speech.wav')
  execFileSync('say', ['-v', 'Tingting', '今天下午三点开会，记得带上周报。[[slnc 1200]] 然后晚上把设计稿发给我，谢谢。', '-o', aiff])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav])
  return wav
}

async function main() {
  assert.ok(fs.existsSync(path.join(MODEL, 'model.int8.onnx')), `本地语音模型不在 ${MODEL}:先在设置 › 语音里下载,或设 FORSION_SENSEVOICE_DIR`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-voicelocal-'))
  const wav = speechWav(tmp)
  const audio = fs.readFileSync(wav).toString('base64')
  let ctx
  try {
    ctx = await launch({
      tag: 'voice-input-local', overrideHome: true,
      beforeLaunch: ({ home }) => {
        const file = path.join(home, 'config.json')
        const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
        fs.writeFileSync(file, JSON.stringify({ ...cfg, asr: { backend: 'local' } }, null, 2))
        fs.mkdirSync(path.join(home, 'models'), { recursive: true })
        fs.symlinkSync(MODEL, path.join(home, 'models', 'sensevoice'))
      },
    })
    const { app, win } = ctx
    await boot(app, win, { space: 'tangu', width: 1150, height: 750 })
    // 批量转写记次数:流式成功时不该再走它
    // ipcMain.handle 的处理器存在内部表 _invokeHandlers 里;包一层计数(拿不到就记 -1,下面那条断言跳过)
    await app.evaluate(({ ipcMain }) => {
      const table = ipcMain._invokeHandlers
      const inner = table?.get?.('asr:transcribe')
      if (!inner) { globalThis.__batchCalls = -1; return }
      globalThis.__batchCalls = 0
      table.set('asr:transcribe', (...args) => { globalThis.__batchCalls++; return inner(...args) })
    })
    await win.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      window.__speechEnded = false
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext()
        const buffer = await context.decodeAudioData(bytes.buffer.slice(0))
        const destination = context.createMediaStreamDestination()
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(destination)
        source.onended = () => { window.__speechEnded = true }
        source.start()
        await context.resume()
        destination.stream.getAudioTracks()[0].stop = () => { void context.close() }
        return destination.stream
      }
    }, audio)

    const view = win.locator('.t2-chat-view:visible').first()
    const input = view.locator('.t2c-ta')
    const mic = view.locator('.t2c-mic-control')
    const stop = view.locator('.t2c-voicestop')
    await input.fill('')
    const t0 = Date.now()
    await mic.click()
    await stop.waitFor()
    // 说话途中采样:每 100ms 记一次输入框的值和「未定稿」那段
    const samples = []
    let shot = false
    while (!(await win.evaluate(() => window.__speechEnded)) && Date.now() - t0 < 20000) {
      const value = await input.inputValue()
      const pending = await view.locator('.t2c-voice-pending').textContent().catch(() => null)
      if (!samples.length || samples.at(-1).value !== value) samples.push({ at: Date.now() - t0, value, pending })
      if (!shot && value.length >= 8) { shot = true; await win.screenshot({ path: path.join(shotDir('voice-input-local'), 'streaming.png'), scale: 'css' }) }
      await new Promise((r) => setTimeout(r, 100))
    }
    for (const s of samples) console.log(`  ${(s.at / 1000).toFixed(1)}s  ${JSON.stringify(s.value)}${s.pending ? `  (未定稿 ${JSON.stringify(s.pending)})` : ''}`)
    const grown = samples.filter((s) => s.value.trim())
    assert.ok(grown.length >= 3, `停止前输入框只变了 ${grown.length} 次:没在边说边出字`)
    assert.ok(grown.some((s) => /开会/.test(s.value)), '说话途中没出现「开会」')
    console.log('PASS: 停止前字就在长')

    await stop.click()
    await win.waitForFunction(() => {
      const ta = Array.from(document.querySelectorAll('.t2-chat-view .t2c-ta')).find((el) => el.checkVisibility())
      return ta && !ta.readOnly && /谢谢/.test(ta.value)
    }, null, { timeout: 8000 })
    const final = await input.inputValue()
    console.log(`  定稿 ${JSON.stringify(final)}`)
    assert.match(final, /开会/)
    assert.match(final, /设计稿/)
    assert.equal(final.match(/开会/g).length, 1, '定稿里「开会」出现了不止一次')
    const batchCalls = await app.evaluate(() => globalThis.__batchCalls)
    if (batchCalls < 0) console.log('NOTE: 拿不到 asr:transcribe 处理器,没数整段转写次数')
    else assert.equal(batchCalls, 0, '流式成功了却又走了整段转写')
    assert.equal(await input.isEditable(), true)
    await win.screenshot({ path: path.join(shotDir('voice-input-local'), 'final.png'), scale: 'css' })
    console.log('PASS: 停止后定稿一次、可编辑、没走整段转写')
    console.log(`截图:${shotDir('voice-input-local')}`)
  } finally {
    await ctx?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
