/** Guard application chrome against new ad-hoc sizes. Content typography and graphic glyphs have their own contracts. */
const fs = require('fs')
const path = require('path')
const postcss = require('postcss')
const ROOT = path.resolve(__dirname, '..')
const roles = ['caption', 'meta', 'body', 'heading', 'title', 'display']
const rootCss = postcss.parse(fs.readFileSync(path.join(ROOT, 'frontend/src/styles/base.css'), 'utf8'))
const values = new Map()
rootCss.walkRules(':root', (r) => r.walkDecls(/^--ui-font-/, (d) => values.set(d.prop.replace('--ui-font-', ''), d.value)))
const failures = []
if (values.size !== roles.length || roles.some((r) => !/^\d+px$/.test(values.get(r) || ''))) failures.push('Define exactly six named UI font roles in base.css')
const ordered = roles.map((r) => parseFloat(values.get(r)))
if (!ordered.every((n, i) => Number.isFinite(n) && (!i || n > ordered[i - 1]))) failures.push('UI font roles must increase in size')
// These selectors represent editable/rendered documents, scale-compensated canvases, or graphic marks, not chrome text.
const content = /ProseMirror|milkdown|md-body|msg-content|thinking-content|t2-content|t2-user(?:[\s.:,>]|$)|t2-think-body|amx-title-input|page-title(?:-edit)?(?:[\s.:,>]|$)|amx-db-peek-(?:title|body)|amx-db-form-title|amx-title-(?:bigicon|icon)|amx-iconpick-item|amx-tab-emoji|amx-bm-gen-letter|(?:-emoji|-avatar|-emblem)|\.hp-clock|\.hp-brand|\.am-words-n|\.cm-|\.pdfViewer|\.textLayer|\.amx-overview|\.amx-canvas/
// Standalone legacy themes and third-party document renderers are not Genesis chrome.
const skipFile = /\/amadeus\/theme\/|\/theme\/|\/amadeus\/pdf\/|\/blocks\/excalidraw\/|\/views\/coding\/editor\.css$|Harness\.css$/
let checked = 0, preserved = 0
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name)
    if (e.isDirectory()) { walk(file); continue }
    if (!file.endsWith('.css') || skipFile.test(file)) continue
    postcss.parse(fs.readFileSync(file, 'utf8')).walkDecls((d) => {
      if (d.prop !== 'font-size' && d.prop !== 'font') return
      if (content.test(d.parent.selector || '')) { preserved++; return }
      checked++
      if ((d.prop === 'font-size' && /^\d+(?:\.\d+)?px$/.test(d.value)) ||
          (d.prop === 'font' && !d.value.includes('var(') && /\d+(?:\.\d+)?px/.test(d.value))) {
        failures.push(`${path.relative(ROOT, file)}:${d.source.start.line} ${d.parent.selector}: ${d.value}`)
      }
    })
  }
}
walk(path.join(ROOT, 'frontend/src')); walk(path.join(ROOT, '../lcl/engine'))
console.log(`UI scale: ${roles.map(r => `${r}=${values.get(r)}`).join(', ')}`)
console.log(`${checked} chrome declarations checked; ${preserved} document/graphic declarations preserved`)
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log('PASS: no ad-hoc pixel font sizes in managed chrome CSS')
