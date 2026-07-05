/**
 * Agent 自定义工具（HTTP / JavaScript）的云端加载与执行。
 *
 * 两个来源（与客户端 agentRuntime 对齐）：
 *   ① custom_tools 表：按 agentConfig.enabledToolIds 选中 + 管理员强制(is_builtin+hidden)。
 *   ② 启用技能(skills_catalog.tools)里自带的 http/javascript 工具。
 *
 * 执行红线：
 *   - HTTP：模板插值 {{arg}} → SSRF 守卫(assertPublicHttpUrl，逐跳校验重定向) → 限时/限大小。
 *   - JavaScript：丢进 Docker node 沙箱（runNode，--network none）跑，绝不在主进程 eval。
 *     纯计算；需要联网的工具请用 http executor。
 */
import type { Tool, CustomToolRecord } from '../core/types.js';
import { deps } from '../seams/runtime.js';
import { assertPublicHttpUrl } from '../core/util/urlSafety.js';
import { runNode } from '../sandbox/dockerProvider.js';

// ── 注入依赖的 lazy 别名(保持下方调用点不变)──
const listCustomTools = (filter?: { appId?: string; market?: boolean; visibleOnly?: boolean }) =>
  deps().brain.assets.listCustomTools(filter);
const listForcedCustomTools = (appId?: string) => deps().brain.assets.listForcedCustomTools(appId);
const getSkill = (id: string) => deps().brain.assets.getSkill(id);

export interface CustomToolCtx {
  userId: string;
  sessionId: string;
  appId: string;
  signal?: AbortSignal;
}

export interface LoadedCustomTool {
  name: string;
  definition: Tool;
  executor: 'http' | 'javascript';
  http?: { url: string; method: string; headers: Record<string, string>; bodyTemplate?: string };
  code?: string;
  source: string; // 'custom_tools' | 'skill:<id>'
}

const HTTP_TIMEOUT_MS = 12_000;
const MAX_HTTP_BYTES = 256 * 1024;
const MAX_RESULT_CHARS = 8_000;
const MAX_REDIRECTS = 3;

function parseJsonMaybe<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return v as T;
}

function defaultParams(): any {
  return { type: 'object', properties: {}, required: [] };
}

function makeHttp(
  name: string, description: string, parameters: any,
  url: string, method: string | undefined, headers: any, bodyTemplate: string | undefined,
  source: string,
): LoadedCustomTool {
  return {
    name,
    definition: { type: 'function', function: { name, description: description || '', parameters: parameters || defaultParams() } },
    executor: 'http',
    http: {
      url: String(url),
      method: (method || 'GET').toUpperCase(),
      headers: parseJsonMaybe<Record<string, string>>(headers, {}),
      bodyTemplate: bodyTemplate ? String(bodyTemplate) : undefined,
    },
    source,
  };
}

function makeJs(name: string, description: string, parameters: any, code: string, source: string): LoadedCustomTool {
  return {
    name,
    definition: { type: 'function', function: { name, description: description || '', parameters: parameters || defaultParams() } },
    executor: 'javascript',
    code: String(code),
    source,
  };
}

function fromCustomToolRow(r: CustomToolRecord): LoadedCustomTool | null {
  if (!r || !r.name || !r.executor) return null;
  const parameters = parseJsonMaybe(r.parameters, defaultParams());
  if (r.executor === 'http') {
    if (!r.url_template) return null;
    return makeHttp(r.name, r.description || '', parameters, r.url_template, r.method || 'GET', r.headers, undefined, 'custom_tools');
  }
  if (r.executor === 'javascript') {
    if (!r.code) return null;
    return makeJs(r.name, r.description || '', parameters, r.code, 'custom_tools');
  }
  return null;
}

/** 技能自带工具（skills_catalog.tools 的一项）→ LoadedCustomTool（仅 http/javascript）。 */
function fromSkillTool(t: any, skillId: string): LoadedCustomTool | null {
  if (!t || !t.name) return null;
  const cfg = t.executorConfig || t.executor || null;
  const type = (cfg && cfg.type) || t.executorType;
  const parameters = t.parameters || defaultParams();
  if (type === 'http') {
    const url = cfg?.url || cfg?.url_template;
    if (!url) return null;
    return makeHttp(t.name, t.description || '', parameters, url, cfg?.method, cfg?.headers, cfg?.bodyTemplate, `skill:${skillId}`);
  }
  if (type === 'javascript') {
    const code = cfg?.code;
    if (!code) return null;
    return makeJs(t.name, t.description || '', parameters, code, `skill:${skillId}`);
  }
  return null; // builtin / mcp / 未知 → 此处不处理
}

/**
 * 加载本次 run 可用的自定义工具（按名去重，custom_tools 优先于技能自带；
 * 与内置工具同名的留给调用方在 registry 层过滤）。
 */
