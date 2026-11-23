/** 白板引擎(zsviczian fork)+ 字体的自托管副本。拷进 renderer 的 publicDir(vite 原样带进 out/renderer),
 *  运行时经 EXCALIDRAW_ASSET_PATH / forkRuntime.ts 从这里取(见 ExcalidrawEmbed.tsx)。
 *
 *  - fonts:excalidraw 默认从 CDN(esm.sh)现拉,而本 App 的 CSP 是 default-src 'self' 且桌面端得离线可用。
 *  - excalidraw.js/.css:**fork 的 dist/prod 对外是坏的** —— 里面留着 `@excalidraw/element` 这类
 *    没发布到 npm 的内部裸 import,vite/esbuild 一律解析不了。fork 唯一自包含的产物是 dist/obsidian
 *    那份 IIFE(挂 self.ExcalidrawLib,React 走全局),所以走 <script> 装载而不进打包管道,详见 forkRuntime.ts。
 *
 *  照 build/python 的先例:体积大、可从 node_modules 再生 → 不入库(仓根 .gitignore 已挡)。
 *  postinstall 跑;按版本号戳幂等,版本没变就跳过这 20M 的拷贝。 */
const fs = require('fs')
const path = require('path')

// web 也调这支(它自己 npm ci、自己的 public/):`--out <相对 cwd 的目录>`。
// 包位置一律用 require.resolve 的**逐级上找**,不写死 desktop/node_modules —— 容器里 web 的依赖装在
// 公共祖先 /app/node_modules,写死路径就找不到。
const argOut = process.argv.indexOf('--out')
const outDir = argOut > 0 && process.argv[argOut + 1]
  ? path.resolve(process.cwd(), process.argv[argOut + 1])
  : path.join(__dirname, '..', 'frontend', 'public', 'excalidraw')
const stamp = path.join(outDir, '.version')

/** 自己走 node_modules 上找,不用 require.resolve:fork 的 exports 表只声明了 types 条件,
 *  `require.resolve('@excalidraw/excalidraw/package.json')` 会被 exports 挡掉。 */
