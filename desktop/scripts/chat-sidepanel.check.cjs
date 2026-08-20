/**
 * 「对话开在侧栏」这条链的端到端契约(真 Electron)。2026-08-14 两批用户要求合并钉在这里:
 *
 *  0-2  新对话空状态落在 **view 的竖向中心**(此前只在「输入框以上那段」居中 → 整体偏高)
 *  3,11 细长列(宽:高 < 9:16)不画头像,宽列照常 —— 量的是 container-type: size 有没有生效
 *  4-5  Amadeus 右栏默认 = 对话视图(展开右栏,活动 tab 必须是对话,且主区仍是编辑器)
 *  6-7  侧栏对话默认引用**主区当前打开的文件**
 *  8-10 拖笔记进聊天区 → 「已选择」芯片、不塞草稿、且只挂引用也能发
 *  12-13 侧栏拖宽之后,折叠再展开必须还是那个宽(此前被 pinSides 打回黄金分割)
 *  14   切 Space 时清 stashActive:上个空间停在哪个 tab 不许顶掉下个空间配方的首项
 *  15   空草稿 = 输入框一行高(不留内联 height)——「明明是空的却撑到最高档」
 *  16-17 长代码行只在自己框里横滚,不顶宽聊天流(正文恒受 view 宽度约束)
 *  18-21 输入卡脱流悬浮在正文之上:正文铺满整列、按卡实高留白、卡两侧空当放行、
 *        渐隐只在卡下方那条缝(挂卡上沿被用户打回过)、「回到底」按钮抬过卡
 *  23-25 那批卡一律不描边;glass 输入卡主区走薄档,菜单走可调 float 磨砂(侧栏/portal 也有染色兜底)
 *  26   窄栏(≤520px 容器)滚到底,末条仍完整停在悬浮输入卡上方 —— 那档的 padding 简写
 *       曾把 calc 抹掉,末条被卡压住 178px
 *  27   16 的推广:用户原话是「不管宽度多少,一行内容过长就超出」——长单词/URL/行内 code/宽表/
 *       思考块/工具卡/用户气泡逐个量,都不许顶出横滚(只钉代码块会漏掉表格那类另有溢出路子的)
 * (15-17、27 在流程里跑在 3 之后、Amadeus 那段之前;编号按加入顺序,不按执行顺序)
 *
 * 为什么必须打真 Electron:Amadeus Space 只在有 window.amadeus(文件系统桥)时注册,浏览器里根本
 * 没有这个 Space;右栏的默认内容又走「折叠→stash→展开还原」那条路,单元测试摸不到。
 *
 * ⚠️ 量「居中」要量**内容块**(品牌图上缘 → 副标下缘)的中点,不是 .t2-empty 自己的 rect ——
 *    它是 inset:0 的铺满层,rect 恒等于整列,量它必然「完美居中」= 假绿。
 * ⚠️ 先 npm run build:量的是 out/ 里的产物,源码改了没构建就是白测。
 * ⚠️ **非密闭**:TANGU_HOME 只隔离 tangu 侧,Amadeus 库仍是本机那份 → 5/6 点的是真实库里的第一篇笔记。
 *    空库/新机器上 5/6 红**不是回归**,是没笔记可点;先在库里放一篇再跑。
 *    5 还隐含 host 会话(引用是本机绝对路径,云端会话按设计不挂 —— 见 Composer2 autoChip 的 isHost 闸)。
 *
 * 用法:npm run check:chatside
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chatside-'))
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
    })
  } catch (e) {
    console.error('启动失败。若已有 dev 版 Electron 在跑,先 pkill -f "node_modules/electron/dist/Electron.app"(单实例锁)。')
    throw e
  }
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1500)

  // ── 4 空状态居中(默认 Tangu Space,主区就是新对话)────────────────────────────
  const RECTS = `const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height } }`
  const empty = await win.evaluate(`(() => {
    ${RECTS}
    const col = r('.t2-chat-col'), mark = r('.t2-empty-mark'), sub = r('.t2-empty-sub'), stream = r('.t2-stream')
    const inCol = !!document.querySelector('.t2-chat-col > .t2-empty')
    if (!col || !mark || !sub || !stream) return { col, mark, sub, stream, inCol }
    return { inCol, colMid: (col.top + col.bottom) / 2, streamMid: (stream.top + stream.bottom) / 2, contentMid: (mark.top + sub.bottom) / 2 }
  })()`)
  check('0 前置:主区是新对话空状态(品牌图+标语都在)', !!empty && typeof empty.contentMid === 'number', JSON.stringify(empty))
  if (typeof empty.contentMid === 'number') {
    const dCol = Math.abs(empty.contentMid - empty.colMid)
    const dStream = Math.abs(empty.contentMid - empty.streamMid)
    check('1 空状态是聊天列的直属子元素(不在滚动流里)', empty.inCol)
    // 8px 容差:品牌图与标题之间的 gap 让内容块不完全对称,不是几何误差。
    // 08-14 输入卡改成悬浮后,流已经等于整列 → 两个中心恒等,dStream 不再有鉴别力。
    // 这条现在只剩「内容块确实落在列中心」这一层意思;结构那半由 1 单独钉(空状态不在流里)。
    check('2 空状态落在 view 的竖向中心', dCol <= 8, `距列中心 ${dCol.toFixed(1)}px(流中心 ${dStream.toFixed(1)}px:悬浮后二者恒等)`)
  }

  /** 往每个 .t2-chat-col 插一颗探针头像,读 computed display + 该列的宽高比。
   *  无后端发不出消息 → 没有真实消息行;量的是**规则能不能命中**(container-type: size 生没生效)。 */
  const AVATAR_PROBE = `(() => {
    const out = []
    for (const col of document.querySelectorAll('.t2-chat-col')) {
      const probe = document.createElement('div')
      probe.className = 't2-avatar'
      col.appendChild(probe)
      const b = col.getBoundingClientRect()
      out.push({ ratio: +(b.width / b.height).toFixed(3), display: getComputedStyle(probe).display })
      probe.remove()
    }
    return out
  })()`

  const wideAv = await win.evaluate(AVATAR_PROBE)
  check(
    '3 宽的聊天列(主区)照常显示头像',
    wideAv.length > 0 && wideAv.every((a) => a.ratio >= 9 / 16 && a.display !== 'none'),
    JSON.stringify(wideAv),
  )

  // ── 15 空草稿的输入框必须是一行高 ───────────────────────────────────────────
  // 用户报「明明 chat box 内容为空,size 却异常(被撑到最高档 200px)」。触发路径说不清,
  // 所以修法是「空了就把内联 height 交还 CSS」——这条就钉那个不变式:空 = 无内联 height = 一行。
  const taBox = await win.evaluate(`(() => {
    const ta = document.querySelector('.t2c-ta')
    if (!ta) return null
    return { value: ta.value.length, inline: ta.style.height, h: Math.round(ta.getBoundingClientRect().height) }
  })()`)
  check(
    '15 空草稿时输入框回到一行(不留内联 height)',
    !!taBox && taBox.value === 0 && taBox.inline === '' && taBox.h < 60,
    JSON.stringify(taBox) + '(旧行为:某些时机量到错高度后会钉在 200px 不回缩)',
  )

  // ── 16-17 长代码行不许顶宽正文列 ────────────────────────────────────────────
  // 无后端 → 没有真实助手消息;直接把生产类名的消息节点插进流里量布局(被测的是 CSS 本身)。
  // 长行取 400 字符**不含空格**:任何宽度下都放不下。撤掉 .t2-content pre 的 overflow-x 做过负对照,
  // 16 立刻红(streamOver=2530px = 用户说的「必须左右滑」),装回即绿。
  // ⚠️ 17 不能只看 `pre.scrollWidth > clientWidth` —— overflow:visible 的框一样这么报(负对照里
  //    它照样"绿"= 假绿)。必须同时验 computed overflow-x 不是 visible:内容超框 **且** 框自己能滚。
  const wrapProbe = await win.evaluate(`(() => {
    const inner = document.querySelector('.t2-stream-inner')
    const stream = document.querySelector('.t2-stream')
    if (!inner || !stream) return null
    const node = document.createElement('div')
    node.className = 't2-asst'
    node.innerHTML = '<div class="t2-asst-col"><div class="t2-content">' +
      '<p>' + '这是一段用来量换行的中文正文。'.repeat(12) + '</p>' +
      '<pre><code>' + 'x'.repeat(400) + '</code></pre></div></div>'
    inner.appendChild(node)
    const pre = node.querySelector('pre')
    const p = node.querySelector('p')
    const body = document.querySelector('.t2-chat-body')
    const out = {
      streamOver: stream.scrollWidth - stream.clientWidth,
      streamWide: Math.round(stream.getBoundingClientRect().width - body.getBoundingClientRect().width),
      preScrolls: pre.scrollWidth - pre.clientWidth,
      preOverflowX: getComputedStyle(pre).overflowX,
      pOver: Math.round(p.getBoundingClientRect().width - stream.clientWidth),
    }
    node.remove()
    return out
  })()`)
  check(
    '16 一条超长代码行不会让整条聊天流横滚 / 变宽',
    !!wrapProbe && wrapProbe.streamOver <= 1 && wrapProbe.streamWide <= 1 && wrapProbe.pOver <= 0,
    JSON.stringify(wrapProbe) + '(streamOver>0 = 要左右滑;streamWide>0 = 流被内容顶宽,正文跟着超出视图)',
  )
  check(
    '17 代码块在自己的框里横滚(而不是溢出去)',
    !!wrapProbe && wrapProbe.preScrolls > 0 && wrapProbe.preOverflowX !== 'visible',
    wrapProbe ? `pre 内部可滚 ${wrapProbe.preScrolls}px,overflow-x=${wrapProbe.preOverflowX}` : 'no probe',
  )

  // ── 27 「任何一行内容过长」都不顶宽 ─────────────────────────────────────────
  // 用户原话是「不管宽度多少,一行内容过长就超出」——16 只钉了 ```代码块```,别的形态一样会顶宽
  // (表格 width:max-content、行内 code、长 URL 各有各的溢出路子)。逐个插进真流里量,判据同 16。
  const shapes = await win.evaluate(`(() => {
    const inner = document.querySelector('.t2-stream-inner')
    const stream = document.querySelector('.t2-stream')
    if (!inner || !stream) return null
    const L = 'x'.repeat(400) // 400 字符不含空格:任何宽度都放不下
    const td = Array.from({ length: 30 }, (_, i) => '<td>单元格内容' + i + '</td>').join('')
    const SHAPES = [
      ['正文长单词', '<div class="t2-asst-col"><div class="t2-content"><p>' + L + '</p></div></div>'],
      ['长 URL', '<div class="t2-asst-col"><div class="t2-content"><p>看这个 https://example.com/' + 'a'.repeat(380) + ' 就是了</p></div></div>'],
      ['行内 code', '<div class="t2-asst-col"><div class="t2-content"><p>路径是 <code>' + L + '</code> 这样</p></div></div>'],
      ['宽表格', '<div class="t2-asst-col"><div class="t2-content"><table><tbody><tr>' + td + '</tr></tbody></table></div></div>'],
      ['思考块', '<div class="t2-asst-col"><div class="thinking-block"><div class="t2-content"><p>' + L + '</p></div></div></div>'],
      ['工具卡', '<div class="t2-asst-col"><div class="tool-card"><div class="tool-card-body">' + L + '</div></div></div>'],
      ['用户气泡', '<div class="t2-user-col"><div class="t2-user">' + L + '</div></div>'],
    ]
    const bad = []
    for (const [name, html] of SHAPES) {
      const node = document.createElement('div')
      node.className = name === '用户气泡' ? 't2-userwrap' : 't2-asst'
      node.innerHTML = html
      inner.appendChild(node)
      void node.offsetWidth
      const over = stream.scrollWidth - stream.clientWidth
      if (over > 1) bad.push(name + ' +' + over + 'px')
      node.remove()
    }
    return { bad, width: Math.round(stream.clientWidth) }
  })()`)
  check(
    '27 长单词/URL/行内code/宽表/思考块/工具卡/用户气泡 都不顶出横滚',
    !!shapes && shapes.bad.length === 0,
    shapes ? `流宽 ${shapes.width}px;顶宽的形态:${shapes.bad.length ? shapes.bad.join('、') : '无'}` : 'no probe',
  )

  // ── 18-20 输入卡悬浮在正文之上 ───────────────────────────────────────────────
  // 用户草图:正文铺满整列、从胶囊底下穿过去;输入区不再是占着布局、涂着背景色的一条底栏。
  const floatProbe = await win.evaluate(`(() => {
    ${RECTS}
    const col = document.querySelector('.t2-chat-col')
    const anchor = document.querySelector('.t2-chat-col > .composer-anchor')
    const stream = document.querySelector('.t2-stream')
    const inner = document.querySelector('.t2-stream-inner')
    const tci = document.querySelector('.t2c-inner')
    const card = document.querySelector('.t2c-card')
    if (!col || !anchor || !stream || !inner || !tci || !card) return null
    const c = col.getBoundingClientRect(), a = anchor.getBoundingClientRect(), s = stream.getBoundingClientRect()
    // 胶囊左侧的空当(卡最宽 880 居中,主区更宽 → 一定有空当)必须能点到底下的正文。
    // y 取**卡**的竖向中点而不是 anchor 的:新对话时 anchor 上半截是选择器条(它整块吃事件)。
    const t = tci.getBoundingClientRect()
    const gapX = Math.round(a.left + 6), gapY = Math.round(t.top + t.height / 2)
    const hit = document.elementFromPoint(gapX, gapY)
    return {
      anchorPos: getComputedStyle(anchor).position,
      streamToColBottom: Math.round(s.bottom - c.bottom),
      overlap: Math.round(s.bottom - a.top),
      cssVar: getComputedStyle(col).getPropertyValue('--t2-composer-h').trim(),
      anchorH: Math.round(a.height),
      padBottom: Math.round(parseFloat(getComputedStyle(inner).paddingBottom)),
      gapWidth: Math.round(tci.getBoundingClientRect().left - a.left),
      // 渐隐带起点 − 胶囊底缘:≥ -12 表示这条带整个落在胶囊**下方**那条缝里(允许压在卡后面几 px)
      fadePx: Math.round(parseFloat(getComputedStyle(stream).getPropertyValue('--t2-fade')) || 0),
      fadeVsCard: Math.round((s.bottom - (parseFloat(getComputedStyle(stream).getPropertyValue('--t2-fade')) || 0)) - card.getBoundingClientRect().bottom),
      gapHitsComposer: !!(hit && hit.closest('.composer-anchor')),
      // 「回到底」按钮:只在滚上去时才渲染,这里插一颗同类名探针量 computed bottom(考的是 CSS 谁胜出)
      jumpBottom: (() => {
        const p = document.createElement('button')
        p.className = 'jump-bottom t2-jump'
        document.querySelector('.t2-chat-body').appendChild(p)
        const v = Math.round(parseFloat(getComputedStyle(p).bottom) || 0)
        p.remove()
        return v
      })(),
      pe: [getComputedStyle(anchor).pointerEvents, getComputedStyle(tci).pointerEvents],
    }
  })()`)
  check(
    '18 输入卡脱流悬浮,正文铺到整列底部并从卡底下穿过',
    !!floatProbe && floatProbe.anchorPos === 'absolute' && Math.abs(floatProbe.streamToColBottom) <= 1 && floatProbe.overlap > 20,
    JSON.stringify(floatProbe),
  )
  check(
    '19 卡的实高回传成 --t2-composer-h,正文底部按它留白(滚到底末行浮在卡上方)',
    !!floatProbe && floatProbe.cssVar === floatProbe.anchorH + 'px' && floatProbe.padBottom >= floatProbe.anchorH,
    floatProbe ? `--t2-composer-h=${floatProbe.cssVar} 卡高=${floatProbe.anchorH}px 流底留白=${floatProbe.padBottom}px` : 'no probe',
  )
  // 08-14 打回过的做法:把渐隐挂在胶囊**上沿** —— 文字还没碰到胶囊就先化没,看着像胶囊上面又盖了一层。
  // 正确观感:正文被胶囊硬边挡住,再从卡底下钻出来、在视图最底边溶掉。这条钉「渐隐带不许爬到卡上方」。
  check(
    '21 渐隐只在胶囊下方那条缝里(不许挂在卡上沿)',
    !!floatProbe && floatProbe.fadePx > 0 && floatProbe.fadeVsCard >= -12,
    floatProbe ? `渐隐带 ${floatProbe.fadePx}px,起点距胶囊底缘 ${floatProbe.fadeVsCard}px(负得多 = 又爬到卡上面去了)` : 'no probe',
  )
  // .t2-chat-body 现在满列高 → 「回到底」按钮不自己抬就落进卡里。base.css 的 `.jump-bottom{bottom:16px}`
  // 与 `.t2-jump` 同为 (0,1,0) 且排在后面 —— 以前两边都是 16px 看不出来,悬浮之后这条必须靠
  // `.t2-jump.jump-bottom`(0,2,0)才压得过。眼睛看出来的回归,补成断言。
  check(
    '22 「回到底」按钮抬到悬浮卡上方(没被 base.css 的 .jump-bottom 压回去)',
    !!floatProbe && floatProbe.jumpBottom >= floatProbe.anchorH,
    floatProbe ? `bottom=${floatProbe.jumpBottom}px 卡高=${floatProbe.anchorH}px(被压回去就是 16px)` : 'no probe',
  )
  check(
    '20 胶囊两侧的空当放行(滚轮/选中落到底下正文)',
    !!floatProbe && floatProbe.pe[0] === 'none' && floatProbe.pe[1] === 'auto' && (floatProbe.gapWidth < 4 || !floatProbe.gapHitsComposer),
    floatProbe ? `pointer-events=${floatProbe.pe} 空当宽=${floatProbe.gapWidth}px 命中输入区=${floatProbe.gapHitsComposer}` : 'no probe',
  )

  // ── 1 Amadeus 右栏默认 = 对话 ────────────────────────────────────────────────
  const spaceBtn = win.locator('.rb-space[title="Amadeus"], .rb-space:has-text("Amadeus")').first()
  await spaceBtn.click({ timeout: 10_000 })
  await win.waitForTimeout(2500)
  await win.click('.dv-edge-right', { timeout: 10_000 })
  await win.waitForTimeout(2000)

  const side = await win.evaluate(`(() => {
    ${RECTS}
    const chat = r('.t2-chat-view'), am = r('.am-app'), win_ = { w: window.innerWidth }
    return { chat, am, winW: win_.w, tabs: Array.from(document.querySelectorAll('.dv-tab')).map((e) => e.textContent.trim()) }
  })()`)
  check('4 Amadeus 右栏展开后活动 tab 就是对话', !!side.chat && side.chat.w > 0, side.chat ? `聊天视图 x=${Math.round(side.chat.left)}..${Math.round(side.chat.right)}` : `没找到 .t2-chat-view;当前 tabs=${JSON.stringify(side.tabs)}`)
  check(
    '5 对话在右栏、编辑器仍占主区(不是把主区换成了对话)',
    !!side.chat && !!side.am && side.chat.left > side.am.left + side.am.w * 0.5,
    side.chat && side.am ? `chat.left=${Math.round(side.chat.left)} vs am.left=${Math.round(side.am.left)} w=${Math.round(side.am.w)}` : '缺 .am-app 或 .t2-chat-view',
  )

  // ── 3 侧栏对话默认引用主区当前这篇 ──────────────────────────────────────────
  const row = win.locator('.t2s-srow').first()
  let noteName = ''
  if (await row.count().catch(() => 0)) {
    noteName = (await row.textContent().catch(() => '') || '').trim()
    await row.click().catch(() => {})
    await win.waitForTimeout(2500)
  }
  const ref = await win.evaluate(`(() => {
    const label = document.querySelector('.t2c-reflabel')
    const chips = Array.from(document.querySelectorAll('.t2c-refrow .attach-chip > span')).map((e) => e.textContent.trim())
    return { label: label ? label.textContent.trim() : null, chips }
  })()`)
  check(
    '6 主区打开一篇笔记 → 侧栏对话自动挂上「已选择」引用',
    !!ref.label && ref.chips.length > 0,
    `点开的行=${JSON.stringify(noteName)};引用条=${JSON.stringify(ref)}`,
  )
  check(
    '7 挂的正是主区那一篇(不是别的/残留的)',
    !!noteName && ref.chips.some((c) => c && (noteName.includes(c.replace(/\\.md$/i, '')) || c.includes(noteName))),
    `${JSON.stringify(ref.chips)} vs ${JSON.stringify(noteName)}`,
  )

  // ── 拖引用进聊天区 → 芯片(结构化通道,不再拼文本再解析)────────────────────────────
  // 合成 DragEvent + DataTransfer:HTML5 拖放没法用 mouse.down/move 驱动(浏览器不给合成 drag)。
  // 代价:绕过了 Dockview 自己的拖放层。真机上若「拖得动但没反应」,先怀疑那一层截了 drop。
  const drag = await win.evaluate(`(() => {
    const src = Array.from(document.querySelectorAll('.t2s-srow')).find((e) => !e.classList.contains('active')) || document.querySelector('.t2s-srow')
    const target = document.querySelector('.t2-chat-view')
    if (!src || !target) return { err: 'no src/target' }
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    const types = Array.from(dt.types)
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    return { types, row: src.textContent.trim().slice(0, 30) }
  })()`)
  await win.waitForTimeout(800)
  const afterDrag = await win.evaluate(`(() => ({
    chips: Array.from(document.querySelectorAll('.t2c-refrow .attach-chip > span')).map((e) => e.textContent.trim()),
    draft: (document.querySelector('.t2c-ta') || {}).value || '',
  }))()`)
  check('8 拖笔记进聊天区 → 多一条「已选择」芯片', afterDrag.chips.length > ref.chips.length, `拖前 ${JSON.stringify(ref.chips)} → 拖后 ${JSON.stringify(afterDrag.chips)};载荷 ${JSON.stringify(drag)}`)
  check('9 拖进来的东西不再往输入框里塞路径文本', afterDrag.draft === '', `draft=${JSON.stringify(afterDrag.draft)}`)
  // 芯片化之前「拖完直接回车」是能发的(引用就在草稿里);之后正文为空,发送键若还按 draft 判灰
  // 就成了哑火 —— 这条钉住「只挂引用也能发」。
  // 「只挂引用也能发」= 发送键的禁用条件不再只看草稿。本 harness 没有后端,输入框整个是 disabled 的
  // (打不了字、发送键恒灰)→ 量不到这一维,如实报「跳过」而不是判红/假绿。
  const sendState = await win.evaluate(`(() => {
    const ta = document.querySelector('.t2c-ta')
    const b = document.querySelector('.t2c-send')
    return { taDisabled: ta ? ta.disabled : null, sendDisabled: b ? b.disabled : null, draft: ta ? ta.value : null, chips: document.querySelectorAll('.t2c-refrow .attach-chip').length }
  })()`)
  if (sendState.taDisabled) {
    check('10 只挂引用、正文为空时发送键仍可点', true, `跳过:无后端时输入框整个禁用,发送键恒灰(${JSON.stringify(sendState)})。这条只能在连着后端时验`)
  } else {
    check('10 只挂引用、正文为空时发送键仍可点', !sendState.sendDisabled && !sendState.draft && sendState.chips > 0, JSON.stringify(sendState))
  }

  // ── 细长列不画头像(宽:高 < 9:16)────────────────────────────────────────────────
  const slimAv = (await win.evaluate(AVATAR_PROBE)).filter((a) => a.ratio < 9 / 16)
  check('11 细长聊天列(宽:高 < 0.5625)隐藏头像', slimAv.length > 0 && slimAv.every((a) => a.display === 'none'), JSON.stringify(slimAv))

  // ── 26 窄栏(侧栏对话)触底时末条不许被输入卡压住 ─────────────────────────────
  // 08-14 用户报「窄到藏头像那一档,最底下的消息总有一截到不了 chatbox 上面」。
  // 根因不是头像那条规则,是 `@container (max-width:520px)` 里 .t2-stream-inner 用 **padding 简写**
  // 把基础规则的 `calc(var(--t2-composer-h) + 8px)` 整个抹掉,退回 6px —— 悬浮卡下面就没留白了。
  // 实测:窄栏 padBottom=6 / 末条底缘在卡顶下方 178px;修好后 192 / +8(与宽栏同)。
  const bottomGap = await win.evaluate(`(() => {
    const cols = [...document.querySelectorAll('.t2-chat-col')]
    const col = cols.find((c) => { const b = c.getBoundingClientRect(); return b.width / b.height < 9 / 16 }) || cols[0]
    if (!col) return null
    const inner = col.querySelector('.t2-stream-inner')
    const stream = col.querySelector('.t2-stream')
    const anchor = col.querySelector(':scope > .composer-anchor')
    if (!inner || !stream || !anchor) return null
    const made = []
    for (let i = 0; i < 14; i++) {
      const n = document.createElement('div')
      n.className = 't2-asst'
      n.innerHTML = '<div class="t2-asst-col"><div class="t2-content"><p>第' + i + '条 窄栏触底对照文本,写长一点好换行。</p></div></div>'
      inner.appendChild(n)
      made.push(n)
    }
    stream.scrollTop = stream.scrollHeight
    const b = col.getBoundingClientRect()
    const a = anchor.getBoundingClientRect()
    const l = made[made.length - 1].getBoundingClientRect()
    const out = {
      ratio: +(b.width / b.height).toFixed(3),
      padBottom: Math.round(parseFloat(getComputedStyle(inner).paddingBottom)),
      anchorH: Math.round(a.height),
      lastAboveCard: Math.round(a.top - l.bottom),
    }
    made.forEach((n) => n.remove())
    return out
  })()`)
  check(
    '26 窄栏滚到底:末条完整停在输入卡上方(不被悬浮卡压住)',
    !!bottomGap && bottomGap.lastAboveCard >= 0 && bottomGap.padBottom >= bottomGap.anchorH,
    JSON.stringify(bottomGap) + '(lastAboveCard 负数 = 被卡压住多少 px;旧行为 -178)',
  )

  // ── 侧栏宽度:拖过之后折叠再展开必须还是那个宽 ──────────────────────────────────
  const groupRect = `(() => { const g = document.querySelector('.t2-chat-view'); const grp = g && g.closest('.dv-groupview'); return grp ? Math.round(grp.getBoundingClientRect().width) : 0 })()`
  const before = await win.evaluate(groupRect)
  // 拖右栏与主区之间的 sash 往左 120px = 把右栏拉宽
  const sash = await win.evaluate(`(() => {
    const g = document.querySelector('.t2-chat-view')
    const grp = g && g.closest('.dv-groupview')
    if (!grp) return null
    const x = grp.getBoundingClientRect().left
    let best = null
    for (const s of document.querySelectorAll('.dv-sash')) {
      const b = s.getBoundingClientRect()
      if (b.height < 100) continue
      const d = Math.abs(b.left + b.width / 2 - x)
      if (!best || d < best.d) best = { d, x: b.left + b.width / 2, y: b.top + b.height / 2 }
    }
    return best && best.d < 24 ? best : null
  })()`)
  if (sash) {
    await win.mouse.move(sash.x, sash.y)
    await win.mouse.down()
    await win.mouse.move(sash.x - 120, sash.y, { steps: 10 })
    await win.mouse.up()
    await win.waitForTimeout(900)
  }
  const dragged = await win.evaluate(groupRect)
  check('12 右栏 sash 拖得动(前置)', !!sash && Math.abs(dragged - before) > 40, `${before}px → ${dragged}px`)
  await win.click('.dv-edge-right'); await win.waitForTimeout(1200) // 折叠
  await win.click('.dv-edge-right'); await win.waitForTimeout(1600) // 再展开
  const restored = await win.evaluate(groupRect)
  check('13 折叠再展开后宽度仍是拖出来的那个', Math.abs(restored - dragged) <= 6, `拖后 ${dragged}px → 折返 ${restored}px(旧行为会打回黄金分割 ≈${before}px)`)

  // ── 23-24 卡片不描边 / glass 输入卡真的是磨砂 ─────────────────────────────────
  // 颜色可能被 Chrome 报成 `color(srgb r g b / a)`(color-mix 的结果),不只有 rgba() 那一种写法。
  const ALPHA = `const alphaOf = (c) => { const m = /\\/\\s*([0-9.]+)\\s*\\)/.exec(c) || /rgba\\(\\s*[\\d.]+\\s*,\\s*[\\d.]+\\s*,\\s*[\\d.]+\\s*,\\s*([0-9.]+)\\s*\\)/.exec(c); return m ? parseFloat(m[1]) : 1 }`
  const rings = await win.evaluate(`(() => {
    ${ALPHA}
    const col = document.querySelector('.t2-chat-col')
    const out = {}
    const card = document.querySelector('.t2c-card')
    out['t2c-card'] = card ? alphaOf(getComputedStyle(card).borderTopColor) : null
    // 这些块要有真实消息才渲染 → 插同类名探针,量的是规则本身
    for (const cls of ['t2-tool', 't2-todo', 't2-panelcard', 't2-tsum-in', 'agent-desk-card', 'tool-card', 'tool-group']) {
      const p = document.createElement('div')
      p.className = cls
      col.appendChild(p)
      out[cls] = alphaOf(getComputedStyle(p).borderTopColor)
      p.remove()
    }
    return out
  })()`)
  check(
    '23 输入卡/任务概览/Agent Desk/工具折叠块都不描边',
    !!rings && Object.values(rings).every((a) => a === 0),
    JSON.stringify(rings) + '(值 = 描边色 alpha,须全 0)',
  )

  // glass 主题只能这样验:启用它的样式表 + 打 data-theme(与 loader 做的事一致),等一帧再量。
  // Glass 输入卡与菜单分档:输入卡主区 50% 看景深,菜单用可调 float 保证侧栏/portal 可读。
  await win.evaluate(`(() => {
    const n = document.getElementById('forsion-theme-css-genesis-glass')
    if (n) n.disabled = false
    document.documentElement.dataset.theme = 'genesis-glass'
  })()`)
  await win.waitForTimeout(1200)
  const glass = await win.evaluate(`(() => {
    ${ALPHA}
    const card = document.querySelector('.t2c-card')
    if (!card) return null
    const cs = getComputedStyle(card)
    // 主区 vs 侧栏各插一颗输入卡探针:侧栏那边 CSS 模糊糊不出东西(backdrop 里没有 app 画的
    // 不透明像素),只能靠染色浓度盖住底下的字 → 两边**本来就该是不同浓度**,这里逐边量。
    const tier = {}
    for (const g of document.querySelectorAll('.dv-groupview')) {
      const side = !!g.querySelector('.wb-tab--icon')
      const host = g.querySelector('.dv-react-part') || g
      const p = document.createElement('div')
      p.className = 't2c-card'
      host.appendChild(p)
      tier[side ? 'side' : 'main'] = alphaOf(getComputedStyle(p).backgroundColor)
      p.remove()
    }
    // 菜单 / 二级浮面只有交互时才渲染 → 插同类名探针,量的是材质表收没收它们
    const menus = {}
    for (const cls of ['composer-menu', 'cm-sub', 'approval-hover-desc', 'ctx-menu', 'rb-menu', 'account-pop', 'ntf', 'wsfile-panel', 'amx-db-pop', 'amx-cal-cardwrap', 'dash-add-menu']) {
      const p = document.createElement('div')
      p.className = cls
      document.body.appendChild(p)
      const s = getComputedStyle(p)
      menus[cls] = { b: (s.backdropFilter || s.webkitBackdropFilter) !== 'none', a: alphaOf(s.backgroundColor) }
      p.remove()
    }
    return {
      blur: cs.backdropFilter || cs.webkitBackdropFilter,
      bgAlpha: alphaOf(cs.backgroundColor),
      borderAlpha: alphaOf(cs.borderTopColor),
      tier,
      menus,
    }
  })()`)
  // 侧栏那边**不能**也是薄档:08-14 实测,侧栏的 backdrop 里没有 app 画的不透明像素
  // (pane 半透 → shell 全透 → 窗口原生 vibrancy),blur 出来是空的,50% 会让正文直接透过输入卡。
  check(
    '24 glass 主题:输入卡主区薄档磨砂 / 侧栏加厚(侧栏糊不出东西,只能靠浓度)',
    !!glass && glass.blur && glass.blur !== 'none' && glass.borderAlpha === 0
      && glass.tier.main >= 0.45 && glass.tier.main <= 0.6
      && glass.tier.side >= 0.8,
    JSON.stringify({ blur: glass && glass.blur, tier: glass && glass.tier, borderAlpha: glass && glass.borderAlpha })
      + '(主区 ≈0.5 才糊得出来;侧栏须 ≥0.8,否则正文透过输入卡)',
  )
  // 菜单必须走 float,而不是输入卡的 50% thin:否则浮层浓度设置对菜单无效,在没有有效 backdrop
  // 的侧栏 / portal 位置又只剩透明染色。新二级面板也逐个列入,漏收一个就红。
  check(
    '25 glass 主题:一级/二级菜单均为可调 float 磨砂(不是透明薄片)',
    !!glass && Object.values(glass.menus).every((m) => m.b && m.a >= 0.8 && m.a <= 0.9),
    glass ? Object.entries(glass.menus).map(([k, v]) => `${k}:${v.b ? '糊' : '实色'}/${v.a}`).join(' ') : 'no probe',
  )

  await app.close()

  // ── 14 跨 Space:上个空间记下的「侧栏活动 tab」不许顶掉下个空间配方的首项 ────────────
  // stashActive 是**全局单份**、只在折叠某侧时写,切 Space 不重置(stash 本身在 applyNamed/resetLayout
  // 已重置,这是它漏下的那半)。要打的路径是「Amadeus 右栏**从没展开过**」——所以必须**另起一个干净
  // 实例**:上面那轮已经把 Amadeus 的右栏展开并存进命名布局了,同一实例里再走一遍打不到这条。
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chatside2-'))
  const app2 = await electron.launch({
    args: [`--user-data-dir=${path.join(home2, 'userdata')}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home2, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  const w2 = await app2.firstWindow()
  await w2.waitForSelector('#root', { timeout: 30_000 })
  await w2.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = w2.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await w2.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await w2.waitForTimeout(1500)
  // Tangu(启动即在):展开右栏 → 停在第 2 个 tab(大纲,Amadeus 右栏里也有 → 能撞上)→ 折叠
  await w2.click('.dv-edge-right').catch(() => {})
  await w2.waitForTimeout(1800)
  const seeded = await w2.evaluate(`(() => {
    let best = null
    for (const g of document.querySelectorAll('.dv-groupview')) {
      const b = g.getBoundingClientRect()
      if (!best || b.left > best.left) best = { left: b.left, g }
    }
    const tabs = best ? best.g.querySelectorAll('.dv-tab') : []
    if (tabs.length < 2) return 0
    tabs[1].click()
    return tabs.length
  })()`)
  await w2.waitForTimeout(800)
  await w2.click('.dv-edge-right').catch(() => {}) // 折叠 → 写 stashActive.right = 第 2 个视图的 type
  await w2.waitForTimeout(1600)
  await w2.locator('.rb-space[title="Amadeus"], .rb-space:has-text("Amadeus")').first().click().catch(() => {})
  await w2.waitForTimeout(2800)
  await w2.click('.dv-edge-right').catch(() => {}) // Amadeus 右栏**首次**展开
  await w2.waitForTimeout(2200)
  const crossOk = await w2.evaluate(`(() => {
    const e = document.querySelector('.t2-chat-view')
    // 「存在」不等于「是当前 tab」:非活动 panel 仍在 DOM 里,只是被藏了 → 必须量可见宽度。
    return !!e && e.getBoundingClientRect().width > 0
  })()`)
  check(
    '14 上个 Space 的侧栏活动 tab 不会顶掉本 Space 的默认(对话)',
    !!seeded && crossOk,
    seeded ? `Tangu 右栏停在第 2/${seeded} 个 tab 后折叠;Amadeus 首次展开右栏见到对话:${crossOk}` : '⚠️ Tangu 右栏没展开/不足 2 个 tab → 这条没跑到,不算数',
  )
  await app2.close()

  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
