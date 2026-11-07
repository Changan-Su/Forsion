/** Run with a fresh Electron build and an isolated profile. No microphone or supplier access. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const { boot, launch, shotDir } = require('./lib/uiux-electron.cjs')

async function main() {
  let allowStream = true
  let batchCalls = 0
  let frames = 0
  let finished = 0
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'POST' && req.url === '/api/brain/transcribe') {
      batchCalls++
      req.resume()
      req.on('end', () => res.end(JSON.stringify({ text: '整段识别结果。' })))
    } else res.end('{}')
  })
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (!allowStream || !req.url.startsWith('/api/brain/realtime?mode=transcription&') || req.headers.authorization !== 'Bearer voice-fixture') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      const send = (type, fields = {}) => ws.send(JSON.stringify({ type, ...fields }))
      send('session.updated')
      ws.on('message', (data, binary) => {
        if (binary) {
          assert.equal(data.length % 2, 0)
          if (++frames === 1) send('conversation.item.input_audio_transcription.text', { item_id: 'one', text: '', stash: '今天讨论的' })
          if (frames === 3) send('conversation.item.input_audio_transcription.text', { item_id: 'one', text: '今天', stash: '讨论的三件事' })
          return
        }
        assert.equal(data.toString(), 'finish')
        finished++
        send('conversation.item.input_audio_transcription.completed', { item_id: 'one', transcript: '今天讨论了三件事。' })
        send('session.finished')
      })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const cloudUrl = `http://127.0.0.1:${server.address().port}`
  let ctx
  try {
    ctx = await launch({
      tag: 'voice-input-e2e', overrideHome: true,
      beforeLaunch: ({ home }) => fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl, token: 'voice-fixture' })),
    })
    const { app, win } = ctx
    await boot(app, win, { space: 'tangu', width: 1150, height: 750 })
    // A synthetic tone feeds both Chromium MediaRecorder and WebAudio. Nothing is played.
    await win.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext()
        const destination = context.createMediaStreamDestination()
        const oscillator = context.createOscillator()
        oscillator.connect(destination)
        oscillator.start()
        await context.resume()
        destination.stream.getAudioTracks()[0].stop = () => { void context.close() }
        return destination.stream
      }
    })
    const view = win.locator('.t2-chat-view:visible').first()
    const input = view.locator('.t2c-ta')
    const mic = view.locator('.t2c-mic-control')
    const stop = view.locator('.t2c-voicestop')
    const assertValue = value => win.waitForFunction(
      text => Array.from(document.querySelectorAll('.t2-chat-view .t2c-ta')).some(input => input.checkVisibility() && input.value === text),
      value, { timeout: 5000 },
    )
    const screenshot = file => win.screenshot({ path: path.join(shotDir('voice-input'), file), scale: 'css' })

    await input.fill('请整理：')
    await mic.click()
    await assertValue('请整理：今天讨论的三件事')
    assert.ok(frames >= 3)
    assert.equal(finished, 0)
    assert.equal(await input.getAttribute('readonly'), '')
    assert.equal(await view.locator('.t2c-send').count(), 0)
    assert.equal(await view.locator('.t2c-voice-pending').textContent(), '讨论的三件事')
    await input.press('Enter')
    await assertValue('请整理：今天讨论的三件事')
    await screenshot('streaming.png')
    await stop.click()
    await assertValue('请整理：今天讨论了三件事。')
    assert.equal(finished, 1)
    assert.equal(batchCalls, 0)
    assert.equal(await input.isEditable(), true)
    await input.fill('我修改了流式草稿。')
    await assertValue('我修改了流式草稿。')
    await screenshot('draft.png')

    allowStream = false
    await mic.click()
    await stop.waitFor()
    assert.equal(await input.inputValue(), '我修改了流式草稿。')
    assert.equal(await view.locator('.t2c-send').count(), 0)
    // Give the real recorder audio to decode on the fallback path.
    await win.waitForTimeout(400)
    assert.equal(batchCalls, 0)
    await stop.click()
    await assertValue('我修改了流式草稿。整段识别结果。')
    assert.equal(batchCalls, 1)
    assert.equal(await input.isEditable(), true)
    await input.fill('我修改了整段草稿。')
    await assertValue('我修改了整段草稿。')
    allowStream = true
    await mic.click()
    await stop.waitFor()
    await win.locator('.t2s-srow').filter({ hasText: 'Probe session two' }).first().click()
    await assertValue('')
    assert.equal(await view.locator('.t2c-voicestop').count(), 0)
    await win.locator('.t2s-srow').filter({ hasText: 'Probe session one' }).first().click()
    await assertValue('我修改了整段草稿。')
    console.log('PASS: recording cleanup and draft ownership on session change')
    console.log('PASS: real Electron, PCM before stop, interim replacement, explicit finish, batch fallback and editable drafts')
  } finally {
    await ctx?.close()
    for (const ws of sockets.clients) ws.terminate()
    sockets.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
