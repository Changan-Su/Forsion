#!/usr/bin/env node
/**
 * 引擎路由 × 远端可用性分类表的生成器(设备能力 MCP 方案 §6.6 / 附录 C,P0 ③)。
 *
 * 为什么要它:unitWeb 的 /engine/* 从「任意路径直通」改成 **default-deny 允许清单**。清单只有跟
 * 引擎真实路由逐条对齐才有意义 —— 引擎加了新路由而这里没分类,远端要么够不着(设备页静默少功能),
 * 要么(若有人图省事写通配)被放行(装插件、改通道那一类)。所以:
 *   1. 从 tangu-agent/src 抽出 standalone 引擎**实际挂载**的每一条路由(method + path);
 *   2. 按下面 CLASSIFICATION 逐条(不写通配)标 allow | deny-remote,附一句理由;
 *   3. 写出 desktop/electron/engineRoutes.generated.ts(unitWeb 运行时只读它);
 *   4. unitWeb.test 跑 `--check --json`:新增路由未分类 / 分类表里有已消失的路由 / 生成物过期 → 红。
 *
 * 抽取口径(对不上就**大声失败**,不猜):
 *   - 挂载面:standalone/main.ts 里 `app.use('/', mod.<router>)` 的那几个 module router,
 *     再到 index.ts 里找 `<router>.use(<import>)` 组合出的 routes/*.ts。adminRouter 不挂 → 不收。
 *   - 应用级路由:standalone/main.ts 的 `app.get('/health', …)` 之类。
 *   - 路由文件里只认 `router.<get|post|put|patch|delete>(<字符串字面量 | 同文件 const 常量>, …)`;
 *     模板字符串、正则、`*`、`(…)`、`?`、`.route(`、`.all(`、嵌套子 router 一律报错。
 *   - **覆盖断言**(Codex 终审 out1 #5):上面几种之外的挂载写法以前会被静默漏抽(表里没有 = 远端 403,--check 照样绿)。
 *     现在 main.ts 里**每一处** `app`、index.ts 里被挂载的 module router 的**每一处**引用、路由文件里**每一个** Router() 都得是
 *     认得的形态,否则失败 —— 见 assertAppUsesKnown / assertModuleRouterUsesKnown / assertSingleRouter。
 *   - 引擎插件经 registerRoutes 贡献的路由在构建期不可知 → 表里没有 → 运行时 default-deny(远端 403)。
 *
 * 用法(desktop 目录下):
 *   node scripts/gen-engine-routes.mjs            重新生成(有未分类 / 分类表孤儿时仍写出,但 exit 1)
 *   node scripts/gen-engine-routes.mjs --check    只校验:生成物过期 / 未分类 / 孤儿 → exit 1
 *   node scripts/gen-engine-routes.mjs --check --json   同上,结果以 JSON 打到 stdout(测试用)
 *   node scripts/gen-engine-routes.mjs --md       以 markdown 表打印全表(附录 C 素材)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(here, '..')
const ENGINE_SRC = resolve(DESKTOP, '../tangu-agent/src')
const OUT = join(DESKTOP, 'electron', 'engineRoutes.generated.ts')

/**
 * 分类表。键 = `METHOD /path`(与引擎源码逐字一致)。值 = [access, reason]。
 *   allow       —— 远端(隧道 / P2P / 局域网配对)可达:设备页今天真在用,且不越出「驾驶一个会话」的范围;
 *                  请求字段钳制与有效审批档钳制在引擎侧(P0 ④),不在这张表。
 *   deny-remote —— 只许本机:改配置 / 装卸扩展 / 写记忆 / 建持久化的后续执行 / 读出凭据或本机绑定。
 * 审批类(runs/:id/approvals、inquiries、special/approvals、muse/todos/:id/approve)按 D1/D2 允许远端。
 */
