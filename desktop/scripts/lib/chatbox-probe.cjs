/** Installed DOM plugin used by coding-studio.e2e: consumes only the public ctx.ui API. */
const fs = require('fs')
const path = require('path')
exports.writeChatBoxProbe = home => {
  const directory = path.join(home, 'plugins', 'chatbox-probe')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ id: 'chatbox-probe', name: 'Chat Box probe', version: '1.0.0', minAppVersion: '0.0.1' }))
  fs.writeFileSync(path.join(directory, 'main.js'), `
    const probe = window.__chatBoxProbe = { submitted: [], disposed: 0 }
    ctx.registerView({ id: 'prompt', title: 'Chat Box probe', mount(el) {
      el.innerHTML = '<div class="chatbox-probe" style="max-width:720px;padding:24px;margin:auto"><h2>Shared plugin Chat Box</h2><div class="chatbox-probe-input"></div></div>'
      const node = el.querySelector('.chatbox-probe-input')
      probe.box = ctx.ui.mountChatBox(node, {
        value: 'Plugin-owned draft', label: 'Plugin request', submitLabel: 'Accept draft',
        onSubmit(draft) { probe.submitted.push(draft); return false }
      })
      return () => { probe.disposed++; probe.box.dispose() }
    } })
    probe.open = () => ctx.openView('prompt')
  `)
}

exports.verifyChatBoxProbe = async (win, check) => {
  await win.waitForFunction(() => !!window.__chatBoxProbe)
  await win.evaluate(() => window.__chatBoxProbe.open())
  const box = win.locator('.chatbox-probe')
  await box.locator('textarea').waitFor()
  check('A disk-installed plugin mounts the public Chat Box', await box.locator('[data-ui-component="chat-box"]').count() === 1)
  await box.locator('textarea').fill('Edited plugin draft')
  await box.locator('textarea').evaluate(el => { window.__probeInput = el })
  await win.evaluate(() => window.__chatBoxProbe.box.update({ placeholder: 'Updated in place' }))
  check('Plugin update keeps the same input and unsent draft', await box.locator('textarea').evaluate(el => el === window.__probeInput && el.value === 'Edited plugin draft'))
  await box.locator('.model-pill-btn').click()
  await win.locator('.composer-menu--portal [data-pane-trigger="model"]').click()
  await win.locator('.composer-menu--portal .menu-item').filter({ hasText: 'Studio reasoning' }).click()
  await box.locator('.model-pill-btn').click()
  await win.locator('.composer-menu--portal .cm-effort-input').fill('4')
  await win.keyboard.press('Escape')
  await box.getByRole('button', { name: 'Accept draft', exact: true }).click()
  check('Plugin submission receives the selected model and effort and can keep its draft', await win.evaluate(() => {
    const sent = window.__chatBoxProbe.submitted[0]
    return sent?.text === 'Edited plugin draft' && sent.modelId === 'm2' && sent.thinkingLevel === 'high'
      && document.querySelector('.chatbox-probe textarea')?.value === 'Edited plugin draft'
  }))
  await win.evaluate(() => window.__chatBoxProbe.box.dispose())
  await box.locator('textarea').waitFor({ state: 'detached' })
  check('Public plugin Chat Box disposal removes its input and menus', await box.locator('[data-ui-component="chat-box"]').count() === 0 && await win.locator('.composer-menu--portal').count() === 0)
}
