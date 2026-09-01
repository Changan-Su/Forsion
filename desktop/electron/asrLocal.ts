/**
 * 本地离线语音识别(SenseVoice Small)——只在 Electron 主进程,完全离线、不经引擎/服务端。
 * 运行时 = sherpa-onnx-node(自带 onnxruntime,N-API);模型按需下载到 ~/.forsion/models/sensevoice/。
 * 云端/自带-key 路径见 asr.ts;本文件只管「本地」这一条。
 */
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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
// 候选主机**有序列表**,依次回退(同 market 安装的 githubMirrorCandidates 家法):中国大陆直连 huggingface.co
// 常被拦成 `TypeError: fetch failed` 或干脆 SYN 挂起,而主进程 fetch 又不读系统代理 → 挂了 VPN 也照样死。
// 所以不管用户有没有把「网络环境」切到中国大陆,两个地址都试,只是顺序不同。
const HOSTS: Record<string, string[]> = {
  default: ['https://huggingface.co', 'https://hf-mirror.com'],
  china: ['https://hf-mirror.com', 'https://huggingface.co'],
}
const FILES = ['model.int8.onnx', 'tokens.txt']
// 两个 env 既是单测把 15s/30s 压到毫秒级的旋钮,也是现场排障(慢到爆的网络)调宽的旋钮。
const CONNECT_TIMEOUT_MS = Number(process.env.FORSION_ASR_CONNECT_TIMEOUT_MS) || 15_000 // 连接阶段;被墙时是挂起而非快速失败,没这个就永远等不到回退
const STALL_TIMEOUT_MS = Number(process.env.FORSION_ASR_STALL_TIMEOUT_MS) || 30_000 // 下载中「多久没收到字节」算断流(整段不能设超时,230MB 慢网合法)
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
  const tmp = dest + '.part'
  const ac = new AbortController()
  let timer = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS)
  const arm = (ms: number): void => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), ms) }
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    arm(STALL_TIMEOUT_MS) // 响应头到手 → 改判「断流」看门狗,每收到一块字节续一次
    const nodeStream = Readable.fromWeb(res.body as never)
    nodeStream.on('data', (c: Buffer) => { onBytes(c.length); arm(STALL_TIMEOUT_MS) })
    await pipeline(nodeStream, createWriteStream(tmp)) // 出错时 pipeline 负责销毁写流(手写 pipe 会漏 fd)
    await rename(tmp, dest) // 整段落盘后再改名 → 半截不会被 localModelReady 误判就绪
  } catch (e) {
    await unlink(tmp).catch(() => {}) // 换下一个候选前清掉半截,免得攒一堆 .part
    throw new Error((e as Error)?.name === 'AbortError' ? '连接超时/断流' : (e as Error)?.message || String(e))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 按候选主机顺序下载整组文件,前一个整组失败才试下一个。
 * 抽成导出函数只为可单测(不碰 electron、不碰 230MB 的大小校验);真身入口是 downloadLocalModel。
 */
export async function downloadFromHosts(
  hosts: string[],
  dir: string,
  onProgress: (received: number, total: number) => void,
  verify: () => boolean,
): Promise<void> {
  const errs: string[] = []
  for (const host of hosts) {
    let received = 0
    try {
      for (const f of FILES) {
        const dest = join(dir, f)
        // 已经下全的大文件不重下:230MB 在慢网上重来一遍太贵(tokens.txt 极小,不值得判)
        if (f === 'model.int8.onnx' && existsSync(dest) && statSync(dest).size >= MIN_MODEL_BYTES) {
          received += statSync(dest).size
          onProgress(received, APPROX_TOTAL)
          continue
        }
        await downloadOne(`${host}/${REPO}/resolve/main/${f}`, dest, (n) => { received += n; onProgress(received, APPROX_TOTAL) })
      }
      if (!verify()) throw new Error('下载完成但模型校验未通过(大小异常)')
      return
    } catch (e) {
      errs.push(`${host.replace(/^https?:\/\//, '')} — ${(e as Error)?.message || String(e)}`)
    }
  }
  throw new Error(`模型下载失败,已尝试 ${hosts.length} 个地址:${errs.join(' ; ')}。若在中国大陆,请连上代理(注意:主进程不读系统 HTTP 代理,需 TUN/全局模式)后重试。`)
}

/** 下载 SenseVoice int8 模型(带累计字节进度)。mirror 只决定候选主机的**顺序**,两个都会试。 */
export async function downloadLocalModel(
  mirror: 'default' | 'china',
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  await mkdir(modelDir(), { recursive: true })
  await downloadFromHosts(HOSTS[mirror] || HOSTS.default, modelDir(), onProgress, localModelReady)
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
