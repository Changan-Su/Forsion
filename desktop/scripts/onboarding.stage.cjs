/**
 * 把首次引导摆出来给人看 / 给 Codex 用 computer use 走一遍:真 Electron(out/ 里的构建)+ 临时家目录 + 桩模型目录,
 * 普通窗口(会到前台,不是台架的静默窗),停在引导第一屏。Ctrl-C 结束并清掉临时目录。
 * 电脑历史连的是真主进程:PI_CU_SOCKET_PATH 指到不存在的 socket,不会拉起本机真的 Computer Use 助手,开了也只落「连不上」。
 * ⚠️ 权限卡上的「安装并设置权限 / 打开系统设置」是真的会动这台电脑的,摆出来看的时候别点。
 * 用法:npm run build && npm run stage:first-run [-- --lang=en]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { MAC_FLAGS, workspaceEnv } = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const argv = process.argv.slice(2)
const lang = (argv.find((a) => a.startsWith('--lang=')) || '--lang=zh-CN').split('=')[1]

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-onboarding-stage-'))
  const config = { historian: { enabled: true }, muse: { enabled: true } }
  const stub = await startStubEngine({
    models: ['GPT-5.4', 'Claude Sonnet 4.6', 'Gemini 3.1 Pro', 'Qwen 3.5'].map((name, i) => ({ id: `cloud-${i}`, name, provider: 'Forsion', source: 'forsion', modelType: 'llm' })),
    override: async ({ path: p, method, body }) => {
      if (p !== '/agent/special/config') return undefined
      if (method === 'POST') { const patch = await body(); Object.assign(config.historian, patch.historian); Object.assign(config.muse, patch.muse) }
      return { config }
    },
  })
  const userData = path.join(home, 'userdata')
  const child = spawn(require('electron'), [`--user-data-dir=${userData}`, `--lang=${lang}`, ROOT, ...MAC_FLAGS], {
    cwd: ROOT, stdio: 'inherit',
    env: workspaceEnv({ ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_CLOUD_URL: stub.url,
      PI_CU_SOCKET_PATH: path.join(home, 'no-helper.sock'), TANGU_HARNESS_QUIET: '0' }),
  })
  console.log(`STAGE first-run: pid ${child.pid}, home ${home}`)
  const stop = () => { child.kill() }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  child.on('exit', async () => { await stub.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(`${home}-workspace`, { recursive: true, force: true }); process.exit(0) })
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
