/**
 * 插件停用开关拨下时先浮出「为什么停用？」(遥测 v3,components/PluginReasons.tsx):台架一律点「直接停用」。
 * 只有遥测通道在(装载了带遥测的 Extend)时才问 —— 没问就什么都不做,所以在哪个台架里都能直接调。
 * 用法:await sw.click(); await skipDisableReason(page)
 */
async function skipDisableReason(page, timeout = 3000) {
  const skip = page.locator('[data-disable-reasons] [data-reason="none"]')
  if (await skip.waitFor({ timeout }).then(() => true, () => false)) await skip.click()
}
module.exports = { skipDisableReason }
