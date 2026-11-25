/**
 * 多账号模式(multi-account mode)的 standalone 装配:一台机器上多个账号共用一个引擎进程,互相读不到对方的东西。
 * 开关是真实环境变量 `TANGU_MULTI_ACCOUNT=1`(core/accountScope.ts);standalone/main.ts 的多账号分支和测试都走这里,
 * 测的就是真路径。
 *
 * 做法一律缺省拒绝:
 * - 来的是谁:除 GET /health 外每个请求都要带宿主口令(Authorization: Bearer <TANGU_LOCAL_TOKEN>)和 X-Forsion-User
 *   (宿主验完登录后填的账号 id)。口令不对 / 缺头 → 401;账号 id 不合格 → 400。通过后整个请求跑在 runWithAccount 里。
 * - 接口:method + path 白名单(ROUTE_ALLOWLIST),白名单外一律 403。名单按 Express 注册的路由模式匹配(从各路由器的栈里
 *   把这几条摘出来另装一个路由器),不按请求 URL 猜;新加的路由不进名单就自动关着。带 run id 的几条先在当前账号的库里查这条 run,
 *   查不到一律 404。不新建东西的接口:别人的 id 和不存在的 id 回一模一样的状态码和响应体(会话 / run 只在自己的库里查,
 *   中间件对两者走同一条路)。会新建的只有 POST /agent/runs(会话不存在就建):客户端给的会话 id 必须是 UUID(猜不到别人的),
 *   已被别的账号占用 → 404(会话 id 是全局命名空间,登记在 multiAccountSqliteHost 的 session-owners.db)。
 * - 工具:tools/multiAccountTools.ts 的白名单。
 * - 库与路径:每个账号一个 home(<engineRoot>/accounts/<id>)、一个 state.db(adapters/standalone/multiAccountSqliteHost.ts)。
 * - 关掉的功能:Muse、定时 / 自动化、收件箱、通道、MCP、外部引擎、浏览器工具、钩子、云同步、账号工具、发布、商店、git、遥测、
 *   回收站清理、profile 轮询、run 事件保留期、启动恢复、实时语音、宿主命令(core/hostSpawn.ts)。
 * - 模型调用:没有进程凭据。宿主随访客的请求带来这个账号的模型票(X-Forsion-Model-Ticket),每个账号存最新一张,发往 server 的模型请求
 *   一律用当前账号的票(standalone/modelTickets.ts);没有账号上下文 / 没票 / 票过期 → 401 报错,不回落。出站脱敏层包在这里面(注入的 brain 也包)。
 */
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import { existsSync, mkdirSync } from 'node:fs';
import { createTanguModule } from '../index.js';
import { createNoopBilling } from '../adapters/standalone/noopBilling.js';
import { createTanguProfile } from '../profiles/index.js';
import type { AppProfile } from '../seams/appProfile.js';
import type { AssetsBrain, CloudBrainServices, StorageBrain } from '../seams/cloudBrain.js';
import { accountHome, accountWorkspaceDir, currentAccountId, isMultiAccount, runWithAccount, setSessionClaimer } from '../core/accountScope.js';
import { assertAccountStorage, lastTotalUsage, markAccountUsageDirty, newAccountsAllowed, StorageLimitError } from '../services/accountStorage.js';
import { checkAccountIdentity, createMultiAccountSqliteHost, type MultiAccountHost } from '../adapters/standalone/multiAccountSqliteHost.js';
import { createLocalAssets } from '../adapters/standalone/localAssetsBrain.js';
import { createLocalMemoryBrain } from '../adapters/standalone/localMemoryBrain.js';
import { withOutboundMasking } from '../llm/outboundMask.js';
import { runMigration } from '../db/migrate.js';
import { seedBuiltinSkills } from '../skills/localSkills.js';
import { seedExampleCommand } from '../services/customCommands.js';
import { assertBundleDirsOutsideAccounts, bundleDirs, seedBundleAgents, setMultiAccountBundleDirs } from '../plugins/bundles.js';
import { accountCwdDenied, setAccountReadOnlyRoots } from '../services/accessDomain.js';
import { getRunForUser } from '../services/runStore.js';
import { deps } from '../seams/runtime.js';
import { MULTI_ACCOUNT_TOOL_ALLOWLIST } from '../tools/multiAccountTools.js';
import { createProfileStore } from '../profiles/profileStore.js';
import { remoteLockGuard } from './remoteLockGuard.js';
import { accountHasRuns, drainRunsForExit, recoverAccountRuns } from '../services/agentLoop.js';
import { clearAccountScratch } from '../services/pluginScripts.js';
import { minutesMs, multiAccountLimits } from '../core/multiAccountLimits.js';
import type { StandaloneConfig } from './config.js';
import { LlmError } from '../core/types.js';
import { NO_ACCOUNT_FOR_MODEL_CALL, takeModelTicket } from './modelTickets.js';

