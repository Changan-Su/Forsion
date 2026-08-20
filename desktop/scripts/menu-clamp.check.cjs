/**
 * 锚定浮层的「别掉出屏幕」源码闸。
 *
 * 病症(2026-08-13 用户实报,手机截图):聊天输入区的模型菜单连同它的子面板整块跑到屏幕左边界
 * 外面去了。真因不是某一个菜单写错,而是**一整类**浮层的共性 —— `position:absolute` 锚在按钮上
 * + 硬编码像素宽(224 / 264 / min-width:320),窄屏上按钮离边缘不够宽,菜单左/右缘直接是负数。
 * 视口夹取的正典是 lcl/engine/menuAnchor.tsx:fixed 自定位浮层走 OverlayAt/useClampedMenu,
 * 这类「CSS 已定好位、只是会溢出」的走 useEdgeNudge。
 *
 * 为什么是源码闸而不是浏览器实测:桌面开发机上 body zoom 恒 1、窗口恒宽,这个 bug **在本地永远
 * 复现不出来**;而唯一的真 app harness(overlay-zoom)要起 vite + 走进聊天页 + 造出模型列表,
 * 为一条几何断言不值当。这里按 menu-tap.check.cjs 第二段的同款做法钉源码:名单里的浮层类,
 * 渲染它的文件必须引了夹取手段。新加浮层请连同名单一起加 —— 名单本身就是「有哪些锚定浮层」的账。
 *
 * 跑:node scripts/menu-clamp.check.cjs   (npm run check:menuclamp)
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'frontend', 'src')

// 锚定浮层类名 → 允许的夹取手段。三种都算数:
//   useEdgeNudge(absolute 原地兜底) / OverlayAt / useClampedMenu(fixed 自定位)。
const CLAMPERS = ['useEdgeNudge', 'OverlayAt', 'useClampedMenu']
const GUARDED = [
  'composer-menu', // 输入区 add / mode 菜单 + ModelPill 一级菜单(base.css 固定 224px)
  'cm-sub',        // ModelPill 四类子面板(右/左/叠放决定形态,useEdgeNudge 负责边界兜底)
  'project-menu',  // New Chat 的工作区下拉(264px 左对齐)
  'dash-add-menu', // 仪表盘「添加卡片」/ 右键菜单
  't2c-ctxring-pop', // 上下文占比悬停详情
]
// 故意豁免的**渲染点**(键 = `类 @ 相对路径`)。写清理由,别只留个名字。
const EXEMPT = {
  'composer-menu @ components/ModelSelect.tsx':
    '设置页的模型下拉:.composer-menu--down/--up 是 left:0;right:0;max-width:none —— 宽度跟着表单字段走,' +
    '不是锚按钮的固定宽浮层,横向天生溢不出去(它的翻面逻辑只管上下)。',
}

/** 递归收集 .tsx。 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.tsx')) out.push(p)
  }
  return out
}

const files = walk(ROOT)
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

for (const cls of GUARDED) {
  // 渲染点 = className 串里出现该类。前后都要卡边界,否则 `composer-menu--mode` 会被当成
  // `composer-menu` 的渲染点;后界必须放行 `${`(模板串 `cm-sub${flip ? ' flip' : ''}`)。
  // 注释里提一嘴类名也会命中 → 再要求同一行确实带 className。
  const re = new RegExp(`[\\s"'\`{]${cls}(?![\\w-])`)
  const sites = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    if (src.split('\n').some((ln) => ln.includes('className') && re.test(ln))) sites.push(f)
  }
  if (sites.length === 0) {
    check(`${cls} 名单未过期(仍有渲染点)`, false, '一个渲染点都没找到 —— 类改名或已删,请更新 GUARDED')
    continue
  }
  for (const f of sites) {
    const key = `${cls} @ ${path.relative(ROOT, f)}`
    if (EXEMPT[key]) {
      console.log(`SKIP  ${key}  | 豁免:${EXEMPT[key]}`)
      continue
    }
    const src = fs.readFileSync(f, 'utf8')
    const used = CLAMPERS.filter((c) => src.includes(c))
    check(
      `${key} 有视口夹取`,
      used.length > 0,
      used.length ? used.join('+') : `没引 ${CLAMPERS.join(' / ')} —— 窄屏会掉出屏幕,见 lcl/engine/menuAnchor.tsx`,
    )
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
