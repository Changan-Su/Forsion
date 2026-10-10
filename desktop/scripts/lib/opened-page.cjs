/**
 * 台架点了一个链接之后,认「这次点击打开的那张页」。
 *
 * 不拿「地址栏现在的地址」和链接比:页面加载完可以自己改写地址栏(history.replaceState —— Obsidian 帮助站把
 * /help/Files+and+folders/How+Obsidian+stores+data 改写成 /help/data-storage),页面明明打开了却比不上。
 * 这里比的是「这张页的文档是从哪个地址加载出来的」(主框架 did-navigate,同文档的地址改写不触发它),
 * 并且要求加载发生在点击之后 —— 点击之前就开着的同地址页面不算这次点击打开的。
 *
 * watch / find / loadedSince 在 Electron 主进程里跑,都不引用模块作用域:既能原样交给 playwright 的
 * app.evaluate(它把函数转成源码送过去),也能在裸 Electron 脚本里直接 fn(require('electron'), …)。
 *
 * ponytail: 链接被服务器跳转走(help.obsidian.md → obsidian.md/help、notion.so → notion.com)时加载地址 ≠ 链接,
 * 照旧认不出。要放过它:在 watch 里把 did-start-navigation 的起始地址一起记下,find 改成比起始地址。
 * 仪器:npm run check:sourceopen
 */

/** 点击之前调:开始记每张页的文档加载地址,返回此刻(交给 find 的 since)。 */
exports.watch = ({ app, webContents }) => {
  if (!globalThis.__pageLoads) {
    const loads = globalThis.__pageLoads = new Map()
    const on = (wc) => wc.on('did-navigate', (_e, url) => loads.set(wc.id, { url, at: Date.now() }))
    webContents.getAllWebContents().forEach(on)
    app.on('web-contents-created', (_e, wc) => on(wc))
  }
  return Date.now()
}

/** since 之后从 href 加载出来、并且已经加载完的那张页;没有就是 null。fragment 不参与比较。 */
exports.find = ({ webContents }, { href, since }) => {
  const bare = (u) => u.split('#')[0]
  for (const wc of webContents.getAllWebContents()) {
    const load = globalThis.__pageLoads?.get(wc.id)
    if (load && load.at >= since && bare(load.url) === bare(href) && !wc.isLoading()) return { url: wc.getURL(), loadedFrom: load.url, title: wc.getTitle() }
  }
  return null
}

/** 认不出时留证据:since 之后加载过哪些地址。 */
exports.loadedSince = (_electron, since) => [...(globalThis.__pageLoads?.values() ?? [])].filter((l) => l.at >= since).map((l) => l.url)

/** 打开了,而且不是错误页。 */
exports.ok = (page) => !!page?.title && !/404|not found|error/i.test(page.title)
