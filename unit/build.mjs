import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { cp, mkdir, writeFile, rm, rename } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { readReleaseBaseline } from './check-sync.mjs'
import { checkBundleInputs, validateDistribution } from './releasePolicy.mjs'
const root = dirname(fileURLToPath(import.meta.url))
const repository = resolve(root, '..')
const require = createRequire(new URL('../desktop/package.json', import.meta.url))
const { build } = require('esbuild')
const baseline = await readReleaseBaseline()
const output = resolve(root, 'dist')
const stage = resolve(root, `.dist.building-${process.pid}`)
const previous = resolve(root, `.dist.previous-${process.pid}`)
await mkdir(stage, { recursive: true })
try {
  const result = await build({ entryPoints: [resolve(root, 'main.ts'), resolve(root, 'backendWorker.ts')], outdir: stage, outExtension: { '.js': '.mjs' },
    absWorkingDir: repository, metafile: true, bundle: true, platform: 'node', target: 'node20', format: 'esm', tsconfig: resolve(root, '../desktop/tsconfig.json') })
  checkBundleInputs(Object.keys(result.metafile.inputs), repository)
  await writeFile(resolve(stage, 'package.json'), JSON.stringify({ name: '@forsion/unit', version: baseline.desktopVersion, type: 'module' }, null, 2) + '\n')
  await writeFile(resolve(stage, 'release.json'), JSON.stringify({ ...baseline, builtAt: new Date().toISOString(), commercialServerIncluded: false }, null, 2) + '\n')
  await cp(resolve(root, 'README.md'), resolve(stage, 'README.md'))
  if (process.argv.includes('--package')) {
    for (const [script, assetOutput] of [['copy-excalidraw-assets.cjs', 'public/excalidraw'], ['gen-fonts.cjs', 'public/fonts']]) {
      const assets = spawnSync(process.execPath, [resolve(root, '../desktop/build', script), '--out', assetOutput], { cwd: resolve(root, '../web'), stdio: 'inherit' })
      if (assets.status !== 0) throw new Error('Unit static asset preparation failed')
    }
    const result = spawnSync(process.execPath, [resolve(root, '../desktop/scripts/build-unit-web.mjs')], {
      stdio: 'inherit', env: { ...process.env, FORSION_UNIT_RELEASE: '1' },
    })
    if (result.status !== 0) throw new Error('Unit web build failed')
    await cp(resolve(root, '../desktop/unit-web-dist'), resolve(stage, 'web'), { recursive: true })
  }
  if (process.argv.includes('--local-plugins')) await (await import('./build-local-plugins.mjs')).buildLocalPlugins(resolve(stage, 'plugins'))
  await validateDistribution(stage)
  // Fresh staging prevents stale commercial or optional packages from leaking
  // into a later base-only build. Keep the last working release on build failure.
  let hadPrevious = false
  try { await rename(output, previous); hadPrevious = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  try { await rename(stage, output) }
  catch (error) { if (hadPrevious) await rename(previous, output); throw error }
  if (hadPrevious) await rm(previous, { recursive: true, force: true, maxRetries: 3 })
  console.log(`[unit] Built independent Unit from Desktop ${baseline.desktopTag} (revision ${baseline.unitRevision}); no commercial Server package.`)
} finally { await rm(stage, { recursive: true, force: true, maxRetries: 3 }) }
