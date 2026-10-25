/** 走查第五轮 5.10–5.14 的真 Electron 台架(假引擎,无用户数据)。
 *  5.10 Agent 详情某一格崩了:头部和标签条留着,只有那一格换成错误态(详情默认折起、不 break-all),换个标签就回来。
 *       复现用的是 W-16 原址:协作说明接口少了 content → HumanCollaborationPanel 的 `doc?.content.trim()` 抛错。
 *  5.11 分段控件一种选中态、一种圆角:侧栏胶囊 / LCL 看法胶囊 / Agent 标签条的轨道与滑块圆角相同;暗色下滑块比轨道亮;选中字 = --text。
 *  5.12 Agents 搜索框 32px 胶囊。
 *  5.13 模式菜单每行图标与文字同一列;英文审批分组标题一行「Approval」、「Turn on team mode…」;非本机会话药丸写「普通模式」;
 *       上下文浮层不越出输入卡。
 *  5.14 命令面板:没图标的行留空位,所有行文字同一列;同按一对写「⌘⌘」带悬停说明;页脚「Esc」。
 *  前置:npm run build(出 out/)。用法:node scripts/r5-views.check.cjs —— 截图落在最后打印的临时目录(亮 / 暗 / 英文)。 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-r5-views-'))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`) }

const base = { archived: false, model_id: 'm1', created_at: '2026-10-25 09:00:00', updated_at: '2026-10-25 09:00:00', projectless: true, project_path: null, project_name: null }
const hostSession = { ...base, id: 'r5-host', title: 'R5 host chat', agent_config: { agentSlug: 'xyra', execMode: 'host', cwd: home } }
const plainSession = { ...base, id: 'r5-plain', title: 'R5 sandbox chat', agent_config: { agentSlug: 'xyra', execMode: 'sandbox', cwd: home } }
const agents = ['xyra', 'research'].map((slug) => ({ slug, name: slug === 'xyra' ? 'Xyra' : 'Research', description: 'Helper', tools: [], model: '', thinkingLevel: '', maxIterations: null, approvalMode: '', systemPrompt: 'Be precise.', soul: '', createdBy: 'user', libraryDir: path.join(home, slug, 'Library') }))

async function run() {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'main.js'))) throw new Error('Build the desktop first: npm run build')
  const stub = await startStubEngine({ agents, sessions: [hostSession, plainSession], messages: [{ id: 'u1', role: 'user', content: 'Hello', timestamp: 1 }, { id: 'a1', role: 'model', content: 'Hi.', timestamp: 2 }], override: async ({ path: p, method }) => {
    // W-16 原址:协作说明少了 content(旧引擎 / 半截响应)→ 协作这一格渲染抛错
    if (p === '/agent/agents/xyra/human' && method === 'GET') return { scope: { kind: 'agent', slug: 'xyra' }, path: path.join(home, 'xyra', 'HUMAN.md'), version: 'v1', exists: true, history: [], maxLength: 8000 }
    return undefined
  } })
  const ud = path.join(home, 'userData')
  for (const dir of [ud, `${ud}-dev`]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' })) }
  const app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: path.join(home, 'shell'), TANGU_BACKEND_URL: stub.url } })
  const win = await app.firstWindow(); win.setDefaultTimeout(15000)
  const shot = async (name) => { await win.waitForTimeout(300); await win.screenshot({ path: path.join(home, `${name}.png`) }) }
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 940))
    await win.waitForSelector('#root'); await win.waitForTimeout(2000)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.waitForSelector('.dv-groupview')
    const reloadInto = async (space, locale) => {
      await win.evaluate(([s, l]) => { localStorage.setItem('forsion_default_space', s); localStorage.setItem('tangu_locale', l) }, [space, locale])
      await win.reload(); await win.waitForSelector('.dv-groupview'); await win.waitForTimeout(1200)
    }
    const setDark = async (dark) => {
      const now = await win.evaluate(() => document.documentElement.classList.contains('dark'))
      if (now === dark) return
      await win.waitForTimeout(500) // 上一次关面板的退场残影(useExitGhost)还在时会有两个 .cmd-input
      await win.keyboard.press('Meta+k'); await win.locator('.cmd-panel .cmd-input').last().fill('theme dark')
      await win.locator('.cmd-item[data-command-id="theme-mode"]').click(); await win.waitForTimeout(500)
    }

    // ── 5.10 + 5.11 + 5.12:Agents ──
    await reloadInto('agents', 'zh')
    await win.locator('[data-agents-space]').waitFor()
    const search = await win.locator('.agents-roster .agents-search').evaluate((el) => { const cs = getComputedStyle(el); return { h: el.getBoundingClientRect().height, r: parseFloat(cs.borderTopLeftRadius) } })
    check('5.12 Agents 搜索框是 32px 胶囊', Math.abs(search.h - 32) < 0.6 && search.r >= search.h / 2, JSON.stringify(search))

    await win.locator('.agents-roster-item').filter({ hasText: 'Xyra' }).first().click()
    const nav = win.locator('.agent-section-nav').first()
    await nav.waitFor()
    await nav.locator('[role=tab][id$="-human"]').click(); await win.waitForTimeout(500)
    const err = await win.evaluate(() => {
      const content = document.querySelector('.agent-profile-content'), e = content?.querySelector('[data-view-error]')
      const pre = e?.querySelector('.sk-error-details pre')
      return { inTab: !!e, wholeView: !!document.querySelector('.wb-view > [data-view-error], .wb-view > div > [data-view-error]') && !e,
        header: !!document.querySelector('.agent-character-name'), tabs: document.querySelectorAll('.agent-section-nav [role=tab]').length,
        title: e?.querySelector('.sk-error-title')?.textContent, line: e?.querySelector('.sk-error-msg')?.textContent,
        open: e?.querySelector('details')?.open, wb: pre ? getComputedStyle(pre).wordBreak : null, raw: pre?.textContent,
        btns: [...(e?.querySelectorAll('.sk-error-btn') || [])].map((b) => b.textContent) }
    })
    check('5.10 协作这一格崩了:错误态在标签内容里,Agent 头部和 6 个标签都还在', err.inTab && err.header && err.tabs === 6, JSON.stringify(err))
    check('5.10 错误态文案:标题 / 带标签名的一句话 / 重试 + 复制详情', err.title === '这一页没能打开' && /「协作」加载时出了错/.test(err.line || '') && err.btns.join('|') === '重试|复制详情', `${err.title} · ${err.line} · ${err.btns}`)
    check('5.10 原始异常默认折起,等宽且不 break-all', err.open === false && err.wb !== 'break-all' && /trim/.test(err.raw || ''), `open=${err.open} wordBreak=${err.wb} raw=${err.raw}`)
    await shot('5.10-error-light')
    await win.locator('[data-view-error] .sk-error-details summary').click(); await setDark(true); await shot('5.10-error-open-dark'); await setDark(false)
    await nav.locator('[role=tab][id$="-config"]').click(); await win.waitForTimeout(400)
    const back = await win.evaluate(() => ({ err: !!document.querySelector('.agent-profile-content [data-view-error]'), selected: document.querySelector('.agent-section-nav [aria-selected=true]')?.id || '' }))
    check('5.10 换到「配置」就回来了(边界按标签重置)', !back.err && back.selected.endsWith('-config'), JSON.stringify(back))

    // 5.11:同一页上量真 Agent 标签条;侧栏胶囊 / LCL 看法胶囊按真类名合成一份(真样式表已加载)
    const seg = async () => win.evaluate(() => {
      const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] ?? 1] }
      const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]))
      const Y = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
      const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-9999px;top:0;width:240px'
      host.innerHTML = '<div class="t2s-vaultseg"><div class="t2s-vaultseg-thumb"></div><button class="on">A</button><button>B</button></div>'
        + '<div class="lcl-vmode"><div class="lcl-vmode-pill" style="--seg-n:2"><span class="lcl-vmode-thumb"></span><button class="on">A</button><button>B</button></div></div>'
      document.body.appendChild(host)
      host.querySelectorAll('*').forEach((el) => { el.style.transition = 'none' })
      const nav = document.querySelector('.agent-section-nav')
      const panelBg = lum(getComputedStyle(document.querySelector('.agent-profile-content') || document.body).backgroundColor)
      const bodyBg = lum(getComputedStyle(document.body).backgroundColor)
      const paper = panelBg[3] > 0 ? panelBg : bodyBg
      const pair = (track, thumb, on) => {
        const t = over(lum(getComputedStyle(track).backgroundColor), paper)
        const th = over(lum(thumb.bg), t)
        return { r: [getComputedStyle(track).borderTopLeftRadius, thumb.r], track: Y(t), thumb: Y(th), on: getComputedStyle(on).color }
      }
      const css = (el, pseudo) => { const cs = getComputedStyle(el, pseudo); return { bg: cs.backgroundColor, r: cs.borderTopLeftRadius } }
      const out = {
        vault: pair(host.querySelector('.t2s-vaultseg'), css(host.querySelector('.t2s-vaultseg-thumb')), host.querySelector('.t2s-vaultseg button.on')),
        vmode: pair(host.querySelector('.lcl-vmode-pill'), css(host.querySelector('.lcl-vmode-thumb')), host.querySelector('.lcl-vmode-pill button.on')),
        // 滑块两种形态都认:整条等分的 nav::before,或 5.16 之后按钮自带的 button.selected::before
        agent: (() => { const sel = nav.querySelector('button.selected'); const own = getComputedStyle(sel, '::before').content !== 'none'; return pair(nav, css(own ? sel : nav, '::before'), sel) })(),
        text: getComputedStyle(document.body).color,
      }
      host.remove(); return out
    })
    for (const dark of [false, true]) {
      await setDark(dark)
      await win.evaluate(() => document.querySelectorAll('.agent-section-nav, .agent-section-nav button').forEach((el) => { el.style.transition = 'none' }))
      const s = await seg()
      const radii = [...s.vault.r, ...s.vmode.r, ...s.agent.r]
      check(`5.11 ${dark ? '暗' : '亮'}色:侧栏胶囊 / 看法胶囊 / Agent 标签条的轨道与滑块圆角一致`, new Set(radii).size === 1, radii.join(' '))
      check(`5.11 ${dark ? '暗' : '亮'}色:三处滑块都比轨道亮(凸起)`, ['vault', 'vmode', 'agent'].every((k) => s[k].thumb > s[k].track + 4), ['vault', 'vmode', 'agent'].map((k) => `${k} ${s[k].track.toFixed(0)}→${s[k].thumb.toFixed(0)}`).join(', '))
      check(`5.11 ${dark ? '暗' : '亮'}色:选中字是正文色,不是强调色`, ['vault', 'vmode', 'agent'].every((k) => s[k].on === s.text), ['vault', 'vmode', 'agent'].map((k) => s[k].on).join(' / ') + ` text=${s.text}`)
      await shot(`5.11-agent-tabs-${dark ? 'dark' : 'light'}`)
    }
    await setDark(false)

    // ── 5.14 命令面板 ──
    await win.waitForTimeout(500) // 刚切完明暗,面板的退场残影还在
    await win.keyboard.press('Meta+k'); await win.locator('.cmd-panel').waitFor(); await win.locator('.cmd-panel .cmd-input').last().fill(''); await win.waitForTimeout(200)
    const pal = await win.evaluate(() => {
      const items = [...document.querySelectorAll('.cmd-item')]
      const textX = items.map((it) => { const t = it.querySelector('.cmd-title'); const r = document.createRange(); const node = [...t.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()); if (!node) return null; r.selectNodeContents(node); return Math.round(r.getBoundingClientRect().left * 2) / 2 }).filter((x) => x != null)
      return { rows: items.length, textX: [...new Set(textX)], empties: document.querySelectorAll('.cmd-icon-empty').length, foot: document.querySelector('.cmd-foot')?.textContent || '',
        pair: [...document.querySelectorAll('.cmd-hotkey')].filter((k) => k.title).map((k) => `${k.textContent}|${k.title}`) }
    })
    check('5.14 有图标没图标的命令,文字都在同一列', pal.rows > 5 && pal.empties > 0 && pal.textX.length === 1, JSON.stringify({ rows: pal.rows, empties: pal.empties, textX: pal.textX }))
    check('5.14 页脚写「Esc」', /\bEsc\b/.test(pal.foot) && !/\besc\b/.test(pal.foot), pal.foot)
    await win.locator('.cmd-input').fill('窗口')
    const pairKbd = await win.evaluate(() => [...document.querySelectorAll('.cmd-hotkey')].filter((k) => k.title).map((k) => `${k.textContent}|${k.title}`))
    check('5.14 同按一对写「⌘⌘」,悬停说清是同时按', pairKbd.some((x) => x === '⌘⌘|同时按左右两个 ⌘'), JSON.stringify(pairKbd))
    await shot('5.14-palette-light')
    await win.keyboard.press('Escape')

    // ── 5.13 模式菜单 / 药丸 / 上下文浮层 ──
    await win.locator('[data-ribbon-id="space:tangu"], [data-id="space:tangu"]').first().click(); await win.waitForTimeout(1200)
    const openSession = async (title) => { await win.locator('.t2s-srow, .t2o-row').filter({ hasText: title }).first().click(); await win.waitForTimeout(1200) }
    await openSession('R5 sandbox chat')
    const plainPill = (await win.locator('.mode-pill-btn .t2c-pill-label').first().textContent()) || ''
    check('5.13 非本机会话的模式药丸写「普通模式」(同菜单里那一项)', plainPill === '普通模式', plainPill)
    await openSession('R5 host chat')
    const modeMenu = async () => {
      await win.locator('.mode-pill-btn').first().click(); await win.locator('.composer-menu--mode').waitFor(); await win.waitForTimeout(250)
      return win.evaluate(() => {
        // 行首带图标的行(普通模式右侧那枚「当前 Agent ›」是二级入口,不是一行)
        const rows = [...document.querySelectorAll('.composer-menu--mode button.menu-item')].filter((b) => b.offsetParent && !b.closest('.cm-sub') && b.firstElementChild?.tagName === 'svg')
        const col = (b) => { const ic = b.querySelector('svg'); const tx = b.querySelector('.grow, span'); return { ic: ic ? Math.round(ic.getBoundingClientRect().left) : null, icw: ic ? Math.round(ic.getBoundingClientRect().width) : null, tx: tx ? Math.round(tx.getBoundingClientRect().left) : null } }
        const sections = [...document.querySelectorAll('.composer-menu--mode .menu-section')].map((s) => ({ text: s.textContent, h: s.getBoundingClientRect().height }))
        return { cols: rows.map(col), labels: rows.map((b) => b.textContent.trim()), sections }
      })
    }
    const zh = await modeMenu()
    const uniq = (k) => [...new Set(zh.cols.map((c) => c[k]))]
    check('5.13 模式菜单每行图标同一列、同尺寸、文字同一列', zh.cols.length >= 7 && uniq('ic').length === 1 && uniq('icw').length === 1 && uniq('tx').length === 1, JSON.stringify(zh.cols))
    await shot('5.13-mode-menu-light')
    await win.keyboard.press('Escape'); await win.mouse.click(700, 300); await win.waitForTimeout(200)
    const ctx = async () => {
      await win.locator('.t2c-ctxring-btn').first().click(); await win.waitForTimeout(500)
      return win.evaluate(() => { const p = document.querySelector('.t2c-ctxring-pop').getBoundingClientRect(), c = document.querySelector('.t2c-ctxring-pop').closest('.t2c-card').getBoundingClientRect(); return { pl: p.left, pr: p.right, cl: c.left, cr: c.right } })
    }
    const ctxZh = await ctx()
    check('5.13 上下文浮层不越出输入卡', ctxZh.pr <= ctxZh.cr + 0.5 && ctxZh.pl >= ctxZh.cl - 0.5, JSON.stringify(ctxZh))
    await shot('5.13-ctx-light')
    await win.locator('.t2c-ctxring-btn').first().click(); await win.waitForTimeout(200)
    // 输入卡比浮层(300)还窄:浮层收进卡里、宽度稳定(Codex 评审:useEdgeNudge 量到收窄后的宽会来回翻)
    await win.evaluate(() => { const c = document.querySelector('.t2c-card'); c.dataset.r5w = c.style.width; c.style.width = '260px' })
    await win.waitForTimeout(300)
    await win.locator('.t2c-ctxring-btn').first().click()
    const widths = []
    for (let i = 0; i < 6; i++) { await win.waitForTimeout(120); widths.push(await win.evaluate(() => { const p = document.querySelector('.t2c-ctxring-pop').getBoundingClientRect(), c = document.querySelector('.t2c-card').getBoundingClientRect(); return [Math.round(p.width), Math.round(p.left - c.left), Math.round(c.right - p.right)] })) }
    const stable = new Set(widths.map((w) => w.join(','))).size === 1
    check('5.13 输入卡比浮层窄:浮层收进卡里、不来回闪', stable && widths[0][1] >= 0 && widths[0][2] >= 0, JSON.stringify(widths))
    await win.locator('.t2c-ctxring-btn').first().click(); await win.waitForTimeout(200)
    await win.evaluate(() => { const c = document.querySelector('.t2c-card'); c.style.width = c.dataset.r5w || ''; delete c.dataset.r5w })

    // ── 英文 ──
    await reloadInto('tangu', 'en')
    await openSession('R5 host chat')
    const en = await modeMenu()
    const approvalHead = en.sections.find((s) => /Approval/.test(s.text))
    check('5.13 英文审批分组标题是一行「Approval」', approvalHead?.text === 'Approval', JSON.stringify(en.sections))
    check('5.13 英文「Turn on team mode…」', en.labels.some((l) => l === 'Turn on team mode…'), JSON.stringify(en.labels))
    await shot('5.13-mode-menu-en')
    await win.keyboard.press('Escape'); await win.mouse.click(700, 300); await win.waitForTimeout(200)
    const ctxEn = await ctx()
    check('5.13 英文下上下文浮层也不越出输入卡', ctxEn.pr <= ctxEn.cr + 0.5 && ctxEn.pl >= ctxEn.cl - 0.5, JSON.stringify(ctxEn))
    await shot('5.13-ctx-en')
    await win.locator('.t2c-ctxring-btn').first().click(); await win.waitForTimeout(200)
    await reloadInto('agents', 'en')
    await win.locator('.agents-roster-item').filter({ hasText: 'Xyra' }).first().click()
    await win.locator('.agent-section-nav [role=tab][id$="-human"]').click(); await win.waitForTimeout(500)
    const enErr = await win.evaluate(() => ({ title: document.querySelector('[data-view-error] .sk-error-title')?.textContent, btns: [...document.querySelectorAll('[data-view-error] .sk-error-btn')].map((b) => b.textContent).join('|') }))
    check('5.10 英文:This page didn’t load · Retry · Copy details', enErr.title === "This page didn't load" && enErr.btns === 'Retry|Copy details', JSON.stringify(enErr))
    await shot('5.10-error-en')
    await win.keyboard.press('Meta+k'); await win.locator('.cmd-input').fill('window')
    const enPair = await win.evaluate(() => [...document.querySelectorAll('.cmd-hotkey')].filter((k) => k.title).map((k) => k.title))
    check('5.14 英文悬停说明', enPair.includes('Press both ⌘ keys together'), JSON.stringify(enPair))
    await win.keyboard.press('Escape')
    await setDark(true); await win.keyboard.press('Meta+k'); await win.locator('.cmd-panel').waitFor(); await shot('5.14-palette-dark'); await win.keyboard.press('Escape')
  } finally {
    await app.close().catch(() => {}); await stub.close?.()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots: ${home}`)
  process.exitCode = failed.length ? 1 : 0
}
run().catch((e) => { console.error(e); console.log(`screenshots: ${home}`); process.exitCode = 1 })