export interface MultiAccountAppOptions {
  localToken: string;            // 宿主口令
  brain: CloudBrainServices;     // 测试注入假模型;main.ts 传 buildMultiAccountBaseBrain 出来的那份(脱敏层在这里包)
  defaultModelId?: string;
  bundleDirs?: string[];         // 只读插件包目录;缺省读 TANGU_BUNDLE_DIRS
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** 碰 id 之前的核对。run / session = 这个账号的库里查得到这条 run / 会话(查不到 404,别人的和不存在的一样;先于工作目录钳制,
 *  与 handler 自己「先查会话、再看请求体」的次序一致)。
 *  newSession = 会新建会话的接口里客户端给的会话 id:必须是 UUID(400);当场替当前账号认领,已被别的账号认领过 → 404(认领表见 multiAccountSqliteHost)。 */
type Own = { kind: 'run'; param: string } | { kind: 'session'; param: string } | { kind: 'newSession'; body: string }
  /** sessionRef = 只读 / 删除接口里客户端给的会话 id(查询串或请求体):必须是 UUID(400);不认领。属于别的账号 → 标 req.foreignSession,
   *  handler 按「空的、没人用过的会话」回(与不存在的 id 一模一样)。 */
  | { kind: 'sessionRef'; query?: string; body?: string };
/** 客户端给的新会话 id 的格式:UUID(8-4-4-4-12 十六进制,大小写不限)。引擎内部建的会话一律 randomUUID,不受影响。 */
const SESSION_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 客户端给的工作目录:必须在账号文件夹里。where = 'body'(建会话 / 改会话:project_path + agent_config.cwd / extraRoots)、
 *  'config'(会话配置:体本身就是 agent_config)、'run'(起 run:agent_config.cwd / extraRoots)。 */
type Clamp = 'session' | 'config' | 'run';
/** quota = 这条会往账号文件夹里写东西:账号磁盘已满(services/accountStorage.ts)时回 507,读和删不受影响。 */
interface RouteRule { method: Method; path: string; own?: Own[]; clamp?: Clamp; quota?: true; why: string }

/**
 * 接口白名单(第一段):对话(runs / SSE / 会话 / 审批)、Agent、记忆、技能。每条都读过 handler:
 * 只经按人分流的库(deps().host / deps().state → 当前账号的 state.db)、按人分流的路径(tanguHome() 派生)或已按人分的缓存拿数据。
 * 工作区文件路由(/agent/workspace/*)第一版不放:它落在会话沙箱目录 + 云端存储(进程那一份凭据)上,不是账号文件夹。
 */
const ROUTE_ALLOWLIST: ReadonlyArray<RouteRule> = [
  // ── 对话:run ──
  { quota: true, method: 'POST', path: '/agent/runs', own: [{ kind: 'newSession', body: 'session_id' }], clamp: 'run', why: 'client session id must be a UUID; an id claimed by another account is 404 (session claim registry); the session is looked up / auto-created in this account DB; run row in this account DB; cwd clamped here and in runLoop' },
  { method: 'GET', path: '/agent/runs', why: 'lists runs from this account DB only (another account session id = no runs, same as an unknown id)' },
  { method: 'GET', path: '/agent/runs/:id/events', own: [{ kind: 'run', param: 'id' }], why: 'run looked up in this account DB first; replay from this account DB; live bus keyed by a run id that only exists here' },
  { method: 'POST', path: '/agent/runs/:id/abort', own: [{ kind: 'run', param: 'id' }], why: 'run looked up in this account DB first; abortRun also refuses another account run' },
  { method: 'POST', path: '/agent/runs/:id/steer', own: [{ kind: 'run', param: 'id' }], why: 'run looked up in this account DB first; enqueueSteer also refuses another account run' },
  { method: 'DELETE', path: '/agent/runs/:id/steer/:messageId', own: [{ kind: 'run', param: 'id' }], why: 'run looked up in this account DB first; cancelSteer also refuses another account run' },
  { method: 'POST', path: '/agent/runs/:id/compaction/skip', own: [{ kind: 'run', param: 'id' }], why: 'run looked up in this account DB first; operation id bound to that run' },
  // ── 对话:审批 / 询问(ask_user)──
  { method: 'POST', path: '/agent/runs/:runId/approvals/:approvalId', own: [{ kind: 'run', param: 'runId' }], why: 'run looked up in this account DB first; the approval registry checks the approval belongs to that run' },
  { method: 'POST', path: '/agent/runs/:runId/inquiries/:inquiryId', own: [{ kind: 'run', param: 'runId' }], why: 'run looked up in this account DB first; inquiry / ui / client-action registries check the id belongs to that run' },
  // ── 对话:会话 ──
  { method: 'GET', path: '/agent/sessions', why: 'SELECT from this account DB; busy flag from activeSessionIds() filtered by account' },
  { quota: true, method: 'POST', path: '/agent/sessions', clamp: 'session', why: 'server-generated UUID claimed for this account; row in this account DB; project_path / agent_config.cwd clamped' },
  { method: 'GET', path: '/agent/sessions/:id/detail', own: [{ kind: 'session', param: 'id' }], why: 'getOwnSession on this account DB (session looked up in this account DB before anything else: another account id = unknown id = 404)' },
  { method: 'PATCH', path: '/agent/sessions/:id', own: [{ kind: 'session', param: 'id' }], clamp: 'session', why: 'getOwnSession on this account DB (session looked up in this account DB before anything else: another account id = unknown id = 404); project_path clamped' },
  { method: 'DELETE', path: '/agent/sessions/:id', own: [{ kind: 'session', param: 'id' }], why: 'getOwnSession on this account DB (session looked up in this account DB before anything else: another account id = unknown id = 404); cascade delete in this account DB + checkpoints under this account home' },
  { method: 'GET', path: '/agent/sessions/:id/messages', own: [{ kind: 'session', param: 'id' }], why: 'session looked up in this account DB first (another account id = unknown id = 404); messages from this account DB' },
  { method: 'GET', path: '/agent/sessions/:id/config', own: [{ kind: 'session', param: 'id' }], why: 'getOwnSession on this account DB (session looked up in this account DB before anything else: another account id = unknown id = 404)' },
  { quota: true, method: 'PUT', path: '/agent/sessions/:id/config', own: [{ kind: 'session', param: 'id' }], clamp: 'config', why: 'getOwnSession on this account DB (session looked up in this account DB before anything else: another account id = unknown id = 404); cwd / extraRoots clamped' },
  { quota: true, method: 'PATCH', path: '/agent/sessions/:id/config', own: [{ kind: 'session', param: 'id' }], clamp: 'config', why: 'getOwnSession on this account DB (session looked up in this account DB before anything else: another account id = unknown id = 404); cwd / extraRoots clamped' },
  { method: 'GET', path: '/agent/sessions/:id/card-marks', own: [{ kind: 'session', param: 'id' }], why: 'getOwnSession on this account DB (session looked up in this account DB before anything else: another account id = unknown id = 404); card_marks column of that row' },
  { quota: true, method: 'POST', path: '/agent/sessions/:id/card-marks', own: [{ kind: 'session', param: 'id' }], why: 'getOwnSession on this account DB (session looked up in this account DB before anything else: another account id = unknown id = 404); per-key add-only merge into card_marks of that row' },
  // ── Agent ──
  { method: 'GET', path: '/agent/agents', why: 'listAgents() over this account agents/ (roster cache per account); cloud sync scope absent (no agentFiles brain)' },
  { quota: true, method: 'POST', path: '/agent/agents', why: 'saveAgent under this account agents/; cloud sync refused without an agentFiles brain' },
  { quota: true, method: 'PATCH', path: '/agent/agents/:slug', why: 'patchAgent under this account agents/' },
  { method: 'GET', path: '/agent/agents/:slug/memory', why: 'memory repository under this account agents/<slug>; cloud sync is a no-op without an agentFiles brain' },
  { quota: true, method: 'PUT', path: '/agent/agents/:slug/memory', why: 'memory repository under this account agents/<slug>' },
  // ── 记忆 / 日志(当前 Agent 的,本地记忆 brain 按路径走)──
  { method: 'GET', path: '/agent/memory', why: 'local memory brain under this account agents/<slug>' },
  { quota: true, method: 'POST', path: '/agent/memory', why: 'local memory brain under this account agents/<slug>' },
  { method: 'GET', path: '/agent/log', why: 'local memory brain under this account agents/<slug>/LOG' },
  { quota: true, method: 'POST', path: '/agent/log', why: 'local memory brain under this account agents/<slug>/LOG' },
  // ── 技能 ──
  { method: 'GET', path: '/agent/skills', why: 'local skills from this account skills/ + packaged / bundle skills (read-only); cloud skills off' },
  // ── 会话的工作区文件 / 上传(routes/workspace.ts 的多账号分支:<accountHome>/uploads/<sessionId>/,不碰进程级会话沙箱与云端存储)──
  { method: 'GET', path: '/agent/workspace/list', own: [{ kind: 'sessionRef', query: 'sessionId' }], why: 'lists <accountHome>/uploads/<sessionId> via confinedFs; another account session id answers like an unused id (empty)' },
  { method: 'GET', path: '/agent/workspace/read', own: [{ kind: 'sessionRef', query: 'sessionId' }], why: 'reads inside <accountHome>/uploads/<sessionId> via confinedFs; another account session id answers like an unused id (404)' },
  { method: 'GET', path: '/agent/workspace/download', own: [{ kind: 'sessionRef', query: 'sessionId' }], why: 'same as read, as a download' },
  { method: 'POST', path: '/agent/workspace/delete', own: [{ kind: 'sessionRef', body: 'sessionId' }], why: 'unlinks inside <accountHome>/uploads/<sessionId> via confinedFs; another account session id answers like an unused id (ok:false)' },
  { quota: true, method: 'POST', path: '/agent/workspace/upload', own: [{ kind: 'newSession', body: 'sessionId' }], why: 'client session id must be a UUID and is claimed for this account (taken by another account = 404); writes inside <accountHome>/uploads/<sessionId> via confinedFs; storage limit per file' },
  // ── 模型目录:进程那一份(同一份目录给所有人看);多账号模式去掉直连 provider 的 baseUrl,不报覆盖可写 ──
  { method: 'GET', path: '/agent/models', why: 'process model catalogue (the same for every account); direct provider baseUrl stripped in multi-account mode; per-model overrides read from this account config only' },
  // ── 待处理的审批 / 询问计数(services/pendingPromptIndex.ts 按账号分:条目记属主、只列当前账号的、清理只看当前账号的、版本号按账号数)──
  { method: 'GET', path: '/agent/approvals/pending', why: 'per-account view of the pending prompt index (entries tagged with their account; sweep and rev per account)' },
];

// ── brain:只留按人无关或按人本地的能力 ─────────────────────────────────────────────────────────────

const unavailable = (what: string) => (): never => { throw new Error(`multi-account mode: ${what} is not available`); };
const NO_STORAGE: StorageBrain = new Proxy({} as StorageBrain, { get: (_t, k) => unavailable(`cloud storage (${String(k)})`) });
const NO_CLOUD_ASSETS: AssetsBrain = {
  getSkill: async () => null,
  listCustomTools: async () => [],
  listForcedCustomTools: async () => [],
};

/** 模型调用只在账号上下文里发(不管注入的是哪种 brain):没有账号 → 401,不发。main.ts 那份 brain 的凭据本身就是当前账号的票,
 *  这一层再兜住直连 provider 与测试注入的 brain,也让「账号上下文之外的模型调用」在多账号测试里当场红。 */
function accountBound<T extends object>(obj: T, names: ReadonlyArray<string>): T {
  const out: any = { ...obj };
  for (const name of names) {
    const fn = out[name];
    if (typeof fn !== 'function') continue;
    out[name] = (...args: unknown[]) => (currentAccountId() ? fn.apply(obj, args) : Promise.reject(new LlmError(401, NO_ACCOUNT_FOR_MODEL_CALL)));
  }
  return out;
}

/**
 * 注入的 brain 只取 llm(包出站脱敏)和 models(模型目录)。main.ts 注入的那份发往 server 的请求一律带当前账号的模型票
 * (standalone/modelTickets.ts 的 createModelTicketHttpBrain);以后透传的语音识别(asr)走同一个 httpBrain、同一份凭据,
 * 在下面照 llm / models 加一行,并放进 accountBound。云端 per-user 的其它能力(云存储、云记忆、Agent 云文件、收件箱、
 * 云笔记、账号面、git 凭据、生图 / 实时、决策模型、商店)一律不给。
 * 用户资料不出网:getUserById 只回账号 id。记忆 / 技能换成本地实现(按路径,天然按人)。
 */
function multiAccountBrain(b: CloudBrainServices): CloudBrainServices {
  return {
    llm: accountBound(withOutboundMasking(b.llm), ['resolveModelAndKey', 'buildProviderPayload', 'streamProviderCompletion', 'refreshModelKey', 'fimCompletion']),
    models: accountBound(b.models, ['listGlobalModels', 'listModelsForProject', 'providerQuota']),
    users: { getUserById: async (id: string) => ({ id, username: id }) },
    memory: createLocalMemoryBrain(),
    assets: createLocalAssets(NO_CLOUD_ASSETS, false),
    search: { runSearch: unavailable('web search') },
    storage: NO_STORAGE,
  };
}

function multiAccountProfile(defaultModelId?: string): AppProfile {
  const base = createTanguProfile({ sandboxMode: 'none', defaultModelId, toolBuiltins: [...MULTI_ACCOUNT_TOOL_ALLOWLIST] });
  // 群聊不开:协调 run 拿着这个账号的名额等成员 run,成员 run 又排在同一个账号的名额后面(services/runAdmission.ts)→ 等到超时
  return { ...base, capabilities: { ...base.capabilities, groupChat: false }, features: { ...base.features, sandbox: false, webSearch: false, historian: false, customTools: false } };
}

// ── 白名单路由器:按注册的路由模式从各路由器栈里摘 ──────────────────────────────────────────────────

interface CollectedRoute { rule: RouteRule; handlers: RequestHandler[] }

/** 从 Express 4 路由器的栈里把白名单里的 (method, route.path) 摘出来,保持注册顺序。只认挂在根上的子路由器;
 *  非路由的中间件层(router.use(path, …))不带出来 —— 它们服务的路径都不在名单里。名单里有一条没摘到就抛(名单得说实话)。 */
function collectAllowedRoutes(routers: Router[], rules: ReadonlyArray<RouteRule>): CollectedRoute[] {
  const out: CollectedRoute[] = [];
  const seen = new Set<string>();
  const key = (m: string, p: string) => `${m.toUpperCase()} ${p}`;
  const byKey = new Map(rules.map((r) => [key(r.method, r.path), r]));
  const walk = (router: any): void => {
    for (const layer of router?.stack ?? []) {
      const route = layer.route;
      if (route) {
        if (typeof route.path !== 'string') continue;
        for (const method of Object.keys(route.methods || {})) {
          if (method === '_all') continue;
          const rule = byKey.get(key(method, route.path));
          if (!rule || seen.has(key(method, route.path))) continue;
          seen.add(key(method, route.path));
          const handlers = (route.stack || []).filter((l: any) => l.method === method).map((l: any) => l.handle as RequestHandler);
          out.push({ rule, handlers });
        }
      } else if (typeof layer.handle === 'function' && Array.isArray((layer.handle as any).stack) && layer.regexp?.fast_slash) {
        walk(layer.handle);
      }
    }
  };
  for (const r of routers) walk(r);
  const missing = rules.filter((r) => !seen.has(key(r.method, r.path)));
  if (missing.length) throw new Error(`multi-account route allowlist names routes that do not exist: ${missing.map((r) => key(r.method, r.path)).join(', ')}`);
  return out;
}

function ownershipGuard(host: MultiAccountHost, own: Own[] | undefined): RequestHandler {
  return (req, res, next) => {
    if (!own?.length) return next();
    void (async () => {
      const me = (req as any).accountId as string;
      for (const o of own) {
        if (o.kind === 'run') {
          const id = req.params[o.param];
          if (typeof id !== 'string' || !(await getRunForUser(id, me).catch(() => null))) return void res.status(404).json({ detail: 'Run not found' });
        } else if (o.kind === 'session') {
          const id = req.params[o.param];
          if (typeof id !== 'string' || (await deps().state.getSessionOwner(id)) !== me) return void res.status(404).json({ detail: 'Session not found' });
        } else if (o.kind === 'sessionRef') {
          const raw = o.query ? req.query[o.query] : (req.body || {})[o.body!];
          if (raw === undefined || raw === null || raw === '') continue; // 缺 id:交给 handler 照常 400
          if (typeof raw !== 'string' || !SESSION_ID_UUID_RE.test(raw)) return void res.status(400).json({ detail: 'sessionId must be a UUID' });
          const owner = host.sessionOwner(raw);
          if (owner !== undefined && owner !== me) (req as any).foreignSession = true;
        } else {
          const raw = (req.body || {})[o.body];
          if (raw === undefined || raw === null || raw === '') continue; // 缺 id:交给 handler 照常 400
          if (typeof raw !== 'string' || !SESSION_ID_UUID_RE.test(raw)) return void res.status(400).json({ detail: `${o.body} must be a UUID` });
          // 当场认领(原子的 INSERT OR IGNORE):两个账号同时拿同一个新 id 来,后到的在这里就是 404,不会走到建会话那步才撞上(500)。
          // 认领了但这次请求后面没建成会话(比如缺 model_id 的 400)也无妨:这个 id 留给这个账号。
          if (!host.claimSession(raw)) return void res.status(404).json({ detail: 'Session not found' });
        }
      }
      next();
    })().catch((e) => res.status(500).json({ detail: (e as Error)?.message || 'ownership check failed' }));
  };
}

/** 客户端给的工作目录钳在账号文件夹里(runLoop 里还有一道:会话存值 / 派生配置抄来的也拦)。 */
function cwdClamp(clamp: Clamp | undefined): RequestHandler {
  return (req, res, next) => {
    if (!clamp) return next();
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const cfg = clamp === 'config' ? b : (b.agent_config && typeof b.agent_config === 'object' && !Array.isArray(b.agent_config) ? b.agent_config : {});
    const dirs: unknown[] = [];
    if (clamp === 'session') dirs.push(b.project_path);
    dirs.push(cfg.cwd);
    if (Array.isArray(cfg.extraRoots)) dirs.push(...cfg.extraRoots);
    else if (cfg.extraRoots != null) dirs.push(cfg.extraRoots);
    for (const d of dirs) {
      const bad = accountCwdDenied(d);
      if (bad) return void res.status(400).json({ detail: bad });
    }
    next();
  };
}

const NOT_AVAILABLE = { detail: 'Not available in multi-account mode' } as const;

/** 写进账号文件夹的接口先看磁盘上限(读 / 删不看):已用 + 这次请求体大小超了 → 507。 */
function storageGuard(quota: true | undefined): RequestHandler {
  return (req, res, next) => {
    if (!quota) return next();
    const incoming = Number(req.headers['content-length']) || 0;
    assertAccountStorage((req as any).accountId as string, incoming).then(
      () => { markAccountUsageDirty((req as any).accountId as string); next(); },
      (e) => {
        if (e instanceof StorageLimitError) return void res.status(507).json({ code: e.code, detail: e.message });
        res.status(500).json({ detail: 'Storage check failed' });
      },
    );
  };
}

/** 测试与 main.ts 共用的入口。整个进程只装配一次(configureTangu 是进程级的)。 */
export async function createMultiAccountApp(opts: MultiAccountAppOptions): Promise<{
  app: Express;
  dispose: () => Promise<void>;
  routeAllowlist: ReadonlyArray<{ method: string; path: string }>;
  toolAllowlist: ReadonlyArray<string>;
  /** 账号库的打开 / 开户情况与立即淘汰一次(测试 / 诊断)。 */
  accounts: { open(): string[]; provisioned(): string[]; evictIdleNow(idleMs?: number, maxOpen?: number): string[] };
}> {
  if (!isMultiAccount()) throw new Error('createMultiAccountApp requires TANGU_MULTI_ACCOUNT=1 in the real environment');
  if (!opts.localToken) throw new Error('multi-account mode requires a host credential (TANGU_LOCAL_TOKEN)');

  if (opts.bundleDirs) setMultiAccountBundleDirs(opts.bundleDirs);
  assertBundleDirsOutsideAccounts(); // 插件包目录与账号文件夹重叠 → 不装配
  setAccountReadOnlyRoots(() => bundleDirs());

  const mh = createMultiAccountSqliteHost({
    localToken: opts.localToken,
    // 开户:建目录、迁移、播种内置技能 / 示例命令 / 插件包带的人设。在该账号的上下文里跑,同账号并发首请求共用一次。
    provision: async (id) => {
      mkdirSync(accountWorkspaceDir(id), { recursive: true });
      clearAccountScratch(id); // 上次进程留下的插件脚本临时目录(这一轮结束时本该删掉的)
      await runMigration();
      // 上次进程留下的 run(崩溃 / 被强杀 / 退出时还在排队):开户发生在本进程第一次服务这个账号之前,还是 queued / running 的行都是上次的。
      // 标成中断、补回这一轮用户说的话和一条说明行,不重放、不续跑(services/agentLoop.ts 的 recoverAccountRuns)。
      const recovered = await recoverAccountRuns();
      if (recovered) console.log(`[tangu] multi-account: settled ${recovered} run(s) of ${id} left by the previous engine as interrupted`);
      await seedBuiltinSkills().catch((e) => console.warn(`[tangu] multi-account: seeding built-in skills for ${id} failed:`, e?.message || e));
      try { seedExampleCommand(); } catch { /* best-effort */ }
      await seedBundleAgents().catch(() => []);
    },
  });

  setSessionClaimer((sessionId) => mh.claimSession(sessionId)); // enqueueRun 入队前核会话归属(core/accountScope.ts)

  const maProfile = multiAccountProfile(opts.defaultModelId);
  const mod = createTanguModule({
    host: mh.host,
    brain: multiAccountBrain(opts.brain),
    billing: createNoopBilling(),
    profile: maProfile,
    // 这个模式的 profile 就是上面这份:不叠仓里给 tangu 的文件覆盖(那份会把群聊、联网搜索重新打开),也不读覆盖表
    profileStore: createProfileStore({ baseline: maProfile, fileOverrides: {}, fetchOverrideRows: async () => [] }),
    // 不给 MCP 管理器、外部引擎管理器:这两样在多账号模式下不存在
  });
  mod.startBackgroundTasks(); // 多账号分支只起睡眠检测(index.ts)

  const allowed = collectAllowedRoutes([mod.userRouter, mod.dataRouter], ROUTE_ALLOWLIST);
  const allowRouter = express.Router();
  for (const { rule, handlers } of allowed) {
    (allowRouter as any)[rule.method.toLowerCase()](rule.path, ownershipGuard(mh, rule.own), cwdClamp(rule.clamp), storageGuard(rule.quota), ...handlers);
  }

  // 账号库淘汰:手上没事(没有在途请求 / SSE、没有 run)且闲了一阵的账号关掉库句柄,下次用时原地重开(开户与恢复不重跑)。
  const inflight = new Map<string, number>();
  const busy = (id: string): boolean => (inflight.get(id) ?? 0) > 0 || accountHasRuns(id);
  const evictTimer = setInterval(() => {
    const l = multiAccountLimits();
    const closed = mh.evictIdle({ idleMs: minutesMs(l.idleCloseMinutes), maxOpen: l.maxOpenAccounts, isBusy: busy });
    if (closed.length) console.log(`[tangu] multi-account: closed ${closed.length} idle account database(s)`);
  }, 60_000);
  evictTimer.unref?.();

  const app = express();
  app.disable('x-powered-by');
  // 宿主据 newAccounts 知道还接不接新账号(只读上次量到的合计,不在这里走盘;没量过 = unknown,顺手起一次量)
  app.get('/health', (_req, res) => {
    const t = lastTotalUsage();
    if (!t) void newAccountsAllowed().catch(() => {});
    const limit = multiAccountLimits().totalStorageGB * 1024 ** 3;
    res.json({ ok: true, mode: 'multi-account', newAccounts: t ? (t.bytes < limit ? 'open' : 'closed') : 'unknown' });
  });
  // ① 来的是谁(先于读请求体:没过口令的请求连 25MB 的 JSON 都不解析)
  app.use((req, res, next) => {
    const who = checkAccountIdentity(req.headers, opts.localToken);
    if (!who.ok) return void res.status(who.status).json({ detail: who.detail });
    (req as any).accountId = who.accountId;
    (req as any).user = { userId: who.accountId, username: who.accountId, role: 'USER' };
    // 宿主带来的模型票:从请求上摘掉(后面谁都看不到),是这个账号的就存下(standalone/modelTickets.ts)
    takeModelTicket(req as any, who.accountId);
    // 在途请求(含 SSE 长连接)计数:淘汰不关正被用着的账号库
    inflight.set(who.accountId, (inflight.get(who.accountId) ?? 0) + 1);
    let counted = true;
    res.once('close', () => {
      if (!counted) return;
      counted = false;
      const left = (inflight.get(who.accountId) ?? 1) - 1;
      if (left > 0) inflight.set(who.accountId, left); else inflight.delete(who.accountId);
    });
    next();
  });
  // ② 白名单先判(先于读请求体、先于开户):按原始 method + 注册的路由模式。HEAD 不当 GET、OPTIONS 不自动应答 ——
  // 只认名单里那条路由自己登记的 method(Express 的 route.methods),路径用同一个 layer 的 match 判。
  const allowedLayers = (allowRouter as any).stack as Array<{ match(path: string): boolean; route?: { methods?: Record<string, boolean> } }>;
  const listed = (req: Request): boolean => {
    const method = String(req.method || '').toLowerCase();
    return allowedLayers.some((l) => l.route?.methods?.[method] === true && l.match(req.path));
  };
  app.use((req, res, next) => { if (listed(req)) return next(); res.status(403).json(NOT_AVAILABLE); });
  app.use(express.json({ limit: '25mb' }));
  // ③ 开户 + 整个请求(含它起的 run 的异步子树)绑进这个账号
  app.use((req, res, next) => {
    const id = (req as any).accountId as string;
    const openAccount = (): void => void mh.ensureAccount(id).then(
      () => runWithAccount(id, () => next()),
      (e) => {
        // 细节(本机路径)只进日志,不回给请求方
        console.error(`[tangu] multi-account: account ${id} could not be opened:`, (e as Error)?.message || e);
        res.status(500).json({ detail: 'Account could not be opened' });
      },
    );
    // 新账号(本进程没开过户、磁盘上也没有它的文件夹):全部账号合计到了总量上限就不接(已有账号照常用),回 503 带固定的 code。
    if (mh.provisionedAccounts().includes(id) || existsSync(accountHome(id))) return openAccount();
    newAccountsAllowed().then((ok) => {
      if (!ok) return void res.status(503).json({ code: 'NEW_ACCOUNTS_CLOSED', detail: 'This engine is not accepting new accounts right now.' });
      openAccount();
    }, () => res.status(500).json({ detail: 'Account could not be opened' }));
  });
  // ④ 远程锁定(与单人 standalone 同一道):锁定时带远程来源头的非只读请求一律 423(中止 run 除外)。
  // 锁是整台电脑的(桌面主进程的锁文件 + 进程内闩),对所有账号都收紧;读它不碰账号路径、不抛(读不出 = 锁定)。
  app.use((req, res, next) => remoteLockGuard(req, res, next));
  // ⑤ 白名单里的路由;其余一律 403(②已经挡过,这里是兜底)
  app.use(allowRouter);
  app.use((_req, res) => { res.status(403).json(NOT_AVAILABLE); });
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(typeof err?.status === 'number' ? err.status : 500).json({ detail: err?.type === 'entity.parse.failed' ? 'Invalid JSON body' : 'Request failed' });
  });

  return {
    app,
    dispose: async () => {
      clearInterval(evictTimer);
      try { mod.dispose(); } catch { /* ignore */ }
      mh.close();
      setMultiAccountBundleDirs(null);
      setSessionClaimer(null);
    },
    routeAllowlist: ROUTE_ALLOWLIST.map(({ method, path }) => ({ method, path })),
    toolAllowlist: [...MULTI_ACCOUNT_TOOL_ALLOWLIST],
    accounts: {
      open: () => mh.openAccounts(),
      provisioned: () => mh.provisionedAccounts(),
      evictIdleNow: (idleMs, maxOpen) => {
        const l = multiAccountLimits();
        return mh.evictIdle({ idleMs: idleMs ?? minutesMs(l.idleCloseMinutes), maxOpen: maxOpen ?? l.maxOpenAccounts, isBusy: busy });
      },
    },
  };
}