export async function loadCustomTools(appId: string, agentConfig: any): Promise<LoadedCustomTool[]> {
  const enabledToolIds: string[] = Array.isArray(agentConfig?.enabledToolIds) ? agentConfig.enabledToolIds : [];
  const enabledSkillIds: string[] = Array.isArray(agentConfig?.enabledSkillIds) ? agentConfig.enabledSkillIds : [];
  const byName = new Map<string, LoadedCustomTool>();

  // ① custom_tools 表：可见的按 enabledToolIds 选 + 强制的（管理员隐藏强开）
  try {
    const wanted = new Set(enabledToolIds);
    const [visible, forced] = await Promise.all([
      listCustomTools({ appId, visibleOnly: true }).catch(() => [] as CustomToolRecord[]),
      listForcedCustomTools(appId).catch(() => [] as CustomToolRecord[]),
    ]);
    const rows: CustomToolRecord[] = [];
    for (const r of visible) if (wanted.has(r.id)) rows.push(r);
    for (const r of forced) rows.push(r); // 强制：无视 enabled
    for (const r of rows) {
      const t = fromCustomToolRow(r);
      if (t && !byName.has(t.name)) byName.set(t.name, t);
    }
  } catch { /* 表缺失/查询失败 → 跳过 */ }

  // ② 技能自带工具
  if (enabledSkillIds.length) {
    const skills = (await Promise.all(enabledSkillIds.map((id) => getSkill(id).catch(() => null)))).filter(Boolean) as any[];
    for (const s of skills) {
      const tools = parseJsonMaybe<any[]>(s.tools, []);
      if (!Array.isArray(tools)) continue;
      for (const raw of tools) {
        const t = fromSkillTool(raw, s.id);
        if (t && !byName.has(t.name)) byName.set(t.name, t);
      }
    }
  }

  return Array.from(byName.values());
}

// ── 执行 ─────────────────────────────────────────────────────────────────

function interpolate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = (args as any)[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** 单次 fetch + 逐跳重定向 SSRF 复核 + 限时限大小。 */
async function safeFetch(rawUrl: string, init: RequestInit): Promise<string> {
  let current = await assertPublicHttpUrl(rawUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetch(current.toString(), {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return `HTTP ${res.status} (no Location)`;
      current = await assertPublicHttpUrl(new URL(loc, current).toString());
      continue;
    }
    // 读取并截断
    const reader = res.body?.getReader();
    if (!reader) {
      const txt = await res.text().catch(() => '');
      return `HTTP ${res.status}\n${txt.slice(0, MAX_RESULT_CHARS)}`;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remain = MAX_HTTP_BYTES - total;
      if (remain <= 0) { await reader.cancel(); break; }
      if (value.byteLength > remain) { chunks.push(value.slice(0, remain)); await reader.cancel(); break; }
      total += value.byteLength; chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const prefix = res.ok ? '' : `HTTP ${res.status}\n`;
    return (prefix + text).slice(0, MAX_RESULT_CHARS);
  }
  throw new Error('Too many redirects');
}

async function execHttp(tool: LoadedCustomTool, args: Record<string, unknown>): Promise<string> {
  const cfg = tool.http!;
  // SSRF 校验在 safeFetch 内逐跳进行（assertPublicHttpUrl：DNS + 私网/保留段拦截）。
  const url = interpolate(cfg.url, args);
  const headers: Record<string, string> = { ...cfg.headers };
  const init: RequestInit = { method: cfg.method, headers };
  if (cfg.method !== 'GET' && cfg.method !== 'HEAD' && cfg.bodyTemplate) {
    init.body = interpolate(cfg.bodyTemplate, args);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }
  return safeFetch(url, init);
}

const JS_SENTINEL = '__TANGU_RESULT__';

async function execJs(tool: LoadedCustomTool, args: Record<string, unknown>, ctx: CustomToolCtx): Promise<string> {
  // 包装：把 args 以 JSON 字面量内联，定义用户函数，执行(支持 async)，结果以哨兵前缀打印。
  const wrapper =
    `"use strict";\n` +
    `const args = ${JSON.stringify(args)};\n` +
    `(async () => {\n` +
    `  const __fn = (args) => {\n${tool.code}\n  };\n` +
    `  let __r = __fn(args);\n` +
    `  if (__r && typeof __r.then === 'function') __r = await __r;\n` +
    `  process.stdout.write("\\n${JS_SENTINEL}:" + JSON.stringify(__r === undefined ? null : __r));\n` +
    `})().catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });\n`;

  const res = await runNode(wrapper, { signal: ctx.signal, kind: `node:${tool.name}` });
  if (res.aborted) return 'Error: tool execution aborted';
  if (res.timedOut) return 'Error: tool execution timed out';

  const idx = res.stdout.lastIndexOf(`${JS_SENTINEL}:`);
  if (idx >= 0) {
    const payload = res.stdout.slice(idx + JS_SENTINEL.length + 1).trim();
    return (payload || 'null').slice(0, MAX_RESULT_CHARS);
  }
  // 没拿到结果哨兵 → 报错（带 stderr/stdout 便于排查）
  const err = (res.stderr || res.stdout || `exit ${res.exitCode}`).trim();
  return `Error: ${err.slice(0, MAX_RESULT_CHARS)}`;
}

export async function executeCustomTool(
  tool: LoadedCustomTool,
  args: Record<string, unknown>,
  ctx: CustomToolCtx,
): Promise<string> {
  if (tool.executor === 'http') return execHttp(tool, args);
  if (tool.executor === 'javascript') return execJs(tool, args, ctx);
  return `Error: unsupported executor`;
}
