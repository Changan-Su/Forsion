import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const root = dirname(fileURLToPath(import.meta.url))
const require = createRequire(new URL('../desktop/package.json', import.meta.url))
const { build } = require('esbuild')
await build({ entryPoints: [resolve(root, 'main.ts'), resolve(root, 'backendWorker.ts')], outdir: resolve(root, 'dist'), outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', target: 'node20', format: 'esm', tsconfig: resolve(root, '../desktop/tsconfig.json') })
const { version } = JSON.parse(await readFile(resolve(root, '../desktop/package.json'), 'utf8'))
await writeFile(resolve(root, 'dist/package.json'), JSON.stringify({ name: '@forsion/unit', version, type: 'module' }, null, 2) + '\n')
if (process.argv.includes('--package')) {
  for (const [script, output] of [['copy-excalidraw-assets.cjs', 'public/excalidraw'], ['gen-fonts.cjs', 'public/fonts']]) {
    const assets = spawnSync(process.execPath, [resolve(root, '../desktop/build', script), '--out', output], { cwd: resolve(root, '../web'), stdio: 'inherit' })
    if (assets.status !== 0) throw new Error('Unit static asset preparation failed')
  }
  const result = spawnSync(process.execPath, [resolve(root, '../desktop/scripts/build-unit-web.mjs')], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Unit web build failed')
  await rm(resolve(root, 'dist/web'), { recursive: true, force: true })
  await mkdir(resolve(root, 'dist/web'), { recursive: true })
  await cp(resolve(root, '../desktop/unit-web-dist'), resolve(root, 'dist/web'), { recursive: true })
}
if (process.argv.includes('--local-plugins')) await (await import('./build-local-plugins.mjs')).buildLocalPlugins()
console.log('[unit] Built standalone runtime and backend worker (no Electron or runtime npm dependencies).')
