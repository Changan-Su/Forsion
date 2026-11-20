/**
 * 帮助改进 Forsion v2:宿主侧的白名单键、设置分档与报错归类(契约 docs/ToBeImproved/默认数据采集方案_2026-10-28/contract.md §9 / §11)。
 * 主进程(electron/telemetryHost.ts)与渲染层共用这一份:键名照抄 telemetry-schema.json,改一处两边一起变。
 * 纯函数、零依赖。报错归类只看报错原文的形状,**原文本身一个字都不往外带**,只回枚举。
 */

/** 渲染层经 preload telemetryReport 报给主进程的种类(契约 §9);主进程 shapeRendererReport 每种一个分支,别的一律丢。 */
export const RENDERER_REPORT_KINDS = [
  'crash', 'feature', 'longtasks', 'plugin_install', 'plugin_deps', 'plugin_lifecycle', 'plugin_load', 'onboarding', 'guide_tip', 'count', 'command', 'setting',
  // v3(契约 §19):额度提示计数、插件清单、按模型的重新生成 / 停止 / 改了再发、首次运行
  'quotaPrompt', 'pluginInventory', 'modelCount', 'firstRun',
] as const
export type RendererReportKind = typeof RENDERER_REPORT_KINDS[number]

// ── v3 · 额度(契约 §16 / §17 / §19)──
/** 额度操作 / 下单请求里带的入口(服务端随账号记)。新接收方对表外的值当没给,绝不因此拒绝请求。 */
export const QUOTA_ENTRIES = ['chat-banner', 'run-error', 'run-toast', 'avatar-menu', 'muse-settings', 'quota-page', 'agent-tool', 'backpack', 'other'] as const
export type QuotaEntry = typeof QUOTA_ENTRIES[number]
/** 表里的入口原样;别的(含 undefined)→ undefined,调用方据此**不带**这个参数(老接收方看到的参数个数和原来一样)。 */
export const quotaEntry = (v: unknown): QuotaEntry | undefined => (typeof v === 'string' && (QUOTA_ENTRIES as readonly string[]).includes(v) ? v as QuotaEntry : undefined)
/**
 * 通道参数末尾追加 entry(契约 §16 新旧混跑):合法才追加,否则原样 —— 老接收方(老 Extend)看到的参数个数和原来一样。
 * `account:useResetCard(type?, entry?)` / `account:bgConvert(percent, entry?)` / `account:bgAutoMain(enabled, entry?)` / `account:pointsAutoDeduct(enabled, entry?)`。
 */
export function withEntry(args: readonly unknown[], entry: unknown): unknown[] {
  const e = quotaEntry(entry)
  return e ? [...args, e] : [...args]
}
/** `auth:openPayCenter` 的通道参数:Extend 的老签名是 (tab?, plan?, period?),entry 排第 4 位;没有合法 entry 就一个参数都不带(同原来)。 */
export function payCenterArgs(opts?: { entry?: unknown } | null): unknown[] {
  const e = quotaEntry(opts?.entry)
  return e ? [undefined, undefined, undefined, e] : []
}
/**
 * 开付款页:带上 entry 发一次;接收方回 { ok: false, error: 'invalid_*' }(口径对不上)就立刻不带 entry 再开一次 ——
 * 升级按钮绝不因为遥测参数失效。没带 entry 的那次原样返回。invoke = 往 auth:openPayCenter 发、参数原样转。
 */
