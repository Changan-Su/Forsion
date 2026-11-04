/** pako 1.x(jszip 带进来的那份;coreUpdates.ts 只用流式 Inflate 来封顶解 npm tarball 的 gzip)。 */
declare module 'pako' {
  export class Inflate {
    err: number
    msg: string
    onData: (chunk: Uint8Array) => void
    push(data: Uint8Array, mode?: boolean): boolean
  }
  const pako: { Inflate: typeof Inflate }
  export default pako
}
