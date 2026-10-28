// 项目文件夹搬走后重新指向的界面钉(真 Electron × 假引擎,先 npx electron-vite build):
//   A 不在原处的项目名变淡 + 「文件夹不在原处」小标,别的项目没有;
//   B 项目 ⋯ / 右键菜单第一项「重新指向文件夹…」,其余菜单项照旧;在原处的项目没有这一项;
//   C 对话框:远端对上的同名文件夹预选,列出会一起改的三样;
//   D 重新指向 → 「已经是项目」→ 合并:请求体先 merge:false 再 merge:true,成功后小标消失、会话落到新分组;
//   E 判失效只在挂上和窗口重新获得焦点时问,不轮询;
//   F 库里没存 cwd 的会话(打开时按旧 project_path 补进缓存):重新指向后发一条,run 带的是新目录(Codex 评审)。
// 引擎那半(三处一起改 / 中途失败回滚 / 合并去重 / 外接盘没挂上只标记)在 tangu-agent/src/services/projectRelink.test.ts。
//   node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="重新指向界面钉" --eta=5 -- node scripts/project-relink.check.cjs
// SHOT=<目录> 存三张截图(左栏小标 / 菜单 / 对话框;浅色 110% 缩放,和方案图同口径)。
const fs = require('fs'), path = require('path')
const { launch, boot, sleep, makeReporter } = require('./lib/uiux-electron.cjs')

const OLD = '/Users/demo/Site', NEW = '/Users/demo/Projects/Site', HERE = '/Users/demo/Notes'
const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
const row = (id, title, mins, dir, name) => ({ id, title, summary: '', archived: false, model_id: 'm1', agent_config: { cwd: dir, execMode: 'host' }, project_path: dir, project_name: name, projectless: false, created_at: at(mins + 60), updated_at: at(mins) })
const SESSIONS = [row('rl-1', '首页文案改版', 5, OLD, '官网'), { ...row('rl-2', '下载页加 Windows 包', 9, OLD, '官网'), agent_config: null }, row('rl-3', '整理读书摘录', 20, HERE, '读书笔记')]