/**
 * standalone/main.ts 多账号分支的后半段:装配(createMultiAccountApp)→ 监听 → 给宿主发 ready → 收到 SIGTERM / SIGINT / 断开时
 * 排空 run 再退出。onPhase 报启动走到哪一步(main.ts 退出时据此说停在哪)。
 */
export async function startMultiAccountServer(opts: {
  cfg: StandaloneConfig;
  brain: CloudBrainServices;
  version: string;
  onPhase?: (phase: 'multi-account' | 'listen' | 'ready') => void;
}): Promise<void> {
  const { cfg } = opts;
  opts.onPhase?.('multi-account');
  const { app, dispose } = await createMultiAccountApp({
    localToken: cfg.localToken!,
    brain: opts.brain,
    defaultModelId: cfg.defaultModelId || undefined,
  });
  opts.onPhase?.('listen');
  const server = app.listen(cfg.port, cfg.host, () => {
    opts.onPhase?.('ready');
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : cfg.port;
    if (process.send) process.send({ type: 'tangu:ready', host: cfg.host, port, version: opts.version, mode: 'multi-account' });
    console.log(`[tangu] standalone (multi-account) 已启动 http://${cfg.host}:${port}`);
  });
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    const drained = drainRunsForExit(3000);
    void drained.finally(() => dispose()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref?.();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  if (process.send) process.on('disconnect', shutdown);
}