export async function invokePayCenter<R>(invoke: (...args: unknown[]) => Promise<R>, opts?: { entry?: unknown } | null): Promise<R> {
  const args = payCenterArgs(opts)
  const r = await invoke(...args)
  const o = r as { ok?: unknown; error?: unknown } | null | undefined
  if (args.length && o?.ok === false && typeof o.error === 'string' && o.error.startsWith('invalid_')) return invoke()
  return r
}
/** 匿名计数 quota_prompt 的入口(telemetry-schema.json events.quota_prompt.entry;比上表少 agent-tool / backpack —— 那两处没有提示可露出)。 */
export const QUOTA_PROMPT_ENTRIES = ['chat-banner', 'run-error', 'run-toast', 'avatar-menu', 'muse-settings', 'quota-page', 'other'] as const
export type QuotaPromptEntry = typeof QUOTA_PROMPT_ENTRIES[number]
/** quota_prompt 的计数字段(= 提示上的动作;shown 是露出)。 */
export const QUOTA_PROMPT_ACTIONS = ['shown', 'dismiss', 'card', 'points', 'upgrade', 'topup', 'bgConvert', 'bgSettings', 'more'] as const
export type QuotaPromptAction = typeof QUOTA_PROMPT_ACTIONS[number]

// ── v3 · 按模型的计数(model_feedback)与首次运行(first_run)──
export const MODEL_COUNT_KEYS = ['regenerate', 'stop', 'editResend'] as const
export type ModelCountKey = typeof MODEL_COUNT_KEYS[number]
export const PROVIDER_KINDS = ['forsion', 'codex', 'byok', 'local', 'other'] as const
export type ProviderKind = typeof PROVIDER_KINDS[number]
/**
 * 模型 id → 来源类别(model_feedback.providerKind,交给 Extend 的 publicModelId 当「宿主核过的来源」):
 * 托管只认 `pr-` + 48 位十六进制整串,Codex 订阅只认 `codex/<一段模型名>`,本地 ollama / lmstudio / local,其余自带 key。
 * 比 Extend 的 providerKindOf 严:Extend 对 codex / forsion 原样放行整串,用户自建的渠道叫 `codex`、`pr-xxx` 时
 * (`codex/私有空间/模型`、`pr-my-relay/gpt-4o`)这里判成自带 key,Extend 就只留最后一段 —— 渠道名 / 命名空间不出本机。
 */
export function providerKindOf(modelId: string | null | undefined): ProviderKind {
  if (!modelId) return 'other'
  if (/^pr-[a-f0-9]{48}$/.test(modelId)) return 'forsion'
  if (/^codex\/[^/]+$/.test(modelId)) return 'codex'
  if (/^(?:ollama|lmstudio|local)[/:]/i.test(modelId)) return 'local'
  return 'byok'
}
export const RUN_ERROR_CLASSES = ['timeout', 'rate_limit', 'auth', 'network', 'context_length', 'upstream', 'tool', 'aborted', 'quota', 'other'] as const
export type RunErrorClass = typeof RUN_ERROR_CLASSES[number]
/**
 * 运行的报错句子 → 类别(与 Extend errorClassOf 同一规则,另把额度用尽排在限流前面:契约 §20)。只回枚举,原文不出这个函数。
 * aborted = 用户停下 / 中止。
 */
export function runErrorClass(error: unknown, aborted = false): RunErrorClass {
  if (aborted) return 'aborted'
  const e = String(error ?? '').toLowerCase()
  if (!e) return 'other'
  if (/token_quota_exceeded/.test(e)) return 'quota'
  if (/abort|cancel/.test(e)) return 'aborted'
  if (/timeout|timed out|etimedout/.test(e)) return 'timeout'
  if (/\b429\b|rate.?limit|too many requests|quota/.test(e)) return 'rate_limit'
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid api key|authentication/.test(e)) return 'auth'
  if (/context.{0,20}(length|window|too long)|maximum context|too many tokens|prompt is too long/.test(e)) return 'context_length'
  if (/econn|enotfound|eai_again|socket|network|fetch failed|getaddrinfo/.test(e)) return 'network'
  if (/\b5\d\d\b|upstream|bad gateway|overloaded|service unavailable/.test(e)) return 'upstream'
  if (/tool/.test(e)) return 'tool'
  return 'other'
}