const A = 'allow'
const D = 'deny-remote'
export const CLASSIFICATION = {
  // ── 应用级 ──
  'GET /health': [A, 'unauthenticated liveness probe'],

  // ── runs.ts:远程会话的主干 ──
  'POST /agent/runs': [A, 'start a run (field / approval-mode clamping is engine-side, P0 ④)'],
  'GET /agent/runs': [A, 'list runs'],
  'GET /agent/runs/:id/events': [A, 'run event stream'],
  'POST /agent/runs/:id/abort': [A, 'stop a run'],
  'POST /agent/runs/:id/steer': [A, 'steer a running run'],
  'DELETE /agent/runs/:id/steer/:messageId': [A, 'withdraw a queued steer message'],

  // ── approvals.ts ──
  'POST /agent/runs/:runId/approvals/:approvalId': [A, 'answer an approval (D1: remote approval allowed; bound to its run by P0 ②)'],
  'POST /agent/runs/:runId/inquiries/:inquiryId': [A, 'answer an inquiry (D1)'],
  'POST /agent/runs/:runId/captures/:shotId': [A, 'Agent Desk capture upload for a run (shotId bound to run, P0 ②)'],
  'GET /agent/approval-rules': [D, 'approval rules are local policy'],
  'PUT /agent/approval-rules': [D, 'approval rules are local policy'],
  // P1-K3
  'GET /agent/approvals/pending': [A, 'per-session pending counts for the session-list badge (no ids / previews)'],
  'GET /agent/approvals/stream': [D, 'engine-wide pending approval feed for the host main process only'],

  // ── workspace.ts ──
  'GET /agent/workspace/list': [A, 'session workspace listing'],
  'GET /agent/workspace/read': [A, 'session workspace read'],
  'GET /agent/workspace/download': [A, 'download artifacts'],
  'POST /agent/workspace/upload': [A, 'attachments from the remote device (design §6.6)'],
  'POST /agent/workspace/delete': [D, 'destructive workspace delete (design appendix C)'],
  'GET /agent/projects': [A, 'list cloud workspace projects'],
  'POST /agent/projects': [D, 'create cloud workspace project (design appendix C)'],

  // ── sessions.ts ──
  'GET /agent/sessions': [A, 'session list'],
  'POST /agent/sessions': [A, 'create a session'],
  'GET /agent/sessions/search': [A, 'session search'],
  'POST /agent/sessions/:id/branch': [A, 'branch a session (remote taint propagates, C5)'],
  'GET /agent/sessions/:id/background': [A, 'background child sessions'],
  'POST /agent/sessions/:id/team-members/:slug': [A, 'open a team member child session (taint propagates, C5)'],
  'GET /agent/sessions/:id/detail': [A, 'session detail'],
  'PATCH /agent/sessions/:id': [A, 'rename / archive / model / project of a session (a remote project_path never widens /unit/host* reads: only locally confirmed project roots count)'],
  'DELETE /agent/sessions/:id': [D, 'irreversible hard delete of a local session (runs, messages, code checkpoints); remote uses archive (PATCH archived)'],
  'GET /agent/sessions/:id/messages': [A, 'session messages'],
  'POST /agent/sessions/:id/messages/delete': [D, 'irreversible deletion of local conversation history'],
  'GET /agent/sessions/:id/config': [A, 'read session config'],
  'PATCH /agent/sessions/:id/config': [A, 'session config patch (field subset + approval ceiling enforced engine-side, P0 ④ / C3)'],
  'PUT /agent/sessions/:id/config': [D, 'whole-config replace; remote uses PATCH'],
  'GET /agent/sessions/:id/usage': [A, 'session usage'],
  'GET /agent/sessions/:id/timeline': [A, 'session timeline'],
  'POST /agent/sessions/:id/compact': [A, 'compact a session'],
  'POST /agent/sessions/:id/aside': [A, 'btw aside (taint propagates, C5)'],
  'GET /agent/sessions/:id/checkpoints': [A, 'list code checkpoints'],
  'POST /agent/sessions/:id/checkpoints/restore': [D, 'restores host files from checkpoints (design appendix C)'],
  'GET /agent/compaction': [A, 'read compaction settings'],
  'PUT /agent/compaction': [D, 'global compaction config'],

  // ── commands.ts / models.ts / vision.ts ──
  'GET /agent/commands': [A, 'slash command catalog'],
  'POST /agent/commands/:name/expand': [A, 'expand a custom slash command template (read-only)'],
  'GET /agent/models': [A, 'model list'],
  'PUT /agent/models/overrides': [D, 'model overrides config'],
  'POST /agent/vision/describe': [A, 'describe an image for a non-vision model'],

  // ── engines.ts(外部引擎)—— 整组本机 ──
  'GET /agent/engines': [D, 'external engines are local-only (engineId is stripped from remote runs)'],
  'GET /agent/engines/:id/capabilities': [D, 'external engines are local-only'],
  'PUT /agent/engines/:id': [D, 'external engine config'],
  'GET /agent/engines/:id/assets': [D, 'reads host assets of an external engine'],
  'POST /agent/engines/:id/import': [D, 'imports external engine assets'],

  // ── providers.ts(provider / 联网搜索配置)—— 整组本机 ──
  'GET /agent/providers': [D, 'provider config (device page uses /unit/providers, keys stripped)'],
  'POST /agent/providers/test': [D, 'provider config'],
  'POST /agent/providers/fetch-models': [D, 'provider config (design appendix C)'],
  'GET /agent/websearch': [D, 'web search config'],
  'PUT /agent/websearch': [D, 'web search config (design appendix C)'],
  'POST /agent/websearch/test': [D, 'web search config'],

  // ── memory.ts / memoryMaintenance.ts ──
  'GET /agent/memory': [A, 'read memory'],
  'POST /agent/memory': [D, 'memory write'],
  'GET /agent/log': [A, 'read daily log'],
  'POST /agent/log': [D, 'memory log write'],
  'POST /agent/sync': [D, 'memory sync (design appendix C)'],
  'GET /agent/sync/status': [A, 'memory sync status'],
  'GET /agent/agents/:slug/memory/dream': [A, 'read memory maintenance state'],
  'PUT /agent/agents/:slug/memory/dream': [D, 'memory maintenance config'],
  'POST /agent/agents/:slug/memory/dream': [D, 'starts a memory rewrite'],
  'DELETE /agent/agents/:slug/memory/dream': [D, 'memory maintenance control'],

  // ── assets.ts(技能 / 工具)──
  'GET /agent/skills/catalog': [A, 'skill catalog'],
  'GET /agent/skills/catalog/:key': [A, 'skill detail'],
  'POST /agent/skills/catalog': [D, 'create skill'],
  'POST /agent/skills/catalog/import': [D, 'skill import (design appendix C)'],
  'PATCH /agent/skills/catalog/:key': [D, 'edit skill'],
  'PUT /agent/skills/catalog/:key/disabled': [D, 'skill enablement config'],
  'DELETE /agent/skills/catalog/:key': [D, 'delete skill'],
  'POST /agent/skills/catalog/:key/copy': [D, 'copy skill between Agents'],
  'GET /agent/skills': [A, 'skills list'],
  'POST /agent/skills/upload': [D, 'skill upload (design appendix C)'],
  'DELETE /agent/skills/user/:id': [D, 'delete user skill'],
  'GET /agent/tools': [A, 'tool list'],

  // ── agents.ts ──
  'GET /agent/agents': [A, 'Agent roster'],
  'GET /agent/tool-catalog': [A, 'tool catalog'],
  'POST /agent/agents': [D, 'create Agent (design appendix C)'],
  'PATCH /agent/agents/:slug': [D, 'update Agent (design appendix C)'],
  'DELETE /agent/agents/:slug': [D, 'delete Agent'],
  'POST /agent/agents/:slug/rename': [D, 'rename Agent'],
  'POST /agent/agents/:slug/avatar': [D, 'update Agent avatar'],
  'GET /agent/agents/:slug/avatar': [A, 'Agent avatar'],
  'DELETE /agent/agents/:slug/avatar': [D, 'update Agent avatar'],
  'GET /agent/agents-meta': [A, 'Agent roster meta'],
  'PUT /agent/agents-meta': [D, 'Agent roster meta write'],
  'GET /agent/agents/:slug/memory': [A, 'read Agent memory'],
  'PUT /agent/agents/:slug/memory': [D, 'memory write (design appendix C)'],
  'GET /agent/agents/:slug/memory/revisions': [A, 'memory revisions'],
  'POST /agent/agents/:slug/memory/restore': [D, 'memory write'],
  'POST /agent/agents/:slug/memory/entries': [D, 'memory write (design appendix C)'],
  'GET /agent/agents/:slug/logs': [A, 'Agent log list'],
  'GET /agent/agents/:slug/log': [A, 'Agent log'],
  'PUT /agent/agents/:slug/log': [D, 'memory log write'],
  'GET /agent/agents/:slug/library': [A, 'Agent library listing'],
  'GET /agent/agents/:slug/library/file': [A, 'Agent library file'],
  'POST /agent/agents/:slug/library/file': [D, 'writes into the Agent library'],
  'DELETE /agent/agents/:slug/library/file': [D, 'deletes from the Agent library'],
  'GET /agent/agents/:slug/harness': [A, 'read HARNESS'],
  'POST /agent/agents/:slug/harness/rollback': [D, 'harness rollback (design appendix C)'],
  'GET /agent/user-profile': [A, 'read user profile'],
  'PUT /agent/user-profile': [D, 'user profile write (design appendix C)'],

  // ── solo.ts / teams.ts ──
  'POST /agent/solo/:kind/:id/open': [A, 'open the Agent direct-chat session'],
  'POST /agent/solo/:kind/:id/rotate': [A, 'start a fresh Agent direct-chat session'],
  'GET /agent/teams': [A, 'team list'],
  'GET /agent/teams-meta': [A, 'team meta'],
  'PUT /agent/teams-meta': [D, 'team meta write'],
  'GET /agent/teams/:slug': [A, 'team detail'],
  'POST /agent/teams': [D, 'create team'],
  'PATCH /agent/teams/:slug': [D, 'update team'],
  'POST /agent/teams/:slug/avatar': [D, 'update team avatar'],
  'GET /agent/teams/:slug/avatar': [A, 'team avatar'],
  'DELETE /agent/teams/:slug/avatar': [D, 'update team avatar'],
  'DELETE /agent/teams/:slug': [D, 'delete team'],
  'POST /agent/teams/:slug/session/open': [A, 'open a team session'],

  // ── projectContext.ts ──
  'GET /agent/project-context': [A, 'read project context'],
  'POST /agent/project-context/init': [D, 'project instruction write (design appendix C)'],
  'PUT /agent/project-context/doc': [D, 'project instruction write (design appendix C)'],
  'GET /agent/project-context/settings': [A, 'read project settings'],
  'PUT /agent/project-context/settings': [D, 'project settings write (design appendix C)'],
  'POST /agent/project-context/skills': [D, 'project skill write (design appendix C)'],
  'POST /agent/project-context/icon': [D, 'project icon write'],
  'GET /agent/project-context/icon': [A, 'project icon'],
  'DELETE /agent/project-context/icon': [D, 'project icon write'],

  // ── plugins.ts —— 除渲染助手外整组本机 ──
  'GET /agent/plugins': [D, 'engine plugins are local-only'],
  'POST /agent/reply-segments': [A, 'chat bubble segmentation helper (read-only)'],
  'POST /agent/plugins/rescan': [D, 'engine plugins are local-only'],
  'POST /agent/plugins/install': [D, 'installs code (design appendix C)'],
  'GET /agent/plugins/:id/source': [D, 'engine plugins are local-only'],
  'DELETE /agent/plugins/:id': [D, 'engine plugins are local-only'],
  'PUT /agent/plugins/:id/enabled': [D, 'engine plugins are local-only'],
  'GET /agent/plugins/:id/settings': [D, 'plugin settings may hold secrets'],
  'PUT /agent/plugins/:id/settings': [D, 'engine plugins are local-only'],
  'GET /agent/plugins/:id/files': [D, 'engine plugins are local-only'],
  'POST /agent/plugins/:id/files': [D, 'engine plugins are local-only'],
  'DELETE /agent/plugins/:id/files': [D, 'engine plugins are local-only'],

  // ── special.ts(Historian / Muse / 自动化 / 日程 / 异步审批)──
  'GET /agent/special/config': [A, 'renderer auth probe; remote callers get only on/off + two cadence values (P1-K10b projection)'],
  'POST /agent/special/config': [D, 'special-agent config write (design appendix C)'],
  'GET /agent/special/historian/activity': [A, 'Historian activity'],
  'GET /agent/special/muse/todos': [A, 'Muse todos'],
  'GET /agent/special/muse/todos/:id': [A, 'Muse todo'],
  'PATCH /agent/special/muse/todos/:id': [A, 'Muse todo status only (card landing / dismiss)'],
  'POST /agent/special/muse/todos/:id/approve': [A, 'approve a Muse todo (D1/D2)'],
  'POST /agent/special/muse/todos/inject': [D, 'creates persistent follow-up execution (design appendix C)'],
  'GET /agent/special/muse/status': [A, 'Muse status'],
  'GET /agent/special/muse/triggers': [A, 'Muse triggers'],
  'DELETE /agent/special/muse/triggers/:id': [D, 'Muse trigger config'],
  'POST /agent/special/muse/triggers': [D, 'creates persistent follow-up execution (design appendix C)'],
  'POST /agent/special/automation/triggers/:id/fire': [D, 'fires an automation (design appendix C)'],
  'POST /agent/special/automation/kick': [D, 'kicks automations (design appendix C)'],
  'GET /agent/special/automation/actions': [A, 'automation action catalog'],
  'GET /agent/special/automation/executions': [A, 'automation executions'],
  'GET /agent/special/automation/sessions': [A, 'automation sessions'],
  'GET /agent/special/automation/runs': [A, 'automation runs'],
  'GET /agent/special/schedule': [A, 'Agent schedules'],
  'POST /agent/special/schedule/:slug/entries': [D, 'creates persistent follow-up execution (design appendix C)'],
  'DELETE /agent/special/schedule/:slug/entries/:id': [D, 'schedule write'],
  'POST /agent/special/muse/feedback': [D, 'appends to Muse LOG (memory write into an autonomous Agent)'],
  'GET /agent/special/approvals': [A, 'pending async approvals'],
  'GET /agent/special/approvals/:id': [A, 'pending async approval'],
  'POST /agent/special/approvals/:id/approve': [A, 'answer an async approval (D1/D2)'],
  'POST /agent/special/approvals/:id/reject': [A, 'answer an async approval (D1/D2)'],
  'GET /agent/special/muse/library': [A, 'Muse library'],
  'GET /agent/special/muse/library/file': [A, 'Muse library file (read-only, realpath-bounded to the Library)'],

  // ── hooks.ts / wechat.ts / channels.ts —— 整组本机 ──
  'GET /agent/hooks': [D, 'hooks run host commands'],
  'PUT /agent/hooks': [D, 'hooks run host commands'],
  'POST /agent/hooks/trust': [D, 'hooks run host commands'],
  'POST /agent/hooks/enable': [D, 'hooks run host commands'],
  'POST /agent/wechat/login/start': [D, 'WeChat binding is local-only'],
  'GET /agent/wechat/login/status': [D, 'WeChat binding is local-only'],
  'GET /agent/wechat/status': [D, 'WeChat binding is local-only'],
  'POST /agent/wechat/disconnect': [D, 'WeChat binding is local-only'],
  'GET /agent/wechat/sessions': [D, 'WeChat binding is local-only'],
  'POST /agent/wechat/connect': [D, 'WeChat binding is local-only'],
  'POST /agent/wechat/session-agent': [D, 'WeChat binding is local-only'],
  'POST /agent/wechat/sessions/new': [D, 'WeChat binding is local-only'],
  'GET /agent/channels': [D, 'channel config is local-only'],
  'PUT /agent/channels/:kind/config': [D, 'channel config is local-only'],
  'POST /agent/channels/:kind/connect': [D, 'channel binding is local-only (design appendix C)'],
  'POST /agent/channels/:kind/disconnect': [D, 'channel binding is local-only'],
  'POST /agent/channels/:kind/connect-session': [D, 'channel binding is local-only (design appendix C)'],
  'POST /agent/channels/:kind/sessions/new': [D, 'channel binding is local-only (design appendix C)'],

  // ── inbox.ts ──
  'GET /agent/inbox': [A, 'inbox list'],
  'GET /agent/inbox/unread-count': [A, 'inbox badge'],
  'POST /agent/inbox': [D, 'posts a system-sender message and forwards it to channels'],
  'PATCH /agent/inbox/:id': [A, 'mark read / star'],
  'POST /agent/inbox/read-all': [A, 'mark all read'],
  'DELETE /agent/inbox/:id': [A, 'soft-delete an inbox message'],
  'POST /agent/inbox/:id/claim': [A, 'claim a reward for the same account'],
  'POST /agent/inbox/pull': [A, 'pull cloud broadcasts'],

  // ── tts.ts ──
  'POST /agent/tts': [A, 'read aloud'],
  'POST /agent/tts/voices/list': [D, 'posts to a caller-chosen baseUrl from the host network and echoes the reply (SSRF pivot into the host LAN)'],
  'POST /agent/tts/voices/clone': [D, 'creates a provider voice'],
  'POST /agent/tts/voices/design': [D, 'creates a provider voice'],
  'POST /agent/tts/voices/delete': [D, 'deletes a provider voice'],
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
const SEGMENT = /^(?:[A-Za-z0-9._~-]+|:[A-Za-z_][A-Za-z0-9_]*)$/

function fail(msg) {
  throw new Error(`[gen-engine-routes] ${msg}`)
}

/** 去掉块注释与行注释(保留换行,行号不漂)。路由文件里没有含 `//` 的字符串字面量出现在 router.x( 之前。 */
function stripComments(src) {
  // 小扫描器而非两条正则:行注释里的 `/agent/workspace/*` 会被「先剥块注释」的正则当成块注释开头,
  // 一路吃到下一个 `*/`,把中间的 app.use / router.x 整片吞掉(实翻过)。字符串内的 // 与 /* 原样保留。
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++
        else if (src[j] === '\n' && c !== '`') break
        j++
      }
      out += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

/** 字符串字面量的内容换成空格(引号与长度保留、偏移不漂):扫描标识符时,字符串里的 `app` / `Router(` 不算。 */
function blankStrings(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++
        else if (src[j] === '\n' && c !== '`') break
        j++
      }
      out += c + src.slice(i + 1, Math.min(j, n)).replace(/[^\n]/g, ' ') + (j < n ? src[j] : '')
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length

/**
 * 调用的顶层实参区间:code = 已剥注释 + 剥字符串内容的源码(括号不会被字符串里的字符骗),open = 左括号之后的下标。
 * 返回每个实参的 [起, 止)(原文同偏移,调用方拿原文判字面量)。括号不配平 → fail。
 * 为什么要逐个实参判(Codex r3 #4):只看前缀,`app.use(express.json(), extraRouter)` 这种合法多参挂载会整条放行,extraRouter 静默漏抽。
 */
function callArgs(code, open, where) {
  const args = []
  let depth = 0
  let start = open
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        if (c !== ')') break
        if (code.slice(start, i).trim()) args.push([start, i])
        return args
      }
      depth--
    } else if (c === ',' && depth === 0) {
      args.push([start, i])
      start = i + 1
    }
  }
  fail(`${where}: unbalanced call arguments`)
}
const argTexts = (src, code, open, where) => callArgs(code, open, where).map(([a, b]) => src.slice(a, b).trim())
const INLINE_MIDDLEWARE = /^(?:async\s+)?\(\s*[A-Za-z_$][\w$]*(?:\s*:\s*[A-Za-z_$][\w$]*)?\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)\s*=>/
const IDENT = '[A-Za-z_$][\\w$]*'
/** app 上不产生路由的调用(起服务 / 设置项)。 */
const APP_NONROUTE = new Set(['listen', 'set', 'disable', 'enable'])

