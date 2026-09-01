/**
 * 本地 ASR 模型下载的**候选主机回退**单测(中国大陆直连 huggingface.co 被拦 → 必须自动落到 hf-mirror)。
 * 只测 downloadFromHosts:不碰 230MB 大小校验(verify 注入)、不碰 electron(mock)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { mkdtempSync, readFileSync, existsSync, readdirSync, closeSync, openSync, ftruncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { isPackaged: false } })) // macQuarantine 在模块加载期只用它判是否自愈

// 超时旋钮压到毫秒级(模块加载期读一次,必须早于下面的 import)——否则这套测试要跑 15s
process.env.FORSION_ASR_CONNECT_TIMEOUT_MS = '400'
process.env.FORSION_ASR_STALL_TIMEOUT_MS = '400'

const { downloadFromHosts } = await import('./asrLocal')

const HF = 'https://huggingface.co'
const MIRROR = 'https://hf-mirror.com'
const realFetch = global.fetch

/** 按主机可达性造 fetch:命中 ok 列表的主机返回内容,其余抛 undici 那种 `fetch failed`。 */
function stubFetch(reachable: string[]): { urls: string[] } {
  const urls: string[] = []
  global.fetch = vi.fn(async (input: any) => {
    const url = String(input)
    urls.push(url)
    if (!reachable.some((h) => url.startsWith(h))) throw new TypeError('fetch failed')
    return new Response(Buffer.from(`payload of ${url.split('/').pop()}`))
  }) as never
  return { urls }
}

/** 响应头已到、body 读到一半断掉(中国大陆的典型形态:不是连不上,是连接被重置)。 */
function brokenBody(): Response {
  return new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(16)); c.error(new Error('connection reset')) },
  }))
}

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asrdl-')) })
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

describe('downloadFromHosts 候选主机回退', () => {
  it('首选主机不可达 → 自动落到第二个,文件照样落盘', async () => {
    const { urls } = stubFetch([MIRROR])
    await downloadFromHosts([HF, MIRROR], dir, () => {}, () => true)
    expect(urls[0].startsWith(HF)).toBe(true) // 先试直连
    expect(urls.some((u) => u.startsWith(MIRROR))).toBe(true) // 失败后确实换了镜像
    expect(readFileSync(join(dir, 'model.int8.onnx'), 'utf8')).toContain('model.int8.onnx')
    expect(existsSync(join(dir, 'tokens.txt'))).toBe(true)
  })

  it('mirror=china 的顺序:先镜像,且直连从未被请求', async () => {
    const { urls } = stubFetch([MIRROR])
    await downloadFromHosts([MIRROR, HF], dir, () => {}, () => true)
    expect(urls[0].startsWith(MIRROR)).toBe(true)
    expect(urls.some((u) => u.startsWith(HF))).toBe(false)
  })

  it('全部不可达 → 报错一次列出两个主机(用户能看懂,不是裸 TypeError)', async () => {
    stubFetch([])
    await expect(downloadFromHosts([HF, MIRROR], dir, () => {}, () => true)).rejects.toThrow(/huggingface\.co.*hf-mirror\.com/s)
  })

  it('首选主机中途断流(响应头已到) → 照样回退到镜像并拿到完整文件', async () => {
    global.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.startsWith(HF)) return brokenBody()
      return new Response(Buffer.from(`payload of ${url.split('/').pop()}`))
    }) as never
    await downloadFromHosts([HF, MIRROR], dir, () => {}, () => true)
    expect(readFileSync(join(dir, 'model.int8.onnx'), 'utf8')).toContain('model.int8.onnx')
  })

  it('全主机都中途断流 → 不留 .part 半截(留下会攒垃圾,且下次续下逻辑会撞上)', async () => {
    global.fetch = vi.fn(async () => brokenBody()) as never
    await expect(downloadFromHosts([HF, MIRROR], dir, () => {}, () => true)).rejects.toThrow()
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('校验不过(半截模型)也算该主机失败 → 继续试下一个', async () => {
    const { urls } = stubFetch([HF, MIRROR])
    let calls = 0
    await downloadFromHosts([HF, MIRROR], dir, () => {}, () => ++calls > 1) // 第一次校验失败
    expect(urls.some((u) => u.startsWith(MIRROR))).toBe(true)
  })

  it('大模型已下全 → 只补 tokens.txt,不重下 230MB', async () => {
    const fd = openSync(join(dir, 'model.int8.onnx'), 'w') // 稀疏文件:size 够大但不真占盘
    ftruncateSync(fd, 120_000_000)
    closeSync(fd)
    const { urls } = stubFetch([HF])
    await downloadFromHosts([HF], dir, () => {}, () => true)
    expect(urls).toEqual([expect.stringContaining('tokens.txt')])
  })

  it('进度回调累计字节', async () => {
    stubFetch([HF])
    const seen: number[] = []
    await downloadFromHosts([HF], dir, (r) => seen.push(r), () => true)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBeGreaterThan(0)
    expect(seen).toEqual([...seen].sort((a, b) => a - b)) // 单调不减
  })

  // 真网络的一条:黑洞主机=收下连接但永不回响应头,正是被墙时的形态(不是拒绝,是挂起)。
  // 没有连接超时,这里会永远卡住,回退代码一辈子跑不到——所以这条比前面所有 stub 都更贴近现场。
  it('黑洞主机挂起 → 连接超时后 abort 并回退到下一个', async () => {
    const hole = netServer(() => {})
    await new Promise<void>((r) => hole.listen(0, '127.0.0.1', () => r()))
    const ok = createServer((_q, res) => { res.writeHead(200); res.end('ok-body') })
    await new Promise<void>((r) => ok.listen(0, '127.0.0.1', () => r()))
    global.fetch = realFetch
    try {
      await downloadFromHosts(
        [`http://127.0.0.1:${(hole.address() as any).port}`, `http://127.0.0.1:${(ok.address() as any).port}`],
        dir, () => {}, () => true,
      )
      expect(readFileSync(join(dir, 'tokens.txt'), 'utf8')).toBe('ok-body')
      expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
    } finally { hole.close(); ok.close() }
  }, 20_000)
})
