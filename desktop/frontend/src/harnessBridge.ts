// harness 专用的 preload 桥垫片。**必须在 harness.tsx 的其它 import 之前 import**:
// `amadeus/api.ts` 在模块加载时就把 `window.amadeus` 抓成常量了(顶层不许裸读 window 之外的写法),
// 抓到 undefined 之后再往 window 上补就晚了 —— 表现是插件调 ctx.app.readFile 抛
// 「Cannot read properties of undefined」。
//
// 内存 vault:readFile/writeFile 走一个 Map,插件在 harness 里能真正落盘再读回(?plugview 模式验
// 插件的数据契约往返);只读查询面(listPages/listFiles/search)也由同一个 Map 背书,否则用了
// 2026-08-14 新增枚举接缝的插件在台架里一挂就空。思维导图 e2e 依赖的「任意 .mindmap.md 都读得到一个
// 中心节点」保留为兜底。
// 二进制面(saveVaultBytes/readVaultBytes,2026-09-19+):ctx.app.writeBytes/readBytes 的桥,**只在 ?plugview 装**
// (别的台架模式保持「桥上没有字节面」的旧宿主形状,基线不动)。字节单独一张表,同一路径文本/字节二选一
// (后写的赢),读侧两边互通(文本按 UTF-8 编码成字节,字节按 UTF-8 解码成文本)。
const vault = new Map<string, string>()
const vaultBytes = new Map<string, Uint8Array>()
const isPage = (p: string): boolean => p.toLowerCase().endsWith('.md') && !/\.[a-z0-9-]+\.md$/i.test(p)

const g = window as unknown as { amadeus?: Record<string, unknown>; __vault?: Map<string, string>; __vaultBytes?: Map<string, Uint8Array> }
g.amadeus = {
  ...(g.amadeus ?? {}),
  readTextFile: (p: string) =>
    Promise.resolve(vault.has(p) ? vault.get(p)!
      : vaultBytes.has(p) ? new TextDecoder().decode(vaultBytes.get(p)!)
        : p.endsWith('.mindmap.md') ? '中心节点\n' : null),
  writeTextFile: (p: string, text: string) => {
    vaultBytes.delete(p)
    vault.set(p, text)
    return Promise.resolve()
  },
  listPages: () => Promise.resolve(Array.from(vault.keys()).filter(isPage)),
  listFiles: () => Promise.resolve([...vault.keys(), ...vaultBytes.keys()].filter((p) => !isPage(p))),
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
g.__vaultBytes = vaultBytes
if (new URLSearchParams(location.search).has('plugview')) {
  Object.assign(g.amadeus!, {
    // 真桥:缺文件 reject(ENOENT),由 pluginStore 的 readBytes 收成 null —— 台架照同一口径
    saveVaultBytes: (p: string, bytes: Uint8Array) => {
      vault.delete(p)
      vaultBytes.set(p, new Uint8Array(bytes))
      return Promise.resolve()
    },
    readVaultBytes: (p: string) =>
      vaultBytes.has(p) ? Promise.resolve(new Uint8Array(vaultBytes.get(p)!))
        : vault.has(p) ? Promise.resolve(new TextEncoder().encode(vault.get(p)!))
          : Promise.reject(new Error(`ENOENT: ${p}`)),
  })
}
export {}
