const { writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { nsisEscapeString } = require('app-builder-lib/out/targets/nsis/nsisScriptGenerator.js')

function fileAssociationsFor(productId) {
  if (!/^[a-z][a-z0-9-]*$/.test(productId)) throw new Error('Invalid file-association product id')
  return [
    { ext: 'pdf', name: `Forsion.${productId}.pdf`, description: 'PDF document', role: 'Viewer', rank: 'Alternate', mimeType: 'application/pdf' },
    { ext: ['md', 'markdown'], name: `Forsion.${productId}.markdown`, description: 'Markdown document', role: 'Editor', rank: 'Default', mimeType: 'text/markdown' },
  ]
}

// electron-builder's stock Windows macro leaves the executable unquoted and
// claims every extension's default regardless of rank. Generate its replacement
// from the same association table used by macOS and the product configuration.
function createNsisInclude(productId, outputDirectory = __dirname) {
  const associations = fileAssociationsFor(productId)
  const entries = associations.flatMap(item => (Array.isArray(item.ext) ? item.ext : [item.ext]).map(ext => ({ ...item, ext })))
  const ownClasses = [...new Set(entries.map(item => item.name))]
  const quote = value => `"${nsisEscapeString(String(value))}"`
  const include = file => `!include ${quote(resolve(file))}`
  const registryFile = join(outputDirectory, `.associations-${productId}-${process.pid}.generated.nsh`)
  const wrapper = join(outputDirectory, `.installer-${productId}-${process.pid}.generated.nsh`)
  writeFileSync(registryFile, [
    '!ifmacrodef registerFileAssociations',
    '!macroundef registerFileAssociations',
    '!macro registerFileAssociations',
    ...entries.map(item => `!insertmacro ForsionAssociate ${quote(item.ext)} ${quote(item.name)} ${quote(item.description)} ${quote(item.rank === 'Default' ? '1' : '0')}`),
    '!macroend', '!endif',
    '!ifmacrodef unregisterFileAssociations',
    '!macroundef unregisterFileAssociations',
    '!macro unregisterFileAssociations',
    // Run at the actual unregistration point after successful payload removal,
    // including --updated. A replacement installer restores its own defaults.
    ...entries.flatMap(item => ownClasses.map(name => `!insertmacro ForsionClearOwnedDefault ${quote(item.ext)} ${quote(name)}`)),
    ...entries.map(item => `!insertmacro APP_UNASSOCIATE ${quote(item.ext)} ${quote(item.name)}`),
    '!macroend', '!endif', '',
  ].join('\n'))
  writeFileSync(wrapper, [
    include(join(__dirname, 'installer.nsh')),
    '!macro customHeader', include(registryFile), '!macroend', '',
  ].join('\n'))
  return wrapper
}
module.exports = { fileAssociationsFor, createNsisInclude }
