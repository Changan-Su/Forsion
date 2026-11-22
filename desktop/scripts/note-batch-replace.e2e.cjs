// Build desktop first. This exercises the normal search panel, actual IPC and files in an isolated vault.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { boot, launch, shotDir } = require('./lib/uiux-electron.cjs')

const oldTerm = '零点校准'
const newTerm = '零位校准'
const later = '复测结果由实验员补记。'
const setup = '仪器设置.md'
const analysis = '误差分析.md'
const manual = '仪器说明摘录.md'
const writing = '光谱复测记录.md'
const originals = {
  [writing]: Array.from({ length: 35 }, (_, i) => '第 ' + (i + 1) + ' 组。保持积分时间不变，重新固定光纤，记录峰位与不确定度。').join('\n\n') + '\n',
  [setup]: '开机后进行**零点校准**。\n\n第二次零点校准作对照。\n',
  [analysis]: '比较零点校准前后的偏差。\n\n零点校准的不确定度单列。\n',
  [manual]: '仪器说明书，第 14 页。\n\n> 打开光源前，请先完成零点校准。\n\n`零点校准`\n',
}
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function until(check, message) {
  const until = Date.now() + 12000
  do {
    if (await check()) return
    await delay(60)
  } while (Date.now() < until)
  assert.fail(message)
}

async function openNote(win, file) {
  const name = file.replace(/\.md$/, '')
  await win.keyboard.press(mod + '+p')
  const input = win.locator('.amx-qf-input:visible')
  await input.fill(name)
  await win.locator('.amx-qf-row:visible').filter({ hasText: name }).first().click()
  const body = win.locator('.unified-body .ProseMirror:visible').filter({ hasText: file === setup ? '开机后' : file === writing ? '第 35 组' : '不确定度' }).first()
  await body.waitFor()
  return body
}

async function openBatch(win) {
  const entry = win.getByRole('button', { name: '跨笔记替换', exact: true })
  if (!await entry.isVisible()) await win.keyboard.press(mod + '+Shift+f')
  await entry.click()
  return win.locator('.amx-replace-panel:visible')
}

async function run() {
  let vault
  const session = await launch({
    tag: 'note-batch-replace', overrideHome: true,
    beforeLaunch(env) {
      vault = env.vault
      for (const [file, contents] of Object.entries(originals)) fs.writeFileSync(path.join(vault, file), contents)
    },
  })
  const read = name => fs.readFileSync(path.join(vault, name), 'utf8')
  const { app, win } = session
  const errors = []
  win.on('pageerror', error => errors.push(String(error)))
  const shots = shotDir('note-batch-replace')
  try {
    await boot(app, win, { space: 'amadeus', width: 1240, height: 820 })
    await openNote(win, setup)
    let panel = await openBatch(win)
    await panel.getByRole('textbox', { name: '查找正文' }).fill(oldTerm)
    await panel.getByRole('textbox', { name: '替换为' }).fill(newTerm)
    const apply = panel.getByRole('button', { name: '替换 4 处', exact: true })
    await apply.waitFor()
    assert.equal(await panel.getByRole('checkbox').count(), 5)
    assert.equal(await panel.locator('input:checked').count(), 4)
    const quote = panel.locator('.amx-replace-row').filter({ hasText: '引用原文 · 保留' })
    assert.equal(await quote.getByRole('checkbox').isChecked(), false)
    await panel.getByRole('button', { name: /第二次/ }).click()
    await panel.getByRole('button', { name: /开机后/ }).click()
    assert.equal(await win.locator('.dv-tab:visible').filter({ hasText: '替换预览' }).count(), 1)
    const preview = win.locator('.amx-replace-paper:visible')
    await preview.locator('ins').first().waitFor()
    assert.equal(await preview.locator('del').first().innerText(), oldTerm)
    assert.equal(await preview.locator('ins').first().innerText(), newTerm)
    assert.equal(await preview.locator('strong').count(), 1)
    await win.screenshot({ path: path.join(shots, 'replace-review.png') })
    await apply.click()
    await panel.getByRole('button', { name: '撤销这次替换' }).waitFor()
    for (const file of [setup, analysis]) assert.equal(read(file), originals[file].replaceAll(oldTerm, newTerm))
    assert.equal(read(manual), originals[manual])
    const editor = await openNote(win, analysis)
    const end = editor.getByText('零位校准的不确定度单列。', { exact: true })
    await end.click()
    await win.keyboard.press('End')
    await win.keyboard.insertText(later)
    await until(() => read(analysis).includes(later), 'subsequent edit should reach disk')
    const afterEdit = read(analysis)
    await win.reload({ waitUntil: 'domcontentloaded' })
    const restored = win.locator('.unified-body .ProseMirror:visible').filter({ hasText: later }).first()
    await restored.waitFor()
    await restored.click()
    panel = await openBatch(win)
    await panel.getByRole('button', { name: '上次替换' }).click()
    await panel.getByRole('button', { name: '撤销这次替换' }).click()
    await panel.getByText(/内容或位置已变/).waitFor()
    assert.equal(read(setup), originals[setup])
    assert.equal(read(analysis), afterEdit)
    assert.equal(read(manual), originals[manual])
    const writer = await openNote(win, writing)
    await writer.locator('p').filter({ hasText: '第 18 组' }).click()
    await win.locator('.amx-toolbar:visible .amx-more-btn').click()
    await win.locator('[data-pagestyle="centerLine"]:visible').click()
    await win.locator('.amx-toolbar:visible .amx-more-btn').click()
    await writer.locator('p').filter({ hasText: '第 18 组' }).click()
    await win.keyboard.insertText('复核')
    await until(() => writer.evaluate(body => {
      const selection = getSelection()
      if (!selection?.rangeCount || !body.contains(selection.anchorNode)) return false
      const line = selection.getRangeAt(0).getBoundingClientRect()
      const pane = body.closest('.amx-pane').getBoundingClientRect()
      return Math.abs(line.top + line.height / 2 - pane.top - pane.height / 2) < 30
    }), 'typing should center the active line in the actual note pane')
    await win.screenshot({ path: path.join(shots, 'center-line.png') })
    await win.keyboard.press('Escape')
    await until(() => win.locator('.amx-seg-anchor[data-center-line]').count().then(n => n === 0),
      'Escape should leave typing-line mode')
    assert.deepEqual(errors, [])
    console.log('PASS: four original-source edits, protected quotation and inline code, read-only formatted preview, persisted batch undo, subsequent edit preserved.')
  } catch (error) {
    await win.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {})
    console.error(await win.locator('.amx-replace-panel:visible').allTextContents().catch(() => []))
    throw error
  } finally {
    await session.close()
  }
}

run().catch(error => { console.error(error); process.exitCode = 1 })
