import { Duplex, type DuplexOptions } from 'node:stream'
import type { MessagePort } from 'node:worker_threads'
import type { SocketMetadata } from './backendTypes'

type Packet =
  | { type: 'data'; bytes: Uint8Array }
  | { type: 'ack' }
  | { type: 'end' }
  | { type: 'close' }

/** A bounded byte pipe, with acknowledgements tied to the receiving stream's demand. */
export class PortDuplex extends Duplex {
  readonly connecting = false
  readonly pending = false
  readonly remoteAddress?: string
  readonly remotePort?: number
  readonly remoteFamily?: string
  readonly localAddress?: string
  readonly localPort?: number
  readonly encrypted?: boolean
  private readBytes = 0
  private writtenBytes = 0
  private pendingWrite?: { bytes: number; done: (error?: Error | null) => void }
  private awaitingRead = false
  private receivedEnd = false
  private timeoutMs = 0
  private timeoutTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly port: MessagePort, metadata: SocketMetadata = {}, options: DuplexOptions = {}) {
    super({ allowHalfOpen: true, ...options })
    Object.assign(this, metadata)
    // HTTP attaches its own error listener. This also covers a port closing before
    // the HTTP parser has had a chance to attach to a newly transferred connection.
    this.on('error', () => {})
    port.on('message', (packet: Packet) => {
      if (this.destroyed) return
      this.touch()
      if (packet.type === 'data') {
        this.readBytes += packet.bytes.byteLength
        if (this.push(Buffer.from(packet.bytes))) this.send({ type: 'ack' })
        else this.awaitingRead = true
      } else if (packet.type === 'ack') {
        const pending = this.pendingWrite
        this.pendingWrite = undefined
        if (pending) {
          this.writtenBytes += pending.bytes
          pending.done()
        }
      } else if (packet.type === 'end') {
        this.receivedEnd = true
        this.push(null)
      } else if (packet.type === 'close') {
        this.destroy()
      }
    })
    port.on('messageerror', () => this.destroy(new Error('Invalid backend connection message')))
    port.on('close', () => {
      if (!this.destroyed) this.destroy(this.receivedEnd ? undefined : new Error('Backend connection closed'))
    })
  }

  private send(packet: Packet): void {
    try { this.port.postMessage(packet) }
    catch { this.destroy(new Error('Backend connection unavailable')) }
  }

  private touch(): void {
    if (!this.timeoutMs) return
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    this.timeoutTimer = setTimeout(() => this.emit('timeout'), this.timeoutMs)
    this.timeoutTimer.unref()
  }

  override _read(): void {
    if (this.awaitingRead) {
      this.awaitingRead = false
      this.send({ type: 'ack' })
    }
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.touch()
    // Do not transfer chunk.buffer: pooled Buffers can share it with unrelated data.
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
    this.pendingWrite = { bytes: bytes.byteLength, done: callback }
    this.send({ type: 'data', bytes })
  }

  // Node's HTTP diagnostics read these on the socket passed to the worker server.
  get bytesRead(): number { return this.readBytes }
  get bytesWritten(): number { return this.writtenBytes }

  override _final(callback: (error?: Error | null) => void): void {
    this.send({ type: 'end' })
    callback()
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    const pending = this.pendingWrite
    this.pendingWrite = undefined
    pending?.done(error ?? new Error('Backend connection closed'))
    try { this.port.postMessage({ type: 'close' } satisfies Packet) } catch { /* peer already gone */ }
    this.port.close()
    callback(error)
  }

  setTimeout(milliseconds: number, callback?: () => void): this {
    if (callback) this.once('timeout', callback)
    this.timeoutMs = milliseconds
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    this.timeoutTimer = undefined
    this.touch()
    return this
  }

  setNoDelay(): this { return this }
  setKeepAlive(): this { return this }
  ref(): this { this.port.ref(); return this }
  unref(): this { this.port.unref(); this.timeoutTimer?.unref(); return this }
  address(): { address: string; family: string; port: number } {
    return { address: this.localAddress ?? '', family: this.remoteFamily ?? 'IPv4', port: this.localPort ?? 0 }
  }
}
