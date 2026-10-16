/**
 * 把日历 Space 摆出来给人看 / 给 Codex 用 computer use 走一遍体验:真 Electron(out/ 里的构建)+ 临时家目录 + 桩引擎 +
 * 一个预置好的笔记库(本周的事件表、带勾选列的待办表、一篇带 `@` 时间任务的笔记)。普通窗口(会到前台)。
 * 第一屏可能是首次引导:点「跳过引导」,再点左侧图标栏的「日历」。Ctrl-C(或 SIGTERM)结束并清掉临时目录。
 * 用法:npm run build && npm run stage:calendar [-- --lang=en]
 * 给 computer use 用时同 onboarding.stage.cjs:先把 Electron.app 拷到独有路径、改 bundle id(gui-verify §4.2),
 * 再用 FORSION_STAGE_ELECTRON=<那份拷贝>/Contents/MacOS/Electron 起,测试单里写那个 bundle id。
 * STAGE_READY_FILE=<路径>:窗口起来后往里写一行 pid,外层脚本据此开始下一步。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { MAC_FLAGS, workspaceEnv } = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const lang = (process.argv.slice(2).find((a) => a.startsWith('--lang=')) || '--lang=zh-CN').split('=')[1]
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const db = (name, columns, rows) => JSON.stringify({ version: 1, name, columns, rows }, null, 2)

function seedVault(vault) {
  const t = new Date()
  const mon = addDays(t, -((t.getDay() + 6) % 7))
  const D = (i) => ymd(addDays(mon, i))
  const events = [
    ['e1', '产品深度工作', `${D(0)}T09:00/${D(0)}T10:30`], ['e2', '设计评审', `${D(1)}T10:00/${D(1)}T11:30`],
    ['e3', '晨会', `${D(1)}T09:00/${D(1)}T09:15`], ['e4', '团队午餐', `${D(2)}T12:00/${D(2)}T13:00`],
    ['e5', '看房', `${D(3)}T15:00/${D(3)}T16:30`], ['e6', '路线图工作坊', `${D(3)}/${D(4)}`],
    ['e7', '周度复盘', `${D(4)}T14:00/${D(4)}T15:00`], ['e8', '版本发布', D(4)], ['e9', '牙医复诊', `${D(5)}T10:00/${D(5)}T10:45`],
  ].map(([id, name, date]) => ({ id, cells: { name, date } }))
  fs.writeFileSync(path.join(vault, '工作日历.db'), db('工作日历', [
    { id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' },
  ], events))
  const todos = [
    ['t1', '补交上周总结', ymd(addDays(t, -2))], ['t2', '回复设计稿反馈', ymd(t)], ['t3', '订会议室', `${ymd(addDays(t, 1))}T16:00`],
    ['t4', '买牛奶', ''], ['t5', '整理报销单', ''], ['t6', '给房东打电话', ymd(addDays(t, 2))],
  ].map(([id, name, date]) => ({ id, cells: { name, ...(date ? { date } : {}) } }))
  fs.writeFileSync(path.join(vault, '待办.db'), db('待办', [
    { id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' },
  ], todos))
  fs.writeFileSync(path.join(vault, '周计划.md'), `# 周计划\n\n## 这周要做\n\n- [ ] 准备季度汇报材料 @${ymd(addDays(t, 1))}T10:00\n- [ ] 读完《设计心理学》第三章 @${ymd(addDays(t, 3))}\n`)
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-calendar-stage-'))
  const vault = path.join(home, 'vault')
  const userData = path.join(home, 'userdata')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(`${userData}-dev`, { recursive: true }) // 未打包构建的 userData 是 <dir>-dev
  seedVault(vault)
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const stub = await startStubEngine({})
  const child = spawn(process.env.FORSION_STAGE_ELECTRON || require('electron'), [`--user-data-dir=${userData}`, `--lang=${lang}`, ROOT, ...MAC_FLAGS], {
    cwd: ROOT, stdio: 'inherit',
    env: workspaceEnv({ ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_CLOUD_URL: stub.url,
      PI_CU_SOCKET_PATH: path.join(home, 'no-helper.sock'), TANGU_HARNESS_QUIET: '0' }),
  })
  console.log(`STAGE calendar: pid ${child.pid}, home ${home}, vault ${vault}`)
  if (process.env.STAGE_READY_FILE) setTimeout(() => fs.writeFileSync(process.env.STAGE_READY_FILE, `${child.pid}\n`), 8000)
  const stop = () => { child.kill() }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  child.on('exit', async () => {
    await stub.close()
    if (!process.env.STAGE_KEEP) { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(`${home}-workspace`, { recursive: true, force: true }) }
    process.exit(0)
  })
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