/** 卸载 / 停用时可选的理由(plugin_lifecycle.reason)。 */
export const LIFECYCLE_REASONS = ['unused', 'broken', 'slow', 'mistake'] as const
export type LifecycleReason = typeof LIFECYCLE_REASONS[number]

/** app_counts 的字段(telemetry-schema.json events.app_counts,逐字照抄)。 */
export const APP_COUNT_KEYS = [
  'achChatSend', 'achChatGroup', 'achNoteCreate', 'achNoteWikilink', 'achNoteCanvas', 'achBaseCreate', 'achSpaceSave', 'achSpaceSwitch',
  'achAgentCreate', 'achAutomationCreate', 'achMuseOpen', 'achComputerUse', 'achMarketInstall', 'achThemeChange', 'achTodoDone',
  'achCalendarEvent', 'achAccountLogin', 'achImageGenerate', 'achDrawingCreate', 'achMiniOpen', 'achSpecialEnable',
  'chatStop', 'chatRegenerate', 'chatEditResend', 'chatTruncateResend', 'chatRetry', 'chatRewind', 'chatBranch', 'chatSteer',
  'chatSteerWithdraw', 'chatCompact', 'chatRetryFailed',
  'searchOpen', 'searchPick', 'searchCloseEmpty',
  'providerLoginOk', 'providerLoginFail', 'byokSave', 'byokImport', 'byokImportStale', 'byokDelete',
  'connTestOk', 'connTestFail', 'connTestAuthRejected',
  'modelSwitchUser', 'modelSwitchRemember', 'engineDefaultModelSet',
  'homeWidgetAdd', 'homeWidgetRemove', 'homeWidgetMove',
  'openNote', 'openDatabase', 'openDashboard', 'openPdf', 'openBoard', 'openPluginFile', 'openOther',
] as const
export type AppCountKey = typeof APP_COUNT_KEYS[number]
const COUNT_SET: ReadonlySet<string> = new Set(APP_COUNT_KEYS)
export const isAppCountKey = (k: unknown): k is AppCountKey => typeof k === 'string' && COUNT_SET.has(k)

/** 官方成就计数名 → app_counts 字段。插件的 plugin:* 计数与这张表以外的一律不发。 */
export const ACHIEVEMENT_COUNT_KEYS: Readonly<Record<string, AppCountKey>> = {
  'chat.send': 'achChatSend', 'chat.group': 'achChatGroup', 'note.create': 'achNoteCreate', 'note.wikilink': 'achNoteWikilink',
  'note.canvas': 'achNoteCanvas', 'base.create': 'achBaseCreate', 'space.save': 'achSpaceSave', 'space.switch': 'achSpaceSwitch',
  'agent.create': 'achAgentCreate', 'automation.create': 'achAutomationCreate', 'muse.open': 'achMuseOpen', 'computer.use': 'achComputerUse',
  'market.install': 'achMarketInstall', 'theme.change': 'achThemeChange', 'todo.done': 'achTodoDone', 'calendar.event': 'achCalendarEvent',
  'account.login': 'achAccountLogin', 'image.generate': 'achImageGenerate', 'drawing.create': 'achDrawingCreate', 'mini.open': 'achMiniOpen',
  'special.enable': 'achSpecialEnable',
}
export const achievementCountKey = (event: string): AppCountKey | undefined =>
  Object.hasOwn(ACHIEVEMENT_COUNT_KEYS, event) ? ACHIEVEMENT_COUNT_KEYS[event] : undefined

export const COMMAND_SOURCES = ['palette', 'hotkey', 'ribbon', 'agent', 'other'] as const
export type CommandSource = typeof COMMAND_SOURCES[number]

