/**
 * 本地离线语音识别(SenseVoice Small)——只在 Electron 主进程,完全离线、不经引擎/服务端。
 * 运行时 = sherpa-onnx-node(自带 onnxruntime,N-API);模型按需下载到 ~/.forsion/models/sensevoice/。
 * 云端/自带-key 路径见 asr.ts;本文件只管「本地」这一条。
 */
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { OfflineRecognizer } from 'sherpa-onnx-node'
import { forsionHomeDir } from './forsionHome'
import { healMacQuarantine } from './macQuarantine'
import { wavToSamples, splitOnSilence } from './asrAudio'

// 自愈须早于 app ready / 引擎子进程 spawn;本模块被 main.ts 顶层 import,模块加载期即执行。
healMacQuarantine()

// sherpa-onnx-node 是原生 CJS 模块;electron-vite 把 main 打成 ESM 且外置它 → ESM 具名 import 运行时报
// "Named export not found"。改 createRequire 运行期加载,类型走 `import type`(编译期擦除,不产生运行时 import)。
// ⚠️必须懒加载:顶层加载曾在 Gatekeeper 拦 dylib 时把整个 App 启动崩死(v2.6.0~v2.6.8 macOS 安装版)。
// 只缓存成功——失败后用户清完隔离属性无需重启即可重试。
let sherpaMod: typeof import('sherpa-onnx-node') | undefined
function loadSherpa(): typeof import('sherpa-onnx-node') {
  if (!sherpaMod) {
    try {
      sherpaMod = createRequire(import.meta.url)('sherpa-onnx-node') as typeof import('sherpa-onnx-node')
    } catch (e) {
      const bundle = process.platform === 'darwin' ? resolve(process.resourcesPath || '', '..', '..') : ''
      throw new Error(
        `本地语音识别组件加载失败:${(e as Error).message}` +
          (bundle.endsWith('.app') ? `\n(macOS 常见原因是隔离属性拦截,可在终端执行 xattr -dr com.apple.quarantine "${bundle}" 后重试)` : ''),
      )
    }
  }
  return sherpaMod
}

// 官方 SenseVoice sherpa 模型(zh/en/ja/ko/yue);int8 ~230MB,tokens 极小。
const REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
const HOSTS: Record<string, string> = { default: 'https://huggingface.co', china: 'https://hf-mirror.com' }
const FILES = ['model.int8.onnx', 'tokens.txt']
const MIN_MODEL_BYTES = 100_000_000 // int8 ~230MB;< 100MB 视为半截/损坏
const APPROX_TOTAL = 240 * 1024 * 1024 // 进度条用的近似总量

function modelDir(): string { return join(forsionHomeDir(), 'models', 'sensevoice') }
function modelFile(): string { return join(modelDir(), 'model.int8.onnx') }
function tokensFile(): string { return join(modelDir(), 'tokens.txt') }

/** 模型是否已就绪(两文件都在 + onnx 大小合理,挡半截下载)。 */
export function localModelReady(): boolean {
  try {
    return existsSync(tokensFile()) && existsSync(modelFile()) && statSync(modelFile()).size >= MIN_MODEL_BYTES
  } catch { return false }
}

export function localModelSize(): number {
  try { return statSync(modelFile()).size } catch { return 0 }
}

async function downloadOne(url: string, dest: string, onBytes: (n: number) => void): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}: ${url}`)
  const tmp = dest + '.part'
  const out = createWriteStream(tmp)
  const nodeStream = Readable.fromWeb(res.body as never)
  nodeStream.on('data', (c: Buffer) => onBytes(c.length))
  await new Promise<void>((resolve, reject) => {
    nodeStream.pipe(out)
    out.on('finish', () => resolve())
    out.on('error', reject)
    nodeStream.on('error', reject)
  })
  await rename(tmp, dest) // 整段落盘后再改名 → 半截不会被 localModelReady 误判就绪
}

/** 下载 SenseVoice int8 模型(带累计字节进度)。mirror='china' 走 hf-mirror.com。 */
export async function downloadLocalModel(
  mirror: 'default' | 'china',
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  await mkdir(modelDir(), { recursive: true })
  const base = `${HOSTS[mirror] || HOSTS.default}/${REPO}/resolve/main`
  let received = 0
  for (const f of FILES) {
    await downloadOne(`${base}/${f}`, join(modelDir(), f), (n) => { received += n; onProgress(received, APPROX_TOTAL) })
  }
  if (!localModelReady()) throw new Error('下载完成但模型校验未通过(大小异常),请重试')
}

export async function removeLocalModel(): Promise<void> {
  await unlink(modelFile()).catch(() => {})
  await unlink(tokensFile()).catch(() => {})
  recognizerP = null
}

let recognizerP: Promise<OfflineRecognizer> | null = null

/** 懒建 recognizer 并缓存(首次加载 ~230MB 模型有秒级延迟,用 async 工厂不阻塞主进程)。 */
function getRecognizer(): Promise<OfflineRecognizer> {
  if (!recognizerP) {
    recognizerP = loadSherpa().OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: modelFile(), language: '', useInverseTextNormalization: 1 },
        tokens: tokensFile(),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    }).catch((e) => { recognizerP = null; throw e })
  }
  return recognizerP
}

/** 单段解码(SenseVoice 一次一句)。 */
async function decodeSlice(rec: OfflineRecognizer, samples: Float32Array, sampleRate: number): Promise<string> {
  const stream = rec.createStream()
  stream.acceptWaveform({ samples, sampleRate })
  const result = await rec.decodeAsync(stream)
  return (result.text || '').trim()
}

/** 一条带时间的转写片段(秒);与 asr.ts 的 AsrSegment 同形(此处不 import,免主进程模块环)。 */
export interface LocalSegment { start: number; end: number; text: string }

export { wavToSamples, splitOnSilence } // 纯函数真身在 asrAudio.ts(那边可单测);此处转出,老调用点不改

/**
 * 本地离线转写:WAV → 文本(全在 V8 内存,不落临时文件、不经 sherpa readWave)。
 * 不要时间戳且音频短(≤30s,语音输入的情形)→ 老路径原样一次解码。
 * 要时间戳、或音频长 → 按静音切段逐段解码(长音频不切等于结果不可用)。
 */
export async function transcribeLocal(wav: Buffer, opts?: { timestamps?: boolean }): Promise<string | { text: string; segments?: LocalSegment[] }> {
  if (!localModelReady()) throw new Error('本地语音模型未下载')
  const rec = await getRecognizer()
  const { samples, sampleRate } = wavToSamples(wav)
  const short = samples.length <= sampleRate * 30
  if (!opts?.timestamps && short) return decodeSlice(rec, samples, sampleRate)

  const slices = splitOnSilence(samples, sampleRate)
  const segments: LocalSegment[] = []
  for (const s of slices) {
    const text = await decodeSlice(rec, samples.subarray(s.from, s.to), sampleRate)
    if (text) segments.push({ start: s.from / sampleRate, end: s.to / sampleRate, text })
  }
  const text = segments.map((s) => s.text).join(' ').trim()
  return opts?.timestamps ? { text, segments: segments.length ? segments : undefined } : text
}
