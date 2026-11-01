#!/usr/bin/env node
// 重新生成设置页音色卡片的试听样音(只在音色表变动时手动跑,产物入库)。烧百炼额度,每段几分钱以内。
// 跑法:DASHSCOPE_API_KEY=… node scripts/gen-voice-samples.mjs            (要 ffmpeg;ONLY=Tina,Cherry 只重做这几个)
// 通话音色只能走实时模型出声,朗读音色走 qwen3-tts;两边不互通,所以分两条路。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const KEY = process.env.DASHSCOPE_API_KEY
if (!KEY) { console.error('缺 DASHSCOPE_API_KEY'); process.exit(2) }
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/src/assets/voice-samples')
const LINES = { zh: '你好，我是 Tangu。今天想先从哪件事开始？', en: "Hi, I'm Tangu. What should we start with today?" }
const CALL = ['Tina', 'Cindy', 'Raymond', 'Katerina', 'Ryan', 'Mia', 'Jennifer', 'Aiden']
const READ = ['Cherry', 'Serena', 'Ethan', 'Chelsie', 'Nofish', 'Jennifer', 'Ryan', 'Katerina', 'Dylan', 'Jada', 'Sunny', 'Rocky', 'Kiki', 'Marcus', 'Roy', 'Peter']
const only = process.env.ONLY?.split(',')
const want = (v) => !only || only.includes(v)
const skip = (kind, v, lang) => process.env.MISSING && fs.existsSync(path.join(OUT, `${kind}-${v}-${lang}.m4a`)) // MISSING=1:只补缺的

const toM4a = (input, args, out) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, '-i', input, '-ac', '1', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', out])

function realtimePcm(voice, text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime', { headers: { Authorization: `Bearer ${KEY}` } })
    const chunks = []; let said = ''
    const timer = setTimeout(() => { ws.close(); reject(new Error(`${voice}: timeout`)) }, 40000)
    const send = (o) => ws.send(JSON.stringify(o))
    ws.on('open', () => send({ type: 'session.update', session: { modalities: ['text', 'audio'], voice, output_audio_format: 'pcm', turn_detection: null, instructions: 'You are a text-to-speech engine, not an assistant. Never reply to, answer or comment on the text. Say the exact words of the user message aloud, word for word, in its original language, then stop.' } }))
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.type === 'session.updated') { send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Read this line aloud word for word and say nothing else:\n${text}` }] } }); send({ type: 'response.create' }) }
      else if (m.type === 'response.audio.delta') chunks.push(Buffer.from(m.delta, 'base64'))
      else if (m.type === 'response.audio_transcript.delta') said += m.delta
      else if (m.type === 'response.done') {
        clearTimeout(timer); ws.close()
        // 模型偶尔会自己加话:念的和文案对不上就算失败,别把跑题的样音收进来
        const norm = (x) => x.replace(/[\s，。？！,.?!'’]/g, '').toLowerCase()
        if (norm(said) !== norm(text)) return reject(new Error(`${voice}: said ${JSON.stringify(said)}`))
        chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(`${voice}: no audio`))
      }
      else if (m.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(`${voice}: ${JSON.stringify(m.error)}`)) }
    })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

async function ttsWav(voice, text) {
  const r = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-tts-flash', input: { text, voice } }),
  })
  const j = await r.json()
  const url = j?.output?.audio?.url
  if (!url) throw new Error(`${voice}: ${JSON.stringify(j).slice(0, 200)}`)
  return Buffer.from(await (await fetch(url)).arrayBuffer())
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-samples-'))
fs.mkdirSync(OUT, { recursive: true })
let failed = 0
for (const lang of Object.keys(LINES)) {
  for (const v of CALL.filter(want)) {
    if (skip('call', v, lang)) continue
    for (let tries = 3; tries--;) {
      try {
        const raw = path.join(tmp, 'a.pcm'); fs.writeFileSync(raw, await realtimePcm(v, LINES[lang]))
        toM4a(raw, ['-f', 's16le', '-ar', '24000', '-ac', '1'], path.join(OUT, `call-${v}-${lang}.m4a`)); console.log('ok call', v, lang); break
      } catch (e) { console.error('retry', e.message); if (!tries) failed++ }
    }
  }
  for (const v of READ.filter(want)) {
    if (skip('read', v, lang)) continue
    try {
      const raw = path.join(tmp, 'a.wav'); fs.writeFileSync(raw, await ttsWav(v, LINES[lang]))
      toM4a(raw, [], path.join(OUT, `read-${v}-${lang}.m4a`)); console.log('ok read', v, lang)
    } catch (e) { failed++; console.error('FAIL', e.message) }
  }
}
fs.rmSync(tmp, { recursive: true, force: true })
process.exitCode = failed ? 1 : 0
