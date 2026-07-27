// harness 专用的 preload 桥垫片。**必须在 harness.tsx 的其它 import 之前 import**:
// `amadeus/api.ts` 在模块加载时就把 `window.amadeus` 抓成常量了(顶层不许裸读 window 之外的写法),
// 抓到 undefined 之后再往 window 上补就晚了 —— 表现是插件调 ctx.app.readFile 抛
// 「Cannot read properties of undefined」。
//
// 只垫真正被 harness 场景走到的那几个:思维导图插件开图前会先 readFile 确认文件存在
// (防「打开一条已删除的条目 → loadPage 凭空重建」),没有这层就永远显示「找不到」。
const g = window as unknown as { amadeus?: Record<string, unknown> }
g.amadeus = {
  ...(g.amadeus ?? {}),
  readTextFile: (p: string) => Promise.resolve(p.endsWith('.mindmap.md') ? '中心节点\n' : null),
  writeTextFile: () => Promise.resolve(),
}
export {}
