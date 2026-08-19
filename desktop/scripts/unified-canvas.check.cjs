// 块上画布 Phase 1 的出口门仪器(方案 §7,2026-08-16)。用法:node scripts/e2e-editor.cjs --check=unified-canvas
//
// 覆盖面按「会毁数据 / 用户看得见」两条挑,不追覆盖率:
//   C1 默认文档模式 + 切画布不写盘(懒物化,用户拍板:「它首先是个文档」)
//   C2 从 ⠿ 拖到舞台空白 = 成卡,且**恰好一次**物化(mode/main/cards 齐)
//   C3 卡片几何:视口矩形 == 舞台原点 + (x,y)·z,缩放后仍成立
//      ——这条同时在守「主卡用 margin 而不是 position/transform 偏移」:一旦有人改成 position,
//        卡片的包含块就从舞台变成主卡,落盘坐标全部错位,而肉眼在 1 倍下几乎看不出来
//   C4 落盘 → 重新载入 → 折叠还原出同一张卡(round-trip)
//   C5 P0:折叠 fail-closed 退出的文件,编辑一次后 canvas 行**逐字不变**(否则打开就敲一个字=画布没了)
//   C6 收回文档:卡拆壳回自然流,锚转惰性字面留下(锚永不回收)
//   C7 卡片调宽 → 单笔 attr 事务进撤销栈,Cmd+Z 一击还原
//   C12 白板层只读渲染:连线端点落在卡边上、悬空端点不画、整层不吃指针、offsetParent 契约
//   C13 P0:切模式**不重挂编辑器**(旧实现 Fragment↔div 跳变 = 撤销栈每切一次就没一次)
//   C14 撤销步隔断的后沿:拖完立刻打字,一次 Cmd+Z 只回退打字
//   C15 端点悬空的连线不渲染但一个字节不改地留在盘上
//   C19 P0:拖形状落盘时,条目里的未知字段与顶层未知键**逐字幸存**(写侧不许拿 safeElements 回吐)
//   C20 删形状顺手剪断头连线,卡锚之间的连线一条不动
//   C21 空白拖 = 框选(不是平移),卡与形状同进一个选中集合
//   C22 元素自带的撤销栈(fm 在 PM 事务根之外,Cmd+Z 够不着 —— 见 canvasStage 顶注)
//   C23 连线工具的两点成线
//   C24 卡内打字时舞台键盘让路(不挡的话退格会删掉选中的形状)
//   C27 P0:跨卡拖块落**进**目标卡,绝不落在「卡与卡之间」的 doc 顶层(那会拆壳、锚字面显形)
//   C34 真实输入(CDP)拖卡:拖拽**中途**实时跟手 + 抬起态(此前全部断言只看松手落点)
//   C35 Shift+滚轮 = 横向平移
//   C36 统一撤销时间线(a 跨域时序 / b Tab=pair 一击双退 / c 卡内 Cmd+Z 同样按时序)
//   C37 跨卡选区夹断(原生扫选夹回 anchor 容器;卡内 Cmd+A 只全选本卡)
//   C38 ⠿ 拖已有卡片到舞台空白 = 搬卡(修前被静默吞掉)
//   C39 主卡完全等同卡片(chrome 圈选中/拖动跟手/落盘/撤销/连线 {main:true};「正文」条已移除)
//   C40 连线橡皮筋预览 + 有效目标高亮
//   C41 删卡撤销:层级跟卡一起回来(逐字),重做回认祖父形态(Codex F1)
//   C42 素笔记首次拖主卡:撤销真回默认位 + 派生自然去物化(Codex F3)
//   C43 编辑器重建后 pair 半边失效 → 整条丢弃,绝不半撤销(Codex F2)
//   C44 主卡两段式(一击选中不落光标/二击进编辑/Esc 退回)+ Delete/全选删除动不了主卡
//   C45 文档模式卡片零装饰无缝;悬停/光标进入浮现整块约束框(含卡内块级 NodeSelection);不泄画布
//      (2026-08-18 深夜追加钉值:offset 2px / 圆角 6px —— 用户拍板「削弱弧度防重合」)
//   C46 画布右键捕获期仲裁:先于 blockLayer,单菜单,不绕两段式/免删(Codex 08-18 晚 high)
//   C47 双击真实命中:双击卡片=进编辑不建卡;双击形状=文字弹窗不建卡;双击空白=建卡
//      (e.target 被 pointer capture 重定向到 host,isBlank 误判 —— 2026-08-18 深夜用户实报)
//   C48 (2026-08-19 闭合锚重写)a=缝上落点入上卡尾+undo 一击;b=散块留顶层=合法正文(吸收退役);
//      c=拖卡=整卡搬家(拆壳退役,只走块菜单收回)
//   C49 标题回车:首块空段=落光标;首块有内容(段/卡)=顶插空白首行;方向键滑入不插行
//      (C49d/e 改名竞态,Codex 深夜 F2:档位逐次 commit 绑定 —— 点走 blur 改名不插行不抢焦点)
//   C50 尾部恒可写:末段有字点 page-tail=追加空段;空段不重复加;末块是卡=**卡后顶层**新行(08-19)
//   C51 卡片完整性两道闸(Codex 深夜 F1):粘贴卡=transformPasted 解壳落内容;嵌套卡/顶层重复锚
//      的事务被 filterTransaction 整笔拒(修前:粘贴/拖复制出的卡 → 重开整篇画布拒折)
//   C52 tab 缩进子树=整体单元(抓父段=父+子+孙;拖动/Cmd+Z/Delete 全整树;AFFiNE/Notion 同款)
//   C53 编辑态光标:进卡编辑=该卡 text,他卡/主卡仍 grab(单元素规则钉泄漏);Esc 退回
//   C54 卡缝插入口:悬停相邻两卡缝浮现 + 行,点击=缝间插空段;卡体上/画布模式不出
//   C55 闭合锚迁移:旧格式照折;编辑保存即补闭合符;闭合/混合形重开照折且闭合符零显形
//   C57 主卡也能长子节点(Tab/回车);层级哨兵 `m:` 过得了派生剪枝(重开仍在)
//   C58 卡侧 ⊕:点得中(元素层 pointer-events)、建卡连线、编辑态收起
//   C59 形状四角塑型:把手不再被 overflow 裁掉(真鼠标命中);对角固定 + 夹到最小也不走位
//   C60 Frame 进工具栏 + 矩形/椭圆/Frame 拖出尺寸(拖不动则回落默认尺寸)
//   C61 拖到卡边缘=认亲:右缘=子+吸附队列+一击撤销/下缘=兄弟(目标顶层则摘爹)/环形目标不给认
//   C62 层级线可选中 + Delete=解除关系(卡片不动);Cmd+A 不收线
//   C61c 卡心中立区:边缘带按盒尺寸取比例,一行卡也留得出「只是挪位置」的落点
//   C63 箭头工具:卡→卡=建父子(零连线条目),卡→形状/Shift=仍自由连线
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** ⚠️ 本仪器**整套**跑生产壳镜像 `&upane`:模式胶囊住在笔记顶栏 `.amx-toolbar` 里(生产由
 *  amadeusViews 渲染),默认那个 720px 居中盒子根本没有顶栏 —— 在那儿测切模式等于测一个
 *  用户永远看不到的形态。满铺的两个真风险(脱不出纸面 / 盖住顶栏)也只有这个壳能暴露。
 *  (unified-page / unified-columns 仍吃默认壳,别去动它们的几何。) */
async function open(browser, seed) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(400)
  return p
}

/** 按**标题**挑工具,不按位置 —— nth-child 写死的下场是往工具栏里插一个按钮,连线那几条
 *  (C19/C23/C39/C40)全部静默改测「新工具」并挂掉(2026-08-19 加 Frame 时实测)。 */
const pickTool = async (p, title) => {
  const i = await p.evaluate((t) => [...document.querySelectorAll('.amx-stage-tools button')].findIndex((b) => (b.title ?? '').includes(t)), title)
  if (i < 0) throw new Error(`工具栏没有「${title}」`)
  await p.click(`.amx-stage-tools button:nth-child(${i + 1})`)
}

const fmOf = (p) => p.evaluate(() => {
  window.__upage.probe.flush?.()
  return window.__upage.probe.fmState?.().fm ?? ''
})
const canvasLine = (fm) => (/^amadeus_canvas:\s*(.*)$/m.exec(fm ?? '') || [])[1] ?? null

/* ⚠️「在不在画布模式」的判据:2026-08-17 舞台改为**常驻**(文档模式挂 .amx-stage-off + display:contents)
 *  之后,`!!querySelector('.amx-stage')` 恒真 —— 拿它当判据的断言会静默退化成恒绿(对抗评审 P2:
 *  C4/C10/C11 三处都中了)。下面各处一律写成 `!!s && !s.classList.contains('amx-stage-off')`。 */

/** 从 ⠿ 把某个顶层块拖到舞台的某个视口点。blockLayer 的真实链路:mousedown 设 NodeSelection
 *  → dragstart 挂 view.dragging → 舞台的 drop 接管。合成 DragEvent 是唯一可行的驱动方式
 *  (Playwright 的 mouse 拖不触发 HTML5 dnd)。 */
async function dragBlockToStage(p, text, at) {
  const box = await p.evaluate(({ text }) => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror > *')].find((x) => (x.textContent ?? '').includes(text))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, { text })
  if (!box) return false
  await p.mouse.move(box.x, box.y)
  await p.waitForTimeout(220) // 等把手上屏(hover 追踪有节流)
  return p.evaluate(({ at }) => {
    const gutter = document.querySelector('.unified-gutter')
    const drag = gutter?.querySelector('.drag-handle')
    const stage = document.querySelector('.amx-stage')
    if (!gutter || !drag || !stage) return false
    const fire = (ev, target, opts) => target.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, ...opts }))
    drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const dt = new DataTransfer()
    fire('dragstart', gutter, { dataTransfer: dt })
    const opts = { clientX: at.x, clientY: at.y, dataTransfer: dt }
    fire('dragover', stage, opts)
    fire('drop', stage, opts)
    fire('dragend', gutter, { dataTransfer: dt })
    return true
  }, { at })
}

/** 把某个块从 ⠿ 拖到**另一个块上**(frac:0=顶边 .5=中 1=底边)。与 dragBlockToStage 同一条真实链路,
 *  区别只是 drop 派发在编辑器 DOM 之内 —— 那条路由归 blockLayer 的捕获期 onDropCapture。 */
