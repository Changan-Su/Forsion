/** 「打开即升 v4」开关(设置→笔记,默认**开** —— 2026-08-14 用户拍板:v3 笔记一律走 v4
 *  统一渲染,显式关掉才回块编辑器。打开只读不改写,首次真实编辑才落盘 v4。
 *  ⚠️发版清单:正式发版须与带 v4 路由的手机 APK(≥2.7.8)同车 —— 旧 APK 编辑已升级的
 *  分栏笔记会把分栏布局退化掉(内容不丢,只丢排版)。
 *
 *  路由分类在渲染路径上同步读 —— 同 wikiFiles.ts:进程内缓存,首次乐观取默认(开)再异步回填;
 *  显式关过的机器在回填前首篇笔记可能多走一次 unified,只读打开不写盘,无害。 */
let cached: boolean | null = null

export function upgradeV4Enabled(): boolean {
  if (cached === null) {
    cached = true
    void window.tangu?.getConfig?.()
      .then((c) => { cached = (c as { notesUpgradeV4?: boolean } | undefined)?.notesUpgradeV4 !== false })
      .catch(() => {})
  }
  return cached
}

export function setUpgradeV4Enabled(v: boolean): void {
  cached = v
}

// 模块装载即预热(Codex P1:显式关过的机器,首篇 v3 笔记若在回填前被路由会整个打开周期
// 误进 unified,编辑还会违背用户设置写出 v4)。preload 先于渲染模块执行,回填在应用启动
// 毫秒级完成,远早于任何笔记打开;web/mobile 无 window.tangu 则保持默认开。
void upgradeV4Enabled()
