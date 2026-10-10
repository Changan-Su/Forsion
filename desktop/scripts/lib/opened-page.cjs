/**
 * 台架点了一个链接之后,认「这次点击打开的那张页」。
 *
 * 不拿「地址栏现在的地址」和链接比:页面加载完可以自己改写地址栏(history.replaceState —— Obsidian 帮助站把
 * /help/Files+and+folders/How+Obsidian+stores+data 改写成 /help/data-storage),页面明明打开了却比不上。
 * 这里比的是「这张页的文档是从哪个地址加载出来的」(主框架 did-navigate,同文档的地址改写不触发它),
 * 并且要求这次加载是点击之后才**开始**的 —— 点击之前就开着、或者点击之前就已经在加载的同地址页面,不算这次点击打开的。
 * 先后用主进程里的事件序号排,不用时钟(同一毫秒分不出先后,系统对时还会让时钟往回跳)。
 *
 * watch / find / loadedSince 在 Electron 主进程里跑,都不引用模块作用域:既能原样交给 playwright 的
 * app.evaluate(它把函数转成源码送过去),也能在裸 Electron 脚本里直接 fn(require('electron'), …)。
 *
 * ponytail: 两种情况照旧认不出(判红):
 *  - 链接被服务器跳转走(help.obsidian.md → obsidian.md/help、notion.so → notion.com):加载地址 ≠ 链接。
 *    要放过它,把 did-start-navigation 的起始地址一起记下,find 改成比起始地址。
 *  - 同一个来源点第二次:产品复用已有的 webview,只换 fragment 是同文档导航,没有新的加载。
 *    现在的场景每个来源只点一次;要认它得另记 did-navigate-in-page,并和页面自己的地址改写分开。
 * 仪器:npm run check:sourceopen
 */

/** 点击之前调:开始记每张页的文档加载,返回此刻的记号(交给 find 的 since)。 */
exports.watch = ({ app, webContents }) => {
  const g = globalThis.__pageLoads ??= { n: 0, started: new Map(), loads: new Map() }
  if (!g.on) {
    g.on = (wc) => {
      wc.on('did-start-navigation', (e, _url, inPlace, mainFrame) => { if ((e.isMainFrame ?? mainFrame) && !(e.isSameDocument ?? inPlace)) g.started.set(wc.id, ++g.n) })
      // 开始记之前就在途的导航没有起始序号 → 0,永远算「点击之前」。
      wc.on('did-navigate', (_e, url) => g.loads.set(wc.id, { url, n: g.started.get(wc.id) ?? 0 }))
    }
    webContents.getAllWebContents().forEach(g.on)
    app.on('web-contents-created', (_e, wc) => g.on(wc))
  }
  return g.n
}

/** since 之后才开始加载、从 href 加载出来、并且已经加载完的那张页;没有就是 null。fragment 不参与比较。 */
exports.find = ({ webContents }, { href, since }) => {
  const bare = (u) => u.split('#')[0]
  for (const wc of webContents.getAllWebContents()) {
    const load = globalThis.__pageLoads?.loads.get(wc.id)
    if (load && load.n > since && bare(load.url) === bare(href) && !wc.isLoading()) return { url: wc.getURL(), loadedFrom: load.url, title: wc.getTitle() }
  }
  return null
}

/** 认不出时留证据:since 之后开始、并且加载出来了的地址。 */
exports.loadedSince = (_electron, since) => [...(globalThis.__pageLoads?.loads.values() ?? [])].filter((l) => l.n > since).map((l) => l.url)

/** 打开了,而且不是错误页。 */
exports.ok = (page) => !!page?.title && !/404|not found|error/i.test(page.title)
