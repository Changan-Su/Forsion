/** Disposable device-local cache. Original cover URLs stay in frontmatter for sync/share/export. */
const DB_NAME = 'forsion-cover-images'
const STORE = 'images'
const MAX_BYTES = 64 * 1024 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_ENTRIES = 96
type Entry = { url: string; blob: Blob; used: number }
type Loaded = { blob: Blob; persisted: boolean }
type Job = { promise: Promise<Loaded>; controller: AbortController; consumers: number; done: boolean }
const pending = new Map<string, Job>()
const waiting = new Set<() => void>()
let downloading = 0

function acquire(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => { waiting.delete(start); reject(signal.reason) }
    const start = (): void => {
      waiting.delete(start)
      signal.removeEventListener('abort', cancel)
      if (signal.aborted) { reject(signal.reason); return }
      downloading++
      resolve()
    }
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener('abort', cancel, { once: true })
    if (downloading < 4) start()
    else waiting.add(start)
  })
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'url' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('Cover cache blocked'))
  })
}

async function cached(url: string): Promise<Blob | null> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      const req = store.get(url)
      let blob: Blob | null = null
      req.onsuccess = () => {
        const entry = req.result as Entry | undefined
        if (entry?.blob instanceof Blob && entry.blob.size > 0) {
          blob = entry.blob
        }
      }
      tx.oncomplete = () => resolve(blob)
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Cover cache unavailable'))
    })
  } finally { db.close() }
}

async function persist(url: string, blob: Blob, signal: AbortSignal): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const cancel = (): void => tx.abort()
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) { signal.removeEventListener('abort', cancel); tx.abort(); reject(signal.reason); return }
      const store = tx.objectStore(STORE)
      const req = store.getAll()
      req.onsuccess = () => {
        const entries = (req.result as Entry[]).filter((entry) => entry.url !== url).sort((a, b) => a.used - b.used)
        let bytes = entries.reduce((total, entry) => total + entry.blob.size, blob.size)
        while (entries.length >= MAX_ENTRIES || bytes > MAX_BYTES) {
          const oldest = entries.shift()
          if (!oldest) break
          bytes -= oldest.blob.size
          store.delete(oldest.url)
        }
        store.put({ url, blob, used: Date.now() } satisfies Entry)
      }
      tx.oncomplete = () => { signal.removeEventListener('abort', cancel); resolve() }
      tx.onerror = tx.onabort = () => { signal.removeEventListener('abort', cancel); reject(tx.error || new Error('Cover cache write failed')) }
    })
  } finally { db.close() }
}

/** Fetch stays in the renderer: normal CORS/CSP rules apply, no privileged URL proxy. */
async function download(url: string, signal: AbortSignal): Promise<Blob> {
  await acquire(signal)
  const controller = new AbortController()
  const cancel = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const timer = setTimeout(() => controller.abort(new Error('Cover image timed out')), 12_000)
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
    const type = response.headers.get('content-type')?.split(';')[0] || ''
    if (!response.ok || !type.startsWith('image/') || !response.body) {
      void response.body?.cancel().catch(() => {})
      throw new Error('Cover image unavailable')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_IMAGE_BYTES) throw new Error('Cover image too large')
        chunks.push(value as Uint8Array<ArrayBuffer>)
      }
    } finally { void reader.cancel().catch(() => {}) }
    const blob = new Blob(chunks, { type })
    // Do not persist HTML masquerading as an image, or a truncated/undecodable response.
    const src = URL.createObjectURL(blob)
    const image = new Image()
    const stopDecode = (): void => { image.src = '' }
    controller.signal.addEventListener('abort', stopDecode, { once: true })
    try {
      controller.signal.throwIfAborted()
      image.src = src
      await image.decode()
      controller.signal.throwIfAborted()
    } finally { controller.signal.removeEventListener('abort', stopDecode); image.src = ''; URL.revokeObjectURL(src) }
    return blob
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    downloading--
    waiting.values().next().value?.()
  }
}

export function loadCoverImage(url: string, refresh = false, signal?: AbortSignal): Promise<Loaded> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  let job = pending.get(url)
  if (!job) {
    const controller = new AbortController()
    const created: Job = { controller, consumers: 0, done: false, promise: null! }
    created.promise = (async (): Promise<Loaded> => {
      const blob = refresh ? null : await cached(url).catch(() => null)
      controller.signal.throwIfAborted()
      if (blob) return { blob, persisted: true }
      const fresh = await download(url, controller.signal)
      controller.signal.throwIfAborted()
      const persisted = await persist(url, fresh, controller.signal).then(() => true, () => false)
      controller.signal.throwIfAborted()
      return { blob: fresh, persisted }
    })().finally(() => {
      created.done = true
      if (pending.get(url) === created) pending.delete(url)
    })
    pending.set(url, created)
    job = created
  }
  const shared = job
  shared.consumers++
  return new Promise((resolve, reject) => {
    let finished = false
    const release = (): void => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', cancel)
      if (--shared.consumers === 0 && !shared.done) {
        if (pending.get(url) === shared) pending.delete(url)
        shared.controller.abort()
      }
    }
    const cancel = (): void => { release(); reject(signal?.reason) }
    signal?.addEventListener('abort', cancel, { once: true })
    shared.promise.then((result) => { if (!finished) { release(); resolve(result) } }, (error) => { if (!finished) { release(); reject(error) } })
  })
}
