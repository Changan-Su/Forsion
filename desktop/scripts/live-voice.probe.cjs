/**
 * 实时语音免手采集的**真链路**探针(无人值守):
 *   macOS `say` 合成两句中文(中间夹静音)→ Chromium 假麦克风(--use-file-for-fake-audio-capture)
 *   → frontend/src/hooks/liveCapture.ts 原样打包进真 Electron 渲染进程(16k AudioContext + 端点检测 + pre-roll)
 *   → 每句 PCM 回主进程 → electron/asrLocal.ts 本地 SenseVoice 转写 → 断言。
 * 不起 App、不碰引擎、不花模型额度;要 macOS(say/afconvert)+ 已下载的本地 SenseVoice 模型(~/.forsion-dev/models/sensevoice)。
 *
 *   npm run probe:livevoice
 *   npm run probe:livevoice -- --clip-ms=400   # 负对照:每句砍掉开头 400ms(模拟起录晚了),首词断言应当变红
 *   npm run probe:livevoice -- --preroll=0     # 负对照:去掉 pre-roll,前导静音断言应当变红
 *
 * 场景 A(正常):恰好切出两句;每句带 ≥150ms 前导静音(pre-roll 在);时长 ≈ 原句 + pre-roll + 收口;转写含首词与关键词。
 * 场景 B(暂停):第 1 句说到一半时 setPaused(true) 且不再解除 → 第 1 句仍完整交出(暂停不吞半句),第 2 句的开口被挡住。
 *   ⚠️ 假设备每次 getUserMedia 都从文件开头重放,所以 B 重开一路采集即可复用同一份音频。
 * 另打印每句 ASR 耗时(首句含模型冷启)。退出码:全过 0,否则 1。
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')
const { RATE, writeWav, synthMic, fakeMicSwitches } = require('./lib/voice-fixture.cjs')

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const PREROLL = arg('preroll', null)
const CLIP_MS = Number(arg('clip-ms', 0))
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'live-voice-'))
const LINES = [
  { text: '今天有点累,随便陪我聊两句吧。', head: '今天', keys: ['累'] },
  { text: '周末去爬山还是在家看电影好?', head: '周末', keys: ['爬山', '电影'] },
]
const GAPS = [1.0, 1.5, 3.0] // 句前 / 句间 / 句后;句间 1.5s > hangover 0.7s 才该切成两句

const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }

// 合成假麦克风音频(必须在 app ready 之前:开关要在启动期挂上)。
const { file: micWav, seconds: micSeconds, lineSeconds: lineDur } = synthMic(OUT, LINES.map((l) => l.text), GAPS)
console.log(`假麦克风 ${micWav}(${micSeconds.toFixed(1)}s;句长 ${lineDur.map((d) => d.toFixed(2)).join(' / ')}s)`)
for (const sw of [...fakeMicSwitches(micWav), '--autoplay-policy=no-user-gesture-required']) {
  const [k, ...v] = sw.slice(2).split('=')
  app.commandLine.appendSwitch(k, v.join('='))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 开一路采集(文件从头放),可在 pauseAtMs 处暂停,放完收集切出的句子。 */
async function capture(win, { pauseAtMs } = {}) {
  const cfg = PREROLL == null ? 'LC.VAD' : `{ ...LC.VAD, prerollMs: ${Number(PREROLL)} }`
  await win.webContents.executeJavaScript(`(async () => {
    window.__utt = []
    const enc = (pcm) => { const b = new Uint8Array(pcm.length * 2), dv = new DataView(b.buffer)
      for (let i = 0; i < pcm.length; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); dv.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true) }
      let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(bin) }
    window.__cap = await LC.startLiveCapture({ onUtterance: (pcm) => __utt.push({ dur: pcm.length / 16000, b64: enc(pcm) }) }, ${cfg})
  })()`)
  const t0 = Date.now()
  if (pauseAtMs != null) { await sleep(pauseAtMs); await win.webContents.executeJavaScript('window.__cap.setPaused(true)') }
  await sleep(Math.max(0, micSeconds * 1000 + 3000 - (Date.now() - t0)))
  const utts = await win.webContents.executeJavaScript('window.__utt.map((u) => ({ dur: u.dur, b64: u.b64 }))')
  await win.webContents.executeJavaScript('window.__cap.stop()')
  return utts.map((u) => {
    const wav = Buffer.from(u.b64, 'base64')
    return { dur: u.dur, pcm: new Int16Array(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length)) }
  })
}

