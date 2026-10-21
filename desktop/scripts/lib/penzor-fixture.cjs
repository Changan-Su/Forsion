/** Isolated acceptance signing: a temporary build copy trusts a one-use test key.
 * Never reads production signing credentials or edits source/build output in place. */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { generateKeyPairSync } = require('node:crypto')
const { pathToFileURL } = require('node:url')
exports.preparePenzorFixture = async (desktop, extend) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'penzor-signed-fixture-'))
  const app = path.join(root, 'desktop'), pkg = path.join(root, 'extend')
  fs.mkdirSync(app); fs.mkdirSync(pkg)
  const meta = JSON.parse(fs.readFileSync(path.join(extend, 'package.json'), 'utf8'))
  const files = ['package.json', ...meta.files.filter(f => f !== 'SIGNATURE')]
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(pkg, file)), { recursive: true })
    fs.cpSync(path.join(extend, file), path.join(pkg, file), { recursive: true })
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ format: 'pem', type: 'spki' })
  const { signFiles, verifySignatureFile } = await import(pathToFileURL(path.join(extend, 'scripts/signature.mjs')))
  fs.writeFileSync(path.join(pkg, 'SIGNATURE'), JSON.stringify(await signFiles(pkg, files, privateKey)))
  if (!(await verifySignatureFile(pkg, pem, ['manifest.json','dist/desktop.mjs'])).ok) throw Error('Fixture signature failed')
  fs.copyFileSync(path.join(desktop, 'package.json'), path.join(app, 'package.json'))
  fs.cpSync(path.join(desktop, 'out'), path.join(app, 'out'), { recursive: true })
  const bundle = JSON.parse(fs.readFileSync(path.join(desktop, 'electron/builtinBundles.json'), 'utf8')).find(b => b.id === 'forsion-extend')
  const main = path.join(app, 'out/main/main.js')
  const src = fs.readFileSync(main, 'utf8'), from = JSON.stringify(bundle.desktop.signingKey), to = JSON.stringify(pem)
  if (!src.includes(from)) throw Error('Pinned key absent in copied build; rebuild first')
  fs.writeFileSync(main, src.replaceAll(from, to))
  const modules = path.join(app, 'node_modules')
  fs.mkdirSync(modules)
  for (const name of fs.readdirSync(path.join(desktop, 'node_modules'))) {
    if (name === '@forsion') continue
    fs.symlinkSync(path.resolve(desktop, 'node_modules', name), path.join(modules, name))
  }
  fs.mkdirSync(path.join(modules, '@forsion'))
  for (const name of fs.readdirSync(path.join(desktop, 'node_modules/@forsion'))) {
    fs.symlinkSync(name === 'extend' ? pkg : path.resolve(desktop, 'node_modules/@forsion', name), path.join(modules, '@forsion', name))
  }
  return { app, extend: pkg, root }
}
