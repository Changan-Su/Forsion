/**
 * 云桥 resolveRef:带 '/' 的引用页相对落空 → 回退按库根解析(镜像桌面 vaultManager.resolveAttachment,2026-10-20)。
 * 起因:网页版独立白板 / db 视图传 pagePath = ref = 完整 vault 相对路径,页相对会双拼目录
 * (`A.fd/B.fd/A.fd/B.fd/画板.excalidraw.md`)→ 子文件夹里的白板 / db 一律「文件缺失」,库根的不受影响。
 * 负对照(实跑过):去掉回退 → 前两条红(status missing)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudAmadeusBridge } from '../../../../web/src/amadeus/cloudBridge'

const DRAW = 'WMOSv11/MOC-Tisy.fd/Prelude v11.10.1.fd/画板 2026-10-15 18.49.46.excalidraw.md'
const DB = 'WMOSv11/sub/Tisyhub.db'
const SCENE = '# Excalidraw Data\n\n## Drawing\n```json\n{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}\n```\n'
const DBFILE = JSON.stringify({ version: 1, columns: [], rows: [] })
const rows = new Map<string, string>()
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  rows.clear()
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
  })
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('location', { origin: 'https://cloud.test', reload: vi.fn() })
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input)
    const end = url.pathname.split('/').pop()
    if (end === 'vaults') return json(200, { vaults: [{ id: 'v1' }] })
    if (end === 'tree') {
      const entries = [...rows.keys()].map((path) => ({ path, kind: 'page', seq: 1 }))
      return json(200, { pages: [], files: entries.map((e) => ({ path: e.path, size: 0 })), folders: [], entries, seq: 1 })
    }
    if (end === 'file') {
      const p = url.searchParams.get('path') ?? ''
      const body = rows.get(p)
      return body === undefined ? json(404, { detail: 'not found' }) : json(200, { path: p, content: body, seq: 1 })
    }
    return json(404, { detail: `unhandled ${url.pathname}` })
  }))
})

const bridge = () => createCloudAmadeusBridge({ apiBase: 'https://cloud.test/api', getToken: () => 'h.e30.s', onAuthError: vi.fn() })

describe('resolveRef 库根回退', () => {
  it('独立白板:子文件夹里的画板读得到,path 是原路径', async () => {
    rows.set(DRAW, SCENE)
    const r = await bridge().readDrawing(DRAW, DRAW)
    expect(r).toMatchObject({ status: 'ok', path: DRAW })
  })

  it('独立 db:子文件夹里的 .db 读得到', async () => {
    rows.set(DB, DBFILE)
    const r = await bridge().readDatabase(DB, DB)
    expect(r).toMatchObject({ path: DB })
    expect(r.status).not.toBe('missing')
  })

  it('页相对引用照旧优先:两处都有同名文件时取页目录下那份', async () => {
    rows.set('notes/sub/b.excalidraw.md', SCENE)
    rows.set('sub/b.excalidraw.md', SCENE)
    const r = await bridge().readDrawing('notes/page.md', 'sub/b.excalidraw.md')
    expect(r).toMatchObject({ status: 'ok', path: 'notes/sub/b.excalidraw.md' })
  })
})
