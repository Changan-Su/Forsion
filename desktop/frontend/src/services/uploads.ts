/**
 * 上传台账:界面上每个「正在读 / 正在传」的文件一条。磁贴、正文占位、文件行只读这里,不各自记进度;
 * 画法是 `@lcl/components` 的 UploadRing / UploadBar。方案页:docs/ToBeImproved/附件上传进度方案_2026-10-24/r2.html
 *
 * 一条 = 名字 + 总字节 + 阶段(排队 / 读取 / 上传 / 完成 / 失败)+ 本阶段已处理字节(null = 传输层报不了,环转圈)。
 * 真正干活的是调用方给的 job:它自己读文件、自己上传、自己把结果交给自己的界面;台账只管并发、阶段、取消与重试。
 * 同时最多跑 3 个,其余排队。切页 / 切会话不打断(台账在模块级,不随组件卸载)。
 */
import { create } from 'zustand'

export type UploadPhase = 'queued' | 'reading' | 'uploading' | 'done' | 'failed'

export interface UploadEntry {
  id: string
  name: string
  size: number
  phase: UploadPhase
  /** 本阶段已处理的字节;null = 传输层报不了进度(本机写盘、经中继) */
  sent: number | null
  error?: string
}

export interface UploadJobCtx {
  stage(phase: 'reading' | 'uploading'): void
  progress(sent: number | null): void
  signal: AbortSignal
}
export type UploadJob = (ctx: UploadJobCtx) => Promise<void>

export const useUploads = create<Record<string, UploadEntry>>(() => ({}))

const MAX_PARALLEL = 3
const jobs = new Map<string, { job: UploadJob; ac?: AbortController }>()
const waiting: string[] = []
let running = 0
let seq = 0

const patch = (id: string, p: Partial<UploadEntry>): void => {
  useUploads.setState((all) => (all[id] ? { ...all, [id]: { ...all[id], ...p } } : all), true)
}

function pump(): void {
  while (running < MAX_PARALLEL && waiting.length) {
    const id = waiting.shift()!
    const rec = jobs.get(id)
    if (!rec || !useUploads.getState()[id]) continue
    running++
    const ac = new AbortController()
    rec.ac = ac
    patch(id, { phase: 'reading', sent: 0, error: undefined })
    const ctx: UploadJobCtx = {
      // 新阶段从「报不了」开始:传输层报了第一个进度才有数字(网页版的 fetch 一直报不了 → 一直转圈,不会停在 0%)
      stage: (phase) => { if (!ac.signal.aborted) patch(id, { phase, sent: null }) },
      progress: (sent) => { if (!ac.signal.aborted) patch(id, { sent }) },
      signal: ac.signal,
    }
    void rec.job(ctx)
      .then(() => { if (!ac.signal.aborted) { jobs.delete(id); patch(id, { phase: 'done', sent: useUploads.getState()[id]?.size ?? null }) } }) // 完成的不会重试:放掉 job(它攥着原文件)
      .catch((e: unknown) => { if (!ac.signal.aborted) patch(id, { phase: 'failed', error: e instanceof Error ? e.message : String(e) }) })
      .finally(() => { running--; pump() })
  }
}

/** 登记并排队一个上传;返回它的 id(界面按 id 读状态)。 */
export function startUpload(name: string, size: number, job: UploadJob): string {
  const id = `up${Date.now().toString(36)}${(seq++).toString(36)}`
  jobs.set(id, { job })
  useUploads.setState((all) => ({ ...all, [id]: { id, name, size, phase: 'queued', sent: 0 } }), true)
  waiting.push(id)
  pump()
  return id
}

/** 失败的那条原样再跑一遍(同一个 job,同一个 id)。 */
export function retryUpload(id: string): void {
  const e = useUploads.getState()[id]
  if (!e || e.phase !== 'failed' || !jobs.has(id)) return
  patch(id, { phase: 'queued', sent: 0, error: undefined })
  waiting.push(id)
  pump()
}

