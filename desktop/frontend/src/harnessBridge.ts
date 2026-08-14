// harness 专用的 preload 桥垫片。**必须在 harness.tsx 的其它 import 之前 import**:
// `amadeus/api.ts` 在模块加载时就把 `window.amadeus` 抓成常量了(顶层不许裸读 window 之外的写法),
// 抓到 undefined 之后再往 window 上补就晚了 —— 表现是插件调 ctx.app.readFile 抛
// 「Cannot read properties of undefined」。
//
// 内存 vault:readFile/writeFile 走一个 Map,插件在 harness 里能真正落盘再读回(?plugview 模式验
// 插件的数据契约往返);只读查询面(listPages/listFiles/search)也由同一个 Map 背书,否则用了
// 2026-08-14 新增枚举接缝的插件在台架里一挂就空。思维导图 e2e 依赖的「任意 .mindmap.md 都读得到一个
// 中心节点」保留为兜底。
const vault = new Map<string, string>()
const isPage = (p: string): boolean => p.toLowerCase().endsWith('.md') && !/\.[a-z0-9-]+\.md$/i.test(p)

const g = window as unknown as { amadeus?: Record<string, unknown>; __vault?: Map<string, string> }
g.amadeus = {
  ...(g.amadeus ?? {}),
  readTextFile: (p: string) =>
    Promise.resolve(vault.has(p) ? vault.get(p)! : p.endsWith('.mindmap.md') ? '中心节点\n' : null),
  writeTextFile: (p: string, text: string) => {
    vault.set(p, text)
    return Promise.resolve()
  },
  listPages: () => Promise.resolve(Array.from(vault.keys()).filter(isPage)),
  listFiles: () => Promise.resolve(Array.from(vault.keys()).filter((p) => !isPage(p))),
  search: (q: string) =>
    Promise.resolve(
      Array.from(vault.entries())
        .filter(([, text]) => text.includes(q))
        .map(([path, text], i) => ({
          path,
          title: path.split('/').pop() || path,
          snippet: text.slice(Math.max(0, text.indexOf(q) - 20), text.indexOf(q) + 60),
          line: text.slice(0, text.indexOf(q)).split('\n').length,
          score: 1 - i * 0.01,
        })),
    ),
}
g.__vault = vault
export {}
