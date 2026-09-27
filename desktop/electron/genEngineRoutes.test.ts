/**
 * gen-engine-routes.mjs 的抽取覆盖(Codex 终审 out1 #5):unitWeb 的 /engine 允许清单只有与引擎真实挂载逐条对齐才有意义。
 * 生成器只认几种字面形态(`app.use('/', mod.<router>)`、`<router>.use(<routes 导入>)`、`router.<verb>('<path>')`);
 * 引擎哪天换一种合法的 Express 挂载写法,旧生成器会**静默漏抽** —— 表里没有 = 运行时远端 403(设备页静默少功能),
 * 而「新增路由必红」的 --check 仍然全绿。这里在临时目录里造一个最小引擎源码树,逐个塞进新挂载形态:
 * 生成器必须大声失败,而不是少抽几条照样出表。
 * 跑法:npx vitest run electron/genEngineRoutes.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type Route = { method: string; path: string; src: string }
type Gen = { extractEngineRoutes: (engineSrc?: string) => Route[] }
const loadGen = async (): Promise<Gen> =>
  (await import(/* @vite-ignore */ pathToFileURL(resolve(__dirname, '../scripts/gen-engine-routes.mjs')).href)) as Gen

const BASE_MAIN = `import express from 'express';
async function main() {
  const mod = createTanguModule({});
  mountPluginRoutes({ userRouter: mod.userRouter, dataRouter: mod.dataRouter, adminRouter: mod.adminRouter });
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use((req, res, next) => { next(); });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/', mod.userRouter);
  app.use('/', mod.dataRouter);
  const server = app.listen(0, '127.0.0.1', () => {});
}
`
const BASE_INDEX = `import { Router } from 'express';
import runsRouter from './routes/runs.js';
import sessionsRouter from './routes/sessions.js';
export function createTanguModule(d) {
  const userRouter = Router();
  userRouter.use(runsRouter);
  const dataRouter = Router();
  dataRouter.use(sessionsRouter);
  const adminRouter = Router();
  return { userRouter, dataRouter, adminRouter };
}
`
const BASE_ROUTES: Record<string, string> = {
  'runs.ts': `import { Router } from 'express';\nconst router = Router();\nrouter.post('/agent/runs', h);\nrouter.get('/agent/runs/:id/events', h);\nexport default router;\n`,
  'sessions.ts': `import { Router } from 'express';\nconst router = Router();\nrouter.get('/agent/sessions', h);\nexport default router;\n`,
}

/** 造一棵最小引擎源码树(与 tangu-agent/src 的 standalone/main.ts / index.ts / routes/*.ts 同形)。 */
function fixture(patch: { main?: (s: string) => string; index?: (s: string) => string; routes?: Record<string, string> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gen-routes-'))
  mkdirSync(join(dir, 'standalone'))
  mkdirSync(join(dir, 'routes'))
  writeFileSync(join(dir, 'standalone', 'main.ts'), (patch.main ?? ((s) => s))(BASE_MAIN))
  writeFileSync(join(dir, 'index.ts'), (patch.index ?? ((s) => s))(BASE_INDEX))
  for (const [f, body] of Object.entries({ ...BASE_ROUTES, ...(patch.routes ?? {}) })) writeFileSync(join(dir, 'routes', f), body)
  return dir
}

describe('gen-engine-routes:认不出的挂载形态大声失败,不静默漏抽', () => {
  it('基线:最小源码树按今天的形态全部抽到(非空性 —— 下面的红不是因为夹具本身坏了)', async () => {
    const gen = await loadGen()
    const got = gen.extractEngineRoutes(fixture()).map((r) => `${r.method} ${r.path}`).sort()
    expect(got).toEqual(['GET /agent/runs/:id/events', 'GET /agent/sessions', 'GET /health', 'POST /agent/runs'])
  })

  const cases: Array<[string, Parameters<typeof fixture>[0]]> = [
    ['main.ts 无路径前缀挂 module router:app.use(mod.extraRouter)', { main: (s) => s.replace("app.use('/', mod.dataRouter);", "app.use('/', mod.dataRouter);\n  app.use(mod.extraRouter);") }],
    ['main.ts 直接挂一个路由文件:app.use(\'/\', inboxRouter)', { main: (s) => s.replace("app.use('/', mod.dataRouter);", "app.use('/', mod.dataRouter);\n  app.use('/', inboxRouter);") }],
    ['main.ts 应用级 app.all(...)', { main: (s) => s.replace("app.get('/health'", "app.all('/debug', h);\n  app.get('/health'") }],
    ['main.ts 应用级 app.route(...)', { main: (s) => s.replace("app.get('/health'", "app.route('/x').get(h);\n  app.get('/health'") }],
    ['main.ts 把 app 交给别的函数挂路由:mountExtras(app)', { main: (s) => s.replace("app.get('/health'", "mountExtras(app);\n  app.get('/health'") }],
    ['main.ts 应用级路由的路径不是字面量:app.get(HEALTH_PATH, …)', { main: (s) => s.replace("app.get('/health'", "app.get(HEALTH_PATH") }],
    ['main.ts 挂 express.static(文件伺服面)', { main: (s) => s.replace("app.use((req, res, next)", "app.use(express.static(dir));\n  app.use((req, res, next)") }],
    ['index.ts 带路径前缀组合:dataRouter.use(\'/p\', sessionsRouter)', { index: (s) => s.replace('dataRouter.use(sessionsRouter);', "dataRouter.use('/p', sessionsRouter);") }],
    ['index.ts 组合一个现造的 router:dataRouter.use(makeRouter())', { index: (s) => s.replace('dataRouter.use(sessionsRouter);', 'dataRouter.use(sessionsRouter);\n  dataRouter.use(makeRouter());') }],
    ['index.ts 直接在 module router 上写路由:dataRouter.get(...)', { index: (s) => s.replace('dataRouter.use(sessionsRouter);', "dataRouter.use(sessionsRouter);\n  dataRouter.get('/agent/extra', h);") }],
    ['路由文件里另一个 Router 实例:const api = Router(); api.get(...)', { routes: { 'sessions.ts': `import { Router } from 'express';\nconst router = Router();\nconst api = Router();\nrouter.get('/agent/sessions', h);\napi.get('/agent/secret', h);\nrouter.use(api);\nexport default router;\n` } }],
    ['路由文件里另一个 Router 实例(express.Router() 形态,未 use)', { routes: { 'runs.ts': `import express from 'express';\nconst router = express.Router();\nexport const extra = express.Router();\nrouter.post('/agent/runs', h);\nrouter.get('/agent/runs/:id/events', h);\nextra.get('/agent/x', h);\nexport default router;\n` } }],
  ]
  for (const [name, patch] of cases) {
    it(`认不出 → 抛错:${name}`, async () => {
      const gen = await loadGen()
      expect(() => gen.extractEngineRoutes(fixture(patch))).toThrow(/gen-engine-routes/)
    })
  }

  it('注释里的挂载形态不算(剥注释后判)', async () => {
    const gen = await loadGen()
    const dir = fixture({ main: (s) => s.replace("app.get('/health'", "// app.use(mod.extraRouter);  /* app.all('/x') */\n  app.get('/health'") })
    expect(gen.extractEngineRoutes(dir).length).toBe(4)
  })
})