// ── setting_change:只收这张表里的键,值是枚举或分档;别的键 / 值一律丢 ──
const onOff = (v: unknown): string | undefined => (typeof v === 'boolean' ? (v ? 'on' : 'off') : v === 'on' || v === 'off' ? v : undefined)
const oneOf = (values: readonly string[]) => (v: unknown): string | undefined => (typeof v === 'string' && values.includes(v) ? v : undefined)
/** 主题语言 / 配色:内置 id 原样,用户自己的(磁盘主题、自定义色)由渲染层先换成 custom。这里只认 kebab 短串。 */
const themeId = (v: unknown): string | undefined => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v) ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** 界面缩放:按 0.1 一档,超出 0.5–2 的夹到边上。 */
const scaleBucket = (v: unknown): string | undefined => {
  const n = num(v)
  if (n === undefined || n <= 0) return undefined
  return (Math.round(Math.min(2, Math.max(0.5, n)) * 10) / 10).toFixed(1)
}
const heartbeatBucket = (v: unknown): string | undefined => {
  const n = num(v)
  if (n === undefined) return undefined
  return [30, 60, 120, 180].includes(n) ? String(n) : 'other'
}
/** 每天最多几条私信:0 = 不限。 */
const dmBucket = (v: unknown): string | undefined => {
  const n = num(v)
  if (n === undefined || n < 0 || !Number.isInteger(n)) return undefined
  return n <= 1 ? String(n) : n <= 3 ? '2-3' : n <= 5 ? '4-5' : n <= 10 ? '6-10' : '11+'
}

/** 契约 §9 的设置键表。代码里找不到对应设置的键不在这里(sync.* 在 Extend 的同步页,由 Extend 自己报)。 */
export const SETTING_KEYS: Readonly<Record<string, (v: unknown) => string | undefined>> = {
  'ui.themeMode': oneOf(['light', 'dark', 'system']),
  'ui.language': oneOf(['zh', 'en']),
  'ui.designLanguage': themeId,
  'ui.skin': themeId,
  'ui.bg': themeId,
  'ui.motionTheme': oneOf(['genesis', 'droplet', 'stretch', 'glide']), // = lcl/engine/panelMotion MOTION_THEME_IDS
  'ui.scale': scaleBucket,
  'muse.enabled': onOff,
  'muse.mode': oneOf(['ask', 'agent', 'auto']),
  'muse.notify': oneOf(['immediate', 'digest']),
  'muse.heartbeat': heartbeatBucket,
  'muse.maxDmPerDay': dmBucket,
  'computerHistory.enabled': onOff,
  'plugins.autoUpdate': onOff,
  'update.channel': oneOf(['stable', 'beta']),
  'approval.defaultMode': oneOf(['readonly', 'auto-edit', 'full-auto', 'custom']),
}
/** 一条设置改动 → 白名单里的 { key, value };键不在表里、值归不了档 → null。 */
export function settingChange(key: unknown, value: unknown): { key: string; value: string } | null {
  if (typeof key !== 'string' || !Object.hasOwn(SETTING_KEYS, key)) return null
  const v = SETTING_KEYS[key](value)
  return v === undefined ? null : { key, value: v }
}

// ── 报错归类:只回枚举,原文不出这个函数 ──
const DISK = /\b(ENOSPC|EACCES|EPERM|EBUSY|EROFS|EMFILE|EIO)\b|no space left/i
const NETWORK = /\b(ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR\w*|CERT_\w+)\b|fetch failed|net::ERR_|socket|network|unreachable|getaddrinfo|certificate|aborted/i

export type InstallStage = 'resolve' | 'download' | 'install'
export type InstallErrorClass = 'timeout' | 'network' | 'http' | 'too-large' | 'not-zip' | 'integrity' | 'identity' | 'version' | 'min-app'
  | 'platform' | 'deps' | 'builtin' | 'activate' | 'disk' | 'other'

/** DownloadFailed 的原文:`<主机>: <原因码>` 用 ` · ` 连起来(electron/marketInstall.ts)。主机必须带点,
 *  否则 Node 的 `EACCES: permission denied, …` 这类也会被当成「主机: 原因」。 */