async function dragBlockOnto(p, text, targetText, frac) {
  const box = await p.evaluate(({ text }) => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => (x.textContent ?? '').trim() === text)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, { text })
  if (!box) return 'no-source'
  await p.mouse.move(box.x, box.y)
  await p.waitForTimeout(240) // 等把手上屏(hover 追踪有节流)
  return p.evaluate(({ targetText, frac }) => {
    const gutter = document.querySelector('.unified-gutter')
    const drag = gutter?.querySelector('.drag-handle')
    if (!gutter || !drag) return 'no-handle'
    const tgt = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => (x.textContent ?? '').trim() === targetText)
    if (!tgt) return 'no-target'
    const r = tgt.getBoundingClientRect()
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height * frac }
    const fire = (ev, target, opts) => target.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, ...opts }))
    drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const dt = new DataTransfer()
    fire('dragstart', gutter, { dataTransfer: dt })
    const el = document.elementFromPoint(at.clientX, at.clientY) ?? tgt
    fire('dragover', el, { ...at, dataTransfer: dt })
    fire('drop', el, { ...at, dataTransfer: dt })
    fire('dragend', gutter, { dataTransfer: dt })
    return 'ok'
  }, { targetText, frac })
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const SEED = '# 画布页\n\n主卡一段。\n\n要拖出去的段。\n'

  // ── C1 默认文档模式 + 切画布不写盘 ────────────────────────────────────────────
  const p = await open(browser, SEED)
  // ⚠️ 2026-08-17 起判据从「舞台元素不存在」改成「舞台常驻但不产生盒子」:元素必须常驻,
  //    否则切模式时槽位元素类型跳变 → React 重挂编辑器 → 撤销栈每切一次没一次(C13)。
  //    这里三条一起断言,`display:contents` + 零盒子 = 文档模式的布局一个像素都没被舞台碰过;
  //    `position: static` 是 blockLayer overlayOrigin 的护栏(没有盒子的 relative 祖先会被它挑中,
  //    getBoundingClientRect 恒 0 → 块浮层整体偏一个容器位)。
  const c1a = await p.evaluate(() => {
    const st = document.querySelector('.amx-stage')
    const cs = st ? getComputedStyle(st) : null
    // 内层单独查:外层零盒子而内层退回 absolute 的话,编辑器就脱出正常流了,而只看外层照绿
    // (Codex 评审 P2)。两层都必须 display:contents + position:static + 零盒子。
    const inner = document.querySelector('.amx-stage-inner')
    const ics = inner ? getComputedStyle(inner) : null
    return {
      off: !!st && st.classList.contains('amx-stage-off'),
      boxes: st ? st.getClientRects().length : -1,
      disp: cs?.display ?? '',
      pos: cs?.position ?? '',
      innerOk: !!inner && ics.display === 'contents' && ics.position === 'static' && inner.getClientRects().length === 0,
      hud: !!document.querySelector('.amx-stage-hud'),
      seg: [...document.querySelectorAll('.amx-modeseg button')].map((b) => `${b.textContent}${b.classList.contains('on') ? '*' : ''}`).join('|'),
      thumb: document.querySelector('.amx-modeseg .t2s-vaultseg-thumb')?.dataset.side ?? '',
      writes: window.__upage.writes.length,
    }
  })
  record('C1 打开默认文档模式(舞台内外两层都零盒子/零 HUD,钮邀请进画布)',
    c1a.off && c1a.boxes === 0 && c1a.disp === 'contents' && c1a.pos === 'static' && c1a.innerOk && !c1a.hud && c1a.seg === '文档*|画布' && c1a.thumb === 'doc' && c1a.writes === 0,
    JSON.stringify(c1a))

  await p.click('.amx-modeseg button:nth-child(3)')
  await p.waitForTimeout(1200) // 跨过 800ms 防抖窗
  const c1b = await p.evaluate(() => {
    const st = document.querySelector('.amx-stage')
    return {
      on: !!st && !st.classList.contains('amx-stage-off') && st.getClientRects().length === 1,
      hud: !!document.querySelector('.amx-stage-hud'),
      writes: window.__upage.writes.length,
      fm: window.__upage.probe.fmState?.().fm ?? '',
    }
  })
  record('C1 切到画布 = 只换视角,零写盘且 fm 不物化(懒物化)',
    c1b.on && c1b.hud && c1b.writes === 0 && !c1b.fm.includes('amadeus_canvas'), JSON.stringify({ ...c1b, fm: c1b.fm.length }))

  // ── C2 拖出成卡 + 恰好一次物化 ────────────────────────────────────────────────
  const stageBox = await p.evaluate(() => {
    const r = document.querySelector('.amx-stage').getBoundingClientRect()
    return { x: r.right - 90, y: r.bottom - 90 } // 舞台右下角空白处
  })
  const dragged = await dragBlockToStage(p, '要拖出去的段', stageBox)
  await p.waitForTimeout(1400)
  const c2 = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.amx-ucard')]
    return {
      n: cards.length,
      text: cards[0]?.textContent ?? '',
      // ⚠️ 卡片节点本身就是 .ProseMirror 的子节点,量 ProseMirror.textContent 会把卡里的字也算进来,
      //    于是「搬迁 vs 复制」这一格恒绿。只数**非卡片**的顶层块。
      inMain: [...document.querySelectorAll('.unified-body .ProseMirror > *')]
        .filter((el) => !el.classList.contains('amx-ucard'))
        .some((el) => (el.textContent ?? '').includes('要拖出去的段')),
      writes: window.__upage.writes.length,
      last: window.__upage.writes.at(-1)?.text ?? '',
    }
  })
  const cj = canvasLine(c2.last)
  let parsed = null
  try { parsed = JSON.parse(cj) } catch { /* 下面按 null 断言 */ }
  record('C2 拖到舞台空白 → 成卡(正文搬迁走,不是复制)',
    dragged && c2.n === 1 && c2.text.includes('要拖出去的段') && !c2.inMain, JSON.stringify({ dragged, n: c2.n, inMain: c2.inMain }))
  record('C2 物化恰好一次,mode/main/cards 齐且落盘带 schema',
    c2.writes === 1 && !!parsed && parsed.v === 1 && parsed.mode === 'canvas' && parsed.main?.w > 0 &&
    parsed.cards?.length === 1 && /^amadeus_schema:/m.test(c2.last),
    JSON.stringify({ writes: c2.writes, canvas: parsed }))

  // ── C3 几何:视口矩形 == 舞台原点 + (x,y)·z ─────────────────────────────────────
  const geo = async () => p.evaluate(() => {
    const inner = document.querySelector('.amx-stage-inner')
    const card = document.querySelector('.amx-ucard')
    if (!inner || !card) return null
    const m = new DOMMatrixReadOnly(getComputedStyle(inner).transform)
    const ir = inner.getBoundingClientRect() // inner 是 0×0:它的 left/top 就是舞台坐标原点
    const cr = card.getBoundingClientRect()
    const x = Number(card.dataset.x); const y = Number(card.dataset.y); const w = Number(card.dataset.w)
    // ⚠️ x/y 一并回报:两者都是 0 时「卡片落在舞台原点」这条断言平凡成立,坐标系全错也照样绿。
    return { z: m.a, x, y, dx: cr.left - (ir.left + x * m.a), dy: cr.top - (ir.top + y * m.d), dw: cr.width - w * m.a }
  })
  const g1 = await geo()
  const nonTrivial = (g) => !!g && Math.abs(g.x) > 20 && Math.abs(g.y) > 20 // 前置条件,见 geo() 注
  record('C3 卡片落点 == 舞台原点+(x,y)·z(±1.5px,含宽度;坐标非零)',
    nonTrivial(g1) && Math.abs(g1.dx) <= 1.5 && Math.abs(g1.dy) <= 1.5 && Math.abs(g1.dw) <= 1.5, JSON.stringify(g1))

  await p.evaluate(() => {
    const stage = document.querySelector('.amx-stage')
    const r = stage.getBoundingClientRect()
    stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -240, clientX: r.left + 200, clientY: r.top + 200 }))
  })
  await p.waitForTimeout(200)
  const g2 = await geo()
  record('C3 Cmd+滚轮缩放后同一条不变式仍成立(缩放真生效)',
    nonTrivial(g2) && g2.z > (g1?.z ?? 1) + 0.05 && Math.abs(g2.dx) <= 1.5 && Math.abs(g2.dy) <= 1.5 && Math.abs(g2.dw) <= 1.5, JSON.stringify(g2))

  // ── C7 调宽 = 单笔事务,Cmd+Z 一击还原 ────────────────────────────────────────
  const w0 = await p.evaluate(() => Number(document.querySelector('.amx-ucard').dataset.w))
  // pointerdown 必须**派发在卡片自身**上:舞台的处理器靠 `target === card` 判定「指针落在卡的
  // chrome 圈上而不是正文里」,直接往 stage 上派发的话 target 是 stage,判定走的是另一条分支(平移)。
  await p.evaluate(() => {
    const card = document.querySelector('.amx-ucard')
    const stage = document.querySelector('.amx-stage')
    const r = card.getBoundingClientRect()
    const mk = (t, x) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x, clientY: r.top + 6 })
    card.dispatchEvent(mk('pointerdown', r.right - 3))
    stage.dispatchEvent(mk('pointermove', r.right + 120))
    stage.dispatchEvent(mk('pointerup', r.right + 120))
  })
  await p.waitForTimeout(400)
  const w1 = await p.evaluate(() => Number(document.querySelector('.amx-ucard').dataset.w))
  await p.evaluate(() => window.__upage.probe.view().focus())
  await p.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await p.waitForTimeout(300)
  const w2 = await p.evaluate(() => Number(document.querySelector('.amx-ucard').dataset.w))
  record('C7 拖右缘调宽 → 单笔 attr 事务,Cmd+Z 一击还原', w1 > w0 + 40 && w2 === w0, JSON.stringify({ w0, w1, w2 }))

  // C7b 撤销必须真的落盘,不只是 DOM 回退(Codex 指出的假绿面:C7 只等 300ms 就读 writes,
  //     根本没跨过 800ms 防抖窗,「界面撤销了但盘上还是新宽度」照样会绿)。
  await p.waitForTimeout(1200)
  const c7b = await p.evaluate(() => {
    window.__upage.probe.flush?.()
    const line = /^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '')
    try { return JSON.parse(line[1]).cards[0].w } catch { return null }
  })
  record('C7b 撤销后落盘的宽度也回到原值(不只是 DOM 回退)', c7b === w0, JSON.stringify({ w0, stored: c7b }))

  const saved = await p.evaluate(() => window.__upage.writes.at(-1)?.text ?? '')
  await p.close()

  // ── C4 round-trip:落盘的文件重新载入 → 折出同一张卡 ─────────────────────────────
  const p4 = await open(browser, saved)
  await p4.waitForTimeout(300)
  const c4 = await p4.evaluate(() => ({
    stage: (() => { const s = document.querySelector('.amx-stage'); return !!s && !s.classList.contains('amx-stage-off') })(), // mode:"canvas" 已物化 → 打开直接进画布
    cards: [...document.querySelectorAll('.amx-ucard')].map((c) => ({ a: c.dataset.anchor, x: c.dataset.x, t: c.textContent })),
    raw: (document.querySelector('.unified-body .ProseMirror').textContent ?? '').includes('<!-- a '),
  }))
  record('C4 round-trip:重载后折出同一张卡,且正文里看不到锚字面',
    c4.stage && c4.cards.length === 1 && c4.cards[0].t.includes('要拖出去的段') && !c4.raw, JSON.stringify(c4))

  // ── C6 收回文档:拆壳 + 锚转惰性 ───────────────────────────────────────────────
  const anchor = c4.cards[0]?.a
  await p4.evaluate((a) => {
    const v = window.__upage.probe.view()
    let pos = null
    v.state.doc.forEach((n, off) => { if (n.type.name === 'amadeusCanvasCard' && n.attrs.anchor === a) pos = off })
    if (pos == null) return
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(pos + 1))))
  }, anchor)
  await p4.evaluate(async () => {
    const { unwrapCard } = await import('/src/amadeus/unified/canvasStage.tsx')
    unwrapCard(window.__upage.probe.view(), document.querySelector('.amx-ucard')?.dataset.anchor ?? '')
  })
  await p4.waitForTimeout(1400)
  const c6 = await p4.evaluate(() => {
    window.__upage.probe.flush?.()
    const last = window.__upage.writes.at(-1)?.text ?? ''
    return { cards: document.querySelectorAll('.amx-ucard').length, last }
  })
  record('C6 收回文档:卡拆壳回自然流,锚转惰性字面留下(锚永不回收),canvas 键随之解散',
    c6.cards === 0 && new RegExp(`<!-- a ${anchor} -->`).test(c6.last) && c6.last.includes('要拖出去的段') && !/^amadeus_canvas:/m.test(c6.last),
    JSON.stringify({ cards: c6.cards, hasMarker: new RegExp(`<!-- a ${anchor} -->`).test(c6.last) }))
  await p4.close()

  // ── C5 P0:折叠 fail-closed 的文件,编辑一次后 canvas 行逐字不变 ──────────────────
  // 锚 c9 在正文里根本不存在 → foldCanvas 整体退出 → doc 里零卡片。没有 sawCards 判据的话,
  // 派生会判成「用户把卡删光了」当场剥键:打开这种文件敲一个字,画布几何全没。
  const BROKEN = '---\namadeus_schema: amadeus.page/4\namadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"c9","x":11,"y":22,"w":333}]}\n---\n\n正文一段。\n'
  const p5 = await open(browser, BROKEN)
  const before = canvasLine(await fmOf(p5))
  await p5.click(`${PM} > p`)
  await p5.keyboard.type('改')
  await p5.waitForTimeout(1400)
  const after = canvasLine(await fmOf(p5))
  const c5w = await p5.evaluate(() => window.__upage.writes.at(-1)?.text ?? '')
  record('C5 折叠没成功过 → 编辑后 canvas 行逐字不变(P0 防抹画布)',
    !!before && after === before && c5w.includes('amadeus_canvas:') && c5w.includes('改'),
    JSON.stringify({ same: after === before, before: (before ?? '').slice(0, 40) }))
  await p5.close()

  // ── C9 三张卡:收回中间那张,前面的卡**一张都不许被连带拆掉** ────────────────────────
  // 第一版就地拆壳时必现:c2 一收回,「尾部连续卡区」只剩 c3,normalizer 立刻判 c1 是游离卡也拆了。
  // C6 只测「重开后的一张卡」,这一格永远绿(Codex 点名的假绿面)。
  const THREE = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":300},{"ref":"k2","x":40,"y":300,"w":300},{"ref":"k3","x":40,"y":560,"w":300}]}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一。', '', '<!-- a k2 -->', '卡二。', '', '<!-- a k3 -->', '卡三。', '',
  ].join('\n')
  const p9 = await open(browser, THREE)
  await p9.waitForTimeout(400)
  const before9 = await p9.evaluate(() => document.querySelectorAll('.amx-ucard').length)
  await p9.evaluate(async () => {
    const { unwrapCard } = await import('/src/amadeus/unified/canvasStage.tsx')
    unwrapCard(window.__upage.probe.view(), 'k2')
  })
  await p9.waitForTimeout(1400)
  const c9 = await p9.evaluate(() => {
    window.__upage.probe.flush?.()
    const line = /^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '')
    let refs = null
    try { refs = JSON.parse(line[1]).cards.map((c) => c.ref) } catch { /* 下面按 null 断言 */ }
    return { n: document.querySelectorAll('.amx-ucard').length, refs, body: window.__upage.probe.fmState?.().body ?? '' }
  })
  record('C9 收回中间的卡:只走它自己,k1/k3 仍是卡且 cards 只掉一枚',
    before9 === 3 && c9.n === 2 && JSON.stringify(c9.refs) === JSON.stringify(['k1', 'k3']) && /<!-- a k2 -->/.test(c9.body),
    JSON.stringify({ before: before9, ...c9, body: undefined }))
  await p9.close()

  // ── C10 折叠失败的文件里再拖出一张新卡:磁盘上那份 cards **一个字节都不许动** ─────────
  // C5 只测「坏文件里敲字」,而真正会毁数据的是「坏文件里做画布操作」——只挡「卡为空」的实现
  // 会用只含新卡的数组整体替换掉旧 cards(Codex P0-1),而 C5 照样绿。
  const BROKEN2 = '---\namadeus_schema: amadeus.page/4\namadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"c9","x":11,"y":22,"w":333}]}\n---\n\n可拖的一段。\n\n又一段。\n'
  const p10 = await open(browser, BROKEN2)
  await p10.waitForTimeout(300)
  const before10 = canvasLine(await fmOf(p10))
  const stage10 = await p10.evaluate(() => {
    // ⚠️ 判据不能是「元素存在」:舞台常驻后那恒真,而文档模式下 dragover/drop 根本没挂、
    //    display:contents 的 rect 又四项全 0 → 拿到 (-80,-80)、一张卡都建不出来,而
    //    「canvas 行不变」在「什么都没发生」时平凡成立 = 这一格从大声失败退化成静默通过。
    const s = document.querySelector('.amx-stage')
    if (!s || s.classList.contains('amx-stage-off')) return null
    const r = s.getBoundingClientRect()
    if (r.width <= 0) return null
    return { x: r.right - 80, y: r.bottom - 80 }
  })
  const dragged10 = stage10 ? await dragBlockToStage(p10, '可拖的一段', stage10) : false
  await p10.waitForTimeout(1400)
  const after10 = canvasLine(await fmOf(p10))
  // 前置断言:卡**真的**建出来了。dragBlockToStage 返回 true 只说明事件派发成功,块被卡片盖住时
  // NodeSelection 会落在卡节点上、blockToCard 直接返回 null —— 那时这一格照样「canvas 行不变」。
  const made10 = await p10.evaluate(() => document.querySelectorAll('.amx-ucard').length)
  record('C10 折叠失败的文件里拖出新卡 → canvas 行逐字不变(旧卡几何不被顶掉)',
    !!stage10 && dragged10 && made10 >= 1 && !!before10 && after10 === before10 && /"ref":"c9"/.test(after10),
    JSON.stringify({ dragged: dragged10, cards: made10, same: after10 === before10 }))
  await p10.close()

  // ── C11 插件格式迁移产物必须真能折回卡片 ────────────────────────────────────────────
  // 迁移函数自己的契约在 shared/amadeus/compiler/canvasMigrate.test.ts;这里补的是另一半:
  // 迁移**写对了**不等于折叠**接受它**(cards 序 / 末锚 / 元素保管三条任意一条不合就整体拒折,
  // 用户看到的就是「迁移了但还是没有卡」)。种子 = 迁移器对用户真实文件的实际输出形状。
  const MIGRATED = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"2","x":0,"y":56,"w":280},{"ref":"4","x":340,"y":56,"w":400},{"ref":"3","x":-4,"y":198,"w":400}],"elements":[{"id":"e1","type":"connector","from":{"ref":"2"},"to":{"ref":"4"}}]}',
    'icon: 🏦', '---', '', 'Canva1', '', '<!-- a 2 -->', '', '然后呢', '', '<!-- a 4 -->', '', '可是', '', '<!-- a 3 -->', '', '轻松绷', '',
  ].join('\n')
  const p11 = await open(browser, MIGRATED)
  await p11.waitForTimeout(400)
  const c11a = await p11.evaluate(() => ({
    stage: (() => { const s = document.querySelector('.amx-stage'); return !!s && !s.classList.contains('amx-stage-off') })(),
    cards: [...document.querySelectorAll('.amx-ucard')].map((c) => c.dataset.anchor),
    raw: (document.querySelector('.unified-body .ProseMirror').textContent ?? '').includes('<!-- a '),
    main: (document.querySelector('.unified-body .ProseMirror').textContent ?? '').includes('Canva1'),
  }))
  record('C11 迁移产物:三张卡折出来、正文无锚字面、主卡内容还在、mode 生效直接进画布',
    c11a.stage && JSON.stringify(c11a.cards) === JSON.stringify(['2', '4', '3']) && !c11a.raw && c11a.main, JSON.stringify(c11a))

  // 编辑一次:elements(Phase 1 不渲染)必须一个都不丢 —— 不渲染的东西最容易在派生时被顺手吃掉。
  await p11.click(`${PM} > p`)
  await p11.keyboard.type('改')
  await p11.waitForTimeout(1400)
  const c11b = await p11.evaluate(() => {
    window.__upage.probe.flush?.()
    const line = /^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '')
    try { const o = JSON.parse(line[1]); return { els: o.elements, refs: o.cards.map((c) => c.ref) } } catch { return null }
  })
  record('C11 编辑一次后 elements 与 cards 全部还在(不渲染的元素不许被派生吃掉)',
    !!c11b && JSON.stringify(c11b.els) === JSON.stringify([{ id: 'e1', type: 'connector', from: { ref: '2' }, to: { ref: '4' } }])
      && JSON.stringify(c11b.refs) === JSON.stringify(['2', '4', '3']), JSON.stringify(c11b))
  await p11.close()

  // ── C12/C14/C15 白板层(Phase 2 只读渲染)────────────────────────────────────────
  // 种子里故意混了一条**端点不存在**的连线:只读层必须跳过它却一个字节都不改(剪枝是写侧的活,
  // 而且必须与删卡同属一笔 PM 事务,只读层越权去剪 = 「看一眼」变成静默改档)。
  const WB = [
    '---', 'amadeus_schema: amadeus.page/4',
    // 种子里刻意混了四样东西:①卡→卡连线 ②带**未知字段**的形状 ③端点落在**形状**上的连线(`{id}`)
    // ④端点不存在的连线,外加一个顶层未知键 —— C15 要拿它们证「派生一次后逐字不变」。
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"2","x":0,"y":56,"w":280},{"ref":"4","x":340,"y":56,"w":400},{"ref":"3","x":-4,"y":198,"w":400}],"elements":[{"id":"e1","type":"connector","from":{"ref":"2"},"to":{"ref":"4"}},{"id":"s1","type":"shape","shape":"rect","x":700,"y":40,"w":160,"h":90,"text":"形状","note":"未来字段"},{"id":"e2","type":"connector","from":{"ref":"4"},"to":{"id":"s1"}},{"id":"e9","type":"connector","from":{"ref":"zz"},"to":{"ref":"4"}}],"futureKey":{"a":1}}',
    '---', '', '主卡。', '', '<!-- a 2 -->', '', '然后呢', '', '<!-- a 4 -->', '', '可是', '', '<!-- a 3 -->', '', '轻松绷', '',
  ].join('\n')
  const pw = await open(browser, WB)
  await pw.waitForTimeout(500)
  const c12 = await pw.evaluate(() => {
    const box = (a) => {
      const el = document.querySelector(`.amx-ucard[data-anchor="${a}"]`)
      return el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, op: el.offsetParent?.className ?? '', dx: Number(el.dataset.x), dy: Number(el.dataset.y) } : null
    }
    const svg = document.querySelector('.amx-el-conn')
    const d = svg?.querySelector('path')?.getAttribute('d') ?? ''
    // "M x,y C c1x,c1y c2x,c2y x2,y2" —— 取首末点
    const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
    const p1 = nums.length >= 8 ? { x: nums[0], y: nums[1] } : null
    const p2 = nums.length >= 8 ? { x: nums[6], y: nums[7] } : null
    const onEdge = (p, b) => {
      if (!p || !b) return false
      const inside = p.x >= b.x - 1.5 && p.x <= b.x + b.w + 1.5 && p.y >= b.y - 1.5 && p.y <= b.y + b.h + 1.5
      const e = Math.min(Math.abs(p.x - b.x), Math.abs(p.x - (b.x + b.w)), Math.abs(p.y - b.y), Math.abs(p.y - (b.y + b.h)))
      return inside && e <= 1.5
    }
    const b2 = box('2'); const b4 = box('4')
    // 端点落在**形状**上的那条(e2):首点必须在卡 4 的边上,末点在形状盒的边上。
    const sEl = document.querySelector('.amx-el-shape')
    const sBox = sEl ? { x: sEl.offsetLeft, y: sEl.offsetTop, w: sEl.offsetWidth, h: sEl.offsetHeight } : null
    const d2 = document.querySelector('.amx-el-conn[data-el="e2"] path')?.getAttribute('d') ?? ''
    const n2 = d2.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
    const q1 = n2.length >= 8 ? { x: n2[0], y: n2[1] } : null
    const q2 = n2.length >= 8 ? { x: n2[6], y: n2[7] } : null
    // 真实指针命中:连线中点上按下去,拿到的**不能**是白板层的任何节点(否则挡住 pan/选字)。
    const mid = p1 && p2 ? { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } : null
    const innerR = document.querySelector('.amx-stage-inner').getBoundingClientRect()
    const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.amx-stage-inner')).transform)
    const hitEl = mid ? document.elementFromPoint(innerR.left + mid.x * m.a, innerR.top + mid.y * m.d) : null
    return {
      conns: document.querySelectorAll('.amx-el-conn').length,
      shapes: document.querySelectorAll('.amx-el-shape').length,
      shapeText: document.querySelector('.amx-el-shape')?.textContent ?? '',
      shapeEnds: onEdge(q1, b4) && onEdge(q2, sBox),
      hitIsNotLayer: !!hitEl && !hitEl.closest('.amx-el-layer'),
      hit: hitEl?.className ?? null,
      // 只读层绝不吃指针
      pe: getComputedStyle(document.querySelector('.amx-el-layer')).pointerEvents,
      // offsetParent 契约:画布模式下卡片的 offsetParent 必须是 .amx-stage-inner(中间层全 static),
      // 否则 measureCards 量出来的坐标不在舞台空间,连线整体偏一个容器位。
      opOk: !!b2 && b2.op.includes('amx-stage-inner') && Math.abs(b2.x - b2.dx) <= 1 && Math.abs(b2.y - b2.dy) <= 1,
      ends: onEdge(p1, b2) && onEdge(p2, b4),
      span: p1 && p2 ? Math.hypot(p2.x - p1.x, p2.y - p1.y) : 0,
      b2, b4, p1, p2,
    }
  })
  record('C12 白板层:2 条可解析连线 + 1 个形状渲染出来,端点不存在的那条**不画**',
    c12.conns === 2 && c12.shapes === 1 && c12.shapeText.includes('形状'), JSON.stringify({ conns: c12.conns, shapes: c12.shapes }))
  record('C12 连线两端落在两张卡的边上(且跨度非平凡);`{id}` 端点落在形状盒的边上',
    c12.ends && c12.span > 40 && c12.shapeEnds, JSON.stringify({ ends: c12.ends, span: Math.round(c12.span), shapeEnds: c12.shapeEnds, p1: c12.p1, p2: c12.p2 }))
  record('C12 整层 pointer-events:none,且连线中点上真实命中的不是白板层(不挡 pan/选字)',
    c12.pe === 'none' && c12.hitIsNotLayer, JSON.stringify({ pe: c12.pe, hit: c12.hit }))
  record('C12 offsetParent 契约:卡片的 offsetParent == .amx-stage-inner 且 offset* == data-x/y',
    c12.opOk, JSON.stringify(c12.b2))

  // C14 撤销步隔断:**500ms 内连拖同一张卡两次**,一次 Cmd+Z 只该退回上一次落点、而不是一路退到原位。
  //     这是四组内存复现里**唯一**能区分「有没有 commitGeo 的 closeHistory」的场景 —— 两笔
  //     setNodeMarkup 的 step 范围恰好重叠,isAdjacentTo 判相邻,不封口就合成一个撤销步。
  //     ⚠️ 第一版这条写的是「拖完立刻打字」,那种写法去掉 closeHistory 照样绿(setNodeMarkup 的
  //        StepMap 只覆盖卡节点开/闭边界,与卡内文本位置不重叠)= 假绿,Codex 评审实证推翻。
  //     ⚠️ 往**下**拖,别往右:主卡在 (0,0) 且 720 宽,横向挪一点仍落在它的矩形里 → onUp 判成
  //        「拖回主卡」把卡拆了,后面全拿 null。落点不能依赖当时的布局凑巧。
  const c14 = await pw.evaluate(() => {
    const stage = document.querySelector('.amx-stage')
    const mk = (t, x, y) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: x, clientY: y })
    const drag = (dy) => {
      const card = document.querySelector('.amx-ucard[data-anchor="2"]')
      if (!card) return null
      const r = card.getBoundingClientRect()
      card.dispatchEvent(mk('pointerdown', r.left + 6, r.top + 6))
      stage.dispatchEvent(mk('pointermove', r.left + 6, r.top + dy))
      stage.dispatchEvent(mk('pointerup', r.left + 6, r.top + dy))
      const el = document.querySelector('.amx-ucard[data-anchor="2"]')
      return el ? Number(el.dataset.y) : null
    }
    const y0 = Number(document.querySelector('.amx-ucard[data-anchor="2"]').dataset.y)
    // ⚠️ 落点要**避开别的卡的边缘带**:2026-08-19 起「指针停在某张卡的边缘松手」= 认亲手势,
    //    会把这张卡收成子/兄弟并吸附摆位。这一格测的是撤销粒度,别让它顺带测认亲(dy=180 时
    //    指针正好落在卡 3 左缘内侧 10px,实测被收编,C15 的 elements 段跟着多出一个 tree 键)。
    const y1 = drag(300) // 两次拖拽之间没有任何等待 —— 时间差近乎 0,合并窗必然命中
    const y2 = drag(300)
    return { y0, y1, y2 }
  })
  await pw.evaluate(() => window.__upage.probe.view().focus())
  await pw.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await pw.waitForTimeout(250)
  const c14b = await pw.evaluate(() => {
    const el = document.querySelector('.amx-ucard[data-anchor="2"]')
    return { y: el ? Number(el.dataset.y) : null }
  })
  record('C14 连拖两次后一次撤销 → 退回**上一次**落点而不是原位(几何事务各自成步)',
    c14.y1 != null && c14.y2 != null && c14.y1 > c14.y0 + 50 && c14.y2 > c14.y1 + 50 && c14b.y === c14.y1,
    JSON.stringify({ ...c14, afterUndo: c14b.y }))

  // C15 doc 表达不了的东西(elements + 顶层未知键)派生一次后必须**逐字节**不变。
  // ⚠️ 断言必须是**字符串比对**,不是「解析后 length===3」——后者对「未知字段被删/被改值/键序重排」
  //    一概照绿(Codex 评审 P0:原版就是这么写的)。已知边界:派生走 parse→stringify,>2^53 的整数
  //    会掉精度(canvas.ts 顶注已记),故种子里不放大整数;真要字节级得对原始 JSON 定向 splice。
  const elemSeg = (fm) => {
    const m = /^amadeus_canvas:\s*(.*)$/m.exec(fm ?? '')
    if (!m) return null
    const i = m[1].indexOf('"elements"')
    return i < 0 ? null : m[1].slice(i)
  }
  const seg0 = elemSeg(WB)
  await pw.waitForTimeout(1400)
  const fm15 = await fmOf(pw)
  const seg1 = elemSeg(fm15)
  record('C15 编辑后 elements 段(含悬空连线、形状的未知字段、顶层未知键)逐字节不变',
    !!seg0 && seg0 === seg1 && seg0.includes('"note":"未来字段"') && seg0.includes('"futureKey"'),
    JSON.stringify({ same: seg0 === seg1, before: seg0?.slice(0, 90), after: seg1?.slice(0, 90) }))
  await pw.close()

  // ── 白板可编辑(2026-08-17 Phase 2 第二步)C19-C24 ─────────────────────────────────
  // 全部跑在 WB 种子上:它同时带着「未知字段的形状」「落在形状上的连线」「顶层未知键」——
  // 也就是说每一格顺带都在验 §8 的「老端绝不吞新端的元素」。
  /** 合成一次指针拖拽(pointerdown 落在 sel 上,move/up 落在舞台上 —— 与真实捕获行为一致)。 */
  const dragEl = (p, sel, dx, dy, off = 8) => p.evaluate(({ sel, dx, dy, off }) => {
    const stage = document.querySelector('.amx-stage')
    const el = document.querySelector(sel)
    if (!el || !stage) return false
    const r = el.getBoundingClientRect()
    const mk = (t, x, y) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x, clientY: y })
    el.dispatchEvent(mk('pointerdown', r.left + off, r.top + off))
    stage.dispatchEvent(mk('pointermove', r.left + off + dx, r.top + off + dy))
    stage.dispatchEvent(mk('pointerup', r.left + off + dx, r.top + off + dy))
    return true
  }, { sel, dx, dy, off })
  const elemsOf = (fm) => { try { return JSON.parse(canvasLine(fm)).elements } catch { return null } }

  const p19 = await open(browser, WB)
  await p19.waitForTimeout(600)
  const s1Before = elemsOf(WB).find((e) => e.id === 's1')
  await dragEl(p19, '.amx-el-shape[data-el="s1"]', 70, 45)
  await p19.waitForTimeout(1400)
  const fm19 = await fmOf(p19)
  const line19 = canvasLine(fm19)
  const s1After = (elemsOf(fm19) ?? []).find((e) => e.id === 's1')
  // ⚠️ 这一格是**毁数据级**的:写侧若拿 safeElements 的收窄视图回吐,`note` 与 futureKey 当场蒸发。
  //    单测 canvasEdit.test.ts 里跑过负对照(换成 safeElements → 立刻红),这里是同一判据的端到端版。
  record('C19 拖动形状 → 坐标落盘,而形状的未知字段 note / 顶层 futureKey / cards 段全部逐字幸存',
    !!s1After && s1After.x > s1Before.x && s1After.y > s1Before.y &&
    line19.includes('"note":"未来字段"') && line19.includes('"futureKey":{"a":1}') &&
    line19.includes('"cards":[{"ref":"2","x":0,"y":56,"w":280}'),
    JSON.stringify({ from: { x: s1Before.x, y: s1Before.y }, to: s1After && { x: s1After.x, y: s1After.y }, note: line19.includes('"note":"未来字段"'), future: line19.includes('"futureKey":{"a":1}') }))

  // C22 元素撤销栈:Cmd+Z 落在舞台上时先问元素栈(卡片/正文仍归 PM,见 canvasStage 顶注)。
  await p19.evaluate(() => document.querySelector('.amx-stage').focus())
  await p19.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await p19.waitForTimeout(1400)
  const s1Undo = (elemsOf(await fmOf(p19)) ?? []).find((e) => e.id === 's1')
  record('C22 舞台上 Cmd+Z 撤销的是**元素**的位移(退回拖动前的原值)',
    !!s1Undo && s1Undo.x === s1Before.x && s1Undo.y === s1Before.y, JSON.stringify({ x: s1Undo?.x, y: s1Undo?.y, want: { x: s1Before.x, y: s1Before.y } }))

  // C21 空白拖 = 框选(不再是平移。AFFiNE/插件都是这个语义)。整片框一次,卡与形状都该进选中。
  // ⚠️ 每一步之间必须**等一拍**:选中/选框都是 React 状态,派发完立刻读 DOM 读到的是上一帧
  //    (前一版就是这么写的,`shapes:1` 其实是上一格拖形状留下的旧选中 = 假绿)。
  await p19.evaluate(() => document.querySelector('.amx-stage').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await p19.waitForTimeout(120)
  const c21pre = await p19.evaluate(() => ({
    sel: document.querySelectorAll('.amx-el-selbox, .amx-el-shape.is-sel').length,
    tf: getComputedStyle(document.querySelector('.amx-stage-inner')).transform,
  }))
  await p19.evaluate(() => {
    const stage = document.querySelector('.amx-stage')
    const r = stage.getBoundingClientRect()
    const mk = (t, x, y) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 8, button: 0, clientX: x, clientY: y })
    window.__r = r
    stage.dispatchEvent(mk('pointerdown', r.left + 3, r.top + 3))
    stage.dispatchEvent(mk('pointermove', r.right - 3, r.bottom - 3))
  })
  await p19.waitForTimeout(120)
  const c21mid = await p19.evaluate(() => document.querySelectorAll('.amx-el-marquee').length)
  await p19.evaluate(() => {
    const stage = document.querySelector('.amx-stage')
    const r = window.__r
    stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 8, button: 0, clientX: r.right - 3, clientY: r.bottom - 3 }))
  })
  await p19.waitForTimeout(150)
  const c21 = await p19.evaluate(() => ({
    box: document.querySelectorAll('.amx-el-marquee').length,
    tf: getComputedStyle(document.querySelector('.amx-stage-inner')).transform,
    cards: document.querySelectorAll('.amx-el-selbox').length,
    shapes: document.querySelectorAll('.amx-el-shape.is-sel').length,
  }))
  // ⚠️ 2026-08-18 起主卡是一等公民:整场框选把主卡也选进来,.amx-el-selbox 计 3 卡 + 1 主卡 = 4。
  record('C21 空白拖 = 框选(前置:选中已清零;拖动期间有选框、视口没被平移、卡/形状/主卡一起进选中、松手收框)',
    c21pre.sel === 0 && c21mid === 1 && c21.box === 0 && c21pre.tf === c21.tf && c21.cards === 4 && c21.shapes === 1,
    JSON.stringify({ pre: c21pre.sel, mid: c21mid, ...c21 }))

  // C24 卡内打字时舞台键盘必须让路(keydown 从 PM 冒泡上来 —— 不挡的话在卡里按退格会删掉选中的形状)。
  await p19.evaluate(() => {
    const sh = document.querySelector('.amx-el-shape[data-el="s1"]')
    const r = sh.getBoundingClientRect()
    const mk = (t, x, y) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: x, clientY: y })
    sh.dispatchEvent(mk('pointerdown', r.left + 6, r.top + 6))
    sh.dispatchEvent(mk('pointerup', r.left + 6, r.top + 6))
  })
  await p19.waitForTimeout(150) // 选中是 React 状态,派发完立刻读是上一帧(本文件栽过两次)
  const c24 = await p19.evaluate(() => document.querySelectorAll('.amx-el-shape.is-sel').length)
  // ⚠️ 2026-08-18 起是**两段式**:一击只选中卡(光标不进去),二击才落光标。这里必须点两下 ——
  //    只点一下的话选中的是卡片本身,接着按退格删掉的是整张卡(实测:C24 当场把 `3` 号卡删了)。
  await p19.click('.amx-ucard[data-anchor="3"] p')
  await p19.waitForTimeout(150)
  await p19.click('.amx-ucard[data-anchor="3"] p')
  await p19.waitForTimeout(200) // 等 PM 把光标真正落进这一段(不等就是「按了退格什么也没删」的假红)
  await p19.keyboard.press('Backspace')
  await p19.keyboard.press('Backspace')
  await p19.waitForTimeout(1400)
  // ⚠️ 读之前必须**等这两个节点在场**,不能盲采一帧:落盘后若触发一次回灌重建(structChanged →
  //    setEditorKey),整棵子树会短暂缺席,盲采到的就是 `shape:false / text:''` 的假红(实测中过一次,
  //    而紧随其后的 C23/C20 用的正是这两个对象、全绿 = 数据根本没丢)。真被删了则这里超时硬失败,
  //    比盲采**更严**,不是放水。
  await p19.waitForSelector('.amx-el-shape[data-el="s1"]', { timeout: 5000 })
  await p19.waitForSelector('.amx-ucard[data-anchor="3"]', { timeout: 5000 })
  const c24b = await p19.evaluate(() => ({
    shape: !!document.querySelector('.amx-el-shape[data-el="s1"]'),
    text: document.querySelector('.amx-ucard[data-anchor="3"]')?.textContent ?? '',
  }))
  record('C24 形状选中时在卡内按退格:删的是字,形状一根汗毛没动(舞台键盘对 PM 让路)',
    c24 === 1 && c24b.shape && c24b.text.length > 0 && c24b.text !== '轻松绷', JSON.stringify({ selBefore: c24, ...c24b }))

  // C23 连线工具:依次点两个对象成一条线(端点按命名空间分别落 {ref}/{id})。
  await pickTool(p19, '连线')
  await p19.evaluate(() => {
    const mk = (t, x, y) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 11, button: 0, clientX: x, clientY: y })
    // 卡片必须点在**卡自己的 chrome 圈**上(target === 卡片 div),点正文里是编辑语义。
    const card = document.querySelector('.amx-ucard[data-anchor="3"]')
    const cr = card.getBoundingClientRect()
    card.dispatchEvent(mk('pointerdown', cr.left + 4, cr.top + 4))
    const sh = document.querySelector('.amx-el-shape[data-el="s1"]')
    const sr = sh.getBoundingClientRect()
    sh.dispatchEvent(mk('pointerdown', sr.left + 6, sr.top + 6))
  })
  await p19.waitForTimeout(1400)
  const conns23 = (elemsOf(await fmOf(p19)) ?? []).filter((e) => e.type === 'connector')
  const made23 = conns23.find((e) => e.from?.ref === '3' && e.to?.id === 's1')
  record('C23 连线工具:点卡片 → 点形状 = 新连线一条(端点 {ref} / {id} 各归各的命名空间)',
    !!made23 && conns23.length === 4, JSON.stringify({ n: conns23.length, made: made23 }))

  // C20 删形状:同一笔顺手剪掉端点落在它上面的连线;端点是**卡锚**的连线一条都不许动。
  // ⚠️ 前置断言不可省:上一格框选过整片,若「点中已选对象」不收敛选中集合,这一下删除会把三张卡
  //    一起带走 —— 而只看 elements 的话这一格照样绿(实测中招过,cards 被删成 [] 才发现)。
  await p19.evaluate(() => {
    const sh = document.querySelector('.amx-el-shape[data-el="s1"]')
    const r = sh.getBoundingClientRect()
    const mk = (t, x, y) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 12, button: 0, clientX: x, clientY: y })
    sh.dispatchEvent(mk('pointerdown', r.left + 6, r.top + 6))
    sh.dispatchEvent(mk('pointerup', r.left + 6, r.top + 6))
  })
  await p19.waitForTimeout(150)
  const c20pre = await p19.evaluate(() => ({
    cards: document.querySelectorAll('.amx-el-selbox').length,
    shapes: document.querySelectorAll('.amx-el-shape.is-sel').length,
  }))
  record('C20 前置:多选后点中其中一个但没拖 → 选中收敛成只有它(否则下一次删除会误伤整批)',
    c20pre.cards === 0 && c20pre.shapes === 1, JSON.stringify(c20pre))
  await p19.keyboard.press('Delete')
  await p19.waitForTimeout(1400)
  const fm20 = await fmOf(p19)
  const els20 = elemsOf(fm20) ?? []
  record('C20 删形状 → s1 与连它的 e2/e3 一起走,卡锚之间的 e1 与悬空的 e9 原样留着,cards 一张没少',
    !els20.some((e) => e.id === 's1') && !els20.some((e) => e.to?.id === 's1' || e.from?.id === 's1') &&
    els20.some((e) => e.id === 'e1') && els20.some((e) => e.id === 'e9') &&
    canvasLine(fm20).includes('"cards":[{"ref":"2"') && canvasLine(fm20).includes('"futureKey"'),
    JSON.stringify({ ids: els20.map((e) => e.id), line: (canvasLine(fm20) ?? '').slice(0, 220) }))

  // C25 右键菜单的两条收尾(Codex 评审之外我自己发现的):点**舞台以外**要能关、Esc 要先关它。
  // 舞台自己的 pointerdown 只盖得住舞台内部,漏了就是点侧栏/顶栏后菜单一直挂着。
  const openMenu = () => p19.evaluate(() => {
    const s = document.querySelector('.amx-stage')
    const r = s.getBoundingClientRect()
    s.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 60 }))
  })
  await openMenu()
  await p19.waitForTimeout(150)
  const m1 = await p19.evaluate(() => document.querySelectorAll('.amx-canvas-menu').length)
  await p19.evaluate(() => document.querySelector('.amx-toolbar').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 21, button: 0 })))
  await p19.waitForTimeout(150)
  const m2 = await p19.evaluate(() => document.querySelectorAll('.amx-canvas-menu').length)
  await openMenu()
  await p19.waitForTimeout(150)
  const m3 = await p19.evaluate(() => document.querySelectorAll('.amx-canvas-menu').length)
  await p19.evaluate(() => document.querySelector('.amx-stage').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await p19.waitForTimeout(150)
  const m4 = await p19.evaluate(() => document.querySelectorAll('.amx-canvas-menu').length)
  record('C25 右键菜单:点舞台以外(顶栏)能关;Esc 先关菜单而不是先清选中',
    m1 === 1 && m2 === 0 && m3 === 1 && m4 === 0, JSON.stringify({ open: m1, outside: m2, reopen: m3, esc: m4 }))
  await p19.close()

  // ── C13 切模式不能清空撤销栈(2026-08-17 修的活缺陷)────────────────────────────
  // 旧实现在文档模式返回 `<>{children}</>`、画布模式返回 <div> —— 槽位元素类型跳变 ⇒ React 卸载
  // 重挂整棵子树 ⇒ MilkdownProvider 重建 ⇒ PM 撤销栈销毁。切一次模式,Cmd+Z 的历史全没。
  const p13 = await open(browser, '# 撤销页\n\n原文。\n')
  await p13.click(`${PM} > p`)
  await p13.keyboard.type('新增字')
  await p13.waitForTimeout(120)
  const undoBefore = await p13.evaluate(() => { window.__t = window.__upage.probe.view(); return document.querySelector('.unified-body .ProseMirror').textContent })
  await p13.click('.amx-modeseg button:nth-child(3)') // → 画布
  await p13.waitForTimeout(200)
  await p13.click('.amx-modeseg button:nth-child(2)') // → 文档
  await p13.waitForTimeout(200)
  const same = await p13.evaluate(() => window.__t === window.__upage.probe.view())
  await p13.evaluate(() => window.__upage.probe.view().focus())
  await p13.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await p13.waitForTimeout(250)
  const undoAfter = await p13.evaluate(() => document.querySelector('.unified-body .ProseMirror').textContent)
  record('C13 切模式往返后 EditorView 是同一个实例(没重挂)', same, JSON.stringify({ same }))
  record('C13 切模式往返后 Cmd+Z 仍能撤销切之前打的字(撤销栈没被清空)',
    undoBefore.includes('新增字') && !undoAfter.includes('新增字'), JSON.stringify({ undoBefore, undoAfter }))
  await p13.close()

  // ── C17 插件启停 = 第四条重 parse 路径(对抗评审 P0,已端到端复现过)─────────────────
  // MarkdownBlock 自己订阅 editorExtensionGen 并挂在 useEditor 的 deps 上 → milkdown destroy+create,
  // `defaultValueCtx` 吃的是**那一刻的 prop**。v4 的 pipe 是 ref,拖卡/打字全程零 setState,
  // prop 于是停在上一次 UnifiedPage 渲染 —— 陈旧 body 缺新卡的锚 → 折叠 fail-closed → onFolded
  // 不调用,而这条重建不经 setEditorKey 也不卸载 host,三处 ownedCards.clear() 一处都够不着
  // → 派生写回 `cards: []`,全部卡片几何永久没了。
  const WB2 = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"2","x":40,"y":620,"w":280},{"ref":"4","x":420,"y":620,"w":300}]}',
    '---', '', '主卡。', '', '可拖的一段。', '', '<!-- a 2 -->', '', '甲', '', '<!-- a 4 -->', '', '乙', '',
  ].join('\n')
  const p17 = await open(browser, WB2)
  await p17.waitForTimeout(500)
  const box17 = await p17.evaluate(() => {
    const s = document.querySelector('.amx-stage')
    if (!s || s.classList.contains('amx-stage-off')) return null
    const r = s.getBoundingClientRect()
    return { x: r.left + 140, y: r.top + 120 } // 舞台左上空白:卡片都在 y=620 那一带
  })
  const drag17 = box17 ? await dragBlockToStage(p17, '可拖的一段', box17) : false
  await p17.waitForTimeout(1400)
  const c17a = await p17.evaluate(() => {
    window.__upage.probe.flush?.()
    const line = /^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '')
    try { return { refs: JSON.parse(line[1]).cards.map((c) => c.ref), cards: document.querySelectorAll('.amx-ucard').length } } catch { return null }
  })
  record('C17 前置:拖块成卡后盘上是三张卡(不成立的话下面那格平凡通过)',
    drag17 && !!c17a && c17a.refs.length === 3 && c17a.cards === 3, JSON.stringify(c17a))

  // 触发注册表代次(等价于用户在设置里启停一个注册了编辑器扩展的插件)。
  // ⚠️ 必须用 addEditorExtension:`clearEditorExtensions` 只在**真删掉**东西时才 bump,
  //    对没注册过的 id 是空转 —— 第一版就这么写的,负对照因此不变红 = 这一格是假绿。
  //    代次有没有真的变,下面当前置断言硬查。
  const gen17 = await p17.evaluate(async () => {
    const m = await import('/src/amadeus/plugins/editorExtensions.ts')
    const before = m.editorExtensionGen()
    m.addEditorExtension('__probe__', () => [])
    return { before, after: m.editorExtensionGen() }
  })
  await p17.waitForTimeout(600)
  await p17.click(`${PM} > p`) // 敲一个字,逼一次派生落盘
  await p17.keyboard.type('改')
  await p17.waitForTimeout(1500)
  const c17b = await p17.evaluate(() => {
    window.__upage.probe.flush?.()
    const fm = window.__upage.probe.fmState?.().fm ?? ''
    const line = /^amadeus_canvas:\s*(.*)$/m.exec(fm)
    let refs = null
    try { refs = JSON.parse(line[1]).cards.map((c) => c.ref) } catch { /* 键没了 = null */ }
    return {
      refs,
      hasKey: /^amadeus_canvas:/m.test(fm),
      cards: document.querySelectorAll('.amx-ucard').length,
      rawMarker: (document.querySelector('.unified-body .ProseMirror').textContent ?? '').includes('<!-- a '),
    }
  })
  record('C17 插件启停 → 敲字后三张卡的几何仍在、正文无锚字面(重建没吃陈旧 body)',
    gen17.after > gen17.before && !!c17b.refs && c17b.refs.length === 3 && c17b.hasKey && c17b.cards === 3 && !c17b.rawMarker,
    JSON.stringify({ gen: gen17, ...c17b }))
  await p17.close()

  // ── C18 卡片手柄上「静止点击」不许落任何几何(对抗评审 P1)────────────────────────
  // 没跑过 onMove 时内联样式是空串,旧实现 `parseFloat('') || 0` 把卡片写到 (0,0)、
  // 调宽那支 `|| CARD_W` 把它拉成 400 —— 都是真事务、进撤销栈、照常落盘。
  const p18 = await open(browser, WB2)
  await p18.waitForTimeout(500)
  const before18 = canvasLine(await fmOf(p18))
  const c18 = await p18.evaluate(() => {
    const card = document.querySelector('.amx-ucard[data-anchor="2"]')
    const stage = document.querySelector('.amx-stage')
    const r = card.getBoundingClientRect()
    const mk = (t, x, y) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 11, button: 0, clientX: x, clientY: y })
    // ① 搬卡热区静止点击 ② 右缘调宽热区静止点击
    card.dispatchEvent(mk('pointerdown', r.left + 6, r.top + 6))
    stage.dispatchEvent(mk('pointerup', r.left + 6, r.top + 6))
    const r2 = document.querySelector('.amx-ucard[data-anchor="2"]')?.getBoundingClientRect()
    if (r2) {
      card.dispatchEvent(mk('pointerdown', r2.right - 3, r2.top + 6))
      stage.dispatchEvent(mk('pointerup', r2.right - 3, r2.top + 6))
    }
    const el = document.querySelector('.amx-ucard[data-anchor="2"]')
    return { alive: !!el, x: el ? Number(el.dataset.x) : null, y: el ? Number(el.dataset.y) : null, w: el ? Number(el.dataset.w) : null }
  })
  await p18.waitForTimeout(1500)
  const after18 = canvasLine(await fmOf(p18))
  record('C18 卡片手柄上静止点击 → 卡还在、dataset 与落盘几何逐字不变(不写 (0,0)/400)',
    c18.alive && c18.x === 40 && c18.y === 620 && c18.w === 280 && before18 === after18,
    JSON.stringify({ ...c18, sameLine: before18 === after18 }))
  await p18.close()

  // ── C16 满铺(用户 2026-08-17 拍板「像 AFFiNE 一样整个 view 显示」)────────────────
  // 必须在**生产壳镜像**里测(&upane):默认的 720px 居中盒子既没有滚动容器也没有 sticky 顶栏,
  // 满铺的两个真风险(脱不出纸面 / 盖住顶栏)在那儿一个都暴露不了。
  const p16 = await open(browser, '# 满铺页\n\n正文一段。\n')
  const c16a = await p16.evaluate(() => ({
    chrome: !!document.querySelector('.amx-doc.unified-page'),
    full: document.querySelector('.unified-body')?.classList.contains('amx-canvas-full') ?? null,
    paneCls: document.querySelector('.amx-pane')?.classList.contains('amx-canvas-pane') ?? null,
  }))
  record('C16 文档模式:标题/属性 chrome 在场,满铺类与面板类都没挂', c16a.chrome && c16a.full === false && c16a.paneCls === false, JSON.stringify(c16a))

  await p16.click('.amx-modeseg button:nth-child(3)')
  await p16.waitForTimeout(700)
  const c16b = await p16.evaluate(() => {
    const pane = document.querySelector('.amx-pane')
    const body = document.querySelector('.unified-body')
    const stage = document.querySelector('.amx-stage')
    const tb = document.querySelector('.amx-toolbar')
    const pr = pane.getBoundingClientRect()
    const br = body.getBoundingClientRect()
    const tr = tb.getBoundingClientRect()
    const cs = getComputedStyle(stage)
    // 顶栏必须仍然可点:满铺层若盖在它上面,这一格拿到的就是舞台而不是顶栏。
    const hit = document.elementFromPoint(tr.left + tr.width - 12, tr.top + tr.height / 2)
    const btn = document.querySelector('.amx-modeseg').getBoundingClientRect()
    return {
      chrome: !!document.querySelector('.amx-doc.unified-page'),
      cover: !!document.querySelector('.amx-cover'),
      dx: br.left - pr.left, dy: br.top - pr.top, dw: br.width - pr.width, dh: br.height - pr.height,
      paneW: Math.round(pr.width),
      radius: cs.borderRadius, border: cs.borderTopWidth,
      toolbarClickable: !!hit?.closest('.amx-toolbar'),
      // 舞台左上那行笔记名 2026-08-17 已按用户要求去掉(顶栏本来就写着名字,重复信息)。
      // 这一格反过来钉「别把它加回来」。
      label: !document.querySelector('.amx-stage-label'),
      // 胶囊住在**笔记顶栏**里(用户 2026-08-17 拍板:跟路径/分享/置顶同一行);
      // 笔记名浮在舞台左上、让开顶栏。
      segOn: document.querySelector('.amx-modeseg .t2s-vaultseg-thumb')?.dataset.side ?? '',
      segW: Math.round(btn.width),
      segInToolbar: !!document.querySelector('.amx-modeseg')?.closest('.amx-toolbar'),
      // 工具条(AFFiNE 同位:底部居中)必须在场且不被舞台边缘裁掉。
      tools: (() => {
        const t = document.querySelector('.amx-stage-tools')
        if (!t) return null
        const b = t.getBoundingClientRect()
        return { n: t.querySelectorAll('button').length, inPane: b.bottom <= pr.bottom + 1 && b.left >= pr.left - 1 }
      })(),
    }
  })
  record('C16 满铺:笔记体与面板同尺寸(脱出 920px 纸面)、chrome 整层不渲染',
    !c16b.chrome && !c16b.cover && c16b.paneW > 1000 &&
    Math.abs(c16b.dx) <= 1 && Math.abs(c16b.dy) <= 1 && Math.abs(c16b.dw) <= 1 && Math.abs(c16b.dh) <= 1,
    JSON.stringify(c16b))
  record('C16 顶栏可点且胶囊就在顶栏里(滑块在画布段、真有宽度)+ 舞台左上不再浮笔记名 + 工具条在场 + 舞台去圆角描边',
    c16b.toolbarClickable && c16b.segInToolbar && c16b.segOn === 'canvas' && c16b.segW > 80 && c16b.label &&
    !!c16b.tools && c16b.tools.n === 8 && c16b.tools.inPane && c16b.radius === '0px' && c16b.border === '0px',
    JSON.stringify({ toolbarClickable: c16b.toolbarClickable, segInToolbar: c16b.segInToolbar, segOn: c16b.segOn, segW: c16b.segW, noLabel: c16b.label, tools: c16b.tools, radius: c16b.radius, border: c16b.border }))

  // 胶囊在**两种模式下都必须在顶栏里**且靠最左(用户实报「画布模式没有」→ 这一格是它的回归网)。
  const c16seg = await p16.evaluate(() => {
    const seg = document.querySelector('.amx-modeseg')
    const tb = document.querySelector('.amx-toolbar')
    if (!seg || !tb) return { in: false }
    const sr = seg.getBoundingClientRect(); const tr2 = tb.getBoundingClientRect()
    return { in: !!seg.closest('.amx-toolbar'), leftmost: sr.left - tr2.left < 24, w: Math.round(sr.width), visible: sr.width > 0 && sr.height > 0 }
  })
  record('C16 画布模式下胶囊仍在顶栏、可见、且顶到最左',
    c16seg.in && c16seg.leftmost && c16seg.visible && c16seg.w > 80, JSON.stringify(c16seg))

  // C26 顶栏插槽**晚于**编辑器到场时,胶囊照样得挂上去(用户 2026-08-18 实报「开机还原到一篇 md
  //     笔记时胶囊必不显示,点过别的笔记才出来」)。生产里顶栏整块挂在 `barPath` 这道门后面,而
  //     barPath 要等一次异步分类才落定 —— 插槽比 UnifiedPage 晚出现是常态。`&udelay` 把这个时序
  //     固定下来;去掉 CanvasSegPortal 的 MutationObserver 这一格立刻红(跑过负对照)。
  const p26 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await p26.goto(`${URL}?upage&upane&udelay&useed=${encodeURIComponent('# 还原页\n\n正文一段。\n')}`, { waitUntil: 'domcontentloaded' })
  await p26.waitForSelector(PM, { timeout: 20000 })
  await p26.waitForTimeout(900)
  const c26 = await p26.evaluate(() => {
    const s = document.querySelector('.amx-modeseg')
    const tb = document.querySelector('.amx-toolbar')
    return {
      seg: !!s,
      inTb: !!s?.closest('.amx-toolbar'),
      w: Math.round(s?.getBoundingClientRect().width ?? 0),
      leftmost: !!s && !!tb && s.getBoundingClientRect().left - tb.getBoundingClientRect().left < 24,
      side: document.querySelector('.amx-modeseg .t2s-vaultseg-thumb')?.dataset.side ?? '',
    }
  })
  record('C26 顶栏插槽晚于编辑器到场(启动还原时序)→ 胶囊仍挂进顶栏、有宽度、顶到最左',
    c26.seg && c26.inTb && c26.w > 80 && c26.leftmost && c26.side === 'doc', JSON.stringify(c26))
  await p26.close()

  await p16.click('.amx-modeseg button:nth-child(2)') // 回文档模式
  await p16.waitForTimeout(500)
  const c16c = await p16.evaluate(() => ({
    chrome: !!document.querySelector('.amx-doc.unified-page'),
    paneCls: document.querySelector('.amx-pane')?.classList.contains('amx-canvas-pane') ?? null,
    bodyW: Math.round(document.querySelector('.unified-body').getBoundingClientRect().width),
    segInToolbar: !!document.querySelector('.amx-modeseg')?.closest('.amx-toolbar'),
  }))
  record('C16 退回文档模式:chrome 回来、面板类摘干净、纸面宽度回到 920 以内、胶囊仍在顶栏',
    c16c.chrome && c16c.paneCls === false && c16c.bodyW <= 921 && c16c.segInToolbar, JSON.stringify(c16c))
  await p16.close()

  // ── C8 分栏 × 画布并存:两个折叠器在同一棵 remark 树上跑,且一次编辑后两个结构键都得活着 ──
  // 这正是 Phase 0 定的那条发布阻断场景(方案 §6.0-2)。以前只有 fm 层的单测,现在有真实现了实测。
  const MIX = [
    '---',
    'amadeus_schema: amadeus.page/4',
    'amadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["L1"],"width":1},{"refs":["L2"],"width":1}],"tail":"T1"}]}',
    'amadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"K1","x":50,"y":60,"w":320}]}',
    '---',
    '',
    '开头一段。',
    '',
    '<!-- a L1 -->',
    '左列。',
    '',
    '<!-- a L2 -->',
    '右列。',
    '',
    '<!-- a T1 -->',
    '行后自然流。',
    '',
    '<!-- a K1 -->',
    '卡片内容。',
    '',
  ].join('\n')
  const p8 = await open(browser, MIX)
  await p8.waitForTimeout(300)
  const c8a = await p8.evaluate(() => ({
    rows: document.querySelectorAll('.amx-ucolrow').length,
    cells: document.querySelectorAll('.amx-ucolcell').length,
    cards: document.querySelectorAll('.amx-ucard').length,
    raw: (document.querySelector('.unified-body .ProseMirror').textContent ?? '').includes('<!-- a '),
  }))
  record('C8 分栏与画布同时折叠(1 行 2 列 + 1 卡),正文无锚字面',
    c8a.rows === 1 && c8a.cells === 2 && c8a.cards === 1 && !c8a.raw, JSON.stringify(c8a))

  const fmBefore = await fmOf(p8)
  await p8.click(`${PM} > p`) // 「开头一段。」(自然流,不在任何结构里)
  await p8.keyboard.type('改')
  await p8.waitForTimeout(1400)
  const fmAfter = await fmOf(p8)
  const c8b = {
    layoutSame: (/^amadeus_layout:\s*(.*)$/m.exec(fmBefore) || [])[1] === (/^amadeus_layout:\s*(.*)$/m.exec(fmAfter) || [])[1],
    canvasSame: canvasLine(fmBefore) === canvasLine(fmAfter),
    schema: /^amadeus_schema:/m.test(fmAfter),
  }
  record('C8 自然流编辑一次 → layout / canvas / schema 三键全部字节稳定',
    c8b.layoutSame && c8b.canvasSame && c8b.schema, JSON.stringify(c8b))
  await p8.close()

  // ── C27 P0:跨卡拖块必须落**进那张卡**,绝不许落在「卡与卡之间」的 doc 顶层 ─────────────
  // 2026-08-18 用户实报「把 A 卡里的块拖进 B 卡,会带出 <!-- a X --> 代号并显示」。两段实测:
  //  ① 画布模式下落点插件算出来的位置与指针无关(卡片绝对定位,它那套逐块扫边沿失去前提)——
  //     修之前瞄准 B 卡的正文/顶边/底边,三次落点完全一样,都掉进主卡;
  //  ② 顶层插在两卡之间 → canvasNormalizer 把前面的卡就地拆壳,锚字面显形、cards 掉枚。
  // 这一格钉的是修完的不变式:块进了 B 卡的辖域(锚序里排在 k2 之后),两张卡一张不少,正文无锚字面。
  const TWO = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":300},{"ref":"k2","x":420,"y":40,"w":300}]}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一甲。', '', '卡一乙。', '', '<!-- a k2 -->', '卡二甲。', '',
  ].join('\n')
  for (const [label, frac, expectAfter] of [['上半 → 落在卡二甲之前', 0.5, false], ['下半 → 落在卡二甲之后', 0.98, true]]) {
    const p27 = await open(browser, TWO)
    await p27.waitForTimeout(400)
    const drop27 = await dragBlockOnto(p27, '卡一乙。', '卡二甲。', frac)
    await p27.waitForTimeout(1500)
    const c27 = await p27.evaluate(() => {
      window.__upage.probe.flush?.()
      const st = window.__upage.probe.fmState?.() ?? {}
      const line = /^amadeus_canvas:\s*(.*)$/m.exec(st.fm ?? '')
      let refs = null
      try { refs = JSON.parse(line[1]).cards.map((c) => c.ref) } catch { /* 下面按 null 断言 */ }
      return {
        cards: document.querySelectorAll('.amx-ucard').length,
        refs,
        body: st.body ?? '',
        // 正文里出现锚字面 = normalizer 拆壳了(用户肉眼看到的那一幕)
        rawMarker: (document.querySelector('.unified-body .ProseMirror')?.textContent ?? '').includes('<!-- a '),
      }
    })
    // 落进 k2 的辖域 = 在 body 里排在 `<!-- a k2 -->` **之后**;顺带按 frac 分辨前/后半。
    const iK2 = c27.body.indexOf('<!-- a k2 -->')
    const iMoved = c27.body.indexOf('卡一乙。')
    const iK2Own = c27.body.indexOf('卡二甲。')
    const inK2 = iK2 >= 0 && iMoved > iK2
    const after = iMoved > iK2Own
    record(`C27 跨卡拖块落进目标卡(${label})`,
      drop27 === 'ok' && c27.cards === 2 && JSON.stringify(c27.refs) === JSON.stringify(['k1', 'k2']) && !c27.rawMarker && inK2 && after === expectAfter,
      JSON.stringify({ drop: drop27, cards: c27.cards, refs: c27.refs, rawMarker: c27.rawMarker, inK2, after }))
    await p27.close()
  }

  // ── C28 两段式:一击选中(不落光标)、二击进编辑、Esc 退回选中 ────────────────────────
  // 判据里最关键的是**第一击不许让 PM 拿到焦点** —— 去掉 onDown 里那道 preventDefault,这一格当场红。
  const p28 = await open(browser, TWO)
  await p28.waitForTimeout(500)
  const at28 = await p28.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const p = el?.querySelector('p')
    if (!p) return null
    const r = p.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const read28 = () => p28.evaluate(() => ({
    sel: !!document.querySelector('.amx-el-selbox[data-anchor="k1"]'),
    editing: !!document.querySelector('.amx-el-selbox.is-editing[data-anchor="k1"]'),
    pmFocus: !!document.activeElement?.closest?.('.ProseMirror'),
  }))
  await p28.mouse.click(at28.x, at28.y)
  await p28.waitForTimeout(200)
  const one = await read28()
  await p28.mouse.click(at28.x, at28.y)
  await p28.waitForTimeout(200)
  const two = await read28()
  await p28.keyboard.press('Escape')
  await p28.waitForTimeout(200)
  const esc = await read28()
  record('C28 两段式:一击=选中且光标不进卡,二击=进编辑并聚焦 PM,Esc=退回选中',
    !!at28 && one.sel && !one.editing && !one.pmFocus && two.sel && two.editing && two.pmFocus && esc.sel && !esc.editing && !esc.pmFocus,
    JSON.stringify({ one, two, esc }))
  await p28.close()

  // ── C29 Tab/回车 = 子/兄弟节点,层级存 tree 且**不进正文**,层级线画得出来 ──────────────
  const ONE = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":300}]}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一。', '',
  ].join('\n')
  const p29 = await open(browser, ONE)
  await p29.waitForTimeout(500)
  const body29before = (await p29.evaluate(() => window.__upage.probe.fmState?.().body ?? ''))
  const at29 = await p29.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const r = el?.getBoundingClientRect()
    return r ? { x: r.left + 4, y: r.top + 4 } : null // chrome 圈:一击即选中
  })
  await p29.mouse.click(at29.x, at29.y)
  await p29.waitForTimeout(200)
  await p29.keyboard.press('Tab')
  await p29.waitForTimeout(900)
  await p29.keyboard.press('Enter')
  await p29.waitForTimeout(1500)
  const c29 = await p29.evaluate(() => {
    window.__upage.probe.flush?.()
    const st = window.__upage.probe.fmState?.() ?? {}
    let doc = null
    try { doc = JSON.parse(/^amadeus_canvas:\s*(.*)$/m.exec(st.fm ?? '')[1]) } catch { /* null */ }
    return {
      cards: document.querySelectorAll('.amx-ucard').length,
      tree: doc?.tree ?? null,
      treeLines: document.querySelectorAll('.amx-el-conn.is-tree').length,
      body: st.body ?? '',
    }
  })
  // ⚠️「层级不进正文」不能只搜 `tree|parent` —— 写侧完全可以往正文追加 `{"k2":"k1"}` 或 `k2→k1`
  //    而这个断言照绿(Codex 评审 P2-5)。改成**逐行白名单**:相对建两个节点之前,正文里新增的行
  //    只允许是锚行或空行,任何别的新增都算把层级漏进了正文。
  const before29 = new Set(body29before.split('\n'))
  const added29 = c29.body.split('\n').filter((l) => !before29.has(l))
  // 闭合锚(2026-08-19):新增行白名单 = 开锚 / 闭合符 / 空行(保存迁移会给既有卡补闭合符)。
  const bodyClean29 = added29.every((l) => l.trim() === '' || /^<!--\s*\/?a\s+[A-Za-z0-9_-]+\s*-->$/.test(l.trim()))
  const kids = c29.tree ? Object.entries(c29.tree) : []
  record('C29 Tab=子节点 / 回车=兄弟节点:两条层级都记在 tree 且指向 k1,画出两条层级线,正文零污染',
    c29.cards === 3 && kids.length === 2 && kids.every(([, p]) => p === 'k1') && c29.treeLines === 2 && bodyClean29,
    JSON.stringify({ ...c29, body: undefined, added29 }))
  await p29.close()

  // ── C30 Frame:拖标题条 = 连辖域一起搬(完全落在框内的才算) ──────────────────────────
  // 顺带钉住「框体不吃指针」:框盖住了主卡,能不能在主卡里正常点出光标就是那条纪律的体检。
  const FRAMED = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":100,"y":100,"w":200}],'
      + '"elements":[{"id":"f1","type":"frame","x":60,"y":60,"w":400,"h":300,"title":"甲组"},{"id":"s9","type":"shape","shape":"rect","x":900,"y":900,"w":80,"h":60}]}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一。', '',
  ].join('\n')
  const p30 = await open(browser, FRAMED)
  await p30.waitForTimeout(600)
  const bar30 = await p30.evaluate(() => {
    const b = document.querySelector('.amx-el-frame-bar')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const before30 = await p30.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    return { cx: Number(el?.dataset.x), title: (document.querySelector('.amx-el-frame-bar')?.textContent ?? '') }
  })
  if (bar30) {
    await p30.mouse.move(bar30.x, bar30.y)
    await p30.mouse.down()
    await p30.mouse.move(bar30.x + 60, bar30.y + 40, { steps: 6 })
    await p30.mouse.up()
  }
  await p30.waitForTimeout(1500)
  const c30 = await p30.evaluate(() => {
    window.__upage.probe.flush?.()
    let doc = null
    try { doc = JSON.parse(/^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '')[1]) } catch { /* null */ }
    const f = (doc?.elements ?? []).find((e) => e.id === 'f1')
    const s = (doc?.elements ?? []).find((e) => e.id === 's9')
    const card = (doc?.cards ?? []).find((c) => c.ref === 'k1')
    return { f, s, card, layerPE: getComputedStyle(document.querySelector('.amx-el-frame')).pointerEvents }
  })
  // ⚠️「框体不吃指针」不能只读 computed style:框内塞一个满幅的 `pointer-events:auto` 子元素/伪元素
  //    照样能糊出隐形挡板,而那条断言仍然绿(Codex 评审 P2-5)。这里**真去点框内的空白**:
  //    先看该点上的命中元素是不是框体,再把 pointerdown 派发给它、看框选起不起得来。
  const down30 = await p30.evaluate(() => {
    const fr = document.querySelector('.amx-el-frame')
    const r = fr.getBoundingClientRect()
    const x = r.left + r.width * 0.8
    const y = r.top + r.height * 0.85 // 卡片在框的上半,这里是空白
    const hit = document.elementFromPoint(x, y)
    const mk = (t, cx, cy) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 21, button: 0, clientX: cx, clientY: cy })
    hit?.dispatchEvent(mk('pointerdown', x, y))
    hit?.dispatchEvent(mk('pointermove', x - 90, y - 60))
    window.__shield = { x, y }
    return { hitCls: hit?.className ?? null, onFrame: !!hit?.closest?.('.amx-el-frame') }
  })
  // ⚠️ 框选是 React 状态,派发完**同一 tick** 读恒为 0(本文件栽过两次)。必须让出一帧。
  await p30.waitForTimeout(150)
  const marquee30 = await p30.evaluate(() => {
    const n = document.querySelectorAll('.amx-el-marquee').length
    const { x, y } = window.__shield
    const mk = (t, cx, cy) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 21, button: 0, clientX: cx, clientY: cy })
    document.querySelector('.amx-stage')?.dispatchEvent(mk('pointerup', x - 90, y - 60))
    return n
  })
  const shield30 = { ...down30, marquee: marquee30 }
  // ⚠️ 断言写成**相对位移相等**,不写死 60/40:舞台开卷会自动 fit,z 不是 1 时视口位移 ≠ 舞台位移,
  //    钉死数字等于在断言缩放比例。真正要守的是「框与框内成员位移完全一致、框外的一动不动」。
  const dfx = (c30.f?.x ?? 0) - 60
  const dfy = (c30.f?.y ?? 0) - 60
  record('C30 拖 Frame 标题条:框与框内的卡同步位移,框外的形状纹丝不动,框体不吃指针',
    !!bar30 && before30.title === '甲组' && dfx > 0 && dfy > 0
      && (c30.card?.x ?? 0) - 100 === dfx && (c30.card?.y ?? 0) - 100 === dfy
      && c30.s?.x === 900 && c30.s?.y === 900 && c30.layerPE === 'none'
      && !shield30.onFrame && shield30.marquee === 1,
    JSON.stringify({ dfx, dfy, ...c30, shield30 }))
  await p30.close()

  // ── C31 P1:卡片经**画布之外**的路消失时,层级也得剪(Codex 评审 P1,CONFIRMED)──────────
  // 文档模式下用块菜单删卡 / 收回文档根本不走 canvasStage 那几条路。逐个入口挂剪枝必漏,
  // 所以剪枝收口在 deriveCanvasJson(cards 是那一步的权威)。这一格钉住:删掉中间那层之后,
  // 孙节点**认祖父**(而不是继续挂在幽灵父节点上 —— 那会让线消失、还能继续往幽灵下面加节点)。
  const CHAIN = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":260},{"ref":"k2","x":360,"y":40,"w":260},{"ref":"k3","x":680,"y":40,"w":260}],"tree":{"k2":"k1","k3":"k2"}}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一。', '', '<!-- a k2 -->', '卡二。', '', '<!-- a k3 -->', '卡三。', '',
  ].join('\n')
  const p31 = await open(browser, CHAIN)
  await p31.waitForTimeout(500)
  const pre31 = await p31.evaluate(() => {
    let doc = null
    try { doc = JSON.parse(/^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '')[1]) } catch { /* null */ }
    return { tree: doc?.tree ?? null, lines: document.querySelectorAll('.amx-el-conn.is-tree').length }
  })
  // 走「收回文档」那条路(= 文档模式块菜单的同一个实现),它不经过 canvasStage 的删除路径。
  await p31.evaluate(async () => {
    const { unwrapCard } = await import('/src/amadeus/unified/canvasStage.tsx')
    unwrapCard(window.__upage.probe.view(), 'k2')
  })
  await p31.waitForTimeout(1500)
  // ⚠️ 落盘会触发一次回灌重建(structChanged → setEditorKey),那个窗口里整棵子树短暂缺席 ——
  //    盲采一帧读到的 `lines: 0` 是假红(C24 中过一次)。等它在场再读;真没了则这里超时,
  //    由 catch 记成 FAIL,比盲采更严。
  let lineBack31 = true
  try {
    await p31.waitForSelector('.amx-el-conn.is-tree', { timeout: 6000 })
  } catch {
    lineBack31 = false
  }
  const c31 = await p31.evaluate(() => {
    window.__upage.probe.flush?.()
    let doc = null
    try { doc = JSON.parse(/^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '')[1]) } catch { /* null */ }
    return { tree: doc?.tree ?? null, refs: (doc?.cards ?? []).map((c) => c.ref), lines: document.querySelectorAll('.amx-el-conn.is-tree').length }
  })
  record('C31 收回中间那层 → 孙节点认祖父(k3→k1),层级不留幽灵父节点',
    JSON.stringify(pre31.tree) === JSON.stringify({ k2: 'k1', k3: 'k2' }) && pre31.lines === 2
      && JSON.stringify(c31.refs) === JSON.stringify(['k1', 'k3'])
      && JSON.stringify(c31.tree) === JSON.stringify({ k3: 'k1' }) && lineBack31 && c31.lines === 1,
    JSON.stringify({ pre: pre31, ...c31, lineBack: lineBack31 }))
  await p31.close()

  // ── C32 真机打回(2026-08-18 A7/A10):**已选中**的卡按住正文拖 = 搬卡,不是选文字 ──────────
  // 两段式第一版的第二击「立刻进编辑然后 return」把整片让给了 PM,于是选中之后再按住正文拖,
  // 卡一动不动、拖出来的是文本选区(真机两条 ❌ 都是它)。现在两击都起拖,只把「要不要进编辑」
  // 记在手势上,纯点击才在 onUp 进编辑。这一格两头都钉:拖 → 卡真的动;点 → 真的进编辑。
  const p32 = await open(browser, TWO)
  await p32.waitForTimeout(500)
  const at32 = await p32.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const p = el?.querySelector('p')
    const r = p?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, x0: Number(el.dataset.x), y0: Number(el.dataset.y) } : null
  })
  await p32.mouse.click(at32.x, at32.y) // 一击:选中
  await p32.waitForTimeout(200)
  // 按住正文拖(真机 A7 的动作)
  await p32.mouse.move(at32.x, at32.y)
  await p32.mouse.down()
  await p32.mouse.move(at32.x + 120, at32.y + 70, { steps: 8 })
  await p32.mouse.up()
  await p32.waitForTimeout(1400)
  const moved32 = await p32.evaluate(() => {
    window.__upage.probe.flush?.()
    let doc = null
    try { doc = JSON.parse(/^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '')[1]) } catch { /* null */ }
    return {
      card: (doc?.cards ?? []).find((c) => c.ref === 'k1'),
      // 拖出来的**不能**是文本选区(那就是修之前的症状)
      textSel: (window.getSelection?.()?.toString() ?? '').length,
      editing: !!document.querySelector('.amx-el-selbox.is-editing'),
    }
  })
  // 纯点击(第二击)仍要进编辑,并且光标真落进卡里
  await p32.mouse.click(at32.x + 120, at32.y + 70)
  await p32.waitForTimeout(300)
  const edit32 = await p32.evaluate(() => ({
    editing: !!document.querySelector('.amx-el-selbox.is-editing[data-anchor="k1"]'),
    pmFocus: !!document.activeElement?.closest?.('.ProseMirror'),
    caretInCard: !!window.__upage.probe.view?.().state.selection.$from.node(1)?.type?.name?.includes('CanvasCard'),
  }))
  record('C32 选中的卡按住正文拖 = 搬卡(不是选文字);纯点击才进编辑并落光标',
    !!at32 && !!moved32.card && (moved32.card.x !== at32.x0 || moved32.card.y !== at32.y0)
      && moved32.textSel === 0 && !moved32.editing
      && edit32.editing && edit32.pmFocus && edit32.caretInCard,
    JSON.stringify({ from: { x: at32.x0, y: at32.y0 }, drag: moved32, click: edit32 }))
  await p32.close()

  // ── C33 真机第四轮 G5 打回:用工具建东西时,**无论落在哪**都得退出编辑态 ────────────────
  // 第一版按「指针还在不在正在编辑的那张卡里」判 —— 矩形恰好放在那张卡上时判成「还在卡里」→
  // 不退出 → 下一次单击那张卡直接落光标,两段式第一段被绕过(真机实测 `a` 打成 `ax`)。
  // 这一格**故意把形状放在正在编辑的那张卡的正中央**,专打那个位置判据。
  const p33 = await open(browser, TWO)
  await p33.waitForTimeout(500)
  const at33 = await p33.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const p = el?.querySelector('p')
    const r = p?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })
  await p33.mouse.click(at33.x, at33.y) // 一击选中
  await p33.waitForTimeout(180)
  await p33.mouse.click(at33.x, at33.y) // 二击进编辑
  await p33.waitForTimeout(250)
  const editing33 = await p33.evaluate(() => !!document.querySelector('.amx-el-selbox.is-editing[data-anchor="k1"]'))
  await pickTool(p33, '矩形')
  await p33.waitForTimeout(150)
  await p33.mouse.click(at33.x, at33.y) // ⚠️ 落点**就在正在编辑的那张卡上**
  await p33.waitForTimeout(400)
  await p33.mouse.click(at33.x, at33.y) // 再单击那张卡:必须只选中,不落光标
  await p33.waitForTimeout(300)
  const c33 = await p33.evaluate(() => ({
    shapes: document.querySelectorAll('.amx-el-shape').length,
    editing: !!document.querySelector('.amx-el-selbox.is-editing'),
    pmFocus: !!document.activeElement?.closest?.('.ProseMirror'),
  }))
  record('C33 用工具在「正在编辑的那张卡」上建形状 → 编辑态必须退出(下一击只选中不落光标)',
    !!at33 && editing33 && c33.shapes >= 1 && !c33.editing && !c33.pmFocus,
    JSON.stringify({ editingBefore: editing33, ...c33 }))
  await p33.close()

  /** fm 里的 canvas 键(解析后的对象;读不出 → null)。 */
  const cvDoc = (pg) => pg.evaluate(() => {
    window.__upage.probe.flush?.()
    try { return JSON.parse(/^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '')[1]) } catch { return null }
  })
  const Z = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'
  const SZ = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z'

  // ── C34 真实输入(CDP)拖卡:**拖拽中途**卡就在跟手,不是松手才跳 ─────────────────────────
  // 全仓的拖拽断言此前只看「松手后的落点」,过程一帧都没验过 —— 用户实报「拖拽没有过程显示」。
  // 这一格走真实输入管线(CDP Input:命中/默认动作/指针捕获全链路,与合成 dispatchEvent 不同层),
  // 在**松手之前**采样卡的位置与抬起态。
  const p34 = await open(browser, TWO)
  await p34.waitForTimeout(500)
  const at34 = await p34.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const r = el?.querySelector('p')?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, left0: el.offsetLeft, top0: el.offsetTop } : null
  })
  await p34.mouse.click(at34.x, at34.y) // 一击选中(两段式)
  await p34.waitForTimeout(200)
  await p34.mouse.move(at34.x, at34.y)
  await p34.mouse.down()
  await p34.mouse.move(at34.x + 140, at34.y + 90, { steps: 10 })
  await p34.waitForTimeout(120)
  // ⚠️ 判据是 offset* 与**计算样式**(dragCss 样式表的作用结果),不查 class/inline —— 手势期
  //    卡片 DOM 上就不该有任何陌生属性(有 = 又在往 PM 的 DOM 上写东西了,C34 的根因复辟)。
  const mid34 = await p34.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const cs = getComputedStyle(el)
    return { left: el.offsetLeft, top: el.offsetTop, cursor: cs.cursor, styleAttr: el.getAttribute('style') ?? '', selbox: (() => { const b = document.querySelector('.amx-el-selbox[data-anchor="k1"]'); return b ? b.offsetLeft : null })() }
  })
  await p34.mouse.up()
  await p34.waitForTimeout(1200)
  const doc34 = await cvDoc(p34)
  const end34 = await p34.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    return { cursor: getComputedStyle(el).cursor }
  })
  const k134 = (doc34?.cards ?? []).find((c) => c.ref === 'k1')
  record('C34 真实输入拖卡:中途实时跟手(±24px)+ 抬起光标 + 选中框同步 + 零 DOM 污染;松手落盘、态摘除',
    !!at34 && Math.abs(mid34.left - (at34.left0 + 140)) <= 24 && Math.abs(mid34.top - (at34.top0 + 90)) <= 24
      && mid34.cursor === 'grabbing' && !mid34.styleAttr.includes('left')
      && mid34.selbox != null && Math.abs(mid34.selbox - mid34.left) <= 4
      && !!k134 && Math.abs(k134.x - (40 + 140)) <= 24 && end34.cursor === 'grab',
    JSON.stringify({ at: at34, mid: mid34, k1: k134, end: end34 }))
  await p34.close()

  // ── C35 Shift+滚轮 = 横向平移(用户实报缺失) ─────────────────────────────────────────
  const p35 = await open(browser, TWO)
  await p35.waitForTimeout(400)
  const mat35 = (s) => ((s.match(/matrix\(([^)]+)\)/) || [])[1] ?? '').split(',').map(Number)
  const tf35a = await p35.evaluate(() => getComputedStyle(document.querySelector('.amx-stage-inner')).transform)
  await p35.mouse.move(720, 500)
  await p35.keyboard.down('Shift')
  await p35.mouse.wheel(0, 240)
  await p35.keyboard.up('Shift')
  await p35.waitForTimeout(250)
  const tf35b = await p35.evaluate(() => getComputedStyle(document.querySelector('.amx-stage-inner')).transform)
  const [za, , , , ea, fa] = mat35(tf35a)
  const [zb, , , , eb, fb] = mat35(tf35b)
  record('C35 Shift+滚轮 = 横向平移(x 动、y 不动、缩放不变)',
    Number.isFinite(ea) && eb !== ea && Math.abs(fb - fa) < 1 && Math.abs(zb - za) < 0.001,
    JSON.stringify({ before: tf35a, after: tf35b }))
  await p35.close()

  // ── C36 统一撤销时间线(评审 P0-1):Cmd+Z 永远退「最近那件事」,跨域按时序 ────────────────
  const SEED36 = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":300}],"elements":[{"id":"s1","type":"shape","shape":"rect","x":700,"y":300,"w":120,"h":80}]}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一甲。', '',
  ].join('\n')
  const p36 = await open(browser, SEED36)
  await p36.waitForTimeout(500)
  const k136 = async () => p36.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const s136 = async () => p36.evaluate(() => {
    const r = document.querySelector('.amx-el-shape[data-el="s1"]').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const geo36 = async () => {
    const doc = await cvDoc(p36)
    return {
      k1: (doc?.cards ?? []).find((c) => c.ref === 'k1'),
      s1: (doc?.elements ?? []).find((e) => e.id === 's1'),
      cards: (doc?.cards ?? []).length,
      tree: doc?.tree ?? null,
    }
  }
  // ① 动卡(PM 域)→ ② 动形状(fm 域)
  let pt36 = await k136()
  await p36.mouse.click(pt36.x, pt36.y)
  await p36.waitForTimeout(200)
  await p36.keyboard.press('ArrowRight') // 卡 +8(NUDGE)
  await p36.waitForTimeout(600)
  pt36 = await s136()
  await p36.mouse.click(pt36.x, pt36.y)
  await p36.waitForTimeout(200)
  await p36.keyboard.press('ArrowDown') // 形状 +8
  await p36.waitForTimeout(600)
  const g36a = await geo36() // k1.x=48, s1.y=308
  // ③④ Cmd+Z ×2:先退**形状**(最近),再退卡 —— 修前这里恒是先元素栈打光才轮到 PM,次序错乱
  await p36.evaluate(() => document.querySelector('.amx-stage').focus())
  await p36.keyboard.press(Z)
  await p36.waitForTimeout(700)
  const g36b = await geo36() // s1 回 300,卡仍 48
  await p36.keyboard.press(Z)
  await p36.waitForTimeout(700)
  const g36c = await geo36() // 卡回 40
  // ⑤ 重做 ×2:按时序重放(先卡后形状)
  await p36.keyboard.press(SZ)
  await p36.waitForTimeout(700)
  await p36.keyboard.press(SZ)
  await p36.waitForTimeout(700)
  const g36d = await geo36() // 48 / 308
  record('C36a 统一时间线:卡→形状交替操作,Cmd+Z 先退形状再退卡;重做按原时序重放',
    g36a.k1?.x === 48 && g36a.s1?.y === 308
      && g36b.k1?.x === 48 && g36b.s1?.y === 300
      && g36c.k1?.x === 40 && g36c.s1?.y === 300
      && g36d.k1?.x === 48 && g36d.s1?.y === 308,
    JSON.stringify({ a: g36a, b: g36b, c: g36c, d: g36d }))
  // ⑥ Tab 建子节点 = 'pair':一次 Cmd+Z 卡与层级一起退(修前要按两次,评审点名)
  pt36 = await k136()
  await p36.mouse.click(pt36.x, pt36.y)
  await p36.waitForTimeout(200)
  await p36.keyboard.press('Tab')
  await p36.waitForTimeout(1000)
  const g36e = await geo36() // cards=2, tree 一条
  await p36.evaluate(() => document.querySelector('.amx-stage').focus())
  await p36.keyboard.press(Z)
  await p36.waitForTimeout(1000)
  const g36f = await geo36() // cards=1, tree 清空
  record('C36b Tab 建子节点 = 一次动作一次撤销(卡与层级同退,pair 合帐)',
    g36e.cards === 2 && !!g36e.tree && Object.keys(g36e.tree).length === 1
      && g36f.cards === 1 && (!g36f.tree || Object.keys(g36f.tree).length === 0),
    JSON.stringify({ after: { cards: g36e.cards, tree: g36e.tree }, undone: { cards: g36f.cards, tree: g36f.tree } }))
  // ⑦ **卡内** Cmd+Z 也走时间线(捕获期拦截):在卡里打字 → 动形状 → 回卡里按 Cmd+Z,
  //    退的必须是**形状**(最近那件事),字一个不动 —— 修前卡内 Cmd+Z 直通 PM,把字退了。
  pt36 = await k136()
  await p36.mouse.click(pt36.x, pt36.y)
  await p36.waitForTimeout(180)
  await p36.mouse.click(pt36.x, pt36.y) // 二击进编辑
  await p36.waitForTimeout(250)
  await p36.keyboard.type('xyz')
  await p36.waitForTimeout(700)
  await p36.keyboard.press('Escape') // 退回选中
  await p36.waitForTimeout(200)
  pt36 = await s136()
  await p36.mouse.click(pt36.x, pt36.y)
  await p36.waitForTimeout(200)
  await p36.keyboard.press('ArrowDown') // s1: 308 → 316
  await p36.waitForTimeout(600)
  pt36 = await k136()
  await p36.mouse.click(pt36.x, pt36.y)
  await p36.waitForTimeout(180)
  await p36.mouse.click(pt36.x, pt36.y) // 回卡内(编辑态,焦点在 PM)
  await p36.waitForTimeout(250)
  await p36.keyboard.press(Z) // ← 焦点在卡里
  await p36.waitForTimeout(700)
  const g36g = await geo36()
  const text36 = await p36.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    return el?.textContent ?? ''
  })
  record('C36c 卡内 Cmd+Z 同样按时序:退的是刚动过的形状,不动刚打的字',
    g36g.s1?.y === 308 && text36.includes('xyz'),
    JSON.stringify({ s1: g36g.s1, text: text36.slice(0, 40) }))
  await p36.close()

  // ── C37 跨卡选区夹断(评审 P0-2):原生选区跨容器 → 夹回 anchor 所在容器 ─────────────────
  const p37 = await open(browser, TWO)
  await p37.waitForTimeout(500)
  const c37a = await p37.evaluate(() => {
    // 用**原生 DOM 选区**驱动(用户真实路径:按住鼠标扫过去,PM 从 domObserver 同步进状态)。
    const pmEl = document.querySelector('.unified-body .ProseMirror')
    const mainText = [...pmEl.querySelectorAll(':scope > p')].find((p2) => (p2.textContent ?? '').includes('主卡正文'))
    const card = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k2')
    const cardText = card?.querySelector('p')
    if (!mainText?.firstChild || !cardText?.firstChild) return null
    const s = window.getSelection()
    s.setBaseAndExtent(mainText.firstChild, 1, cardText.firstChild, 2)
    return true
  })
  await p37.waitForTimeout(300)
  const c37b = await p37.evaluate(() => {
    const view = window.__upage.probe.view()
    const { $anchor, $head, empty } = view.state.selection
    const cont = ($p) => ($p.depth >= 1 && $p.node(1).type.name === 'amadeusCanvasCard' ? `card:${$p.node(1).attrs.anchor}` : 'main')
    return { a: cont($anchor), h: cont($head), empty }
  })
  // 卡内 Cmd+A = 全选**本卡**(AllSelection 收窄),不是整篇
  const k237 = await p37.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k2')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p37.mouse.click(k237.x, k237.y)
  await p37.waitForTimeout(180)
  await p37.mouse.click(k237.x, k237.y)
  await p37.waitForTimeout(250)
  await p37.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await p37.waitForTimeout(300)
  const c37c = await p37.evaluate(() => {
    const view = window.__upage.probe.view()
    const { $from, $to, empty } = view.state.selection
    const inCard = ($p) => $p.depth >= 1 && $p.node(1).type.name === 'amadeusCanvasCard' && $p.node(1).attrs.anchor === 'k2'
    return { from: inCard($from), to: inCard($to), empty, text: view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, ' ') }
  })
  record('C37 跨卡选区夹断:主卡→卡二的原生扫选被夹回主卡;卡内 Cmd+A 只全选本卡',
    !!c37a && !c37b.empty && c37b.a === 'main' && c37b.h === 'main'
      && !c37c.empty && c37c.from && c37c.to && c37c.text.includes('卡二甲'),
    JSON.stringify({ sweep: c37b, cmdA: c37c }))
  await p37.close()

  // ── C38 ⠿ 拖**已有卡片**到舞台空白 = 搬卡(修前:blockToCard 对卡返回 null 而事件已接管,
  //    整个手势被静默吞掉 —— 拖了没反应)。驱动走全真用户路径拿卡片 NodeSelection:
  //    文档模式点进卡内文字 → Esc(blockLayer 阶梯,夹层段落升级到卡壳)→ 切画布 → ⠿ 拖到空白。 ──
  const p38 = await open(browser, TWO.replace('"mode":"canvas"', '"mode":"doc"'))
  await p38.waitForTimeout(500)
  const src38 = await p38.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p38.mouse.click(src38.x, src38.y) // 文档模式:直接落光标
  await p38.waitForTimeout(200)
  await p38.keyboard.press('Escape') // 文字态 Esc → 卡片 NodeSelection
  await p38.waitForTimeout(250)
  const nodeSel38 = await p38.evaluate(() => {
    const sel = window.__upage.probe.view().state.selection
    return { name: sel.node?.type?.name ?? null, anchor: sel.node?.attrs?.anchor ?? null }
  })
  await p38.evaluate(() => {
    ;[...document.querySelectorAll('.amx-modeseg button')].find((b) => (b.textContent ?? '').includes('画布'))?.click()
  })
  await p38.waitForTimeout(700) // 切模式 + 自动 fit(220ms 定时)落定
  const ok38 = await p38.evaluate(() => {
    const gutter = document.querySelector('.unified-gutter')
    const stage = document.querySelector('.amx-stage')
    if (!gutter || !stage) return false
    const sr = stage.getBoundingClientRect()
    const at = { clientX: sr.left + sr.width - 220, clientY: sr.top + sr.height - 180 }
    const fire = (ev, target, opts) => target.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, ...opts }))
    const dt = new DataTransfer()
    fire('dragstart', gutter, { dataTransfer: dt }) // NodeSelection 已就位,blockLayer 挂 view.dragging
    fire('dragover', stage, { ...at, dataTransfer: dt })
    fire('drop', stage, { ...at, dataTransfer: dt })
    fire('dragend', gutter, { dataTransfer: dt })
    return true
  })
  await p38.waitForTimeout(1400)
  const doc38 = await cvDoc(p38)
  const dom38 = await p38.evaluate(() => document.querySelectorAll('.amx-ucard').length)
  const k138 = (doc38?.cards ?? []).find((c) => c.ref === 'k1')
  record('C38 ⠿ 拖已有卡片到舞台空白 = 搬到落点(卡数不变、不拆壳、不再被静默吞掉)',
    nodeSel38.name === 'amadeusCanvasCard' && nodeSel38.anchor === 'k1'
      && ok38 && (doc38?.cards ?? []).length === 2 && dom38 === 2 && !!k138 && (k138.x !== 40 || k138.y !== 40),
    JSON.stringify({ nodeSel: nodeSel38, k1: k138, cards: (doc38?.cards ?? []).length, dom: dom38 }))
  await p38.close()

  // ── C39 主卡完全等同卡片:chrome 圈(padding)选中/拖动(中途 margin 跟手)、落盘、Cmd+Z 还原、
  //    连线到主卡。(2026-08-18 晚:「正文」标题条已按用户拍板移除,手柄=padding 圈,与卡片同款。) ──
  const p39 = await open(browser, TWO)
  await p39.waitForTimeout(500)
  const ring39 = await p39.evaluate(() => {
    const pm = document.querySelector('.unified-body .ProseMirror')
    if (!pm) return null
    const r = pm.getBoundingClientRect()
    // padding 圈上的点(左上角内侧 8px):事件目标 == .ProseMirror 本身 ⇒ chrome 语义
    return { x: r.left + 8, y: r.top + 8, bar: !!document.querySelector('.amx-main-bar'), l0: pm.offsetLeft, t0: pm.offsetTop }
  })
  await p39.mouse.click(ring39.x, ring39.y)
  await p39.waitForTimeout(250)
  const sel39 = await p39.evaluate(() => !!document.querySelector('.amx-el-selbox[data-main-sel]'))
  await p39.mouse.move(ring39.x, ring39.y)
  await p39.mouse.down()
  await p39.mouse.move(ring39.x + 90, ring39.y + 60, { steps: 6 })
  await p39.waitForTimeout(120)
  const mid39 = await p39.evaluate(() => {
    const pm = document.querySelector('.unified-body .ProseMirror')
    return { l: pm.offsetLeft, t: pm.offsetTop }
  })
  await p39.mouse.up()
  await p39.waitForTimeout(1200)
  const doc39 = await cvDoc(p39)
  await p39.evaluate(() => document.querySelector('.amx-stage').focus())
  await p39.keyboard.press(Z)
  await p39.waitForTimeout(1000)
  const doc39u = await cvDoc(p39)
  // 连线:conn 工具 → 点卡 k2 → 点主卡正文 → {ref:k2}→{main:true}
  await pickTool(p39, '连线')
  const k239 = await p39.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k2')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p39.mouse.click(k239.x, k239.y)
  await p39.waitForTimeout(200)
  const main39 = await p39.evaluate(() => {
    const r = document.querySelector('.unified-body .ProseMirror p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p39.mouse.click(main39.x, main39.y)
  await p39.waitForTimeout(1000)
  const doc39c = await cvDoc(p39)
  const conn39 = (doc39c?.elements ?? []).find((e2) => e2.type === 'connector')
  const dom39 = await p39.evaluate(() => document.querySelectorAll('.amx-el-conn:not(.is-tree):not(.is-preview)').length)
  record('C39 主卡完全等同卡片:无「正文」条;chrome 圈选中;拖动中途 margin 跟手、落盘、Cmd+Z 还原;可连线({main:true})',
    !!ring39 && !ring39.bar && sel39
      && Math.abs(mid39.l - (ring39.l0 + 90)) <= 24 && Math.abs(mid39.t - (ring39.t0 + 60)) <= 24
      && !!doc39?.main && Math.abs(doc39.main.x - 90) <= 24 && Math.abs(doc39.main.y - 60) <= 24
      && doc39u?.main?.x === 0 && doc39u?.main?.y === 0
      && !!conn39 && conn39.from?.ref === 'k2' && conn39.to?.main === true && dom39 === 1,
    JSON.stringify({ ring: ring39 && { bar: ring39.bar }, sel: sel39, mid: mid39, main: doc39?.main, undone: doc39u?.main, conn: conn39, dom: dom39 }))

  // ── C40 连线橡皮筋:第一击后有跟随预览线;悬到有效目标上双端高亮 ─────────────────────────
  await p39.keyboard.press('Escape') // 收工具/清态
  await p39.waitForTimeout(150)
  await pickTool(p39, '连线')
  const k140 = await p39.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p39.mouse.click(k140.x, k140.y)
  await p39.waitForTimeout(200)
  const blank40 = await p39.evaluate(() => {
    const sr = document.querySelector('.amx-stage').getBoundingClientRect()
    return { x: sr.left + sr.width - 120, y: sr.top + 120 }
  })
  await p39.mouse.move(blank40.x, blank40.y, { steps: 3 })
  await p39.waitForTimeout(200)
  const c40a = await p39.evaluate(() => ({
    line: !!document.querySelector('.amx-el-conn.is-preview'),
    targets: document.querySelectorAll('.amx-conn-target').length,
  }))
  const k240 = await p39.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k2')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p39.mouse.move(k240.x, k240.y, { steps: 3 })
  await p39.waitForTimeout(200)
  const c40b = await p39.evaluate(() => ({
    line: !!document.querySelector('.amx-el-conn.is-preview'),
    targets: document.querySelectorAll('.amx-conn-target').length,
  }))
  await p39.keyboard.press('Escape')
  record('C40 连线橡皮筋:第一击后预览线跟随指针(起点高亮);悬到有效目标 → 双端高亮',
    c40a.line && c40a.targets === 1 && c40b.line && c40b.targets === 2,
    JSON.stringify({ blank: c40a, over: c40b }))
  await p39.close()

  // ── C41 撤销删卡,层级跟卡一起回来(Codex 评审 F1) ─────────────────────────────────────
  // 删卡的层级剪枝在 deriveCanvasJson(唯一入口,不经 writeFm)——修前 Cmd+Z 只还原卡片节点,
  // 父子关系被剪后永久丢失、删中间层的「认祖父」也留了下来。现在删卡在 PM 笔之前推 fm 检查点、
  // 合成 'pair'。断言**逐字**比 tree(只查条数的话,认祖父残留 {k3:'k1'} 也照绿)。
  const CHAIN41 = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":280},{"ref":"k2","x":420,"y":40,"w":280},{"ref":"k3","x":800,"y":40,"w":280}],"tree":{"k2":"k1","k3":"k2"}}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '根。', '', '<!-- a k2 -->', '中间层。', '', '<!-- a k3 -->', '叶子。', '',
  ].join('\n')
  const p41 = await open(browser, CHAIN41)
  await p41.waitForTimeout(500)
  const k241 = await p41.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k2')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p41.mouse.click(k241.x, k241.y)
  await p41.waitForTimeout(200)
  await p41.keyboard.press('Delete')
  await p41.waitForTimeout(1000)
  const g41a = await cvDoc(p41) // 删中间层:cards [k1,k3],认祖父 {k3:k1}
  await p41.evaluate(() => document.querySelector('.amx-stage').focus())
  await p41.keyboard.press(Z)
  await p41.waitForTimeout(1000)
  const g41b = await cvDoc(p41) // 一击:卡与层级一起回来(逐字)
  await p41.keyboard.press(SZ)
  await p41.waitForTimeout(1000)
  const g41c = await cvDoc(p41) // 重做:回到删除后形态
  record('C41 删中间卡 → 一次 Cmd+Z 卡与层级一起回来(逐字);重做回到认祖父形态',
    JSON.stringify((g41a?.cards ?? []).map((c) => c.ref)) === JSON.stringify(['k1', 'k3'])
      && JSON.stringify(g41a?.tree) === JSON.stringify({ k3: 'k1' })
      && JSON.stringify((g41b?.cards ?? []).map((c) => c.ref)) === JSON.stringify(['k1', 'k2', 'k3'])
      && JSON.stringify(g41b?.tree) === JSON.stringify({ k2: 'k1', k3: 'k2' })
      && JSON.stringify((g41c?.cards ?? []).map((c) => c.ref)) === JSON.stringify(['k1', 'k3'])
      && JSON.stringify(g41c?.tree) === JSON.stringify({ k3: 'k1' }),
    JSON.stringify({ del: { refs: (g41a?.cards ?? []).map((c) => c.ref), tree: g41a?.tree }, undo: { refs: (g41b?.cards ?? []).map((c) => c.ref), tree: g41b?.tree }, redo: { refs: (g41c?.cards ?? []).map((c) => c.ref), tree: g41c?.tree } }))
  await p41.close()

  // ── C42 素笔记首次拖主卡 → Cmd+Z 真的拖回去 + 派生自然去物化(Codex 评审 F3) ─────────────
  // 修前:快照 m=null 时撤销跳过 onMain 却报成功 —— 屏幕一动不动,时间线白白消耗一格。
  const p42 = await open(browser, '# 素笔记\n\n只有正文,从没用过画布。\n')
  await p42.waitForTimeout(400)
  await p42.evaluate(() => {
    ;[...document.querySelectorAll('.amx-modeseg button')].find((b) => (b.textContent ?? '').includes('画布'))?.click()
  })
  await p42.waitForTimeout(700)
  const ring42 = await p42.evaluate(() => {
    const pm = document.querySelector('.unified-body .ProseMirror')
    const r = pm?.getBoundingClientRect()
    return r ? { x: r.left + 8, y: r.top + 8 } : null // chrome 圈 = padding(「正文」条已移除)
  })
  await p42.mouse.move(ring42.x, ring42.y)
  await p42.mouse.down()
  await p42.mouse.move(ring42.x + 80, ring42.y + 50, { steps: 5 })
  await p42.mouse.up()
  await p42.waitForTimeout(1000)
  const g42a = await cvDoc(p42) // 物化:main ≈ {80,50}
  await p42.evaluate(() => document.querySelector('.amx-stage').focus())
  await p42.keyboard.press(Z)
  await p42.waitForTimeout(1000)
  const g42b = await cvDoc(p42)
  const off42 = await p42.evaluate(() => {
    const pm = document.querySelector('.unified-body .ProseMirror')
    return { l: pm.offsetLeft, t: pm.offsetTop }
  })
  // 在主卡里敲一个字 → 派生发现「空 cards + 无元素」→ 整行剥掉(懒物化闭环)
  const p42text = await p42.evaluate(() => {
    const r = document.querySelector('.unified-body .ProseMirror p').getBoundingClientRect()
    return { x: r.left + 20, y: r.top + r.height / 2 }
  })
  await p42.mouse.click(p42text.x, p42text.y)
  await p42.waitForTimeout(150)
  await p42.mouse.click(p42text.x, p42text.y) // 两段式:二击落光标
  await p42.waitForTimeout(250)
  await p42.keyboard.type('x')
  await p42.waitForTimeout(1000)
  const line42 = await p42.evaluate(() => {
    window.__upage.probe.flush?.()
    return (/^amadeus_canvas:\s*(.*)$/m.exec(window.__upage.probe.fmState?.().fm ?? '') || [])[1] ?? null
  })
  // 撤销后允许两种形态:行还在但 main 回默认,或派生已经把整行剥掉(g42b null —— 实测走的是后者,
  // flush 顺带触发派生,比「等下一次打字」还早)。两种都算「回到未物化」。
  record('C42 素笔记首次拖主卡:落盘物化;Cmd+Z 几何真回默认位;派生把整行剥掉(不留渣)',
    !!ring42 && !!g42a?.main && Math.abs(g42a.main.x - 80) <= 24 && Math.abs(g42a.main.y - 50) <= 24
      && (g42b == null || (g42b.main?.x === 0 && g42b.main?.y === 0)) && off42.l === 0 && off42.t === 0
      && line42 == null,
    JSON.stringify({ moved: g42a?.main, undone: g42b?.main ?? null, off: off42, line: line42 }))
  await p42.close()

  // ── C43 pair 半边失效(编辑器重建)→ 整条丢弃,绝不半撤销(Codex 评审 F2) ────────────────
  // 插件启停(C17 同款)重建编辑器 → PM 撤销栈清零,而 fm 栈/时间线还活着。修前:pair 只退 fm
  // 半边(层级没了、卡还在),还把残废 pair 推进 redo。现在两侧可执行性预检,缺一侧整条丢弃 ——
  // 断言「按了 Cmd+Z 但**什么都没变**」,半退才是红。
  const p43 = await open(browser, SEED36)
  await p43.waitForTimeout(500)
  const k143 = await p43.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p43.mouse.click(k143.x, k143.y)
  await p43.waitForTimeout(200)
  await p43.keyboard.press('Tab') // pair:建子卡 + 记层级
  await p43.waitForTimeout(1000)
  const g43a = await cvDoc(p43)
  await p43.evaluate(async () => {
    const m = await import('/src/amadeus/plugins/editorExtensions.ts')
    m.addEditorExtension('__probe43__', () => []) // 编辑器重建,PM 栈清零
  })
  await p43.waitForTimeout(900)
  await p43.evaluate(() => document.querySelector('.amx-stage').focus())
  await p43.keyboard.press(Z)
  await p43.waitForTimeout(900)
  const g43b = await cvDoc(p43)
  record('C43 编辑器重建后撤销 pair:两侧缺一 → 整条丢弃,卡与层级都原样(半撤销才是红)',
    (g43a?.cards ?? []).length === 2 && Object.keys(g43a?.tree ?? {}).length === 1
      && (g43b?.cards ?? []).length === 2 && JSON.stringify(g43b?.tree) === JSON.stringify(g43a?.tree),
    JSON.stringify({ after: { cards: (g43a?.cards ?? []).length, tree: g43a?.tree }, undone: { cards: (g43b?.cards ?? []).length, tree: g43b?.tree } }))
  await p43.close()

  // ── C44 主卡两段式(与卡片 C28 同构)+ 主卡免删 ─────────────────────────────────────────
  // 2026-08-18 晚「完全等同卡片」:正文区一击=选中主卡且**不落光标**,二击=进编辑(光标落点击处),
  // Esc=退回选中。两段式让「点正文任意处」成了一键选中主卡 —— Delete 的可达面骤宽,这里同时
  // 钉死 removeSel 的免删构造(只认 c:/e: 前缀):选中主卡按 Delete、Cmd+A 全选按 Delete,
  // 正文都必须毫发无损(全选删除只带走卡片/元素)。
  const p44 = await open(browser, TWO)
  await p44.waitForTimeout(500)
  const pt44 = await p44.evaluate(() => {
    const p = document.querySelector('.unified-body .ProseMirror > p') // 主卡正文段(顶层,不在卡内)
    const r = p.getBoundingClientRect()
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }
  })
  const read44 = () => p44.evaluate(() => ({
    sel: !!document.querySelector('.amx-el-selbox[data-main-sel]'),
    editing: !!document.querySelector('.amx-el-selbox.is-editing[data-main-sel]'),
    pmFocus: !!document.activeElement?.closest?.('.ProseMirror'),
  }))
  await p44.mouse.click(pt44.x, pt44.y)
  await p44.waitForTimeout(200)
  const one44 = await read44()
  await p44.mouse.click(pt44.x, pt44.y)
  await p44.waitForTimeout(200)
  const two44 = await read44()
  await p44.keyboard.press('Escape')
  await p44.waitForTimeout(200)
  const esc44 = await read44()
  await p44.keyboard.press('Delete') // 选中主卡按 Delete:免删
  await p44.waitForTimeout(600)
  const del44 = await p44.evaluate(() => ({
    cards: document.querySelectorAll('.amx-ucard').length,
    hasMain: (document.querySelector('.unified-body .ProseMirror')?.textContent ?? '').includes('主卡正文'),
  }))
  await p44.evaluate(() => document.querySelector('.amx-stage').focus())
  await p44.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await p44.waitForTimeout(200)
  await p44.keyboard.press('Delete') // 全选(含主卡)删除:只带走卡片,主卡无损
  await p44.waitForTimeout(900)
  const alldel44 = await p44.evaluate(() => ({
    cards: document.querySelectorAll('.amx-ucard').length,
    hasMain: (document.querySelector('.unified-body .ProseMirror')?.textContent ?? '').includes('主卡正文'),
  }))
  record('C44 主卡两段式:一击=选中不落光标,二击=进编辑,Esc=退回选中;Delete/全选删除动不了主卡',
    one44.sel && !one44.editing && !one44.pmFocus
      && two44.sel && two44.editing && two44.pmFocus
      && esc44.sel && !esc44.editing && !esc44.pmFocus
      && del44.cards === 2 && del44.hasMain
      && alldel44.cards === 0 && alldel44.hasMain,
    JSON.stringify({ one: one44, two: two44, esc: esc44, del: del44, alldel: alldel44 }))
  await p44.close()

  // ── C45 文档模式:零装饰无缝 + 悬停/光标进入浮现整块约束框 + 不泄画布 ──────────────────
  // 2026-08-18 晚用户拍板(对齐 AFFiNE):左轨线撤掉,平时与正文完全无缝;整块圆角 outline 只在
  // :hover 或 amx-card-active(光标在卡内,PM decoration)时浮现。悬停断言必须走**真实指针**
  // (合成事件设不了 :hover);光标断言先点进卡、再把指针挪开 —— 框还在才证明是 active 类而非悬停。
  const DOC45 = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":280}]}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一内容。', '',
  ].join('\n')
  const TRANS45 = 'rgba(0, 0, 0, 0)'
  const p45 = await open(browser, DOC45)
  await p45.waitForTimeout(500)
  const base45 = await p45.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.amx-ucard'))
    // offset/圆角钉值(2026-08-18 深夜用户拍板「削弱弧度防重合」):2px 外扩 ×2 < 卡间距,
    // 相邻活动框+悬停框同屏也画不到一起;6px 圆角配小 offset 才不出「药丸」感。
    return { blw: cs.borderLeftWidth, pl: cs.paddingLeft, oc: cs.outlineColor, oo: cs.outlineOffset, br: cs.borderRadius }
  })
  const cpt45 = await p45.evaluate(() => {
    const r = document.querySelector('.amx-ucard p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p45.mouse.move(cpt45.x, cpt45.y, { steps: 2 })
  await p45.waitForTimeout(350) // transition 150ms,余量翻倍
  const hov45 = await p45.evaluate(() => getComputedStyle(document.querySelector('.amx-ucard')).outlineColor)
  await p45.mouse.click(cpt45.x, cpt45.y) // 文档模式:直接落光标
  await p45.waitForTimeout(150)
  await p45.mouse.move(8, 8) // 指针挪开:悬停贡献清零
  await p45.waitForTimeout(350)
  const act45 = await p45.evaluate(() => ({
    active: !!document.querySelector('.amx-ucard.amx-card-active'),
    oc: getComputedStyle(document.querySelector('.amx-ucard')).outlineColor,
  }))
  const mpt45 = await p45.evaluate(() => {
    const r = document.querySelector('.unified-body .ProseMirror > p').getBoundingClientRect()
    return { x: r.left + 30, y: r.top + r.height / 2 }
  })
  await p45.mouse.click(mpt45.x, mpt45.y) // 光标回正文段 → active 摘除
  await p45.waitForTimeout(150)
  await p45.mouse.move(8, 8)
  await p45.waitForTimeout(350)
  const off45 = await p45.evaluate(() => ({
    active: !!document.querySelector('.amx-ucard.amx-card-active'),
    oc: getComputedStyle(document.querySelector('.amx-ucard')).outlineColor,
  }))
  // 卡内**块级** NodeSelection(⠿ 右键=blockLayer 设块级选中,文档模式的真实路径)光标作用域仍
  // 在卡里 → 约束框必须还在(Codex 评审 2026-08-18 晚:修前 NodeSelection 分支只认整卡,恰好在
  // 搬/删块时框消失)。`.ProseMirror-selectednode` 同时在场 = 真的设上了块级选中,防空转假绿。
  await p45.mouse.click(cpt45.x, cpt45.y, { button: 'right' })
  await p45.waitForTimeout(250)
  const blockSel45 = await p45.evaluate(() => ({
    active: !!document.querySelector('.amx-ucard.amx-card-active'),
    nodeSel: !!document.querySelector('.ProseMirror-selectednode'),
  }))
  await p45.keyboard.press('Escape')
  await p45.waitForTimeout(150)
  // AllSelection:Mod+A 是**分级全选**(blockLayer selectAllKeymap:一级=本段/二级=整卡/三级=整篇),
  // 按到第三级才是 AllSelection —— 前两级选区都还在卡里,约束框必须在;第三级两端 depth 0,必须摘。
  await p45.mouse.click(cpt45.x, cpt45.y)
  await p45.waitForTimeout(150)
  const A45 = process.platform === 'darwin' ? 'Meta+a' : 'Control+a'
  await p45.keyboard.press(A45)
  await p45.keyboard.press(A45)
  await p45.waitForTimeout(150)
  const tier245 = await p45.evaluate(() => !!document.querySelector('.amx-ucard.amx-card-active'))
  await p45.keyboard.press(A45)
  await p45.waitForTimeout(150)
  const allSel45 = await p45.evaluate(() => !!document.querySelector('.amx-ucard.amx-card-active'))
  // 不泄画布:切画布模式后悬停,outline 必须仍是 none(画布的 outline 语义归 .amx-droptarget)
  await p45.evaluate(() => {
    ;[...document.querySelectorAll('.amx-modeseg button')].find((b) => (b.textContent ?? '').includes('画布'))?.click()
  })
  await p45.waitForTimeout(700)
  const cvpt45 = await p45.evaluate(() => {
    const r = document.querySelector('.amx-ucard').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + 8 }
  })
  await p45.mouse.move(cvpt45.x, cvpt45.y, { steps: 2 })
  await p45.waitForTimeout(300)
  const cv45 = await p45.evaluate(() => getComputedStyle(document.querySelector('.amx-ucard')).outlineStyle)
  record('C45 文档模式:卡片零装饰无缝;悬停/光标进入浮现约束框(offset 2px/圆角 6px,含卡内块级 NodeSelection),AllSelection 不挂;光标离开摘除;不泄画布',
    base45.blw === '0px' && base45.pl === '0px' && base45.oc === TRANS45
      && base45.oo === '2px' && base45.br === '6px'
      && hov45 !== TRANS45 && act45.active && act45.oc !== TRANS45
      && !off45.active && off45.oc === TRANS45
      && blockSel45.active && blockSel45.nodeSel && tier245 && !allSel45 && cv45 === 'none',
    JSON.stringify({ base: base45, hov: hov45, act: act45, off: off45, blockSel: blockSel45, tier2: tier245, allSel: allSel45, canvas: cv45 }))
  await p45.close()

  // ── C46 画布右键仲裁:捕获期先于 blockLayer,单菜单且不绕两段式(Codex 评审 2026-08-18 晚)──
  // 修前:blockLayer 的 contextmenu 在 .ProseMirror 冒泡先抢 —— preventDefault + 块级
  // NodeSelection + 块菜单,舞台随后又开画布菜单 = 双菜单,且非编辑态就能对正文做块级删除。
  // 现在:非编辑态右键主卡/卡片正文 = 只开画布菜单(主卡菜单无删除项);编辑态 = 两个菜单都不开
  // (原生文本菜单,headless 断言不了原生,断言「我们的两个菜单都不在」)。
  const p46 = await open(browser, TWO)
  await p46.waitForTimeout(500)
  const m46 = await p46.evaluate(() => {
    const p = document.querySelector('.unified-body .ProseMirror > p')
    const r = p.getBoundingClientRect()
    return { x: r.left + 40, y: r.top + r.height / 2 }
  })
  const menus46 = () => p46.evaluate(() => ({
    canvas: document.querySelectorAll('.ctx-menu:not(.unified-block-menu)').length,
    block: document.querySelectorAll('.ctx-menu.unified-block-menu').length,
    mainSel: !!document.querySelector('.amx-el-selbox[data-main-sel]'),
    delItem: [...document.querySelectorAll('.ctx-menu:not(.unified-block-menu) button, .ctx-menu:not(.unified-block-menu) [role="menuitem"], .ctx-menu:not(.unified-block-menu) li')].some((b) => (b.textContent ?? '').includes('删除')),
  }))
  await p46.mouse.click(m46.x, m46.y, { button: 'right' }) // 非编辑态右键主卡正文
  await p46.waitForTimeout(250)
  const a46 = await menus46()
  await p46.keyboard.press('Escape')
  await p46.waitForTimeout(150)
  // 进入编辑态(两段式两击),再右键:两个菜单都不许开
  await p46.mouse.click(m46.x, m46.y)
  await p46.waitForTimeout(150)
  await p46.mouse.click(m46.x, m46.y)
  await p46.waitForTimeout(200)
  await p46.mouse.click(m46.x, m46.y, { button: 'right' })
  await p46.waitForTimeout(250)
  const b46 = await menus46()
  // 非编辑态右键**卡片**正文:同样只开画布菜单
  await p46.keyboard.press('Escape')
  await p46.waitForTimeout(150)
  const k46 = await p46.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p46.mouse.click(k46.x, k46.y, { button: 'right' })
  await p46.waitForTimeout(250)
  const c46 = await p46.evaluate(() => ({
    canvas: document.querySelectorAll('.ctx-menu:not(.unified-block-menu)').length,
    block: document.querySelectorAll('.ctx-menu.unified-block-menu').length,
  }))
  record('C46 画布右键仲裁:非编辑态主卡/卡片正文=只开画布菜单(主卡无删除项);编辑态=两菜单都不开(归原生)',
    a46.canvas === 1 && a46.block === 0 && a46.mainSel && !a46.delItem
      && b46.canvas === 0 && b46.block === 0
      && c46.canvas === 1 && c46.block === 0,
    JSON.stringify({ mainIdle: a46, mainEditing: b46, cardIdle: c46 }))
  await p46.close()

  // ── C47 双击真实命中(2026-08-18 深夜用户实报「双击卡片凭空多一张空白卡」)────────────────
  // 根因:两段式在 pointerdown 里 setPointerCapture,派生 dblclick 的 e.target 被重定向到 host,
  // isBlank 误判「空白」→ addCardAt。修法 = elementFromPoint 取坐标下真实命中。三个面各钉一格:
  // 卡片(进编辑不建卡)/ 形状(askString 弹窗不建卡;harness 需挂 AskStringHost)/ 空白(照旧建卡)。
  const p47 = await open(browser, TWO)
  await p47.waitForTimeout(500)
  const at47 = await p47.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p47.mouse.dblclick(at47.x, at47.y)
  await p47.waitForTimeout(500)
  const card47 = await p47.evaluate(() => ({
    cards: document.querySelectorAll('.amx-ucard').length,
    editing: !!document.querySelector('.amx-el-selbox.is-editing[data-anchor="k1"]'),
    pmFocus: !!document.activeElement?.closest?.('.ProseMirror'),
  }))
  await p47.keyboard.press('Escape')
  await p47.keyboard.press('Escape')
  // 形状:矩形工具拖一个出来 → 双击中心 = 文字弹窗
  await pickTool(p47, '矩形')
  const sr47 = await p47.evaluate(() => { const r = document.querySelector('.amx-stage').getBoundingClientRect(); return { x: r.left + 200, y: r.top + 430 } })
  await p47.mouse.move(sr47.x, sr47.y)
  await p47.mouse.down()
  await p47.mouse.move(sr47.x + 120, sr47.y + 80, { steps: 4 })
  await p47.mouse.up()
  await p47.waitForTimeout(300)
  await p47.mouse.dblclick(sr47.x + 60, sr47.y + 40)
  await p47.waitForTimeout(400)
  const shape47 = await p47.evaluate(() => ({
    cards: document.querySelectorAll('.amx-ucard').length,
    dialog: !!document.querySelector('.dialog-overlay .dialog-input'),
  }))
  await p47.keyboard.press('Escape') // 关弹窗
  await p47.waitForTimeout(200)
  // 空白:照旧建卡(别把修复修过头)
  const blank47 = await p47.evaluate(() => { const r = document.querySelector('.amx-stage').getBoundingClientRect(); return { x: r.left + r.width - 160, y: r.top + r.height - 120 } })
  await p47.mouse.dblclick(blank47.x, blank47.y)
  await p47.waitForTimeout(600)
  const after47 = await p47.evaluate(() => document.querySelectorAll('.amx-ucard').length)
  record('C47 双击真实命中:卡片=进编辑不建卡;形状=文字弹窗不建卡;空白=照旧建卡',
    card47.cards === 2 && card47.editing && card47.pmFocus
      && shape47.cards === 2 && shape47.dialog && after47 === 3,
    JSON.stringify({ card: card47, shape: shape47, blankAfter: after47 }))
  await p47.close()

  // ── C48 P0 散块吸收(2026-08-18 深夜用户实报:文档模式拖块到卡缝 → 整批卡拆壳、锚裸奔)────
  // 新不变式:**只有卡节点自己被挪动才拆壳(§3.2)**;非卡内容闯进卡区一律吸进前一张卡尾。
  // a) 真实拖拽路径:⠿ 拖「主卡正文」进 k1/k2 之间的卡缝 → 吸进 k1 尾,两张卡一张不拆、正文零
  //    锚字面;Cmd+Z 一击整体还原(drop+吸收并进同一撤销组)。⚠️ 拖的必须是**位移可观测**的块:
  //    首版拖 k1 自己的段落,精确落点把位置算回原地(自落吞掉),断言在测一场没发生的拖拽。
  const DOC48 = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":300},{"ref":"k2","x":420,"y":40,"w":300}]}',
    '---', '', '<!-- a k1 -->', '卡一甲。', '', '卡一乙。', '', '<!-- a k2 -->', '卡二甲。', '',
  ].join('\n')
  const DOC48M = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":300},{"ref":"k2","x":420,"y":40,"w":300}]}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一甲。', '', '<!-- a k2 -->', '卡二甲。', '',
  ].join('\n')
  const p48 = await open(browser, DOC48M)
  await p48.waitForTimeout(500)
  const src48 = await p48.evaluate(() => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror > p')].find((x) => (x.textContent ?? '').trim() === '主卡正文。')
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p48.mouse.move(src48.x, src48.y)
  await p48.waitForTimeout(300)
  const drove48 = await p48.evaluate(() => {
    const gutter = document.querySelector('.unified-gutter')
    const drag = gutter?.querySelector('.drag-handle')
    if (!gutter || !drag) return 'no-handle'
    const k1 = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1').getBoundingClientRect()
    const k2 = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k2').getBoundingClientRect()
    const at = { clientX: k1.left + k1.width / 2, clientY: (k1.bottom + k2.top) / 2 } // 卡缝正中
    const fire = (ev, target, opts) => target.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, ...opts }))
    drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const dt = new DataTransfer()
    fire('dragstart', gutter, { dataTransfer: dt })
    const el = document.elementFromPoint(at.clientX, at.clientY) ?? document.body
    fire('dragover', el, { ...at, dataTransfer: dt })
    fire('drop', el, { ...at, dataTransfer: dt })
    fire('dragend', gutter, { dataTransfer: dt })
    return 'ok'
  })
  await p48.waitForTimeout(1200)
  const read48 = () => p48.evaluate(() => {
    window.__upage.probe.flush?.()
    const st = window.__upage.probe.fmState?.() ?? {}
    const view = window.__upage.probe.view()
    const tops = []
    view.state.doc.forEach((n) => tops.push(n.type.name))
    const line = /^amadeus_canvas:\s*(.*)$/m.exec(st.fm ?? '')
    let refs = null
    try { refs = JSON.parse(line[1]).cards.map((c) => c.ref) } catch { /* null 兜底 */ }
    const k1texts = []
    view.state.doc.forEach((n) => { if (n.type.name === 'amadeusCanvasCard' && String(n.attrs.anchor) === 'k1') n.forEach((c) => k1texts.push(c.textContent)) })
    return { tops, refs, k1texts, rawMarker: (document.querySelector('.unified-body .ProseMirror')?.textContent ?? '').includes('<!-- a ') }
  })
  const a48 = await read48()
  // undo 一击整体还原(吸收是 appendTransaction,与 drop 同撤销组;两击才回去 = 中间态会露给用户)
  const mp48 = await p48.evaluate(() => {
    const r = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => (x.textContent ?? '').trim() === '卡二甲。').getBoundingClientRect()
    return { x: r.left + 10, y: r.top + r.height / 2 }
  })
  await p48.mouse.click(mp48.x, mp48.y)
  await p48.waitForTimeout(200)
  await p48.keyboard.press(Z)
  await p48.waitForTimeout(500)
  const u48 = await read48()
  await p48.close()
  // b) 成批散块 + 跨卡归属(一笔事务顶层塞 3 个段落:k1 后两个、k2 后一个)→ 各吸各的前卡,同卡次序保持
  const p48b = await open(browser, DOC48)
  await p48b.waitForTimeout(500)
  const batch48 = await p48b.evaluate(() => {
    const view = window.__upage.probe.view()
    const { doc, schema } = view.state
    const para = (t) => schema.nodes.paragraph.create(null, schema.text(t))
    let k1end = null
    let k2end = null
    doc.forEach((n, off) => {
      if (n.type.name !== 'amadeusCanvasCard') return
      if (String(n.attrs.anchor) === 'k1') k1end = off + n.nodeSize
      if (String(n.attrs.anchor) === 'k2') k2end = off + n.nodeSize
    })
    if (k1end == null || k2end == null) return 'no-cards'
    let tr = view.state.tr
    tr = tr.insert(k2end, para('丙散。')) // 先插后面的,前面坐标不动
    tr = tr.insert(k1end, para('乙散。'))
    tr = tr.insert(k1end, para('甲散。'))
    view.dispatch(tr)
    return 'ok'
  })
  await p48b.waitForTimeout(600)
  const b48 = await p48b.evaluate(() => {
    const view = window.__upage.probe.view()
    const cards = {}
    const tops = []
    view.state.doc.forEach((n) => {
      tops.push(n.type.name)
      if (n.type.name === 'amadeusCanvasCard') {
        const texts = []
        n.forEach((c) => texts.push(c.textContent))
        cards[String(n.attrs.anchor)] = texts
      }
    })
    return { tops, cards }
  })
  // c) §3.2 不回归:把卡 k2 整节点挪到**主卡正文之前**(卡在非卡内容前 = 离开尾部卡区)→ 仍走
  //    拆壳,k2 锚转字面、cards 掉它。⚠️ 种子必须带主卡正文:纯卡文档里怎么换卡序都还是合法卡尾,
  //    根本触发不了拆壳(首版在 p48 原地搬卡就是这个假阳性)。
  const p48c = await open(browser, DOC48M)
  await p48c.waitForTimeout(500)
  const move48 = await p48c.evaluate(() => {
    const view = window.__upage.probe.view()
    let k2 = null
    view.state.doc.forEach((n, off) => { if (n.type.name === 'amadeusCanvasCard' && String(n.attrs.anchor) === 'k2') k2 = { from: off, to: off + n.nodeSize, node: n } })
    if (!k2) return 'no-k2'
    let tr = view.state.tr.delete(k2.from, k2.to)
    tr = tr.insert(0, k2.node)
    view.dispatch(tr)
    return 'ok'
  })
  await p48c.waitForTimeout(1200)
  const c48 = await p48c.evaluate(() => {
    window.__upage.probe.flush?.()
    const st = window.__upage.probe.fmState?.() ?? {}
    const view = window.__upage.probe.view()
    const tops = []
    view.state.doc.forEach((n) => tops.push(n.type.name))
    const line = /^amadeus_canvas:\s*(.*)$/m.exec(st.fm ?? '')
    let refs = null
    try { refs = JSON.parse(line[1]).cards.map((c) => c.ref) } catch { /* null 兜底 */ }
    return { tops, refs, rawK2: (document.querySelector('.unified-body .ProseMirror')?.textContent ?? '').includes('<!-- a k2 -->') }
  })
  await p48c.close()
  record('C48a ⠿ 真实拖主卡段落进卡缝=吸进前卡尾(位移可观测),卡不拆锚不裸;Cmd+Z 一击整体还原',
    drove48 === 'ok'
      && JSON.stringify(a48.tops) === JSON.stringify(['amadeusCanvasCard', 'amadeusCanvasCard'])
      && JSON.stringify(a48.refs) === JSON.stringify(['k1', 'k2'])
      && JSON.stringify(a48.k1texts) === JSON.stringify(['卡一甲。', '主卡正文。']) && !a48.rawMarker
      && JSON.stringify(u48.tops) === JSON.stringify(['paragraph', 'amadeusCanvasCard', 'amadeusCanvasCard'])
      && JSON.stringify(u48.k1texts) === JSON.stringify(['卡一甲。']) && !u48.rawMarker
      && JSON.stringify(u48.refs) === JSON.stringify(['k1', 'k2']),
    JSON.stringify({ drove: drove48, after: a48, undo: u48 }))
  // 闭合锚(2026-08-19)重写 b/c 两格:散块=合法顶层正文(吸收退役),拖卡=整卡搬家(拆壳退役,
  // 只走块菜单「收回文档」)。别按旧语义改回去 —— 旧断言守的是「尾部连续卡区」不变式,病根已除。
  record('C48b 成批散块留在顶层=合法正文(不吸收不拆壳),卡内容与 cards 逐字不动',
    batch48 === 'ok'
      && JSON.stringify(b48.tops) === JSON.stringify(['amadeusCanvasCard', 'paragraph', 'paragraph', 'amadeusCanvasCard', 'paragraph'])
      && JSON.stringify(b48.cards.k1) === JSON.stringify(['卡一甲。', '卡一乙。'])
      && JSON.stringify(b48.cards.k2) === JSON.stringify(['卡二甲。']),
    JSON.stringify({ drove: batch48, ...b48 }))
  record('C48c 拖卡=整卡搬家:卡节点挪到正文前面仍是完整卡(零拆壳零锚字面),cards 随文序',
    move48 === 'ok'
      && JSON.stringify(c48.tops) === JSON.stringify(['amadeusCanvasCard', 'paragraph', 'amadeusCanvasCard'])
      && !c48.rawK2 && JSON.stringify([...(c48.refs ?? [])].sort()) === JSON.stringify(['k1', 'k2']),
    JSON.stringify({ drove: move48, ...c48 }))
  await p48b.close()

  // ── C49 标题回车(AFFiNE doc-title 语义;方向键滑入只落光标)──────────────────────────────
  // 首块有内容 → 顶插空白首行;首块已是空段 → 不重复插;首块是卡片(纯卡文档)→ 也顶插(主卡区合法);
  // ArrowDown 滑入 → 恒不插行。
  const DOC49 = ['---', 'amadeus_schema: amadeus.page/4', '---', '', '主正文。', ''].join('\n')
  const p49 = await open(browser, DOC49)
  await p49.waitForTimeout(400)
  const shape49 = () => p49.evaluate(() => {
    const view = window.__upage.probe.view()
    const first = view.state.doc.firstChild
    return {
      n: view.state.doc.childCount,
      firstType: first?.type.name ?? null,
      firstEmpty: first?.type.name === 'paragraph' && first.content.size === 0,
      selFrom: view.state.selection.from,
      pmFocus: !!document.activeElement?.closest?.('.ProseMirror'),
    }
  })
  await p49.click('.amx-title-input')
  await p49.keyboard.press('Enter')
  await p49.waitForTimeout(400)
  const e49 = await shape49()
  await p49.click('.amx-title-input')
  await p49.keyboard.press('Enter') // 首块已是空段:不重复插
  await p49.waitForTimeout(400)
  const e49b = await shape49()
  const p49b = await open(browser, DOC49)
  await p49b.waitForTimeout(400)
  await p49b.click('.amx-title-input')
  await p49b.keyboard.press('End')
  await p49b.keyboard.press('ArrowDown') // 滑入:不插行
  await p49b.waitForTimeout(400)
  const m49 = await p49b.evaluate(() => {
    const view = window.__upage.probe.view()
    return { n: view.state.doc.childCount, firstText: view.state.doc.firstChild?.textContent ?? '', pmFocus: !!document.activeElement?.closest?.('.ProseMirror') }
  })
  const p49c = await open(browser, DOC48) // 纯卡文档(首块=卡)
  await p49c.waitForTimeout(400)
  await p49c.click('.amx-title-input')
  await p49c.keyboard.press('Enter')
  await p49c.waitForTimeout(400)
  const c49 = await p49c.evaluate(() => {
    const view = window.__upage.probe.view()
    const first = view.state.doc.firstChild
    return { firstType: first?.type.name ?? null, firstEmpty: first?.type.name === 'paragraph' && first.content.size === 0, selFrom: view.state.selection.from }
  })
  record('C49 标题回车:首块有内容=顶插空白首行落光标;已是空段=不重复插;方向键滑入=不插行;首块是卡=也顶插',
    e49.n === 2 && e49.firstEmpty && e49.selFrom === 1 && e49.pmFocus
      && e49b.n === 2 && e49b.firstEmpty && e49b.selFrom === 1
      && m49.n === 1 && m49.firstText === '主正文。' && m49.pmFocus
      && c49.firstEmpty && c49.selFrom === 1,
    JSON.stringify({ enter: e49, again: e49b, move: m49, cardFirst: c49 }))
  await p49.close()
  await p49b.close()
  await p49c.close()

  // ── C49d/e 改名竞态(Codex 深夜 F2:档位必须逐次 commit 绑定,不许时间窗推断)──────────────
  // d) 回车(未改名)后紧接着点走 blur 改名:不许插首行、不许抢焦点(旧 5 秒窗会把它误判成回车改名)。
  //    (回车插的空首段在改名落盘时被序列化丢弃 —— 空段本非内容,重开 n 回到 1 是预期。)
  const p49d = await open(browser, DOC49)
  await p49d.waitForTimeout(400)
  await p49d.click('.amx-title-input')
  await p49d.keyboard.press('Enter')
  await p49d.waitForTimeout(300)
  await p49d.click('.amx-title-input')
  await p49d.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await p49d.keyboard.type('Renamed49')
  await p49d.click('.amx-toolbar', { position: { x: 400, y: 10 } }) // 点走 blur → 改名(focusKind=null)
  await p49d.waitForTimeout(900) // 改名 + 随 key 重建
  const d49 = await p49d.evaluate(() => {
    const view = window.__upage.probe.view()
    const first = view.state.doc.firstChild
    return {
      title: document.querySelector('.amx-title-input')?.value ?? '',
      n: view.state.doc.childCount,
      firstText: first?.textContent ?? '',
      pmFocus: !!document.activeElement?.closest?.('.ProseMirror'),
    }
  })
  await p49d.close()
  // e) 真按回车改名:跨重建恰好执行一次 body-enter(一行空首段,不是两行)。
  const p49e = await open(browser, DOC49)
  await p49e.waitForTimeout(400)
  await p49e.click('.amx-title-input')
  await p49e.keyboard.press('End')
  await p49e.keyboard.type('X')
  await p49e.keyboard.press('Enter')
  await p49e.waitForTimeout(900)
  const e49r = await p49e.evaluate(() => {
    const view = window.__upage.probe.view()
    const first = view.state.doc.firstChild
    return {
      title: document.querySelector('.amx-title-input')?.value ?? '',
      n: view.state.doc.childCount,
      firstEmpty: first?.type.name === 'paragraph' && first.content.size === 0,
      pmFocus: !!document.activeElement?.closest?.('.ProseMirror'),
    }
  })
  await p49e.close()
  record('C49d/e 改名竞态:点走 blur 改名不插行不抢焦点;回车改名跨重建恰插一行',
    d49.title === 'Renamed49' && d49.n === 1 && d49.firstText === '主正文。' && !d49.pmFocus
      && e49r.title.endsWith('X') && e49r.n === 2 && e49r.firstEmpty && e49r.pmFocus,
    JSON.stringify({ blurRename: d49, enterRename: e49r }))

  // ── C50 尾部恒可写(AFFiNE 语义:末行有内容,下面永远有一行可点开写)───────────────────────
  // 末块=普通段有字 → 点 page-tail 追加空段落光标;再点不重复加;末块=卡片 → 空段加进**卡尾**
  // (v4 卡区必须收尾,顶层追加会被 normalizer 吸回同一位置 —— 直插等价且少绕一圈)。
  const p50 = await open(browser, DOC49)
  await p50.waitForTimeout(400)
  const tail50 = () => p50.evaluate(() => {
    const r = document.querySelector('.page-tail').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + Math.min(40, r.height / 2) }
  })
  const t50 = await tail50()
  await p50.mouse.click(t50.x, t50.y)
  await p50.waitForTimeout(300)
  await p50.keyboard.type('尾行字')
  await p50.waitForTimeout(200)
  const a50 = await p50.evaluate(() => {
    const view = window.__upage.probe.view()
    const last = view.state.doc.lastChild
    return { n: view.state.doc.childCount, lastType: last?.type.name, lastText: last?.textContent ?? '' }
  })
  // 清空刚打的字 → 末块回到空段;再点 page-tail 不重复加
  await p50.keyboard.press('Meta+a')
  await p50.keyboard.press('Backspace')
  await p50.waitForTimeout(200)
  const t50b = await tail50()
  await p50.mouse.click(t50b.x, t50b.y)
  await p50.waitForTimeout(300)
  const b50 = await p50.evaluate(() => {
    const view = window.__upage.probe.view()
    const last = view.state.doc.lastChild
    return { n: view.state.doc.childCount, lastEmpty: last?.type.name === 'paragraph' && last.content.size === 0, pmFocus: !!document.activeElement?.closest?.('.ProseMirror') }
  })
  const p50b = await open(browser, DOC48) // 末块=卡片
  await p50b.waitForTimeout(400)
  const t50c = await p50b.evaluate(() => {
    const r = document.querySelector('.page-tail').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + Math.min(40, r.height / 2) }
  })
  await p50b.mouse.click(t50c.x, t50c.y)
  await p50b.waitForTimeout(300)
  await p50b.keyboard.type('卡尾新行')
  await p50b.waitForTimeout(600)
  const c50 = await p50b.evaluate(() => {
    const view = window.__upage.probe.view()
    const tops = []
    view.state.doc.forEach((n) => tops.push(n.type.name))
    const texts = []
    view.state.doc.forEach((n) => { if (n.type.name === 'amadeusCanvasCard' && String(n.attrs.anchor) === 'k2') n.forEach((c) => texts.push(c.textContent)) })
    return {
      tops,
      k2texts: texts,
      lastTop: view.state.doc.lastChild?.textContent ?? '',
      rawMarker: (document.querySelector('.unified-body .ProseMirror')?.textContent ?? '').includes('<!-- a '),
    }
  })
  // 闭合锚(2026-08-19):末块是卡 → 新行落在**卡后顶层**(AFFiNE 的卡外新行,用户当初要的形态;
  // 此前进卡尾是旧「卡区必须收尾」不变式所迫)。
  record('C50 尾部恒可写:末段有字=追加空段可即写;空段=不重复加;末块是卡=卡后顶层新行(不进卡不拆壳)',
    a50.n === 2 && a50.lastType === 'paragraph' && a50.lastText === '尾行字'
      && b50.n === 2 && b50.lastEmpty && b50.pmFocus
      && JSON.stringify(c50.tops) === JSON.stringify(['amadeusCanvasCard', 'amadeusCanvasCard', 'paragraph'])
      && JSON.stringify(c50.k2texts) === JSON.stringify(['卡二甲。']) && c50.lastTop === '卡尾新行' && !c50.rawMarker,
    JSON.stringify({ typed: a50, again: b50, cardTail: c50 }))
  await p50.close()
  await p50b.close()

  // ── C51 卡片完整性两道闸(Codex 深夜 F1:粘贴卡=嵌套卡/重复锚,重开整篇拒折)──────────────
  // ① 粘贴剥卡:剪贴板 HTML 里的 <div data-amx-card> 经 transformPasted 解壳成内容 —— 文本必须
  //   真落进目标卡(证明不是被完整性闸整笔拒掉的假绿),且零嵌套、锚唯一。
  // ② filterTransaction 兜底:PM 级把卡塞进另一张卡 / 顶层插重复锚,事务整笔被拒(doc 原样)。
  const p51 = await open(browser, DOC48M)
  await p51.waitForTimeout(500)
  const k2pt51 = await p51.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k2')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width - 8, y: r.top + r.height / 2 }
  })
  await p51.mouse.click(k2pt51.x, k2pt51.y) // 光标进 k2
  await p51.waitForTimeout(200)
  const pasted51 = await p51.evaluate(() => {
    const html = '<div data-amx-card="" data-anchor="k1" data-x="40" data-y="40" data-w="300"><p>贴来的行。</p></div>'
    const dt = new DataTransfer()
    dt.setData('text/html', html)
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
    document.querySelector('.unified-body .ProseMirror').dispatchEvent(ev)
    return true
  })
  await p51.waitForTimeout(500)
  const a51 = await p51.evaluate(() => {
    const view = window.__upage.probe.view()
    const anchors = []
    let nested = false
    view.state.doc.descendants((n, _p, parent) => {
      if (n.type.name !== 'amadeusCanvasCard') return true
      if (parent?.type.name !== 'doc') nested = true
      else anchors.push(String(n.attrs.anchor))
      return true
    })
    let k2text = ''
    view.state.doc.forEach((n) => { if (n.type.name === 'amadeusCanvasCard' && String(n.attrs.anchor) === 'k2') k2text = n.textContent })
    return { nested, anchors, k2text, rawMarker: (document.querySelector('.unified-body .ProseMirror')?.textContent ?? '').includes('<!-- a ') }
  })
  const b51 = await p51.evaluate(() => {
    const view = window.__upage.probe.view()
    const card = view.state.schema.nodes.amadeusCanvasCard
    let k1 = null
    let k2 = null
    view.state.doc.forEach((n, off) => {
      if (n.type !== card) return
      if (String(n.attrs.anchor) === 'k1') k1 = { node: n, off }
      if (String(n.attrs.anchor) === 'k2') k2 = { node: n, off }
    })
    const shape = () => {
      const tops = []
      view.state.doc.forEach((n) => tops.push(`${n.type.name}:${n.childCount}`))
      return tops.join('|')
    }
    const before = shape()
    view.dispatch(view.state.tr.insert(k2.off + k2.node.nodeSize - 1, k1.node)) // 嵌套 → 应拒
    const afterNest = shape()
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, k1.node)) // 顶层重复锚 → 放行+换新锚
    const anchors = []
    view.state.doc.forEach((n) => { if (n.type === card) anchors.push(String(n.attrs.anchor)) })
    return { before, nestBlocked: afterNest === before, anchors }
  })
  record('C51 完整性闸+粘贴剥卡:粘贴卡=解壳落内容;嵌套卡整笔拒;顶层重复锚=就地换新锚(复制语义)',
    pasted51 && !a51.nested && JSON.stringify(a51.anchors) === JSON.stringify(['k1', 'k2'])
      && a51.k2text.includes('贴来的行') && !a51.rawMarker
      && b51.nestBlocked && b51.anchors.length === 3 && new Set(b51.anchors).size === 3
      && b51.anchors[0] === 'k1' && b51.anchors[1] === 'k2' && b51.anchors[2] !== 'k1',
    JSON.stringify({ paste: a51, filter: b51 }))
  await p51.close()

  // C51c Alt 拖复制整卡(Codex 08-19 F5:此前完整性闸整笔拒 = 复制静默无效):
  // Esc 拿卡 NodeSelection → altKey 合成拖拽到末块之下(tail 路由,dragCopies=复制)→
  // 原卡不动 + 文末多一张内容相同、锚是新的卡;cards 三枚全在册。
  const p51c = await open(browser, DOC48M)
  await p51c.waitForTimeout(500)
  const src51c = await p51c.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + 10, y: r.top + r.height / 2 }
  })
  await p51c.mouse.click(src51c.x, src51c.y)
  await p51c.waitForTimeout(150)
  await p51c.keyboard.press('Escape')
  await p51c.waitForTimeout(250)
  await p51c.mouse.move(src51c.x, src51c.y)
  await p51c.waitForTimeout(300)
  const drove51c = await p51c.evaluate(() => {
    const gutter = document.querySelector('.unified-gutter')
    const drag = gutter?.querySelector('.drag-handle')
    if (!gutter || !drag) return 'no-handle'
    const pm = document.querySelector('.unified-body .ProseMirror')
    const last = pm.lastElementChild.getBoundingClientRect()
    const at = { clientX: last.left + last.width / 2, clientY: last.bottom + 40, altKey: true }
    const fire = (ev, target, opts) => target.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, ...opts }))
    const dt = new DataTransfer()
    fire('dragstart', gutter, { dataTransfer: dt, altKey: true })
    const el = document.elementFromPoint(at.clientX, at.clientY) ?? document.body
    fire('dragover', el, { ...at, dataTransfer: dt })
    fire('drop', el, { ...at, dataTransfer: dt })
    fire('dragend', gutter, { dataTransfer: dt })
    return 'ok'
  })
  await p51c.waitForTimeout(1200)
  const c51c = await p51c.evaluate(() => {
    window.__upage.probe.flush?.()
    const view = window.__upage.probe.view()
    const cards = []
    view.state.doc.forEach((n) => { if (n.type.name === 'amadeusCanvasCard') cards.push({ a: String(n.attrs.anchor), t: n.textContent }) })
    const st = window.__upage.probe.fmState?.() ?? {}
    let refs = null
    try { refs = JSON.parse(/^amadeus_canvas:\s*(.*)$/m.exec(st.fm)[1]).cards.map((c) => c.ref) } catch { /* null */ }
    return { cards, refs }
  })
  record('C51c Alt 拖复制整卡=真复制:原卡不动,复制卡内容相同锚是新的,cards 三枚在册',
    drove51c === 'ok' && c51c.cards.length === 3
      && c51c.cards[0].a === 'k1' && c51c.cards[0].t === '卡一甲。'
      && c51c.cards[2].t === '卡一甲。' && c51c.cards[2].a !== 'k1'
      && new Set(c51c.cards.map((x) => x.a)).size === 3
      && (c51c.refs ?? []).length === 3,
    JSON.stringify(c51c))
  await p51c.close()

  // ── C52 tab 缩进子树 = 整体单元(2026-08-19 用户实报,AFFiNE/Notion 同款)────────────────
  // 无卡种子(隔离画布语义);⚠️ 前置断言 data-indent 真的落上了 —— 种子若没走缩进解码,
  // 子树分支永不触发,后面全是平凡绿(C48a 自落教训)。
  const SUB52 = ['---', 'amadeus_schema: amadeus.page/4', '---', '', '父段。', '', '\t子段一。', '', '\t\t孙段。', '', '兄弟段。', ''].join('\n')
  const p52 = await open(browser, SUB52)
  await p52.waitForTimeout(400)
  const pre52 = await p52.evaluate(() => {
    const ps = [...document.querySelectorAll('.unified-body .ProseMirror > p')]
    const ind = (t) => ps.find((x) => (x.textContent ?? '').trim() === t)?.getAttribute('data-indent') ?? '0'
    return { child: ind('子段一。'), grand: ind('孙段。'), sib: ind('兄弟段。') }
  })
  const hover52 = await p52.evaluate(() => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror > p')].find((x) => (x.textContent ?? '').trim() === '父段。')
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p52.mouse.move(hover52.x, hover52.y)
  await p52.waitForTimeout(300)
  const sel52 = await p52.evaluate(() => {
    const drag = document.querySelector('.unified-gutter .drag-handle')
    if (!drag) return null
    drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const selected = [...document.querySelectorAll('.unified-body .ProseMirror > .amx-block-selected')].map((x) => (x.textContent ?? '').trim())
    return selected
  })
  // 抓中层(子段一):只带孙段。⚠️ 先点击收敛掉上一步的跨块选区 —— 「已有跨块选区且本块在其中
  // = 保留整批」是把手的既有设计(AFFiNE 同款),不收敛的话这里测到的还是上一批。
  await p52.mouse.click(hover52.x, hover52.y)
  await p52.waitForTimeout(150)
  const hoverMid = await p52.evaluate(() => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror > p')].find((x) => (x.textContent ?? '').trim() === '子段一。')
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p52.mouse.move(hoverMid.x, hoverMid.y)
  await p52.waitForTimeout(300)
  const selMid52 = await p52.evaluate(() => {
    const drag = document.querySelector('.unified-gutter .drag-handle')
    drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return [...document.querySelectorAll('.unified-body .ProseMirror > .amx-block-selected')].map((x) => (x.textContent ?? '').trim())
  })
  // 整树拖到兄弟段之下 → 次序 兄弟|父|子|孙,缩进逐档保留;Cmd+Z 一击还原
  const drove52 = await dragBlockOnto(p52, '父段。', '兄弟段。', 0.9)
  await p52.waitForTimeout(800)
  const shape52 = () => p52.evaluate(() => {
    const view = window.__upage.probe.view()
    const out = []
    view.state.doc.forEach((n) => out.push(`${(n.textContent ?? '').trim()}@${Number(n.attrs?.indent ?? 0)}`))
    return out
  })
  const a52 = await shape52()
  const mp52 = await p52.evaluate(() => {
    const r = [...document.querySelectorAll('.unified-body .ProseMirror > p')][0].getBoundingClientRect()
    return { x: r.left + 10, y: r.top + r.height / 2 }
  })
  await p52.mouse.click(mp52.x, mp52.y)
  await p52.waitForTimeout(150)
  await p52.keyboard.press(Z)
  await p52.waitForTimeout(400)
  const u52 = await shape52()
  // Delete = 删整树(把手按下已成跨块选区;有意为之,与「整体操作」一致)
  await p52.mouse.move(hover52.x, hover52.y)
  await p52.waitForTimeout(300)
  await p52.evaluate(() => {
    document.querySelector('.unified-gutter .drag-handle').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  await p52.keyboard.press('Delete')
  await p52.waitForTimeout(300)
  const d52 = await shape52()
  record('C52 缩进子树整体单元:抓父段=选父+子+孙(不含兄弟);抓中层只带孙;整树拖动次序缩进保留,Cmd+Z 一击还原;Delete 删整树',
    pre52.child === '1' && pre52.grand === '2' && pre52.sib === '0'
      && JSON.stringify(sel52) === JSON.stringify(['父段。', '子段一。', '孙段。'])
      && JSON.stringify(selMid52) === JSON.stringify(['子段一。', '孙段。'])
      && drove52 === 'ok'
      && JSON.stringify(a52) === JSON.stringify(['兄弟段。@0', '父段。@0', '子段一。@1', '孙段。@2'])
      && JSON.stringify(u52) === JSON.stringify(['父段。@0', '子段一。@1', '孙段。@2', '兄弟段。@0'])
      && JSON.stringify(d52) === JSON.stringify(['兄弟段。@0']),
    JSON.stringify({ pre: pre52, sel: sel52, mid: selMid52, drove: drove52, after: a52, undo: u52, del: d52 }))
  await p52.close()

  // C52b 卡内部分跨段选删 ≠ 删整卡(Codex 08-19 high:blockRangeDelete 曾把它升级成整卡蒸发):
  // 原生扫选 卡一甲 中段 → 卡一乙 中段,Delete 只删文字,卡与锚原地活着。
  const p52b = await open(browser, DOC48)
  await p52b.waitForTimeout(400)
  const swept52 = await p52b.evaluate(() => {
    const card = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1')
    const ps = card?.querySelectorAll('p')
    if (!ps || ps.length < 2 || !ps[0].firstChild || !ps[1].firstChild) return false
    const s = window.getSelection()
    s.setBaseAndExtent(ps[0].firstChild, 2, ps[1].firstChild, 2)
    return true
  })
  await p52b.waitForTimeout(250)
  await p52b.keyboard.press('Delete')
  await p52b.waitForTimeout(300)
  const d52b = await p52b.evaluate(() => {
    const view = window.__upage.probe.view()
    const cards = []
    view.state.doc.forEach((n) => { if (n.type.name === 'amadeusCanvasCard') cards.push({ a: String(n.attrs.anchor), t: n.textContent }) })
    return { cards }
  })
  record('C52b 卡内部分跨段选删=只删文字(卡与锚原地活着,不再整卡蒸发)',
    swept52 && d52b.cards.length === 2 && d52b.cards[0].a === 'k1' && d52b.cards[0].t === '卡一乙。'
      && d52b.cards[1].a === 'k2' && d52b.cards[1].t === '卡二甲。',
    JSON.stringify(d52b))
  await p52b.close()

  // ── C53 编辑态光标(2026-08-19 用户实报:双击进编辑后鼠标还是抓手)──────────────────────
  // 钉泄漏:编辑 k1 时 k2 与主卡必须仍是 grab(单元素规则,不许通配)。
  const p53 = await open(browser, TWO)
  await p53.waitForTimeout(500)
  const cur53 = () => p53.evaluate(() => {
    const c = (a) => getComputedStyle([...document.querySelectorAll('.amx-ucard')].find((x) => x.dataset.anchor === a)).cursor
    return { k1: c('k1'), k2: c('k2'), main: getComputedStyle(document.querySelector('.unified-body .ProseMirror')).cursor }
  })
  const base53 = await cur53()
  const at53 = await p53.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((x) => x.dataset.anchor === 'k1')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p53.mouse.dblclick(at53.x, at53.y)
  await p53.waitForTimeout(400)
  const edit53 = await cur53()
  await p53.keyboard.press('Escape')
  await p53.waitForTimeout(300)
  const esc53 = await cur53()
  // 主卡:两段式二击进编辑 → .ProseMirror 转 text,卡片不受牵连
  const m53 = await p53.evaluate(() => {
    const pm = document.querySelector('.unified-body .ProseMirror')
    const ps = [...pm.querySelectorAll(':scope > p')]
    const r = ps.find((x) => (x.textContent ?? '').includes('主卡正文')).getBoundingClientRect()
    return { x: r.left + 40, y: r.top + r.height / 2 }
  })
  await p53.keyboard.press('Escape')
  await p53.mouse.click(m53.x, m53.y)
  await p53.waitForTimeout(200)
  await p53.mouse.click(m53.x, m53.y)
  await p53.waitForTimeout(300)
  const mainEdit53 = await cur53()
  record('C53 编辑态光标:进卡编辑=该卡 text、他卡与主卡仍 grab;Esc 退回 grab;主卡编辑=主卡 text 卡不受牵连',
    base53.k1 === 'grab' && base53.k2 === 'grab' && base53.main === 'grab'
      && edit53.k1 === 'text' && edit53.k2 === 'grab' && edit53.main === 'grab'
      && esc53.k1 === 'grab'
      && mainEdit53.main === 'text' && mainEdit53.k1 === 'grab' && mainEdit53.k2 === 'grab',
    JSON.stringify({ base: base53, edit: edit53, esc: esc53, mainEdit: mainEdit53 }))
  await p53.close()

  // ── C54 卡缝插入口(2026-08-19 用户拍板「悬停卡缝出 + 行」)────────────────────────────
  const p54 = await open(browser, DOC48)
  await p54.waitForTimeout(500)
  const gap54 = await p54.evaluate(() => {
    const k1 = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1').getBoundingClientRect()
    const k2 = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k2').getBoundingClientRect()
    return { x: k1.left + k1.width / 2, y: (k1.bottom + k2.top) / 2, inCard: { x: k1.left + k1.width / 2, y: k1.top + 10 } }
  })
  await p54.mouse.move(gap54.inCard.x, gap54.inCard.y)
  await p54.waitForTimeout(200)
  const inCard54 = await p54.evaluate(() => {
    const el = document.querySelector('.amx-gap-insert')
    return !el || getComputedStyle(el).display === 'none'
  })
  await p54.mouse.move(gap54.x, gap54.y, { steps: 2 })
  await p54.waitForTimeout(250)
  const vis54 = await p54.evaluate(() => {
    const el = document.querySelector('.amx-gap-insert')
    if (!el || getComputedStyle(el).display === 'none') return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (vis54) {
    await p54.mouse.click(vis54.x, vis54.y)
    await p54.waitForTimeout(300)
    await p54.keyboard.type('缝里的字')
    await p54.waitForTimeout(300)
  }
  const a54 = await p54.evaluate(() => {
    const view = window.__upage.probe.view()
    const tops = []
    view.state.doc.forEach((n) => tops.push(`${n.type.name}:${(n.textContent ?? '').trim().slice(0, 6)}`))
    return { tops, pmFocus: !!document.activeElement?.closest?.('.ProseMirror') }
  })
  // 画布模式不出插入口
  await p54.evaluate(() => {
    ;[...document.querySelectorAll('.amx-modeseg button')].find((b) => (b.textContent ?? '').includes('画布'))?.click()
  })
  await p54.waitForTimeout(700)
  const cvGap54 = await p54.evaluate(() => {
    const cards = [...document.querySelectorAll('.amx-ucard')]
    const k1 = cards.find((c) => c.dataset.anchor === 'k1').getBoundingClientRect()
    return { x: k1.left + k1.width / 2, y: k1.bottom + 4 }
  })
  await p54.mouse.move(cvGap54.x, cvGap54.y, { steps: 2 })
  await p54.waitForTimeout(250)
  const cv54 = await p54.evaluate(() => {
    const el = document.querySelector('.amx-gap-insert')
    return !el || getComputedStyle(el).display === 'none'
  })
  record('C54 卡缝插入口:卡体上不出;悬停卡缝浮现,点击=缝间插空段落光标可即写;画布模式不出',
    inCard54 && !!vis54
      && JSON.stringify(a54.tops) === JSON.stringify(['amadeusCanvasCard:卡一甲。卡一', 'paragraph:缝里的字', 'amadeusCanvasCard:卡二甲。'])
      && a54.pmFocus && cv54,
    JSON.stringify({ inCard: inCard54, vis: !!vis54, after: a54, canvasHidden: cv54 }))
  await p54.close()

  // C54b 悬停后文档变更 → 插入线自动藏(Codex 08-19:裸数字位置跨事务=点旧位插错层级;
  // 现记锚 + update 钩子藏线,点击时按锚现场重解析)。
  const p54b = await open(browser, DOC48)
  await p54b.waitForTimeout(400)
  const gap54b = await p54b.evaluate(() => {
    const k1 = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k1').getBoundingClientRect()
    const k2 = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k2').getBoundingClientRect()
    return { x: k1.left + k1.width / 2, y: (k1.bottom + k2.top) / 2 }
  })
  await p54b.mouse.move(gap54b.x, gap54b.y, { steps: 2 })
  await p54b.waitForTimeout(250)
  const vis54b = await p54b.evaluate(() => {
    const el = document.querySelector('.amx-gap-insert')
    return !!el && getComputedStyle(el).display !== 'none'
  })
  await p54b.evaluate(() => {
    // 不动鼠标,程序化改文档(等价于键盘输入落笔)
    const view = window.__upage.probe.view()
    view.dispatch(view.state.tr.insertText('x', 2, 2))
  })
  await p54b.waitForTimeout(200)
  const hid54b = await p54b.evaluate(() => {
    const el = document.querySelector('.amx-gap-insert')
    return !el || getComputedStyle(el).display === 'none'
  })
  record('C54b 悬停后文档变更=插入线自动藏(不留旧位可点)', vis54b && hid54b, JSON.stringify({ vis: vis54b, hidden: hid54b }))
  await p54b.close()

  // ── C56 收回文档=就地拆(Codex 08-19 high:旧「搬到卡区前」在交错文档里=无提示重排正文)──
  // 交错种子 A|k1|B|k2|C,菜单收回 k2 → 内容原位展开:A|k1|B|k2内容|C(锚转字面留在原位)。
  const INTER56 = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":300},{"ref":"k2","x":420,"y":40,"w":300}]}',
    '---', '', 'A段。', '', '<!-- a k1 -->', '卡一甲。', '', '<!-- /a k1 -->', 'B段。', '', '<!-- a k2 -->', '卡二甲。', '', '<!-- /a k2 -->', 'C段。', '',
  ].join('\n')
  const p56 = await open(browser, INTER56)
  await p56.waitForTimeout(500)
  const k256 = await p56.evaluate(() => {
    const el = [...document.querySelectorAll('.amx-ucard')].find((c) => c.dataset.anchor === 'k2')
    const r = el.querySelector('p').getBoundingClientRect()
    return { x: r.left + 10, y: r.top + r.height / 2 }
  })
  await p56.mouse.click(k256.x, k256.y)
  await p56.waitForTimeout(150)
  await p56.keyboard.press('Escape') // NodeSelection 整卡
  await p56.waitForTimeout(250)
  await p56.mouse.move(k256.x, k256.y)
  await p56.waitForTimeout(300)
  const menu56 = await p56.evaluate(() => {
    const drag = document.querySelector('.unified-gutter .drag-handle')
    if (!drag) return 'no-handle'
    drag.dispatchEvent(new MouseEvent('click', { bubbles: true })) // 点击把手=开块菜单
    return 'clicked'
  })
  await p56.waitForTimeout(300)
  const dissolved56 = await p56.evaluate(() => {
    const btn = [...document.querySelectorAll('.ctx-menu.unified-block-menu button')].find((b) => (b.textContent ?? '').includes('收回文档'))
    if (!btn) return 'no-button'
    btn.click()
    return 'ok'
  })
  await p56.waitForTimeout(800)
  const a56 = await p56.evaluate(() => {
    window.__upage.probe.flush?.()
    const view = window.__upage.probe.view()
    // 惰性锚是「段落包 inline html」,PM 的 textContent 恒空 —— 字面形态从序列化 body 里断言。
    const tops = []
    view.state.doc.forEach((n) => tops.push(`${n.type.name === 'amadeusCanvasCard' ? 'card:' + n.attrs.anchor : (n.textContent ?? '').trim().slice(0, 8)}`))
    const st = window.__upage.probe.fmState?.() ?? {}
    let refs = null
    try { refs = JSON.parse(/^amadeus_canvas:\s*(.*)$/m.exec(st.fm)[1]).cards.map((c) => c.ref) } catch { /* null */ }
    return { tops, refs, body: st.body ?? '' }
  })
  const order56 = ['B段。', '<!-- a k2 -->', '卡二甲。', 'C段。'].map((s) => a56.body.indexOf(s))
  record('C56 收回文档=就地拆:交错文档 A|k1|B|k2|C 收回 k2 → 内容原位(不再被搬到卡区前重排)',
    menu56 === 'clicked' && dissolved56 === 'ok'
      && JSON.stringify(a56.tops) === JSON.stringify(['A段。', 'card:k1', 'B段。', '', '卡二甲。', 'C段。'])
      && order56.every((i, k) => i >= 0 && (k === 0 || i > order56[k - 1]))
      && JSON.stringify(a56.refs) === JSON.stringify(['k1']),
    JSON.stringify({ ...a56, body: undefined, order: order56 }))
  await p56.close()

  // ── C55 闭合锚迁移:旧格式照读;编辑保存即迁移;闭合形/混合形重开照折,闭合符零显形 ─────────
  const LEGACY55 = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":300},{"ref":"k2","x":420,"y":40,"w":300}]}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一甲。', '', '<!-- a k2 -->', '卡二甲。', '',
  ].join('\n')
  const MIXED55 = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":40,"y":40,"w":300},{"ref":"k2","x":420,"y":40,"w":300}]}',
    '---', '', '<!-- a k1 -->', '卡一甲。', '', '<!-- /a k1 -->', '', '缝间正文。', '', '<!-- a k2 -->', '卡二甲。', '',
  ].join('\n')
  const p55 = await open(browser, LEGACY55)
  await p55.waitForTimeout(500)
  const l55 = await p55.evaluate(() => ({
    cards: document.querySelectorAll('.amx-ucard').length,
    raw: (document.querySelector('.unified-body .ProseMirror')?.textContent ?? '').includes('<!-- '),
  }))
  const at55 = await p55.evaluate(() => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => (x.textContent ?? '').trim() === '主卡正文。')
    const r = el.getBoundingClientRect()
    return { x: r.left + 40, y: r.top + r.height / 2 }
  })
  await p55.mouse.click(at55.x, at55.y)
  await p55.keyboard.press('End')
  await p55.keyboard.type('改')
  await p55.waitForTimeout(300)
  const m55 = await p55.evaluate(() => { window.__upage.probe.flush?.(); return window.__upage.probe.fmState?.().body ?? '' })
  await p55.close()
  const p55b = await open(browser, MIXED55)
  await p55b.waitForTimeout(500)
  const x55 = await p55b.evaluate(() => {
    const view = window.__upage.probe.view()
    const tops = []
    view.state.doc.forEach((n) => tops.push(`${n.type.name}:${(n.textContent ?? '').trim().slice(0, 5)}`))
    return { tops, raw: (document.querySelector('.unified-body .ProseMirror')?.textContent ?? '').includes('<!-- ') }
  })
  const iCloseK1 = m55.indexOf('<!-- /a k1 -->')
  const iOpenK2 = m55.indexOf('<!-- a k2 -->')
  record('C55 闭合锚迁移:旧格式照折;编辑一击保存=补齐闭合符(k1 闭合在 k2 开锚之前);混合形照折且闭合符零显形',
    l55.cards === 2 && !l55.raw
      && iCloseK1 >= 0 && iOpenK2 > iCloseK1 && m55.includes('<!-- /a k2 -->')
      && JSON.stringify(x55.tops) === JSON.stringify(['amadeusCanvasCard:卡一甲。', 'paragraph:缝间正文。', 'amadeusCanvasCard:卡二甲。'])
      && !x55.raw,
    JSON.stringify({ legacy: l55, closeK1AtBeforeOpenK2: iOpenK2 > iCloseK1, mixed: x55 }))
  await p55b.close()

  // ── C57 主卡也能长子节点(2026-08-19 用户实报「正文卡片不支持 Tab/回车」)────────────────
  // 钉两处:① 键盘走得通;② 层级里的哨兵 `m:` **过得了派生剪枝**(alive 集合漏掉它的话,
  // 线一闪就没 —— 实测拿到过 tree:0)。落盘 → 重开仍在,才算真的支持。
  const CV57 = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":700,"y":40,"w":300}]}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一甲。', '<!-- /a k1 -->', '',
  ].join('\n')
  const p57 = await open(browser, CV57)
  await p57.waitForTimeout(400)
  const mainAt = await p57.evaluate(() => {
    const pm = document.querySelector('.unified-body .ProseMirror')
    const r = [...pm.querySelectorAll(':scope > p')].find((x) => (x.textContent ?? '').includes('主卡正文')).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p57.mouse.click(mainAt.x, mainAt.y) // 一击选中(两段式第一段)
  await p57.waitForTimeout(150)
  await p57.keyboard.press('Tab')
  await p57.waitForTimeout(400)
  const s57 = await p57.evaluate(() => ({
    cards: document.querySelectorAll('.amx-ucard').length,
    tree: document.querySelectorAll('.amx-el-conn.is-tree').length,
  }))
  const fm57 = await fmOf(p57)
  const line57 = canvasLine(fm57)
  // 跨域一击退:建卡(PM)+记层级(fm)合成 'pair',一次 Cmd+Z 两域各退一步(C36b 的主卡版)
  await p57.keyboard.press('Meta+z')
  await p57.waitForTimeout(400)
  const undo57 = await p57.evaluate(() => ({
    cards: document.querySelectorAll('.amx-ucard').length,
    tree: document.querySelectorAll('.amx-el-conn.is-tree').length,
  }))
  await p57.close()
  // 落盘那行原样重开:哨兵活过一次完整的 派生→解析→渲染 往返
  const RE57 = ['---', 'amadeus_schema: amadeus.page/4', `amadeus_canvas: ${line57}`, '---', '', '主卡正文。', ''].join('\n')
  const p57b = await open(browser, RE57)
  await p57b.waitForTimeout(400)
  const keep57 = canvasLine(await fmOf(p57b))
  await p57b.close()
  record('C57 主卡 Tab=长子节点:新卡 + 层级线;哨兵 m: 进落盘且过得了剪枝(重开仍在);Cmd+Z 一击卡与层级同退',
    s57.cards === 2 && s57.tree === 1 && /"m:"/.test(line57 ?? '') && /"m:"/.test(keep57 ?? '')
      && undo57.cards === 1 && undo57.tree === 0,
    JSON.stringify({ s57, line: line57, reopened: keep57, undo: undo57 }))

  // ── C58 卡侧 ⊕(AFFiNE autocomplete 同款)─────────────────────────────────────────────
  // ⚠️ 钉「点得中」:按钮住在 pointer-events:none 的元素层里,少一条 auto 就是画上去的贴纸;
  //    且舞台的 pointerdown 会在冒泡路上把它当点空白 → 清选中 → 按钮当场卸载,click 永远等不到。
  const p58 = await open(browser, CV57)
  await p58.waitForTimeout(400)
  const k1At = await p58.evaluate(() => {
    const r = document.querySelector('.amx-ucard[data-anchor="k1"]').getBoundingClientRect()
    return { x: r.left + 6, y: r.top + 6 }
  })
  await p58.mouse.click(k1At.x, k1At.y)
  await p58.waitForTimeout(250)
  const btn58 = await p58.evaluate(() => {
    const b = document.querySelector('.amx-el-add.is-child')
    if (!b) return null
    const r = b.getBoundingClientRect()
    const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    const hit = document.elementFromPoint(at.x, at.y)
    return { at, kinds: [...document.querySelectorAll('.amx-el-add')].map((x) => x.dataset.add), hit: hit?.dataset?.add ?? hit?.className ?? null }
  })
  let after58 = null
  if (btn58) {
    await p58.mouse.click(btn58.at.x, btn58.at.y)
    await p58.waitForTimeout(400)
    after58 = await p58.evaluate(() => ({
      cards: document.querySelectorAll('.amx-ucard').length,
      tree: document.querySelectorAll('.amx-el-conn.is-tree').length,
    }))
  }
  // 编辑态不出(⊕ 压在正文上会挡打字视线;与选中框的 is-editing 同一条口径)
  await p58.mouse.dblclick(k1At.x + 60, k1At.y + 20)
  await p58.waitForTimeout(300)
  const editHide58 = await p58.evaluate(() => document.querySelectorAll('.amx-el-add').length)
  // 换非选择工具 → ⊕ 与把手一律收起(Codex 08-19:选中态不随换工具清空,而建形状分支在 onDown 里
  // 早于 data-add return —— 留着就是「看得见、点下去建了个矩形」)。
  await p58.keyboard.press('Escape')
  await p58.mouse.click(k1At.x, k1At.y)
  await p58.waitForTimeout(200)
  const selVis58 = await p58.evaluate(() => document.querySelectorAll('.amx-el-add').length)
  await pickTool(p58, '矩形')
  await p58.waitForTimeout(200)
  const toolHide58 = await p58.evaluate(() => [...document.querySelectorAll('.amx-el-add')].filter((b) => getComputedStyle(b).display !== 'none').length)
  await p58.close()
  record('C58 卡侧 ⊕:单选出两枚(右=子/下=兄弟)、真能点中(元素层 pointer-events)、点击建卡连层级线;编辑态收起;换非选择工具也收起',
    !!btn58 && btn58.hit === 'child' && JSON.stringify(btn58.kinds) === JSON.stringify(['child', 'sibling'])
      && after58?.cards === 2 && after58?.tree === 1 && editHide58 === 0
      && selVis58 === 2 && toolHide58 === 0,
    JSON.stringify({ btn: btn58, after: after58, editHide: editHide58, selVis: selVis58, toolHide: toolHide58 }))

  // ── C59 形状四角塑型(2026-08-19 用户实报「都应该能够塑型」)──────────────────────────
  // 修前:把手塞在形状内部,被 `overflow: hidden` 裁掉 —— 画得出、点不中,形状根本调不了尺寸
  // (实测 elementFromPoint 落到舞台上)。这条必须走**真实 CDP 鼠标**:合成事件绕过命中测试,
  // 对这个 bug 一律照绿。
  const CV59 = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[],"elements":[{"id":"s1","type":"shape","shape":"rect","x":700,"y":300,"w":160,"h":90}]}',
    '---', '', '主卡正文。', '',
  ].join('\n')
  const p59 = await open(browser, CV59)
  await p59.waitForTimeout(400)
  const box59 = () => p59.evaluate(() => {
    const r = document.querySelector('[data-el="s1"]').getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  })
  const shapeAt = await p59.evaluate(() => {
    const r = document.querySelector('[data-el="s1"]').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p59.mouse.click(shapeAt.x, shapeAt.y)
  await p59.waitForTimeout(250)
  const g59 = await p59.evaluate(() => {
    const corners = [...document.querySelectorAll('[data-grip][data-corner]')].map((x) => x.dataset.corner)
    const nw = document.querySelector('[data-corner="nw"]')?.getBoundingClientRect()
    const at = nw ? { x: nw.left + nw.width / 2, y: nw.top + nw.height / 2 } : null
    return { corners, at, hit: at ? (document.elementFromPoint(at.x, at.y)?.dataset?.corner ?? null) : null }
  })
  const b0 = await box59()
  if (g59.at) {
    await p59.mouse.move(g59.at.x, g59.at.y)
    await p59.mouse.down()
    await p59.mouse.move(g59.at.x - 40, g59.at.y - 30, { steps: 6 })
    await p59.mouse.up()
    await p59.waitForTimeout(300)
  }
  const b1 = await box59()
  // 再把 NW 一路拖过对角:MIN_EL 夹住之后**对角必须还钉在原处**(拿增量硬夹会整体跟着指针走)
  if (g59.at) {
    await p59.mouse.move(b1.x - 5, b1.y - 5)
    await p59.mouse.down()
    await p59.mouse.move(b1.x + 400, b1.y + 400, { steps: 8 })
    await p59.mouse.up()
    await p59.waitForTimeout(300)
  }
  const b2 = await box59()
  const el59 = canvasLine(await fmOf(p59))
  // 换非选择工具 → 把手收起(理由同 C58 那条:留着就是「点把手却建了个矩形」)
  await pickTool(p59, '椭圆')
  await p59.waitForTimeout(200)
  const gripHide59 = await p59.evaluate(() => [...document.querySelectorAll('[data-grip]')].filter((g) => getComputedStyle(g).display !== 'none').length)
  await p59.close()
  record('C59 四角塑型:四枚把手可命中(真鼠标);拖 NW=对角固定、左上跟手且落盘;越过最小尺寸不走位;换非选择工具收起',
    JSON.stringify(g59.corners) === JSON.stringify(['nw', 'ne', 'sw', 'se']) && g59.hit === 'nw'
      && b1.w === b0.w + 40 && b1.h === b0.h + 30 && b1.x === b0.x - 40 && b1.y === b0.y - 30
      && b2.x + b2.w === b1.x + b1.w && b2.y + b2.h === b1.y + b1.h && b2.w === 24 && b2.h === 24
      && /"w":24,"h":24/.test(el59 ?? '') && gripHide59 === 0,
    JSON.stringify({ g: g59, b0, b1, b2, line: el59, gripHide: gripHide59 }))

  // ── C60 Frame 进工具栏 + 拖出尺寸(2026-08-19 用户实报「Frame 为什么没在工具栏」)─────────
  const p60 = await open(browser, CV59)
  await p60.waitForTimeout(400)
  const tools60 = await p60.evaluate(() => [...document.querySelectorAll('.amx-stage-tools button')].map((b) => b.title))
  const fi60 = tools60.findIndex((t) => t.startsWith('Frame'))
  if (fi60 >= 0) {
    await pickTool(p60, 'Frame')
    await p60.mouse.move(300, 620)
    await p60.mouse.down()
    await p60.mouse.move(560, 780, { steps: 6 })
    await p60.mouse.up()
    await p60.waitForTimeout(400)
  }
  const fr60 = await p60.evaluate(() => [...document.querySelectorAll('.amx-el-frame')].map((f) => {
    const r = f.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }))
  // 一次性工具:建完自动回选择工具(不然下一次点击又画一个)
  const back60 = await p60.evaluate(() => document.querySelectorAll('.amx-stage-tools button')[0].classList.contains('on'))
  // 矩形工具点一下(没拖)=默认尺寸,与修前的一击建完全一致
  await pickTool(p60, '矩形')
  await p60.mouse.click(1150, 700)
  await p60.waitForTimeout(400)
  const rects60 = await p60.evaluate(() => [...document.querySelectorAll('.amx-el-rect')].map((f) => {
    const r = f.getBoundingClientRect()
    return `${Math.round(r.width)}x${Math.round(r.height)}`
  }))
  await p60.close()
  record('C60 Frame 工具在工具栏且拖出尺寸(260x160);建完回选择工具;矩形点击建仍是默认 200x120',
    fi60 >= 0 && fr60.length === 1 && fr60[0].w === 260 && fr60[0].h === 160 && back60 && rects60.includes('200x120'),
    JSON.stringify({ tools: tools60, frames: fr60, backToSelect: back60, rects: rects60 }))

  // ── C61-C63 思维导图三件(2026-08-19 晚用户拍板)────────────────────────────────────────
  const MIND = [
    '---', 'amadeus_schema: amadeus.page/4',
    'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":420},"cards":[{"ref":"k1","x":520,"y":80,"w":300},{"ref":"k2","x":560,"y":460,"w":300}],"elements":[{"id":"s1","type":"shape","shape":"rect","x":1040,"y":470,"w":160,"h":90}]}',
    '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一甲。', '<!-- /a k1 -->', '', '<!-- a k2 -->', '卡二甲。', '<!-- /a k2 -->', '',
  ].join('\n')
  const cardBox = (p, a) => p.evaluate((anchor) => {
    const r = document.querySelector(`.amx-ucard[data-anchor="${anchor}"]`).getBoundingClientRect()
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }
  }, a)
  const canvasState = (p) => p.evaluate(() => ({
    tree: (window.__upage.probe.fmState?.().fm ?? '').match(/"tree":\{[^}]*\}/)?.[0] ?? null,
    conns: ((window.__upage.probe.fmState?.().fm ?? '').match(/"type":"connector"/g) ?? []).length,
    lines: document.querySelectorAll('.amx-el-conn.is-tree').length,
    cards: [...document.querySelectorAll('.amx-ucard')].map((c) => `${c.dataset.anchor}@${c.dataset.x},${c.dataset.y}`),
  }))
  /** 抓卡片 chrome 圈拖动,**指针**停在 (px,py)(认亲判据看的是指针,不是卡盒);
   *  返回手势期的认亲高亮(松手前采样)。 */
  const dragCardTo = async (p, anchor, px, py) => {
    const b = await cardBox(p, anchor)
    const gx = b.l + 6
    const gy = b.t + 6
    await p.mouse.move(gx, gy)
    await p.mouse.down()
    await p.mouse.move(px, py, { steps: 10 })
    await p.waitForTimeout(120)
    const hl = await p.evaluate(() => {
      const el = document.querySelector('.amx-el-attach')
      return el ? { side: el.dataset.attach, rel: el.classList.contains('is-child') ? 'child' : 'sibling' } : null
    })
    await p.mouse.up()
    await p.waitForTimeout(400)
    return hl
  }

  // C61 拖到边缘认亲(右缘=子 + 吸附队列 + 一击撤销;下缘=兄弟;环形目标不给认)
  const p61 = await open(browser, MIND)
  await p61.waitForTimeout(300)
  const a61 = await cardBox(p61, 'k1')
  const hl61 = await dragCardTo(p61, 'k2', a61.r - 12, a61.t + a61.h / 2) // 指针推到 k1 右缘
  const s61 = await canvasState(p61)
  await p61.keyboard.press('Meta+z')
  await p61.waitForTimeout(400)
  const undo61 = await canvasState(p61)
  // 环:k2 现在是 k1 的子(先重做回去),把**父** k1 拖到子 k2 的边缘 → 不给高亮、不建关系
  await p61.keyboard.press('Meta+Shift+z')
  await p61.waitForTimeout(400)
  const b61 = await cardBox(p61, 'k2')
  const cyc61 = await dragCardTo(p61, 'k1', b61.r - 12, b61.t + b61.h / 2)
  const after61 = await canvasState(p61)
  await p61.close()
  record('C61 拖到卡右缘=认爹 + 吸附进子队列(x=父右缘+80) + 手势期高亮;Cmd+Z 一击连位置带层级全退;环形目标不给认',
    hl61?.side === 'e' && hl61?.rel === 'child'
      && s61.tree === '"tree":{"k2":"k1"}' && s61.cards.includes('k2@900,80') && s61.lines === 1
      && undo61.tree === null && undo61.cards.includes('k2@560,460')
      && cyc61 === null && after61.tree === '"tree":{"k2":"k1"}',
    JSON.stringify({ hl: hl61, drop: s61, undo: undo61, cycleHl: cyc61, after: after61 }))

  // C61b 下缘=兄弟;目标是顶层节点 → 自己也回顶层(**摘掉旧爹** = 唯一的拖拽式解除关系)
  const p61b = await open(browser, MIND)
  await p61b.waitForTimeout(300)
  const a61b = await cardBox(p61b, 'k1')
  await dragCardTo(p61b, 'k2', a61b.r - 12, a61b.t + a61b.h / 2) // 先认爹
  const mid61b = await canvasState(p61b)
  const a61c = await cardBox(p61b, 'k1')
  const hl61b = await dragCardTo(p61b, 'k2', a61c.l + a61c.w / 2, a61c.b - 8) // 指针推到 k1 下缘 = 与 k1 同级(顶层)
  const s61b = await canvasState(p61b)
  await p61b.close()
  record('C61b 拖到下缘=兄弟;目标是顶层 → 摘掉旧爹回顶层(拖拽式解除关系),卡片本身一张不少',
    mid61b.tree === '"tree":{"k2":"k1"}' && hl61b?.side === 's' && hl61b?.rel === 'sibling'
      && s61b.tree === null && s61b.lines === 0 && s61b.cards.length === 2,
    JSON.stringify({ mid: mid61b, hl: hl61b, after: s61b }))

  // C61c 中立区(Codex 08-19 深夜 medium):一行字的卡也必须留得出「只是挪位置」的落点 ——
  // 边缘带按盒尺寸取比例(每边最多 30%),不是写死 28px(那会把 58px 高的卡整片吃光)。
  const p61c = await open(browser, MIND)
  await p61c.waitForTimeout(300)
  const t61c = await cardBox(p61c, 'k1')
  const hl61c = await dragCardTo(p61c, 'k2', t61c.l + t61c.w / 2, t61c.t + t61c.h / 2) // 正中央
  const s61c = await canvasState(p61c)
  await p61c.close()
  record('C61c 卡心中立区:指针停在目标卡正中央松手 = 只是挪位置(不认亲、不吸附、tree 不动)',
    hl61c === null && s61c.tree === null && s61c.lines === 0,
    JSON.stringify({ hl: hl61c, after: s61c, box: t61c }))

  // C62 层级线可选中 + Delete=解除关系(用户 2026-08-19 拍板,推翻 08-18「层级线故意不可选中」)
  const p62 = await open(browser, MIND)
  await p62.waitForTimeout(300)
  const a62 = await cardBox(p62, 'k1')
  await dragCardTo(p62, 'k2', a62.r - 12, a62.t + a62.h / 2)
  const mid62 = await p62.evaluate(() => {
    const svg = document.querySelector('.amx-el-conn.is-tree')
    const r = svg.getBoundingClientRect()
    const d = svg.querySelector('path')
    const pt = d.getPointAtLength(d.getTotalLength() / 2)
    const vb = svg.viewBox.baseVal // viewBox 吃舞台坐标,换算回视口
    return { x: r.left + (pt.x - vb.x) * (r.width / vb.width), y: r.top + (pt.y - vb.y) * (r.height / vb.height) }
  })
  await p62.mouse.click(mid62.x, mid62.y)
  await p62.waitForTimeout(250)
  const sel62 = await p62.evaluate(() => document.querySelector('.amx-el-conn.is-tree')?.classList.contains('is-sel') ?? false)
  // ⚠️ Cmd+A 不许把层级线收进选中集合:全选后一个删除键就该只删卡片/元素,不该顺手清空层级
  await p62.keyboard.press('Meta+a')
  await p62.waitForTimeout(200)
  const allSel62 = await p62.evaluate(() => document.querySelector('.amx-el-conn.is-tree')?.classList.contains('is-sel') ?? false)
  await p62.mouse.click(mid62.x, mid62.y)
  await p62.waitForTimeout(200)
  await p62.keyboard.press('Delete')
  await p62.waitForTimeout(400)
  const s62 = await canvasState(p62)
  await p62.close()
  record('C62 层级线可选中(is-sel)+ Delete=只解除关系(卡片一张不动);Cmd+A 不把线收进选中集合',
    sel62 && !allSel62 && s62.tree === null && s62.lines === 0 && s62.cards.length === 2,
    JSON.stringify({ sel: sel62, inSelectAll: allSel62, after: s62 }))

  // C63 箭头工具升级:卡→卡 = 建父子(不新增连线条目、位置不动);卡→形状 = 仍画自由连线
  const p63 = await open(browser, MIND)
  await p63.waitForTimeout(300)
  const a63 = await cardBox(p63, 'k1')
  const b63 = await cardBox(p63, 'k2')
  await pickTool(p63, '箭头')
  await p63.mouse.click(a63.l + 6, a63.t + 6)
  await p63.waitForTimeout(150)
  await p63.mouse.click(b63.l + 6, b63.t + 6)
  await p63.waitForTimeout(400)
  const s63 = await canvasState(p63)
  await pickTool(p63, '箭头')
  const sh63 = await p63.evaluate(() => {
    const r = document.querySelector('[data-el="s1"]').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p63.mouse.click(a63.l + 6, a63.t + 6)
  await p63.waitForTimeout(150)
  await p63.mouse.click(sh63.x, sh63.y)
  await p63.waitForTimeout(400)
  const s63b = await canvasState(p63)
  await p63.close()
  // C63b Shift 落第二击 = 强制自由连线(Codex 08-19 深夜:卡↔卡的关联连线是既有能力,别砍)
  const p63b = await open(browser, MIND)
  await p63b.waitForTimeout(300)
  const x63 = await cardBox(p63b, 'k1')
  const y63 = await cardBox(p63b, 'k2')
  await pickTool(p63b, '箭头')
  await p63b.mouse.click(x63.l + 6, x63.t + 6)
  await p63b.waitForTimeout(150)
  await p63b.keyboard.down('Shift')
  await p63b.mouse.click(y63.l + 6, y63.t + 6)
  await p63b.keyboard.up('Shift')
  await p63b.waitForTimeout(400)
  const s63c = await canvasState(p63b)
  await p63b.close()
  record('C63 箭头工具:卡→卡=建父子关系(零新增连线条目、卡不挪位);卡→形状=仍画自由连线;Shift+卡→卡=自由连线不动层级',
    s63.tree === '"tree":{"k2":"k1"}' && s63.conns === 0 && s63.cards.includes('k2@560,460')
      && s63b.conns === 1 && s63b.tree === '"tree":{"k2":"k1"}'
      && s63c.conns === 1 && s63c.tree === null,
    JSON.stringify({ cardToCard: s63, cardToShape: s63b, shiftCardToCard: s63c }))

  await browser.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  // 明确未覆盖(别读成「测过了」):真人**原生 HTML5 拖拽**(⠿ 系)仍是合成 DragEvent 驱动 ——
  // Playwright 造不出原生 dnd,那一格只有 computer use 真机答得了;指针系拖拽自 C34 起已走
  // 真实输入管线(CDP)。触屏双指手势与无障碍焦点(Tab 序/ARIA)仍未覆盖,记账在此。
  console.log('SKIP  ⠿ 原生 dnd 真手势(computer use 侧)/ 触屏双指 / 无障碍焦点:记账在此')
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
