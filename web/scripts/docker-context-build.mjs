/** 镜像构建上下文体检:按 web/Dockerfile 的 COPY 清单把源码搬进临时目录(node_modules 放公共祖先,同容器),
 *  在那里真跑 `npm run build`。check-unit / 本地 typecheck 都看不见「源码 import 了没被 COPY 的文件」这一类红
 *  (2026-09-15 两例:vite.config 顶层 import ../unit/releasePolicy.mjs;desktop/shared/product.ts import ../products/forsion.json),
 *  本机又常没有 docker daemon,所以用它兜底。用法:cd web && npm run check:dockerctx(先 npm ci,字体包要在)。 */
import { cpSync, globSync, mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
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
  symlinkSync(join(web, 'node_modules'), join(stage, 'node_modules')) // 容器里 npm ci 装在 /app
  const r = spawnSync('npm', ['run', 'build'], { cwd: join(stage, 'web'), stdio: 'inherit', env: { ...process.env, CI: '1' } })
  if (r.status !== 0 || !existsSync(join(stage, 'web/dist/index.html'))) throw new Error('镜像上下文里 vite build 失败(见上方输出)')
  console.log(`[docker-context] OK:${copies.length} 条 COPY 的源码集合能独立完成 web 构建`)
} finally { rmSync(stage, { recursive: true, force: true }) }