const DOWNLOAD_PART = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d+)?: \S/i
function downloadClass(reasons: string[]): InstallErrorClass {
  if (reasons.some((r) => /too large/i.test(r))) return 'too-large'
  if (reasons.some((r) => /not a zip|unexpected content/i.test(r))) return 'not-zip'
  if (reasons.length && reasons.every((r) => /^(timeout|stalled)$/i.test(r))) return 'timeout'
  if (reasons.some((r) => /^HTTP \d/.test(r))) return 'http'
  if (reasons.some((r) => DISK.test(r))) return 'disk'
  return 'network'
}

/**
 * 商店安装失败 → { stage, errorClass }。raw = 主进程 market:install 抛出的原文(渲染层剥掉 Electron 那层包装之前或之后都行)。
 * lastPhase = 安装进度最后报到的阶段(没有前缀可认时用它)。
 */
export function classifyInstallError(raw: unknown, lastPhase?: InstallStage): { stage: InstallStage; errorClass: InstallErrorClass } {
  const m = String(raw ?? '').replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '').trim()
  if (m.startsWith('resolve: ')) {
    const d = m.slice(9)
    const errorClass: InstallErrorClass = /^timeout\b|TimeoutError/i.test(d) ? 'timeout' : /^HTTP \d/.test(d) ? 'http'
      : /identity/i.test(d) ? 'identity' : NETWORK.test(d) || /^E[A-Z_]{3,}$/.test(d) ? 'network' : 'other'
    return { stage: 'resolve', errorClass }
  }
  if (m.startsWith('install: ')) {
    const d = m.slice(9)
    const errorClass: InstallErrorClass = /^requires Forsion/i.test(d) ? 'min-app' : /unsupported platform/i.test(d) ? 'platform'
      : /integrity/i.test(d) ? 'integrity' : /identity/i.test(d) ? 'identity' : /^builtin$/i.test(d) ? 'builtin'
      : /versions? differ|not newer|incompatible/i.test(d) ? 'version' : DISK.test(d) ? 'disk' : 'other'
    return { stage: 'install', errorClass }
  }
  const parts = m.split(' · ')
  if (m && parts.every((p) => DOWNLOAD_PART.test(p))) {
    return { stage: 'download', errorClass: downloadClass(parts.map((p) => p.replace(/^[^:]+(?::\d+)?: /, '').trim())) }
  }
  // 解压阶段:extractZipToDir 的两句中文、JSZip 认不出的包
  if (/压缩包|central directory|End of data|Corrupted zip|invalid zip|is this a zip/i.test(m)) return { stage: 'install', errorClass: 'not-zip' }
  if (DISK.test(m)) return { stage: lastPhase ?? 'install', errorClass: 'disk' }
  if (/^timeout$|TimeoutError/i.test(m)) return { stage: lastPhase ?? 'resolve', errorClass: 'timeout' }
  if (NETWORK.test(m)) return { stage: lastPhase ?? 'resolve', errorClass: 'network' }
  return { stage: lastPhase ?? 'install', errorClass: 'other' }
}

export type UpdateErrorClass = 'network' | 'http' | 'integrity' | 'signature' | 'version' | 'identity' | 'incompatible' | 'disk' | 'other'
/** 更新失败(安装包 / 引擎 / 内置插件 / 商店插件)→ errorClass。 */
export function classifyUpdateError(raw: unknown): UpdateErrorClass {
  const m = String(raw ?? '')
  if (/integrity|checksum|sha512 mismatch/i.test(m)) return 'integrity'
  if (/signature|code sign|^package:|not signed/i.test(m)) return 'signature'
  if (/identity/i.test(m)) return 'identity'
  if (/incompatible/i.test(m)) return 'incompatible'
  if (DISK.test(m)) return 'disk'
  if (/\bHTTP \d{3}\b|HttpError|status code \d{3}/.test(m)) return 'http'
  if (/^package is .+, not |not newer|versions? differ/i.test(m)) return 'version'
  if (NETWORK.test(m) || /timeout|stalled/i.test(m)) return 'network'
  return 'other'
}
