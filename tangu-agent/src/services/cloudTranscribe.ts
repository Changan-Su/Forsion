/**
 * 云端转写:transcribe_audio 没有桌面桥时,把一份本机音频交给 Forsion 服务端的 POST /api/brain/transcribe(brain.asr)。
 *
 * 为什么要切段:服务端收整段 base64 JSON(全局 JSON 上限 50 MB,约 37 MB 原始音频 ≈ 16 kHz 单声道 WAV 的 19 分钟),
 * 但生产网关对这个接口的读超时约 60 秒 —— 实测 170 秒人声整段送就 504(desktop/electron/asrCloudChunks.ts 的头注)。
 * 所以 16-bit PCM 单声道 WAV 照桌面同一个口径切成 ≤30 秒一段,逐段送、再拼回去。视频转写交回的就是这种 WAV。
 *
 * 和桌面那份的区别:引擎可能跑在内存很小的机器上,一小时的 WAV 约 115 MB,整段读进来再转成浮点样本会把进程撑爆。
 * 这里按文件句柄一窗一窗地读:切点在每窗后三分之一里找最安静的 20 ms 帧;只记切点,发送时再按偏移读那一段。
 * 内存 ≈ 并发数 × 一段(30 秒 ≈ 1 MB)。
 *
 * 只收 16-bit PCM 单声道 WAV:别的格式没法原样切,服务端按 WAV 头算时长计费,压缩音频整段送时长和费用都会算错,
 * 低码率的长音频还会撞网关读超时。所以一律报错,让调用方先转(视频转写交回的本来就是这种 WAV)。
 * 每段「没人声」= 空文本(上游把它当错误回);别的错误整次失败并带上第几段,不拿半截冒充全文;
 * 一段失败就不再派发、在途的段一起取消,少花冤枉钱。
 * 时间戳:服务端只回文字,所以每段一条(段的真实起止),不编句子级时间。
 */
import { open, stat, type FileHandle } from 'node:fs/promises';

/** 一段最多多长(秒)。15 秒一段实测 13 秒回来,30 秒离 60 秒网关读超时留了一倍余量。 */
export const CLOUD_CHUNK_SEC = 30;
/** 同时在路上的段数。 */
export const CLOUD_CHUNK_CONCURRENCY = 3;
/** 一次最多转多长的音频。按段计费,而工具一次最多 9 分钟:一段 30 秒实测要 25 秒上下才回来,
 *  20 分钟 = 40 段、并发 3 约 14 轮 ≈ 6 分钟,留了余量;再长就可能付完钱在时限里拿不到结果。 */
export const CLOUD_MAX_AUDIO_SEC = 20 * 60;

export interface TranscriptSegment { start: number; end: number; text: string }
export interface CloudTranscript { text: string; segments?: TranscriptSegment[] }
/** 发一段音频,回这段的文字。 */
export type SendAudio = (audio: Buffer, mime: string, signal?: AbortSignal) => Promise<string>;

/** 上游把「这段没人声」当错误回(百炼原生接口 400 `ASR_RESPONSE_HAVE_NO_WORDS`):静音、纯音乐的一段是空文本,不是失败。 */
export function isNoSpeechError(message: string): boolean {
  return /ASR_RESPONSE_HAVE_NO_WORDS/.test(message);
}

interface WavLayout { sampleRate: number; dataOffset: number; samples: number }

/** 读 WAV 头:16-bit PCM 单声道才回布局,别的(包括不是 WAV)回 null。按偏移逐块读块头(大的 LIST 块之后的 data 也找得到);
 *  data 长度按文件实际大小截(流式写的 WAV 头里的长度不可信)。 */
async function monoPcm16Layout(fh: FileHandle, fileSize: number): Promise<WavLayout | null> {
  if (fileSize < 44) return null;
  const b = Buffer.alloc(16);
  const readAt = async (len: number, at: number): Promise<boolean> => (await fh.read(b, 0, len, at)).bytesRead === len;
  if (!(await readAt(12, 0)) || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  for (let n = 0; n < 64 && off + 8 <= fileSize; n++) {
    if (!(await readAt(8, off))) return null;
    const id = b.toString('ascii', 0, 4);
    const size = b.readUInt32LE(4);
    if (id === 'fmt ') {
      if (size < 16 || !(await readAt(16, off + 8))) return null;
      fmt = { format: b.readUInt16LE(0), channels: b.readUInt16LE(2), sampleRate: b.readUInt32LE(4), bits: b.readUInt16LE(14) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || fmt.sampleRate < 8000 || fmt.sampleRate > 96000) return null;
      const dataOffset = off + 8;
      const bytes = Math.min(size, Math.max(0, fileSize - dataOffset));
      return { sampleRate: fmt.sampleRate, dataOffset, samples: Math.floor(bytes / 2) };
    }
    off += 8 + size + (size & 1);
  }
  return null;
}

/** 16-bit PCM 单声道 WAV 头(44 字节)。 */
export function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(dataBytes, 40);
  return h;
}

