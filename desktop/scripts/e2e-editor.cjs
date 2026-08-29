// 一键跑编辑器触发层 e2e:自起 vite(frontend web 模式)→ 等 harness 就绪 → 跑断言 → 收尾。
// 5173 已有人服务 harness 时直接复用(不杀别人的进程)。用法:npm run e2e:editor
//
// ⚠️ **跑的时候别让别人写 frontend/src** —— vite 在 dev 模式watch 整棵源码树,任何一次写盘都会
//    HMR 重载 harness 页;正跑到一半的用例于是查不到块,报出来是 `kind=undefined` 那种「块凭空没了」,
//    **是假红**。2026-07-30 踩过:并行会话在改 AmadeusDashboardView.tsx,T7 连红两次,
//    隔离出来单跑(git worktree 镜像同一份源码 + HARNESS_URL 指到另一个端口)连过五次。
//    怀疑某处改动导致红时,先照这个法子隔离,别先动代码。
// `--check=<名>` 换跑同目录下的 <名>.check.cjs(共用这套起停;如 npm run check:br)。
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

const URL = 'http://localhost:5173/harness.html'

function ping() {
  return new Promise((res) => {
    const req = http.get(URL, (r) => {
      res(r.statusCode === 200)
      r.resume()
    })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => {
      req.destroy()
      res(false)
    })
  })
}

async function main() {
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'ignore',
    })
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) {
      console.error('vite 没起来(5173 被非 harness 进程占用,或 frontend/vite.config.ts 有问题)')
      vite.kill()
      process.exit(1)
    }
  }
  // --check=<名> → <名>.check.cjs;--script=<文件名> → 直接跑同目录下那个脚本
  // (e2e 类脚本文件名是 *.e2e.cjs,套不进 --check 的命名约定)。
  const only = (process.argv.find((a) => a.startsWith('--check=')) || '').slice('--check='.length)
  const named = (process.argv.find((a) => a.startsWith('--script=')) || '').slice('--script='.length)
  const script = named || (only ? `${only}.check.cjs` : 'editor-triggers.e2e.cjs')
  // 自己不认的参数原样转给子脚本(如 --shot[=目录];别在这儿列白名单,否则每加一个都要改两处)。
  const passthrough = process.argv.slice(2).filter((a) => !a.startsWith('--check=') && !a.startsWith('--script='))
  const e2e = spawn('node', [path.join(__dirname, script), ...passthrough], { stdio: 'inherit' })
  e2e.on('exit', (code) => {
    if (vite) vite.kill()
    process.exit(code ?? 1)
  })
}

main()