/** 取消(在跑的中止请求)并从台账里拿掉。完成了的也可以调,等同 forget。 */
export function cancelUpload(id: string): void {
  jobs.get(id)?.ac?.abort()
  forgetUpload(id)
}

/** 从台账里拿掉(界面不再需要它了)。 */
export function forgetUpload(id: string): void {
  const i = waiting.indexOf(id)
  if (i >= 0) waiting.splice(i, 1)
  jobs.delete(id)
  useUploads.setState((all) => {
    if (!all[id]) return all
    const { [id]: _gone, ...rest } = all
    return rest
  }, true)
}

/** 一批上传都落定(完成;或失败 / 在传的被移除、从台账里拿掉了)时回调一次,给出完成了的那几条 id,随后把它们从台账里拿掉。
 *  给「全部传完再写一次」的调用方:数据库附件格逐个写,会各自读到同一份陈旧的格值,最后只剩一个附件。 */
export function onBatchSettled(ids: string[], cb: (done: string[]) => void): void {
  const check = (): void => {
    const all = useUploads.getState()
    if (ids.some((id) => all[id] && all[id].phase !== 'done')) return
    unsub()
    const done = ids.filter((id) => all[id]?.phase === 'done')
    cb(done)
    done.forEach(forgetUpload)
  }
  const unsub = useUploads.subscribe(check)
  check()
}

/** 界面没了(格子卸载、正文占位随换页被拆):这几条以后失败就直接放弃 —— 没人点得到「重试 / 移除」了,
 *  别让同一批里传成功的一直等着它(onBatchSettled 等的就是它们落定)。 */
export function abandonFailures(ids: string[]): void {
  const check = (): void => {
    const all = useUploads.getState()
    const live = ids.filter((id) => all[id])
    for (const id of live) if (all[id].phase === 'failed') forgetUpload(id)
    if (!live.some((id) => uploadBusy(all[id]))) unsub()
  }
  const unsub = useUploads.subscribe(check)
  check()
}

let saveChain: Promise<unknown> = Promise.resolve()
/** 一次只让一个落盘调用在跑(Amadeus 的附件 / 资源)。宿主的「挑一个不撞名的文件名」是先查后写:两个同名文件并发落盘会
 *  挑中同一个名字、后写的盖掉先写的(此前是逐个 await,天然串行)。读文件、排队照旧并发,只有这一步排队。 */
export function oneSaveAtATime<T>(save: () => Promise<T>): Promise<T> {
  const run = saveChain.then(save, save)
  saveChain = run.catch(() => {})
  return run
}

/** 还在路上(排队 / 读取 / 上传)。 */
export const uploadBusy = (e: UploadEntry | undefined): boolean => !!e && (e.phase === 'queued' || e.phase === 'reading' || e.phase === 'uploading')

/** 环 / 细条要的 0..1;null = 转圈。 */
export function uploadFraction(e: UploadEntry | undefined): number | null {
  if (!e) return null
  if (e.phase === 'done') return 1
  if (e.phase === 'queued') return 0
  return e.sent == null || !e.size ? null : Math.min(1, e.sent / e.size)
}

/** 「11.6 / 18.2 MB」:按总大小选单位,两边同一个单位。 */
export function uploadBytesLabel(e: UploadEntry): string {
  const unit = e.size >= 1024 * 1024 ? [1024 * 1024, 'MB'] as const : [1024, 'KB'] as const
  const f = (n: number): string => (n / unit[0]).toFixed(1)
  return e.sent == null ? `${f(e.size)} ${unit[1]}` : `${f(e.sent)} / ${f(e.size)} ${unit[1]}`
}

/** 读成 base64(不带 data: 前缀)。用 FileReader:异步、不卡主线程(手拼 String.fromCharCode 的循环读 25 MB 会把界面冻住,
 *  占位磁贴都画不出来),顺带有读取进度。 */
export function readAsBase64(file: Blob, onProgress?: (read: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onprogress = (e) => onProgress?.(e.loaded)
    r.onload = () => {
      const s = String(r.result || '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error || new Error('read failed'))
    r.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', () => r.abort(), { once: true })
    r.readAsDataURL(file)
  })
}