async function main() {
  const r = makeReporter()
  const posts = []
  let missingGets = 0
  let merged = false
  const ctx = await launch({
    tag: 'project-relink', fixtures: { agents: [], sessions: SESSIONS },
    stubOverride: async ({ path: p, method, body }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: merged ? SESSIONS.map((s) => (s.project_path === OLD ? { ...s, project_path: NEW, project_name: '官网 2' } : s)) : SESSIONS }
      if (p === '/agent/project-context/missing') { missingGets++; return { missing: merged ? [] : [OLD] } }
      if (p === '/agent/project-context/relink' && method === 'GET') return {
        from: OLD, sessions: 2, memoryEntries: 14, settings: ['defaultAgent', 'approvalMode'], remote: 'https://github.com/demo/site.git',
        candidates: [{ path: NEW, remote: 'https://github.com/demo/site.git', remoteMatch: true, project: null }, { path: '/Users/demo/Documents/Site', remote: null, remoteMatch: false, project: null }],
      }
      if (p === '/agent/project-context/relink' && method === 'POST') {
        const b = await body(); posts.push(b)
        if (!b.merge) return { ok: false, error: 'already_project', path: NEW, name: '官网 2' }
        merged = true
        return { ok: true, path: NEW, name: '官网 2', sessionIds: ['rl-1', 'rl-2'], memory: 'merged', configs: { 'rl-1': { cwd: NEW } } } // rl-2 库里没有 cwd,引擎不回它
      }
      return undefined
    },
  })
  const w = ctx.win
  const SHOT = process.env.SHOT
  const shot = async (name, clip) => { if (!SHOT) return; fs.mkdirSync(SHOT, { recursive: true }); await sleep(300); await w.screenshot({ path: path.join(SHOT, `${name}.png`), ...(clip ? { clip } : {}) }) }
  const group = (key) => w.locator(`.t2s-group[data-workspace-key="${key}"]`).first()
  try {
    await boot(ctx.app, w, { space: 'tangu', width: 1512, height: 950 })
    await w.evaluate(() => { document.documentElement.dataset.mode = 'light'; document.documentElement.classList.remove('dark') })
    await group(OLD).waitFor({ timeout: 30_000 })
    await w.locator(`.t2s-group[data-workspace-key="${OLD}"] .t2s-missing`).waitFor({ timeout: 10_000 }).catch(() => {})

    r.check('A0 启动后不用切窗口就问过一次(挂上那一下配置可能还没读到,会话到了要再问)', missingGets >= 1, `GET missing × ${missingGets}`)
    // A
    const a = await w.evaluate(({ OLD, HERE }) => {
      const g = (k) => document.querySelector(`.t2s-group[data-workspace-key="${k}"]`)
      return {
        badge: g(OLD)?.querySelector('.t2s-missing')?.textContent?.trim() || null,
        dim: !!g(OLD)?.querySelector('.t2s-group-label.t2s-missing-name'),
        opacity: Number(getComputedStyle(g(OLD)?.querySelector('.t2s-group-label') || document.body).opacity),
        color: getComputedStyle(g(OLD)?.querySelector('.t2s-missing') || document.body).color,
        warning: getComputedStyle(document.documentElement).getPropertyValue('--warning').trim(),
        other: !!g(HERE)?.querySelector('.t2s-missing'),
      }
    }, { OLD, HERE })
    r.check('A1 不在原处的项目带「文件夹不在原处」小标', a.badge === '文件夹不在原处', JSON.stringify(a))
    r.check('A2 项目名变淡', !!a.dim && a.opacity < 0.8, `opacity=${a.opacity}`)
    r.check('A3 在原处的项目没有小标', !a.other)
    const side = await w.evaluate(() => { const e = document.querySelector('.t2o-projects') || document.querySelector('.t2s-side'); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: Math.min(b.height, 520) } })
    await shot('relink-sidebar', side)

    // B
    await group(HERE).click({ button: 'right' })
    const hereFirst = (await w.locator('.ctx-menu button').first().textContent().catch(() => ''))?.trim()
    await w.keyboard.press('Escape'); await w.mouse.click(5, 5); await sleep(300)
    r.check('B1 在原处的项目菜单里没有「重新指向文件夹…」', !!hereFirst && hereFirst !== '重新指向文件夹…', hereFirst)
    await group(OLD).click({ button: 'right' })
    const items = (await w.locator('.ctx-menu button').allTextContents()).map((x) => x.trim())
    r.check('B2 不在原处的项目菜单第一项是「重新指向文件夹…」', items[0] === '重新指向文件夹…', items.join(' | '))
    r.check('B3 其余菜单项照旧(查看详情 / 重命名 / 移除)', ['查看详情', '重命名', '移除'].every((x) => items.slice(1).some((i) => i.includes(x))), items.join(' | '))
    await shot('relink-menu', { ...side, width: side.width + 260 })

    // C(先打开一下 rl-2:它的 cwd 是打开时按旧 project_path 补进缓存的,F 要用)
    await w.keyboard.press('Escape'); await w.mouse.click(5, 5); await sleep(200)
    await w.locator('.t2s-srow[data-sel-id="rl-2"]').first().click(); await sleep(1500)
    await group(OLD).click({ button: 'right' })
    await w.locator('.ctx-menu button').first().click()
    await w.locator('.relink-dialog .relink-opt').first().waitFor({ timeout: 10_000 })
    const c = await w.evaluate(() => {
      const d = document.querySelector('.relink-dialog')
      const radios = [...d.querySelectorAll('input[type=radio]')]
      return { text: d.textContent, checked: radios.map((x) => x.checked), submit: !d.querySelector('.relink-foot .btn.primary')?.disabled, h: d.getBoundingClientRect().height }
    })
    r.check('C1 远端对上的同名文件夹预选,别的不选', JSON.stringify(c.checked) === '[true,false,false]', JSON.stringify(c.checked))
    r.check('C2 写清会一起改的三样', ['2 个会话的工作目录', '项目记忆（14 条）', '项目默认项：默认 Agent、审批档'].every((x) => c.text.includes(x)), c.text)
    r.check('C3 写明正文里的旧路径不改', c.text.includes('会话正文里出现过的旧路径不改'))
    r.check('C4 预选后「重新指向」可点', !!c.submit)
    await shot('relink-dialog')

    // D
    await w.locator('.relink-foot .btn.primary').click()
    await w.locator('.relink-conflict').waitFor({ timeout: 10_000 })
    r.check('D1 新位置已是项目:提示「这个文件夹已经是项目「官网 2」」', ((await w.locator('.relink-conflict').textContent()) || '').includes('这个文件夹已经是项目「官网 2」'))
    await shot('relink-conflict')
    await w.locator('.relink-foot .btn.primary').click() // 合并
    await w.locator('.relink-dialog').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
    await group(NEW).waitFor({ timeout: 10_000 }).catch(() => {})
    r.check('D2 请求体:先 merge:false,再 merge:true,带会话 id 与新路径',
      posts.length === 2 && posts[0].merge === false && posts[1].merge === true && posts.every((b) => b.path === NEW && b.sessionId === 'rl-1'), JSON.stringify(posts))
    const d = await w.evaluate(({ OLD, NEW }) => ({ dialog: !!document.querySelector('.relink-dialog'), old: !!document.querySelector(`.t2s-group[data-workspace-key="${OLD}"]`), next: !!document.querySelector(`.t2s-group[data-workspace-key="${NEW}"]`), badges: document.querySelectorAll('.t2s-missing').length }), { OLD, NEW })
    r.check('D3 合并后对话框关掉、会话落到新分组、小标消失', !d.dialog && !d.old && d.next && d.badges === 0, JSON.stringify(d))

    // E(合并后左栏的项目变了会再问一次,等它落定再量)
    await sleep(1500)
    const before = missingGets
    await sleep(3000)
    r.check('E1 不轮询:3 秒内没再问', missingGets === before, `${before} → ${missingGets}`)
    await w.evaluate(() => window.dispatchEvent(new Event('focus')))
    await sleep(800)
    r.check('E2 窗口重新获得焦点时再问一次', missingGets === before + 1, `${before} → ${missingGets}`)

    // F
    await w.locator('.t2s-srow[data-sel-id="rl-2"]').first().click(); await sleep(1200)
    const ta = w.locator('.t2c-ta').first()
    for (let i = 0; i < 40 && !(await ta.isEnabled().catch(() => false)); i++) await sleep(500)
    const runsBefore = ctx.stub.seen.runs.length
    await ta.click(); await ta.fill('再跑一次'); await w.keyboard.press('Enter'); await sleep(2000)
    const run = ctx.stub.seen.runs.at(-1)
    r.check('F1 库里没存 cwd 的会话:重新指向后发出的 run 带新目录', ctx.stub.seen.runs.length > runsBefore && run?.sessionId === 'rl-2' && run?.agentConfig?.cwd === NEW, JSON.stringify({ n: ctx.stub.seen.runs.length - runsBefore, sid: run?.sessionId, cwd: run?.agentConfig?.cwd }))
  } finally {
    await ctx.close()
  }
  process.exit(r.summary() ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