/** 首个 |x| > 0.05 之前的时长(ms):pre-roll 在 ≈ 256ms,去掉 ≈ 同帧内几十 ms。 */
const leadMs = (pcm) => { const i = pcm.findIndex((v) => Math.abs(v) > 0.05 * 32767); return i < 0 ? 0 : (i / RATE) * 1000 }

app.whenReady().then(async () => {
  let code = 1
  try {
    const src = path.join(__dirname, '..', 'frontend', 'src', 'hooks', 'liveCapture.ts')
    const bundle = esbuild.buildSync({ entryPoints: [src], bundle: true, format: 'iife', globalName: 'LC', write: false, target: 'chrome120' }).outputFiles[0].text
    fs.writeFileSync(path.join(OUT, 'lc.js'), bundle)
    fs.writeFileSync(path.join(OUT, 'index.html'), '<!doctype html><meta charset="utf-8"><script src="lc.js"></script>')
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(true))
    session.defaultSession.setPermissionCheckHandler(() => true)
    const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
    await win.loadFile(path.join(OUT, 'index.html')) // file:// = 安全上下文,getUserMedia 可用(data: 不行)

    process.env.TANGU_HOME = process.env.TANGU_HOME || path.join(os.homedir(), '.forsion-dev') // dev 家目录,只读模型
    // 产物必须落在 desktop/ 之下:asrLocal 用 createRequire(import.meta.url) 找 sherpa-onnx-node,放 tmp 解析不到
    const asrOut = path.join(__dirname, '..', 'node_modules', '.cache', 'live-voice-probe', 'asrLocal.mjs')
    esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'electron', 'asrLocal.ts')], bundle: true, platform: 'node', format: 'esm', outfile: asrOut, external: ['electron', 'sherpa-onnx-node'] })
    const { transcribeLocal, localModelReady } = await import(asrOut)
    if (!localModelReady()) throw new Error(`本地 SenseVoice 模型不在 ${process.env.TANGU_HOME}/models/sensevoice`)
    const asr = async (pcm, name) => {
      const file = path.join(OUT, `${name}.wav`)
      writeWav(file, pcm.subarray(Math.round(RATE * CLIP_MS / 1000)), RATE)
      const t0 = performance.now()
      const text = String(await transcribeLocal(fs.readFileSync(file)))
      return { text, ms: Math.round(performance.now() - t0) }
    }

    // ── 场景 A:正常两句 ──
    const a = await capture(win)
    check('A 切出的句数 = 2', a.length === LINES.length, `实得 ${a.length}(${a.map((u) => u.dur.toFixed(2) + 's').join(', ')})`)
    for (let i = 0; i < Math.min(a.length, LINES.length); i++) {
      const l = LINES[i], u = a[i]
      const { text, ms } = await asr(u.pcm, `a${i}`)
      const extra = u.dur - lineDur[i]
      check(`A${i + 1} 带 pre-roll(前导静音 ≥150ms)`, leadMs(u.pcm) >= 150, `${Math.round(leadMs(u.pcm))}ms`)
      check(`A${i + 1} 时长 ≈ 原句 + pre-roll + 收口`, extra > 0.4 && extra < 1.8, `原句 ${lineDur[i].toFixed(2)}s,切出 ${u.dur.toFixed(2)}s(+${extra.toFixed(2)}s)`)
      check(`A${i + 1} 首词「${l.head}」没被吃`, text.includes(l.head), `「${text}」 ASR ${ms}ms${i === 0 ? '(含模型冷启)' : ''}`)
      check(`A${i + 1} 关键词 ${l.keys.join('/')}`, l.keys.every((k) => text.includes(k)))
    }

    // ── 场景 B:第 1 句中途暂停且不解除 ──
    const b = await capture(win, { pauseAtMs: Math.round((GAPS[0] + lineDur[0] / 2) * 1000) })
    check('B 暂停后只交出 1 句(第 2 句开口被挡)', b.length === 1, `实得 ${b.length}(${b.map((u) => u.dur.toFixed(2) + 's').join(', ')})`)
    if (b[0]) {
      const { text } = await asr(b[0].pcm, 'b0')
      check('B 说到一半的第 1 句仍完整交出', text.includes(LINES[0].head) && LINES[0].keys.every((k) => text.includes(k)) && !text.includes(LINES[1].head), `「${text}」`)
    }
    code = results.length && results.every(Boolean) ? 0 : 1
  } catch (e) {
    console.error('探针异常:', e?.stack || e)
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} PASS  产物 ${OUT}`)
  app.exit(code)
})