function findPkg() {
  for (const start of [process.cwd(), __dirname]) {
    let dir = start
    for (;;) {
      const p = path.join(dir, 'node_modules', '@excalidraw', 'excalidraw', 'package.json')
      if (fs.existsSync(p)) return path.dirname(p)
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return null
}

const pkgDir = findPkg()
let version
try {
  version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
} catch {
  console.warn('[excalidraw-assets] 未安装 @excalidraw/excalidraw,跳过')
  process.exit(0)
}

// ⚠️ CSS 取 dist/prod 那份而**不是** dist/obsidian 的同名文件:两份是同一套类名(同源构建),但 obsidian
//    档里 --editor-container-padding 之类的值写成了 Obsidian 的设计 token(var(--size-4-2)/--text-color)。
//    在我们这儿解析不出来 → 整条 FixedSideContainer 的 inset 塌成 0,汉堡菜单与工具栏叠在左上角。
const SRC = {
  'excalidraw.js': path.join(pkgDir, 'dist', 'obsidian', 'excalidraw.production.min.js'),
  'excalidraw.css': path.join(pkgDir, 'dist', 'prod', 'index.css'),
}
const FONTS = path.join(pkgDir, 'dist', 'prod', 'fonts')

/** 手写笔补丁的逻辑在 frontend/src/amadeus/blocks/excalidraw/penInput.ts。
 *  钩子按 fork 0.18.122 的压缩原文匹配，每处必须恰好命中一次。升级 fork 时对照上游实现。
 *  修改后增加 PEN_PATCH，确保 postinstall 重建已有副本。 */
const PEN_PATCH = 3
const PEN_HOOK = 'globalThis.__forsionPenInput'
const REMOVE_POINTER = 'let o=ve.pointers.size>=2;ve.pointers.delete(t.pointerId),o&&ve.pointers.size<2&&this.state.scrollConstraints&&this.viewport.releaseOverscroll()'
const FREEDRAW_END = 'let u=He(o,this.state),m=a.points,w=u.x-a.x,b=u.y-a.y;w===m[0][0]&&b===m[0][1]&&(b+=1e-4,w+=1e-4);let D=a.simulatePressure?[]:[...a.pressures,o.pressure];this.scene.mutateElement(a,{points:[...m,k(w,b)],pressures:D})'
const PEN_PATCHES = [
  // 钩子 1:画布按下的最开头 —— 要赶在 maybeCleanupAfterMissingPointerUp 收掉正在画的那一笔之前。`ve` = 引擎的手势表
  [
    'M(this,"handleCanvasPointerDown",t=>{',
    `M(this,"handleCanvasPointerDown",t=>{if(${PEN_HOOK}?.down(t,this.state,ve))return;`,
  ],
  // 钩子 2:按下后建拖动监听。`l` = pointerDownState,`t` = 这次按下的事件,`He` = viewportCoordsToSceneCoords
  [
    'let c=this.onPointerMoveFromPointerDownHandler(l),C=this.onPointerUpFromPointerDownHandler(l),',
    `let[c,C]=(${PEN_HOOK}?.wrap??((a,b)=>[a,b]))(this.onPointerMoveFromPointerDownHandler(l),this.onPointerUpFromPointerDownHandler(l,t.pointerId),l,t,this.state,A=>He(A,this.state)),`,
  ],
  // 钩子 3:自由画笔每帧追加点。`t` = pointerDownState
  [
    'if(c.type==="freedraw"){let C=c.points,B=i.x-c.x,d=i.y-c.y,E=C.length>0&&C[C.length-1];if(!(E&&E[0]===B&&E[1]===d)){let p=this.state.currentStrokeOptions,u=c.simulatePressure?c.pressures:[...c.pressures,p?.constantPressure?1:o.pressure];this.scene.mutateElement(c,{points:[...C,k(B,d)],pressures:u},{informMutation:!1,isDragging:!1}),this.setState({newElement:c})}}',
    `if(c.type==="freedraw"){let __fp=${PEN_HOOK}?.freedraw(c,t,this.state);if(__fp!==void 0)__fp&&(this.scene.mutateElement(c,__fp,{informMutation:!1,isDragging:!1}),this.setState({newElement:c}));else{let C=c.points,B=i.x-c.x,d=i.y-c.y,E=C.length>0&&C[C.length-1];if(!(E&&E[0]===B&&E[1]===d)){let p=this.state.currentStrokeOptions,u=c.simulatePressure?c.pressures:[...c.pressures,p?.constantPressure?1:o.pressure];this.scene.mutateElement(c,{points:[...C,k(B,d)],pressures:u},{informMutation:!1,isDragging:!1}),this.setState({newElement:c})}}}`,
  ],
  // #12704：记录引擎实际接收的接触点，范围包括笔侧键启动的平移。
  [
    'updateGestureOnPointerDown(t){ve.pointers.set(',
    `updateGestureOnPointerDown(t){${PEN_HOOK}?.trackContact?.(ve,t,this.id,this.removeGesturePointer),ve.pointers.set(`,
  ],
  [
    `M(this,"removePointer",t=>{fB&&this.resetContextMenuTimer(),t.type==="pointercancel"&&this.bucketFill.cancel();${REMOVE_POINTER}});`,
    `M(this,"removeGesturePointer",t=>{let o=ve.pointers.size>=2;ve.pointers.delete(t),ve.forsionContacts?.delete(t),o&&ve.pointers.size<2&&this.state.scrollConstraints&&this.viewport.releaseOverscroll()});
     M(this,"removePointer",t=>{fB&&this.resetContextMenuTimer(),t.type==="pointercancel"&&this.bucketFill.cancel(),this.removeGesturePointer(t.pointerId)});
     M(this,"handlePointerCancel",t=>{if(${PEN_HOOK}?.ownsContact?.(ve,t.pointerId,this.id)){this.removePointer(t);if(this.lastPointerDownEvent?.pointerId===t.pointerId)this.missingPointerEventCleanupEmitter.trigger(t).clear()}});`,
  ],
  [
    'onPointerCancel:this.removePointer,onTouchMove:this.handleTouchMove',
    `onPointerCancel:t=>${PEN_HOOK}?.ownsContact?this.handlePointerCancel(t.nativeEvent):this.removePointer(t),onTouchMove:this.handleTouchMove`,
  ],
  [
    '_e(document,"pointerup",this.removePointer,{passive:!1}),',
    '_e(document,"pointerup",this.removePointer,{passive:!1}),_e(document,"pointercancel",this.handlePointerCancel),',
  ],
  [
    've.pointers.clear(),ve.lastCenter=null',
    've.pointers.clear(),ve.forsionContacts?.clear(),ve.lastCenter=null',
  ],
  [
    'this.state.previousSelectedElementIds,this.state)}):ve.pointers.clear())',
    `this.state.previousSelectedElementIds,this.state)}):(${PEN_HOOK}?.endTouches?${PEN_HOOK}.endTouches(ve,this.removeGesturePointer):ve.pointers.clear()))`,
  ],
  // 旧 fork 的 Up 是模块变量。平移只结束自己的按压，画板的普通取消监听不碰 Up。
  [
    'window.removeEventListener("blur",g),n.flush()});return window.addEventListener("blur",g),window.addEventListener("pointermove",n,{passive:!0}),window.addEventListener("pointerup",g),!0',
    `window.removeEventListener("blur",g),window.removeEventListener("pointercancel",cancelPan,true),n.flush()});
     const cancelPan=e=>{if(e.pointerId===t.pointerId)g()};
     return window.addEventListener("blur",g),window.addEventListener("pointermove",n,{passive:!0}),window.addEventListener("pointerup",g),window.addEventListener("pointercancel",cancelPan,true),!0`,
  ],
  // 取消橡皮擦时收掉轨迹和待删除预览，正常松手仍会提交。
  [
    'let E=this.lastPointerDownEvent,h=this.lastPointerUpEvent||this.lastPointerMoveEvent;if(ig(this.state)&&E&&h)',
    'let E=this.lastPointerDownEvent,h=this.lastPointerUpEvent||this.lastPointerMoveEvent;if(ig(this.state)&&o.type==="pointercancel"){this.eraserTrail.endPath(),this.restoreReadyToEraseElements();return}if(ig(this.state)&&E&&h)',
  ],
  // 补收笔沿用最后的实际采样。真正的抬笔继续用引擎原有的终点算法。
  [
    'onPointerUpFromPointerDownHandler(t){return Bo(o=>',
    'onPointerUpFromPointerDownHandler(t,originPointerId){return Bo(o=>',
  ],
  [
    `a?.type==="freedraw"){${FREEDRAW_END},this.actionManager.executeAction(sa);return}`,
    `a?.type==="freedraw"){let finish=${PEN_HOOK}?.finishStroke?.(a,o,originPointerId);if(finish===void 0){${FREEDRAW_END}}else if(finish)this.scene.mutateElement(a,finish);this.actionManager.executeAction(sa);return}`,
  ],
]
/** 文案补丁(走查续七 7.6):引擎不导出 i18n,语言包是模块私有的。插两个钩子,逻辑在
 *  frontend/src/amadeus/blocks/excalidraw/boardText.ts:
 *  - 文案查表 `L` 的最开头:宿主给了某个键的译文就用宿主的(白板菜单的「复制 / 创建副本」对齐图像工作室)。
 *  - 快捷键格式化 `gA`:宿主给了就用宿主的(mac 写 ⇧⌘E 这类系统符号)。
 *  两个钩子都是「宿主不答(undefined)就走引擎原路」;规则同上(逐字匹配、恰好一次),改了把 TEXT_PATCH 加一。 */
const TEXT_PATCH = 1
const TEXT_PATCHES = [
  // `$0` = 当前语言 { code }
  ['L=(A,e,t)=>{if($0.code.startsWith(X0))', 'L=(A,e,t)=>{let __fl=globalThis.__forsionBoardText?.label(A,$0.code);if(__fl!==void 0)return __fl;if($0.code.startsWith(X0))'],
  ['var gA=A=>A.replace(', 'var gA=A=>globalThis.__forsionBoardText?.shortcut(A)??A.replace('],
]
function applyPatches(src, patches, what) {
  for (const [from, to] of patches) {
    const n = src.split(from).length - 1
    if (n !== 1) throw new Error(`[excalidraw-assets] ${what}补丁点命中 ${n} 次(应为 1):${from.slice(0, 60)}…  fork 版本变了?见补丁表的注释`)
    src = src.replace(from, () => to)
  }
  return src
}
function patchEngine(src) {
  src = applyPatches(applyPatches(src, PEN_PATCHES, '手写笔'), TEXT_PATCHES, '文案')
  return `${src}\n;globalThis.__forsionPenPatch=${PEN_PATCH};globalThis.__forsionTextPatch=${TEXT_PATCH};\n`
}
const STAMP = `+pen${PEN_PATCH}+text${TEXT_PATCH}`
const nonEmpty = (p) => {
  try {
    return fs.statSync(p).size > 0
  } catch {
    return false
  }
}

// 幂等戳:版本号 + **产物真的还在**。只看版本号的话,产物被清掉/拷坏时这里会直接跳过,
// 留下一个「装过了但白板 404」的坑(而 404 要到用户点开画板才暴露)。
const complete = Object.keys(SRC).every((f) => nonEmpty(path.join(outDir, f))) && fs.existsSync(path.join(outDir, 'fonts'))
try {
  if (complete && fs.readFileSync(stamp, 'utf8') === `${version}${STAMP}`) process.exit(0)
} catch {
  /* 无戳 / 读不动 → 重拷 */
}

// ⚠️ 先验源、再删旧:反过来的话源缺失时会先把上一份能用的副本清空再抛错,
//    把「装不上」升级成「本来能跑的也跑不了了」。
for (const [name, src] of Object.entries(SRC)) {
  if (!nonEmpty(src)) throw new Error(`[excalidraw-assets] 源文件缺失或为空:${src}(${name});fork 的产物布局变了?`)
}
if (!fs.existsSync(FONTS)) throw new Error(`[excalidraw-assets] 字体目录缺失:${FONTS}`)
// 补丁也算「验源」:打不上就在删旧副本之前抛
const engine = patchEngine(fs.readFileSync(SRC['excalidraw.js'], 'utf8'))

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
fs.cpSync(FONTS, path.join(outDir, 'fonts'), { recursive: true })
fs.copyFileSync(SRC['excalidraw.css'], path.join(outDir, 'excalidraw.css'))
fs.writeFileSync(path.join(outDir, 'excalidraw.js'), engine)
fs.writeFileSync(stamp, `${version}${STAMP}`)
console.log('[excalidraw-assets] engine + fonts', version, '->', outDir)
