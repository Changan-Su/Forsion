/**
 * 新旧读树器并排对比 —— `node scripts/uitree-compare.cjs [轮数]`。
 *
 * 把设备停在想比的那一屏再跑(模拟器是共用的:套 devlock)。每轮:旧的(`uiautomator dump`)读一次 → 起常驻读树器
 * (lib/UiTreeServer.java)读一次(同样等满 1 秒静止)→ 逐节点比,两边各多出来的节点列出来。
 * 两者不能同时在 —— 设备只有一个界面自动化槽位 —— 所以每轮都把读树器停掉再起。
 * 什么时候跑:改了 UiTreeServer.java,或者换了模拟器的系统镜像。退出码 0 = 每一轮两边的节点逐个属性、顺序都一致
 *(画面还在动的那一屏会有真差异:两次读取之间隔着一两秒)。
 */
const h = require('./lib/emu-cdp.cjs')

const parse = (xml) => [...xml.matchAll(/<node\s+([^>]+?)\s*\/?>/g)].map((m) => m[1].trim())
const attr = (node, name) => (node.match(new RegExp(` ${name}="([^"]*)"`)) || [])[1] || ''
const brief = (node) => `${attr(node, 'class').split('.').pop()} ${JSON.stringify(attr(node, 'text') || attr(node, 'content-desc') || attr(node, 'resource-id'))} ${attr(node, 'bounds')}`
const rounds = Number(process.argv[2] || 3)
let differing = 0
for (let round = 1; round <= rounds; round++) {
  h.tree.stop()
  const old = parse(h.tree.old())
  if (!h.tree.start()) process.exit(2)
  const now = parse(h.tree.ask('/dump?idle=1000'))
  h.tree.stop()
  const [inOld, inNow] = [new Set(old), new Set(now)]
  const onlyOld = old.filter((n) => !inNow.has(n))
  const onlyNow = now.filter((n) => !inOld.has(n))
  console.log(`round ${round}: old ${old.length} nodes · connected ${now.length} nodes · only old ${onlyOld.length} · only connected ${onlyNow.length}${old.join('\n') === now.join('\n') ? ' · same order' : ''}`)
  for (const n of onlyOld) console.log(`   old only        ${brief(n)}`)
  for (const n of onlyNow) console.log(`   connected only  ${brief(n)}`)
  if (old.join('\n') !== now.join('\n')) differing++
}
console.log(differing ? `✗ ${differing} of ${rounds} rounds differ` : `✓ ${rounds} rounds: the same nodes, attribute for attribute, in the same order`)
process.exit(differing ? 1 : 0)
