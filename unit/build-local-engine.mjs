/** Build the optional Tangu plugin's existing standalone runtime and locked
 * production dependencies. Source dependency directories are read-only inputs. */
import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { checkBundleInputs } from './releasePolicy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'desktop/package.json'))
const { build } = require('esbuild')
const exists = (file) => stat(file).then(() => true, () => false)
const within = (base, file) => { const rel = relative(base, file); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)) }

export async function copyLockedProductionDependencies(source, target, lock) {
  if (!lock.packages || lock.lockfileVersion < 2) throw new Error('A package-lock v2/v3 is required')
  let count = 0
  for (const [location, metadata] of Object.entries(lock.packages)) {
    if (!location || metadata.dev) continue
    if (!location.startsWith('node_modules/') || location.split('/').some((part) => part === '..' || part === '.')) throw new Error(`Invalid dependency path: ${location}`)
    const src = join(source, location)
    if (!await exists(src)) {
      if (metadata.optional) continue
      throw new Error(`Missing production dependency: ${src}`)
    }
    const canonical = await realpath(src)
    const installed = JSON.parse(await readFile(join(canonical, 'package.json'), 'utf8'))
    if (installed.version !== metadata.version) throw new Error(`Dependency ${location} differs from lockfile (${installed.version} != ${metadata.version})`)
    await cp(canonical, join(target, location), { recursive: true, dereference: true, filter: async (file) => {
      const name = file.split(sep).at(-1)
      if (file !== canonical && (name === 'node_modules' || name === '.git' || name === '.npmrc' || name === '.DS_Store' || name.startsWith('.env'))) return false
      if (!within(canonical, await realpath(file))) throw new Error(`Dependency symlink escapes package: ${file}`)
      return true
    } })
    count++
  }
  return count
}

export async function buildLocalEngine({ output, dependencyRoot, sqlitePackage = process.env.UNIT_SQLITE_PACKAGE } = {}) {
  if (!output) throw new Error('An explicit engine output directory is required')
  const target = resolve(output)
  const source = join(root, 'tangu-agent')
  if (within(target, root) || within(source, target) || within(join(root, 'desktop/node_modules'), target)) throw new Error('Engine output must not replace source or dependencies')
  // Worktrees may share desktop dependencies without a tangu-agent symlink.
  const dependencies = dependencyRoot || (await exists(join(source, 'node_modules')) ? source : resolve(await realpath(join(root, 'desktop/node_modules')), '../../tangu-agent'))
  const lock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'))
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  await mkdir(target, { recursive: true })
  const result = await build({ entryPoints: [join(source, 'src/standalone/main.ts')], outfile: join(target, 'dist/standalone/main.mjs'), bundle: true,
    absWorkingDir: root, metafile: true,
    packages: 'external', platform: 'node', target: 'node20', format: 'esm', tsconfig: join(source, 'tsconfig.json') })
  checkBundleInputs(Object.keys(result.metafile.inputs), root)
  await writeFile(join(target, 'package.json'), JSON.stringify({ name: '@forsion/unit-tangu-runtime', version: pkg.version, private: true, type: 'module', dependencies: pkg.dependencies }, null, 2) + '\n')
  await writeFile(join(target, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
  for (const asset of ['skills', 'agent-skills']) {
    await rm(join(target, asset), { recursive: true, force: true })
    if (await exists(join(source, asset))) await cp(join(source, asset), join(target, asset), { recursive: true, dereference: true })
  }
  // Built-in engine plugins are an optional part of standalone distribution.
  // Unit-installed bundles are passed explicitly to the child by the host.
  const count = await copyLockedProductionDependencies(dependencies, target, lock)
  if (sqlitePackage) {
    const native = await realpath(sqlitePackage)
    const version = JSON.parse(await readFile(join(native, 'package.json'), 'utf8')).version
    if (version !== lock.packages['node_modules/better-sqlite3']?.version) throw new Error('SQLite override differs from the locked package version')
    await rm(join(target, 'node_modules/better-sqlite3'), { recursive: true, force: true })
    await cp(native, join(target, 'node_modules/better-sqlite3'), { recursive: true, dereference: true, filter: async (file) => {
      if (!within(native, await realpath(file))) throw new Error(`SQLite package symlink escapes its directory: ${file}`)
      return !['node_modules', '.git', '.npmrc'].includes(file.split(sep).at(-1))
    } })
  }
  // Never stamp the builder's Node ABI onto a package containing a different
  // native binary. Detect it here, before installation or host startup.
  const smoke = spawnSync(process.execPath, ['--input-type=module', '-e', "import {createRequire} from 'node:module';const require=createRequire(new URL('./package.json',import.meta.url));const DB=require('better-sqlite3');const db=new DB(':memory:');db.close()"], { cwd: target, encoding: 'utf8' })
  if (smoke.status !== 0) throw new Error(`Packaged Tangu SQLite does not match the current Node runtime: ${smoke.stderr || smoke.error}`)
  console.log(`[unit:tangu] ${target} (${count} locked production dependencies)`)
  return { entryFile: join(target, 'dist/standalone/main.mjs'), dependencies: {
    mode: 'bundled', platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
    ...(process.platform === 'linux' ? { libc: process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl' } : {}),
  } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildLocalEngine({ output: process.argv[2], dependencyRoot: process.argv[3], sqlitePackage: process.argv[4] })
}
