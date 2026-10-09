/**
 * mobile 浏览器台架(*.e2e.cjs)共用的「起 vite preview」。
 *
 * 原先每个脚本各写死一个端口、`--strictPort` 起预览,然后只探「端口上有没有人答 200」。同机另一个检出的预览
 * 占着这个端口时:自己的预览起不来,探测却照样通,脚本接着跑 —— 测到的是**别人的 dist**,假红假绿都出过
 * (2026-10-09 两个会话互相撞上;units-runon 更早为同一件事改成了系统分配端口)。这里一处收口:
 *  · 端口缺省由系统分配,并发跑同一台架互不相干;要固定(比如想自己开浏览器看)就 `E2E_PORT=<端口>`。
 *  · 「起来了」= **自己起的这个进程**报了在听这个端口,并且端口上答的是**本检出**的 dist/index.html ——
 *    不是「有人答 200」。
 *  · 自己的预览退出了(端口被占)当场报错,不接别人的服务。
 */
const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')

const freePort = () => new Promise((res, rej) => {
  const srv = net.createServer()
  srv.once('error', rej)
  srv.listen(0, () => { const { port } = srv.address(); srv.close(() => res(port)) })
})

/** 200 且正文收全 → 正文;其余(连不上 / 超时 / 非 200 / 中途断开)→ null。 */
const fetchText = (url) => new Promise((res) => {
  const req = http.get(url, (r) => {
    let body = ''
    r.setEncoding('utf8')
    r.on('data', (d) => { body += d })
    r.on('end', () => res(r.statusCode === 200 ? body : null))
    r.on('error', () => res(null))
    // 正文没传完连接就断时不出 end,不兜这一下 Promise 永远不结束(收全时 end 在前,已经结算过了)。
    r.on('close', () => res(null))
  })
  req.on('error', () => res(null))
  req.setTimeout(1500, () => { req.destroy(); res(null) })
})

/** 在 root(mobile/,须已 build)起预览。`ready()` 等到本检出的构建在答,起不来就抛;`kill()` 收掉预览。 */
async function startPreview(root) {
  const port = Number(process.env.E2E_PORT) || await freePort()
  const url = `http://localhost:${port}/`
  const index = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')
  console.log(`vite preview → ${url}`)
  // detached + 杀进程组:npx 只是壳,真正听端口的是它 fork 出来的 vite;只 kill npx 会留孤儿占着端口。
  // 输出留着:stdout 用来认「它报了在听」,stderr 起不来时要能说出原因。
  // (前端环境变量约定禁的是 **dev 脚本**带 --port,台架起预览不在其列。)
  const child = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let out = ''
  let err = ''
  let gone = null // 退出后是「code=1」/「signal=SIGTERM」(被信号杀掉时 code 是 null,不能拿它判有没有退)
  child.stdout.on('data', (d) => { out += String(d) })
  child.stderr.on('data', (d) => { err += String(d) })
  child.on('exit', (code, signal) => { gone = signal ? `signal=${signal}` : `code=${code}` })
  const kill = () => { try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill() } catch { /* 已退出 */ } } }
  // vite 把端口号加粗打出来(开着颜色时是 `:<ESC>[1m5173<ESC>[22m/`),先剥掉转义再找。
  const announced = () => out.replace(/\x1b\[[0-9;]*m/g, '').includes(`:${port}/`)
  const ready = async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      // 两样都要:只看正文的话,钉了同一个端口、又恰好是同一份构建的另一个会话会被认成自己(Codex 评审)。
      const mine = announced() && (await fetchText(url)) === index
      if (gone) {
        throw new Error(`vite preview 退出了(${gone}),端口 ${port} 多半被占(别的会话在跑台架?)。看是谁:lsof -iTCP:${port} -sTCP:LISTEN -n -P;`
          + `换端口:E2E_PORT=<端口>,不设则由系统分配\n${err.slice(-800)}`)
      }
      if (mine) return
    }
    throw new Error(`vite preview 没起来(它没报在听 ${port},或 ${url} 上答的不是本检出的 dist/index.html)\n${(err || out).slice(-800) || '(无输出)'}`)
  }
  return { url, kill, ready }
}

module.exports = { startPreview }
