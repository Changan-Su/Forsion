/**
 * 真 Electron 台架:把主窗的首启引导点掉,返回主窗是否真离开了引导(调用方拿它记一条 check)。
 *
 * 两个坑(09-21 floating-panel 实测):① 引导是 authStatus / appVersion 两条 IPC 回来才置上的,异步出现,
 * 挂载后立即 count() 可能还没有;② 按钮叫「跳过引导 / Skip onboarding」,精确名 'Skip' 在哪种语言下都点不中。
 * 点不中时主窗停在引导页:.shell-host 是 visibility:hidden,NotificationHost 不挂,只读 <html> 属性 / 只打浮窗的
 * 断言照样绿 —— 所以返回值一定要记成 check,别吞掉。
 */
async function skipOnboarding(win, timeout = 15000) {
  const skip = win.getByRole('button', { name: /^(Skip onboarding|跳过引导)$/ }).first()
  await skip.waitFor({ timeout }).then(() => skip.click()).catch(() => {})
  return win.waitForFunction(() => {
    const host = document.querySelector('.shell-host')
    return !!host && getComputedStyle(host).visibility !== 'hidden'
  }, null, { timeout: 10000 }).then(() => true, () => false)
}

module.exports = { skipOnboarding }