async function readSamples(fh: FileHandle, layout: WavLayout, from: number, to: number): Promise<Buffer> {
  const buf = Buffer.alloc((to - from) * 2);
  let done = 0;
  while (done < buf.length) {
    const { bytesRead } = await fh.read(buf, done, buf.length - done, layout.dataOffset + from * 2 + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  return done === buf.length ? buf : buf.subarray(0, done - (done & 1));
}

/** 一窗样本里切点:在 [lo, hi) 里找能量最小的 20 ms 帧,切在它的中间。返回相对窗起点的样本序号。 */
function quietestCut(pcm: Buffer, lo: number, hi: number, frame: number): number {
  let best = hi, bestEnergy = Infinity;
  for (let f = lo; f + frame <= hi; f += frame) {
    let e = 0;
    for (let i = f; i < f + frame; i++) { const v = pcm.readInt16LE(i * 2); e += v * v; }
    if (e < bestEnergy) { bestEnergy = e; best = f + (frame >> 1); }
  }
  return best;
}

/** 切点规划:每段 ≤ maxSec,切在每窗后三分之一里最安静的地方。只读窗,不留样本。 */
export async function planChunks(fh: FileHandle, layout: WavLayout, maxSec = CLOUD_CHUNK_SEC): Promise<Array<{ from: number; to: number }>> {
  const max = Math.max(1, Math.round(maxSec * layout.sampleRate));
  const frame = Math.max(1, Math.round(layout.sampleRate * 0.02));
  const out: Array<{ from: number; to: number }> = [];
  let start = 0;
  while (layout.samples - start > max) {
    const pcm = await readSamples(fh, layout, start, start + max);
    const have = pcm.length / 2;
    if (have < max) break; // 文件比头里写的短:剩下的当最后一段
    const cut = quietestCut(pcm, Math.floor((max * 2) / 3), max, frame);
    out.push({ from: start, to: start + cut });
    start += cut;
  }
  if (layout.samples > start) out.push({ from: start, to: layout.samples });
  return out;
}

function abortError(): Error {
  const e = new Error('The transcription was stopped');
  e.name = 'AbortError';
  return e;
}

/**
 * 转写一个本机 16-bit PCM 单声道 WAV:按段送(短于一段的整段送),别的格式报错。
 * timestamps:每段一条 {start,end,text}(段的真实起止)。
 */
export async function transcribeFileViaCloud(
  file: string,
  opts: { timestamps?: boolean; signal?: AbortSignal; maxSec?: number; concurrency?: number; maxAudioSec?: number },
  send: SendAudio,
): Promise<CloudTranscript> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${file} is not a file`);
  if (!info.size) throw new Error('The audio file is empty');
  const fh = await open(file, 'r');
  try {
    const layout = await monoPcm16Layout(fh, info.size);
    if (!layout) {
      throw new Error('Cloud transcription takes 16-bit PCM mono WAV only. Convert the file first, e.g. ffmpeg -i <input> -ac 1 -ar 16000 -c:a pcm_s16le <output>.wav');
    }
    const seconds = layout.samples / layout.sampleRate;
    const cap = opts.maxAudioSec ?? CLOUD_MAX_AUDIO_SEC;
    if (seconds > cap) throw new Error(`The audio is ${Math.round(seconds / 60)} minutes long; cloud transcription takes at most ${Math.round(cap / 60)} minutes per call.`);
    if (!layout.samples) throw new Error('The audio file has no samples');
    const chunks = await planChunks(fh, layout, opts.maxSec ?? CLOUD_CHUNK_SEC);
    const results: string[] = new Array(chunks.length);
    // 一段失败就叫停:不再派发,在途的段一起取消(它们的结果反正用不上)
    const stop = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
    let next = 0;
    let failed = null as Error | null;
    const worker = async (): Promise<void> => {
      while (next < chunks.length && !failed) {
        if (opts.signal?.aborted) throw abortError();
        const i = next++;
        const c = chunks[i];
        const pcm = await readSamples(fh, layout, c.from, c.to);
        if (failed) return; // 读的时候别的段失败了
        try {
          results[i] = (await sendOne(send, Buffer.concat([wavHeader(pcm.length, layout.sampleRate), pcm]), 'audio/wav', signal)).trim();
        } catch (e) {
          if (opts.signal?.aborted) throw abortError();
          if (failed) return; // 是被别的段的失败叫停的
          failed = new Error(chunks.length > 1
            ? `chunk ${i + 1}/${chunks.length} (${(c.from / layout.sampleRate).toFixed(0)}s–${(c.to / layout.sampleRate).toFixed(0)}s) failed: ${(e as Error)?.message || e}`
            : String((e as Error)?.message || e));
          stop.abort();
          throw failed;
        }
      }
    };
    const workers = Array.from({ length: Math.min(opts.concurrency ?? CLOUD_CHUNK_CONCURRENCY, chunks.length) }, worker);
    const settled = await Promise.allSettled(workers);
    if (opts.signal?.aborted) throw abortError();
    if (failed) throw failed;
    const rejected = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (rejected) throw rejected.reason;
    const text = results.filter(Boolean).join('\n');
    if (!opts.timestamps) return { text };
    const segments = chunks
      .map((c, i) => ({ start: c.from / layout.sampleRate, end: c.to / layout.sampleRate, text: results[i] }))
      .filter((s) => s.text);
    return { text, ...(segments.length ? { segments } : {}) };
  } finally {
    await fh.close().catch(() => {});
  }
}

async function sendOne(send: SendAudio, audio: Buffer, mime: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError();
  try {
    return await send(audio, mime, signal);
  } catch (e) {
    if (isNoSpeechError(String((e as Error)?.message || e))) return '';
    throw e;
  }
}
