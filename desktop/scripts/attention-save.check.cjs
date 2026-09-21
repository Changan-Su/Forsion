// 删除线 / 加粗 / 斜体的**落盘往返**实测(真浏览器 × 真 MarkdownBlock,harness)。
//
// 病(用户两次实报,08-25 / 09-18):整块划线后「一开始正常,过一会儿变成字面 `~~`」。
// mark 里带尾随 U+00A0(输入法打的,肉眼同普通空格)→ 落盘成 `~~文字。<NBSP>~~` → 闭合定界符前是
// 空白,CommonMark 不认 → 重开/回灌后退成字面文本 → 下次保存转义成 `\~\~`,不可逆。
// 药在 attentionFlanking.ts(边界字符编码成 `&#xA0;`)。09-18 复发的原因:08-25 第二版把注册点
// 搬进 `attentionSerializer`,却只挂到了 UnifiedSpike 台架上,真编辑器 MarkdownBlock 一直没挂。
// attentionWiring.test.ts 只证「挂了管用」,证不了「真编辑器挂了」—— 这里补上那一环。
//
// 用法:npm run e2e:editor -- --check=attention-save(自带起停 vite)
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(browser, seed) {
  const page = await browser.newPage({ locale: 'zh-CN' })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(`${BASE}?seed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
  await page.waitForTimeout(500)
  return page
}

/** 在最后一个顶层元素末尾打一个字,逼编辑器序列化一次(不碰 mark 所在那段),返回落盘串。 */
async function touchAndDump(page) {
  await page.locator('.md-block .ProseMirror').first().click()
  await page.evaluate(() => {
    const pm = document.querySelector('.md-block .ProseMirror')
    const el = pm.lastElementChild
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let t = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) t = n
    const range = document.createRange()
    if (t) range.setStart(t, t.length)
    else range.setStart(el, 0)
    range.collapse(true)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  })
  await page.waitForTimeout(120)
  await page.keyboard.type('x', { delay: 20 })
  await page.waitForTimeout(600)
  return page.evaluate(() => window.__harness.blocks[0].content)
}

// 喂进去的形态 = 已经正确编码过的(`&#xA0;`),解析后 mark 里真的带着尾随 NBSP ——
// 与用户「选中整段 + 划线」后内存里的文档同形。ASCII 空格喂不出病:milkdown 序列化的 moveSpaces
// 见 mark 以 ASCII 空格结尾就 trimEnd 挪到定界符外(连带前面的 NBSP)—— 只有单独的尾随 NBSP 留在里面。
const CASES = [
  { id: 'A1', name: '删除线', seed: '~~甲乙。&#xA0;~~\n\n尾', tag: 'del', lit: '~~' },
  { id: 'A2', name: '加粗', seed: '**甲乙。&#xA0;**\n\n尾', tag: 'strong', lit: '**' },
  { id: 'A3', name: '斜体', seed: '*甲乙。&#xA0;*\n\n尾', tag: 'em', lit: '*' },
  // 用户那篇的原形:有序列表项里整行划线。
  { id: 'A4', name: '列表项删除线', seed: '1. ~~tab缩进的内容， 等级。&#xA0;~~\n2. ~~拖拽块。&#xA0;~~\n\n尾', tag: 'del', lit: '~~', count: 2 },
]

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  for (const c of CASES) {
    const p1 = await open(browser, c.seed)
    const md1 = await touchAndDump(p1)
    await p1.close()
    // 重开 = 用户「过一会儿」遇到的那次重解析(切笔记 / 外部回灌 / 云同步拉回)。
    const p2 = await open(browser, md1)
    const got = await p2.evaluate(
      ([tag, lit]) => {
        const pm = document.querySelector('.md-block .ProseMirror')
        return { n: pm.querySelectorAll(tag).length, literal: pm.innerText.includes(lit) }
      },
      [c.tag, c.lit],
    )
    const want = c.count ?? 1
    check(`${c.id} ${c.name}:重开后 mark 仍在(<${c.tag}>×${want})`, got.n === want, `n=${got.n} md=${JSON.stringify(md1)}`)
    check(`${c.id} ${c.name}:重开后不露字面 ${c.lit}`, !got.literal, JSON.stringify(md1))
    const md2 = await touchAndDump(p2)
    check(`${c.id} ${c.name}:第二轮保存不转义定界符`, !/\\[~*]/.test(md2), JSON.stringify(md2))
    await p2.close()
  }
  // M1 `_` 定界一律写成 `*`(09-18 二轮评审:借 `_` 会走进上游 encode-info 的 `_` 分支,按 UTF-16 码元编内侧,
  //    emoji 变 U+FFFD)。渲染不变;尾随 NBSP 照样编码。
  {
    const seed = '前 _斜体_ 中 __加粗__ 后 _尾巴。&#xA0;_\n\n尾'
    const p = await open(browser, seed)
    const md = await touchAndDump(p)
    check('M1 `_斜体_` → `*斜体*`', md.includes('*斜体*') && !md.includes('_斜体_'), JSON.stringify(md))
    check('M1 `__加粗__` → `**加粗**`', md.includes('**加粗**'), JSON.stringify(md))
    check('M1 尾随 NBSP 照样编码', md.includes('*尾巴。&#xA0;*'), JSON.stringify(md))
    await p.close()
  }
  // ── 09-18 独立评审挖出的四条(都在真 Milkdown 上实测过)──
  // 选中首段 [a, z) 按快捷键;z<0 = 段尾。
  const markRange = async (p, a, z, key) => {
    await p.evaluate(([a, z]) => {
      const t = document.querySelector('.md-block .ProseMirror').firstElementChild
      const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT)
      const nodes = []
      for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n)
      const at = (off) => { // 跨文本节点的字符偏移 → (node, offset)
        for (const n of nodes) { if (off <= n.length) return [n, off]; off -= n.length }
        const last = nodes[nodes.length - 1]
        return [last, last.length]
      }
      const total = nodes.reduce((s, n) => s + n.length, 0)
      const r = document.createRange()
      r.setStart(...at(a)); r.setEnd(...at(z < 0 ? total : z))
      getSelection().removeAllRanges(); getSelection().addRange(r)
    }, [a, z])
    await p.waitForTimeout(150)
    await p.keyboard.press(key)
    await p.waitForTimeout(500)
  }
  const reopenLiteral = async (md, lit) => {
    const p = await open(browser, md)
    const r = await p.evaluate((lit) => {
      const pm = document.querySelector('.md-block .ProseMirror')
      return { literal: pm.innerText.includes(lit), del: pm.querySelectorAll('del').length }
    }, lit)
    await p.close()
    return r
  }

  // M2 旧笔记的 `__甲__` 旁边 ⌘B 新加粗:两个 marker 不同的 strong 挨着 → 曾拼成 `**甲****，乙**` 自毁。
  {
    const p = await open(browser, '__甲__，乙\n\n尾')
    await p.locator('.md-block .ProseMirror').first().click()
    await markRange(p, 1, -1, 'Meta+b') // 「，乙」加粗
    const md = await p.evaluate(() => window.__harness.blocks[0].content)
    await p.close()
    check('M2 相邻加粗并成一个', md.split('\n')[0] === '**甲，乙**', JSON.stringify(md))
    const p2 = await open(browser, md)
    const n = await p2.evaluate(() => document.querySelector('.md-block .ProseMirror').querySelectorAll('strong').length)
    const lit = await p2.evaluate(() => document.querySelector('.md-block .ProseMirror').innerText.includes('*'))
    await p2.close()
    check('M2 重开仍是加粗、不露 `*`', n >= 1 && !lit, `strong=${n} ${JSON.stringify(md)}`)
  }

  // M3 斜体紧贴「以标点开头的加粗」:两个 `*` run 拼成 `***`,一侧字母一侧标点 → 后一个开不起来(修复前后都坏)。
  //    药:字母那侧的边缘字编成字符引用(`斜&#x4F53;***「注意」**`),两侧都成标点。
  {
    const p = await open(browser, '斜体「注意」\n\n尾')
    await p.locator('.md-block .ProseMirror').first().click()
    await markRange(p, 0, 2, 'Meta+i')
    await markRange(p, 2, -1, 'Meta+b')
    const md = await p.evaluate(() => window.__harness.blocks[0].content)
    await p.close()
    const p2 = await open(browser, md)
    const got = await p2.evaluate(() => {
      const pm = document.querySelector('.md-block .ProseMirror')
      return { em: pm.querySelectorAll('em').length, strong: pm.querySelectorAll('strong').length, star: pm.innerText.includes('*'), text: pm.firstElementChild.innerText }
    })
    await p2.close()
    check('M3 重开后斜体、加粗都在,不露 `*`', got.em === 1 && got.strong === 1 && !got.star, `${JSON.stringify(got)} ${JSON.stringify(md)}`)
    check('M3 文字一个字不变', got.text === '斜体「注意」', JSON.stringify(got.text))
  }

  // (N1 `&#xNAN;`:空文本兄弟那种 mdast 形状点不出来,钉在 attentionFlanking.test.ts 的单测里。)

  // E1 整行划线盖过两段加粗:strike 在 strong 之间那个空格上被 moveSpaces 挪空 → 落 `~~~~` 字面。
  {
    const p = await open(browser, '**甲** **乙**\n\n尾')
    await p.locator('.md-block .ProseMirror').first().click()
    await markRange(p, 0, -1, 'Meta+Shift+s')
    const md = await p.evaluate(() => window.__harness.blocks[0].content)
    await p.close()
    check('E1 不落空删除线 `~~~~`', !md.includes('~~~~'), JSON.stringify(md))
    const r = await reopenLiteral(md, '~~')
    check('E1 重开不露字面 ~~,两段都还划着', !r.literal && r.del >= 2, `del=${r.del} ${JSON.stringify(md)}`)
  }

  // B1 带 BOM 的笔记:remark-marker 读偏一位,marker 成了 BOM/空格 → 上游 checkStrong 抛 → 编辑器起不来。
  {
    const p = await open(browser, '\uFEFF前**加粗**后\n\n尾').catch(() => null)
    const mounted = !!p
    check('B1 BOM + 加粗:编辑器能打开', mounted)
    if (p) {
      const md = await touchAndDump(p)
      check('B1 BOM + 加粗:加粗照常落盘', md.includes('**加粗**'), JSON.stringify(md))
      await p.close()
    }
  }

  // C1 复制整块(列表)的纯文本 flavor 给外部应用:不带 `&#x…;` 实体垃圾(withoutBoundaryRefs)。
  //    刻意的代价:纯文本里的 `**注意：**后面` 不是合法 markdown(= 修复前的剪贴板形态),给人看的。
  {
    const p = await open(browser, '- **注意：**&#x540E;面\n\n尾')
    await p.locator('.md-block .ProseMirror').first().click()
    await p.evaluate(() => {
      const pm = document.querySelector('.md-block .ProseMirror')
      pm.focus()
      const li = pm.querySelector('li p') || pm.querySelector('li')
      const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT)
      const nodes = []
      for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n)
      const r = document.createRange()
      r.setStart(nodes[0], 0); r.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].length)
      getSelection().removeAllRanges(); getSelection().addRange(r)
    })
    await p.waitForTimeout(200) // 等 PM 把 DOM 选区同步进 state,copy 处理器看的是 state
    const text = await p.evaluate(() => {
      let got = null
      const grab = (e) => { got = e.clipboardData.getData('text/plain') }
      document.addEventListener('copy', grab)
      document.execCommand('copy')
      document.removeEventListener('copy', grab)
      return got
    })
    check('C1 复制列表项:拿到的是整块 markdown(防假绿)', /注意/.test(text || '') && /^[-*]\s/.test(text || ''), JSON.stringify(text))
    check('C1 复制列表项:纯文本不含 `&#x`', !!text && !text.includes('&#x'), JSON.stringify(text))
    await p.close()
  }

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
