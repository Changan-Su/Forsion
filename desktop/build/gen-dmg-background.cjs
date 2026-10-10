#!/usr/bin/env node
/** 由 build/dmg-background.html 生成安装窗口背景:dmg-background.png(1x)+ dmg-background@2x.png(Retina)。
 *  只在改了那份 HTML 之后手动跑一次,产物提交进仓(CI 不重新生成 —— 字体取本机系统字体,要在 macOS 上跑)。
 *  用本机 Chrome(playwright-core 不带浏览器)。 */
const { chromium } = require('playwright-core')
const { join } = require('path')
const { pathToFileURL } = require('url')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    for (const [scale, name] of [[1, 'dmg-background.png'], [2, 'dmg-background@2x.png']]) {
      const page = await browser.newPage({ viewport: { width: 600, height: 460 }, deviceScaleFactor: scale })
      await page.goto(pathToFileURL(join(__dirname, 'dmg-background.html')).href)
      await page.screenshot({ path: join(__dirname, name) })
      await page.close()
      console.log(`[gen-dmg-background] ${name}`)
    }
  } finally {
    await browser.close()
  }
})()
