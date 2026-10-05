/** 镜像构建上下文体检:按 web/Dockerfile 的 COPY 清单把源码搬进临时目录(node_modules 放公共祖先,同容器),
 *  在那里真跑 `npm run build`。check-unit / 本地 typecheck 都看不见「源码 import 了没被 COPY 的文件」这一类红
 *  (2026-09-15 两例:vite.config 顶层 import ../unit/releasePolicy.mjs;desktop/shared/product.ts import ../products/forsion.json),
 *  本机又常没有 docker daemon,所以用它兜底。用法:cd web && npm run check:dockerctx(先 npm ci,字体包要在)。
 *
 *  `--unit-web`(cd desktop && npm run check:unitweb):同一份源码集合换一种布局,真跑 desktop/scripts/build-unit-web.mjs ——
 *  依赖只在 web/node_modules,仓根 node_modules 是个**只装着 vite 缓存的真实目录**,mobile / desktop 都没装依赖。
 *  2026-10-05 本机主检出就是这个样子:脚本见「目录存在」便不补软链,3 秒红在 `failed to resolve import "zustand"`;
 *  CI 的干净 checkout 没有那个目录,所以一直看不见。现由 vite.config.ts 的 resolveBareFromWebRoot 兜住。 */
import { cpSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const genesis = resolve(web, '..')
const copies = readFileSync(join(web, 'Dockerfile'), 'utf8').split('\n')
  .map((line) => line.trim()).filter((line) => /^COPY\s/.test(line) && !line.includes('--from='))
  .map((line) => line.replace(/\s+#.*$/, '').split(/\s+/).slice(1))
const stage = mkdtempSync(join(tmpdir(), 'web-docker-ctx-'))
try {
  for (const args of copies) {
    const dest = args.pop()
    // `package-lock.json*` 这类通配按 Docker 语义展开(没匹配 = 可选文件,跳过);普通路径缺失 = Dockerfile 本身就会红。
    for (const src of args.flatMap((a) => a.includes('*') ? globSync(a, { cwd: genesis }) : [a])) {
      if (!existsSync(join(genesis, src))) throw new Error(`Dockerfile COPY 源不存在:${src}`)
      const target = dest.endsWith('/') ? join(stage, dest, src.split('/').pop()) : join(stage, dest)
      cpSync(join(genesis, src), target, { recursive: true, filter: (p) => !/(^|\/)(node_modules|dist)(\/|$)/.test(p) })
    }
  }
  if (process.argv.includes('--unit-web')) {
    mkdirSync(join(stage, 'node_modules/.vite'), { recursive: true })
    symlinkSync(join(web, 'node_modules'), join(stage, 'web/node_modules'))
    const script = 'desktop/scripts/build-unit-web.mjs'
    cpSync(join(genesis, script), join(stage, script))
    const r = spawnSync(process.execPath, [join(stage, script)], { stdio: 'inherit', env: { ...process.env, CI: '1' } })
    if (r.status !== 0 || !existsSync(join(stage, 'desktop/unit-web-dist/index.html'))) throw new Error('仓根只有缓存目录时 build-unit-web 失败(见上方输出)')
    const left = readdirSync(join(stage, 'node_modules'))
    if (left.join() !== '.vite') throw new Error(`构建动了仓根 node_modules:${left.join(', ')}`)
    console.log('[unit-web] OK:仓根 node_modules 只有缓存时设备页照样构建,且该目录原样未动')
  } else {
    symlinkSync(join(web, 'node_modules'), join(stage, 'node_modules')) // 容器里 npm ci 装在 /app
    const r = spawnSync('npm', ['run', 'build'], { cwd: join(stage, 'web'), stdio: 'inherit', env: { ...process.env, CI: '1' } })
    if (r.status !== 0 || !existsSync(join(stage, 'web/dist/index.html'))) throw new Error('镜像上下文里 vite build 失败(见上方输出)')
    console.log(`[docker-context] OK:${copies.length} 条 COPY 的源码集合能独立完成 web 构建`)
  }
} finally { rmSync(stage, { recursive: true, force: true }) }
