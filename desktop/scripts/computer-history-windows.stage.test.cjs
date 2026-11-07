const assert = require('node:assert/strict')
const test = require('node:test')
const { fixtureRows, exclusionPolicy } = require('./computer-history-windows.stage.cjs')

test('fixture receipts cannot be selected by pasted text or another page title', () => {
  const url = 'http://127.0.0.1:34854/'
  const own = { bundleId: 'forsion, 中文验收.exe', title: 'Forsion history comma Chinese acceptance', typed: ['fixture'] }
  const chrome = { bundleId: 'chrome.exe', url: url + '?capture=chrome#fragment', typed: ['ChromeNative1031'] }
  const edge = { bundleId: 'msedge.exe', title: 'Forsion browser history acceptance - Microsoft Edge', typed: ['EdgeNative1031'] }
  const unrelated = [
    { bundleId: 'notepad.exe', title: 'Private document', typed: [url] },
    { bundleId: 'chrome.exe', title: 'Private browser page', typed: [url, own.title] },
    { bundleId: 'chrome.exe', url: 'https://example.invalid/', title: edge.title, typed: ['private'] },
    { bundleId: 'other.exe', title: own.title, typed: ['private'] },
  ]
  assert.deepEqual(fixtureRows([...unrelated, own, chrome, edge], url), [own, chrome, edge])
})

test('one exclusion policy preserves explicit browser allowance with target exclusion', () => {
  const base = ['chrome.exe', 'msedge.exe', 'electron.exe'], exe = 'Forsion, 中文验收.exe'
  assert.deepEqual(exclusionPolicy(base, ['chrome.exe'], true, exe), ['msedge.exe', 'electron.exe', exe])
  assert.deepEqual(exclusionPolicy(base, ['chrome.exe'], false, exe), ['msedge.exe', 'electron.exe'])
  assert.throws(() => exclusionPolicy(base, ['arbitrary.exe'], false, exe), /Only explicit/)
})
