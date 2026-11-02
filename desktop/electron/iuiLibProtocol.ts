// Intelligent UI HTML 卡的随包库:forsion-iui://lib/three@0.186/three.module.js → <renderer>/iui-lib/three@0.186/three.module.js
// 文件由 build/copy-iui-libs.cjs 生成进 renderer 的 publicDir(打包后在 asar 的 out/renderer 里,dev 下还在 frontend/public)。
// 只读、夹在那个目录里、只认 .js。卡是无源沙箱 iframe,module 脚本按 CORS 取:scheme 带 corsEnabled(注册在
// amadeus/assetProtocol.ts),每个响应都放行任意源。目录只带大版本、小版本原地替换,所以不写 immutable。
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { app, protocol } from 'electron'

const HEADERS = { 'Content-Type': 'text/javascript; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }

export function registerIuiLibProtocol(): void {
  const root = [path.join(__dirname, '../renderer/iui-lib'), path.join(app.getAppPath(), 'frontend/public/iui-lib')].find((p) => existsSync(p))
  // 目录不在 = 卡里那块 3D / 图表静默空白;至少在主进程日志里留一句
  if (!root) console.warn('[iui-lib] bundled card libraries not found; run `node build/copy-iui-libs.cjs`')
  protocol.handle('forsion-iui', async (request) => {
    let rel: string
    try { rel = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, '')) } catch { return new Response('bad url', { status: 400 }) }
    const abs = root && path.resolve(root, rel)
    const r = abs ? path.relative(root, abs) : '..'
    if (!rel.endsWith('.js') || r.startsWith('..') || path.isAbsolute(r)) return new Response('forbidden', { status: 403, headers: { 'Access-Control-Allow-Origin': '*' } })
    try { return new Response(await fs.readFile(abs as string), { headers: HEADERS }) } catch { return new Response('not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } }) }
  })
}