/**
 * main.ts 覆盖断言:剥注释 + 剥字符串内容后,每一处 `app` 标识符都必须是下面之一 ——
 *   `const app = express()`(恰好一次);`app.<get|post|put|patch|delete>('<字面量路径>', …)`;
 *   `app.use(express.<json|urlencoded|raw|text>(…))`(请求体解析);`app.use((req, res, next) => …)`(无路径的内联中间件,CORS);
 *   `app.use('<前缀>', mod.<router>)`(前缀由调用方再判);`app.<listen|set|disable|enable>(…)`。
 * 其余(`app.all` / `app.route` / `app.use(mod.x)` / `app.use('/', someRouter)` / `app.use(express.static(…))` /
 * 把 app 交给别的函数 / `app[...]` / 第二个 express())一律失败。main.ts 里也不许自己造 Router()。
 */
function assertAppUsesKnown(mainSrc) {
  const code = blankStrings(mainSrc)
  let decls = 0
  for (const m of code.matchAll(/\bapp\b/g)) {
    const where = `standalone/main.ts:${lineOf(code, m.index)}`
    if (m.index > 0 && /[.$\w]/.test(code[m.index - 1])) continue // obj.app / $app 之类不是这个标识符
    const before = code.slice(Math.max(0, m.index - 16), m.index)
    const after = code.slice(m.index + 3)
    if (/\b(?:const|let|var)\s+$/.test(before) && /^\s*=\s*express\s*\(\s*\)/.test(after)) { decls++; continue }
    const call = new RegExp(`^\\s*\\.\\s*(${IDENT})\\s*\\(\\s*`).exec(after)
    if (!call) fail(`${where}: unsupported use of \`app\` (only app.<verb>('<path>'), app.use(<body parser | (req, res, next) => … | '/', mod.<router>>) and app.${[...APP_NONROUTE].join('/')} are modelled) — extend the generator before mounting routes this way`)
    const verb = call[1]
    const rest = mainSrc.slice(m.index + 3 + call[0].length) // 原文(带字符串)判字面量
    if (METHODS.has(verb)) {
      if (!/^(['"])[^'"\n]+\1/.test(rest)) fail(`${where}: app.${verb}(...) route path must be a string literal`)
      continue
    }
    if (APP_NONROUTE.has(verb)) continue
    if (verb === 'use') {
      // 逐个实参判:认得的只有「单个请求体解析器」「单个无路径内联中间件」「'<前缀>', mod.<router> 两参」三种
      const args = argTexts(mainSrc, code, m.index + 3 + call[0].lastIndexOf('(') + 1, where)
      if (args.length === 1 && /^express\s*\.\s*(?:json|urlencoded|raw|text)\s*\([^]*\)$/.test(args[0])) continue
      if (args.length === 1 && INLINE_MIDDLEWARE.test(args[0])) continue
      if (args.length === 2 && /^(['"])[^'"\n]*\1$/.test(args[0]) && new RegExp(`^mod\\s*\\.\\s*${IDENT}$`).test(args[1])) continue
      fail(`${where}: unsupported app.use(...) form — only a single body parser, a single inline (req, res, next) middleware and app.use('/', mod.<router>) are modelled`)
    }
    fail(`${where}: unsupported app.${verb}(...)`)
  }
  if (decls !== 1) fail(`standalone/main.ts: expected exactly one \`const app = express()\`, found ${decls}`)
  if ((code.match(/\bexpress\s*\(\s*\)/g) || []).length !== 1) fail('standalone/main.ts: a second express() app is not modelled')
  if (/\bRouter\s*\(/.test(code)) fail('standalone/main.ts: creating a Router() here is not modelled')
}

/**
 * index.ts 覆盖断言:被 main.ts 挂载的 module router(userRouter / dataRouter)的每一处引用都必须是
 *   `const <name> = Router()`、`<name>.use(<./routes/* 导入>)`、接口里的类型声明 `<name>: Router;`、或 return 对象里的简写 `{ …, <name>, … }`。
 * `<name>.use('/p', x)` / `<name>.use(makeRouter())` / `<name>.get(...)` / 把它交给别的函数 —— 一律失败。
 */
function assertModuleRouterUsesKnown(indexSrc, name, imports) {
  const code = blankStrings(indexSrc)
  for (const m of code.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
    const where = `index.ts:${lineOf(code, m.index)}`
    if (m.index > 0 && /[.$\w]/.test(code[m.index - 1])) fail(`${where}: unsupported reference to module router ${name}`)
    const before = code.slice(Math.max(0, m.index - 16), m.index)
    const after = code.slice(m.index + name.length)
    if (/\bconst\s+$/.test(before) && /^\s*=\s*Router\s*\(\s*\)/.test(after)) continue
    const use = new RegExp(`^\\s*\\.\\s*use\\s*\\(\\s*(${IDENT})\\s*\\)`).exec(after)
    if (use) {
      if (!imports.has(use[1])) fail(`${where}: ${name}.use(${use[1]}) is not a ./routes/* import`)
      continue
    }
    if (/^\s*:\s*Router\s*;/.test(after)) continue // 接口成员的类型声明
    if (/[{,]\s*$/.test(before) && /^\s*[,}]/.test(after)) continue // return { userRouter, dataRouter, … } 简写
    fail(`${where}: unsupported use of module router ${name} (only ${name}.use(<./routes/* import>) is modelled)`)
  }
}

/** 路由文件覆盖断言:恰好一个 Router(),且绑定名就是 `router`(别名 router 上的路由会被 routesOfFile 漏掉)。 */
function assertSingleRouter(src, rel) {
  const code = blankStrings(src)
  const all = [...code.matchAll(/\bRouter\s*\(/g)]
  const named = [...code.matchAll(/\bconst\s+router\s*=\s*(?:express\s*\.\s*)?Router\s*\(\s*\)/g)]
  if (all.length !== 1 || named.length !== 1) fail(`${rel}: expected exactly one \`const router = Router()\` (found ${all.length} Router() call(s)); other router instances are not modelled`)
}

function validatePath(path, where) {
  if (path === '/') return
  if (!path.startsWith('/')) fail(`${where}: path must start with '/': ${path}`)
  for (const seg of path.slice(1).split('/')) {
    if (!SEGMENT.test(seg)) fail(`${where}: unsupported path syntax ${JSON.stringify(path)} (segment ${JSON.stringify(seg)}); extend the generator + unitWeb matcher before using it`)
  }
}

/** 解析一个路由文件:router.<method>(<literal|const>, …)。 */
function routesOfFile(abs, root = ENGINE_SRC) {
  const raw = readFileSync(abs, 'utf8')
  const src = stripComments(raw)
  const consts = new Map()
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\n]*)\2\s*;/g)) consts.set(m[1], m[3])
  const out = []
  const rel = relative(root, abs).split('\\').join('/')
  assertSingleRouter(src, rel)
  for (const m of src.matchAll(/\brouter\s*\.\s*([A-Za-z]+)\s*\(\s*/g)) {
    const verb = m[1]
    const line = src.slice(0, m.index).split('\n').length
    const where = `${rel}:${line}`
    const rest = src.slice(m.index + m[0].length)
    if (verb === 'use') {
      // 只认「路径前缀, authMiddleware, 内联中间件」三参(memoryMaintenance.ts);多挂一个子 router 之类一律不认(逐个实参判)。
      const args = argTexts(src, blankStrings(src), m.index + m[0].length, where)
      const ok = args.length === 3 && /^(?:(['"])[^'"\n]*\1|[A-Za-z_$][\w$]*)$/.test(args[0]) && args[1] === 'authMiddleware' && INLINE_MIDDLEWARE.test(args[2])
      if (!ok) fail(`${where}: unsupported router.use(...) form`)
      continue
    }
    if (!METHODS.has(verb)) fail(`${where}: unsupported router.${verb}(...)`)
    let path
    const lit = /^(['"])([^'"\n]*)\1/.exec(rest)
    if (lit) path = lit[2]
    else {
      const id = /^([A-Za-z_$][\w$]*)\s*,/.exec(rest)
      if (!id || !consts.has(id[1])) fail(`${where}: route path must be a string literal or a same-file string const`)
      path = consts.get(id[1])
    }
    validatePath(path, where)
    out.push({ method: verb.toUpperCase(), path, src: rel })
  }
  return out
}

/** standalone 引擎实际挂载的全部路由(不含运行期插件路由)。 */
export function extractEngineRoutes(engineSrc = ENGINE_SRC) {
  const mainSrc = stripComments(readFileSync(join(engineSrc, 'standalone/main.ts'), 'utf8'))
  const indexSrc = stripComments(readFileSync(join(engineSrc, 'index.ts'), 'utf8'))
  const routes = []
  assertAppUsesKnown(mainSrc)
  // 应用级路由(/health)
  for (const m of mainSrc.matchAll(/\bapp\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"])([^'"\n]+)\2/g)) {
    validatePath(m[3], 'standalone/main.ts')
    routes.push({ method: m[1].toUpperCase(), path: m[3], src: 'standalone/main.ts' })
  }
  // module router 的挂载
  const mounted = [...mainSrc.matchAll(/\bapp\s*\.\s*use\s*\(\s*(['"])([^'"\n]*)\1\s*,\s*mod\s*\.\s*([A-Za-z_$][\w$]*)\s*\)/g)]
  if (!mounted.length) fail('standalone/main.ts: no app.use(prefix, mod.<router>) mounts found')
  const imports = new Map()
  for (const m of indexSrc.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+'\.\/(routes\/[\w.-]+)\.js';/gm)) imports.set(m[1], m[2] + '.ts')
  const files = new Set()
  for (const m of mounted) {
    if (m[2] !== '/') fail(`standalone/main.ts: router ${m[3]} mounted under ${m[2]} — prefix mounts are not modelled`)
    const name = m[3]
    if (imports.has(name)) { files.add(imports.get(name)); continue } // 直接导出的路由文件(adminRouter 形态)
    if (!new RegExp(`\\bconst\\s+${name}\\s*=\\s*Router\\(\\)`).test(indexSrc)) fail(`index.ts: cannot resolve module router ${name}`)
    assertModuleRouterUsesKnown(indexSrc, name, imports)
    const uses = [...indexSrc.matchAll(new RegExp(`\\b${name}\\s*\\.\\s*use\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)`, 'g'))]
    for (const u of uses) {
      if (!imports.has(u[1])) fail(`index.ts: ${name}.use(${u[1]}) is not a ./routes/* import`)
      files.add(imports.get(u[1]))
    }
  }
  for (const f of [...files].sort()) routes.push(...routesOfFile(join(engineSrc, f), engineSrc))
  const seen = new Set()
  for (const r of routes) {
    const k = `${r.method} ${r.path}`
    if (seen.has(k)) fail(`duplicate route ${k}`)
    seen.add(k)
  }
  return routes
}

/** 合并抽取结果与分类表 → 行;未分类记 'unclassified'(运行时按拒绝处理),分类表里多出的键记为孤儿。 */
export function buildTable(routes = extractEngineRoutes()) {
  const rows = routes.map((r) => {
    const c = CLASSIFICATION[`${r.method} ${r.path}`]
    return { method: r.method, path: r.path, access: c ? c[0] : 'unclassified', src: r.src, why: c ? c[1] : 'NOT CLASSIFIED' }
  })
  rows.sort((a, b) => a.src.localeCompare(b.src) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  const keys = new Set(routes.map((r) => `${r.method} ${r.path}`))
  const orphans = Object.keys(CLASSIFICATION).filter((k) => !keys.has(k)).sort()
  const unclassified = rows.filter((r) => r.access === 'unclassified').map((r) => `${r.method} ${r.path} (${r.src})`)
  return { rows, orphans, unclassified }
}

export function renderTs(rows) {
  const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  const lines = rows.map((r) => `  { method: ${q(r.method)}, path: ${q(r.path)}, access: ${q(r.access)}, src: ${q(r.src)}, why: ${q(r.why)} },`)
  return [
    '/**',
    ' * AUTO-GENERATED by desktop/scripts/gen-engine-routes.mjs — do not edit by hand.',
    ' * Every route the standalone engine mounts, classified for remote reach through unitWeb /engine/*.',
    ' * Change a classification in the generator\'s CLASSIFICATION map, then re-run the script.',
    ' * Routes not listed here (e.g. contributed by engine plugins at runtime) are denied to remote callers.',
    ' */',
    "export type EngineRouteAccess = 'allow' | 'deny-remote' | 'unclassified'",
    'export interface EngineRoute { method: string; path: string; access: EngineRouteAccess; src: string; why: string }',
    '',
    'export const ENGINE_ROUTES: readonly EngineRoute[] = [',
    ...lines,
    ']',
    '',
  ].join('\n')
}

export function renderMarkdown(rows) {
  const out = ['| Method | Path | Remote | Source | Why |', '|---|---|---|---|---|']
  for (const r of rows) out.push(`| ${r.method} | \`${r.path}\` | ${r.access} | ${r.src} | ${r.why} |`)
  return out.join('\n')
}

function main(argv) {
  const check = argv.includes('--check')
  const asJson = argv.includes('--json')
  const { rows, orphans, unclassified } = buildTable()
  if (argv.includes('--md')) {
    console.log(renderMarkdown(rows))
    return 0
  }
  const next = renderTs(rows)
  let current = ''
  try { current = readFileSync(OUT, 'utf8') } catch { /* 首次生成 */ }
  const stale = current !== next
  if (check) {
    const report = { ok: !stale && !orphans.length && !unclassified.length, stale, unclassified, orphans, routes: rows.length }
    if (asJson) console.log(JSON.stringify(report))
    else {
      if (stale) console.error(`[gen-engine-routes] ${relative(process.cwd(), OUT)} is stale — run: node scripts/gen-engine-routes.mjs`)
      for (const u of unclassified) console.error(`[gen-engine-routes] unclassified: ${u}`)
      for (const o of orphans) console.error(`[gen-engine-routes] classification for a route that no longer exists: ${o}`)
      if (report.ok) console.log(`[gen-engine-routes] OK — ${rows.length} routes classified, table up to date`)
    }
    return report.ok ? 0 : 1
  }
  if (stale) writeFileSync(OUT, next)
  console.log(`[gen-engine-routes] ${stale ? 'wrote' : 'unchanged'} ${relative(process.cwd(), OUT)} (${rows.length} routes)`)
  for (const u of unclassified) console.error(`[gen-engine-routes] unclassified (denied at runtime until classified): ${u}`)
  for (const o of orphans) console.error(`[gen-engine-routes] classification for a route that no longer exists: ${o}`)
  return unclassified.length || orphans.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 2
  }
}
