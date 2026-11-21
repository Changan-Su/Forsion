/**
 * Multi-account mode leak tests: shared harness.
 *
 * Everything here is test-side observation. The engine under test is the real one (express app, routes, run loop, tools);
 * only the model is fake. The fake model is scripted per run through a marker in the user message and records every
 * outbound request it receives (after the engine's outbound masking, i.e. what really leaves the process).
 *
 * Nothing in this module imports engine source statically: the test files set the multi-account environment in
 * vi.hoisted() and the engine modules are loaded with dynamic import() afterwards.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { spawnSpyState } from './multiAccountSpawnSpy.js';

export const MODEL_ID = 'fake/model-1';
/** Must equal the TANGU_LOCAL_TOKEN the test files set in vi.hoisted(). */
export const LOCAL_TOKEN = 'multi-account-local-host-token-qwertyuiop';

// ── random strings ──────────────────────────────────────────────────────────────────────────────────────────────
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
function pick(alphabet: string, n: number): string {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[b[i] % alphabet.length];
  return s;
}
export const randUpper = (n: number) => pick(UPPER, n);
export const randLower = (n: number) => pick(LOWER, n);
export const randDigits = (n: number) => pick('0123456789', n);
/**
 * A content canary: letters and underscores only. No digits (phone / card / id-card masking rules), no secret-like
 * shapes (`sk-`, `token=`, ...), so outbound masking and log redaction never rewrite it and "bob can't see it" can't
 * pass just because a redactor ate it.
 */
export const canary = (owner: string, purpose: string) => `${owner.toUpperCase()}_CANARY_${purpose.toUpperCase()}_${randUpper(12)}`;
/** Looks like an API key to the masking rules (sk-proj- + 40 mixed chars). */
export const fakeApiKey = () => `sk-proj-${pick(UPPER + LOWER + '0123456789', 40)}`;
/** A password value for the "密码：<value>" rule: letters + digits, ≥ 8 chars, no 11-digit run. */
export const fakePassword = () => `${randUpper(3)}${randLower(3)}${randDigits(3)}${randUpper(3)}${randLower(4)}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── markers: which script drives which run ───────────────────────────────────────────────────────────────────────
const MARK_RE = /MA-MARK\(([a-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Z]+)\)/g;
export function markerAccountsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MARK_RE)) out.add(m[1]);
  return [...out];
}

// ── fake model ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface ToolCallSpec { name: string; args: Record<string, unknown> }
export type StepOut = { calls: ToolCallSpec[] } | { text: string };
export interface ToolResult { callId: string; name: string; args: Record<string, unknown>; output: string; step: number }
export interface ScriptCtx {
  step: number;
  offered: Set<string>;
  schemas: Map<string, any>;
  results: ToolResult[];
  record: OutboundRecord;
}
export interface Script {
  account: string;
  label: string;
  token: string;
  marker: string;
  next: (ctx: ScriptCtx) => StepOut | Promise<StepOut>;
  plan: Map<number, StepOut>;
  /** latest view of all tool calls + results of this run (from the newest outbound request) */
  results: ToolResult[];
  requests: OutboundRecord[];
  /** every tool name this script asked the engine to run */
  called: Set<string>;
  runIds: Set<string>;
  /** attach the run started for this script (startRun does this as soon as POST /agent/runs answers) */
  bindRun: (runId: string) => void;
}

export interface OutboundRecord {
  seq: number;
  at: number;
  /** a run-loop call (has runId and streams), not a background call (title, memory judge, ...) */
  main: boolean;
  runId?: string;
  /** script / account of the run this call belongs to, by runId (authoritative; undefined for unbound runs and background calls) */
  token?: string;
  runAccount?: string;
  /** every account whose marker appears anywhere in this payload */
  markerAccounts: string[];
  /** account bound in the engine context when the model was called; null = no account; undefined = not observable */
  ctxAccount?: string | null;
  text: string;
  tools: string[];
  signal?: AbortSignal;
}

/** The account an outbound request belongs to, as far as the test can tell: its run, else the engine context. */
export const outboundAccount = (r: OutboundRecord): string | undefined => r.runAccount ?? (r.ctxAccount || undefined);

export interface FakeBrain {
  brain: any;
  outbound: OutboundRecord[];
  scripts: Map<string, Script>;
  script(account: string, label: string, next: Script['next']): Script;
  /** Holds the main-loop call of the given script at `step` until released. */
  gate(token: string, step: number): { release: () => void; reached: Promise<void>; signal: () => AbortSignal | undefined };
}

function toolName(t: any): string {
  return String(t?.function?.name ?? t?.name ?? '');
}
function msgText(m: any): string {
  return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
}

export function createFakeBrain(opts: { currentAccount?: () => string | null | undefined; defaultText?: string } = {}): FakeBrain {
  const outbound: OutboundRecord[] = [];
  const scripts = new Map<string, Script>();
  const runScripts = new Map<string, Script>();
  const gates = new Map<string, { promise: Promise<void>; release: () => void; reached: Promise<void>; hit: () => void; signal?: AbortSignal }>();
  let seq = 0;

  const ctxAccount = (): string | null | undefined => {
    if (!opts.currentAccount) return undefined;
    try { return opts.currentAccount() ?? null; } catch { return null; }
  };

  const llm = {
    resolveModelAndKey: async (modelId: string) => ({
      model: { id: modelId || MODEL_ID, name: 'Fake model', provider: 'fake', context_window: 200_000, contextWindow: 200_000, max_tokens: 8192 },
      apiKey: 'fake-provider-credential',
      baseUrl: 'https://fake-model.invalid/v1',
      apiModelId: modelId || MODEL_ID,
    }),
    buildProviderPayload: async (o: any) => ({
      __ma: { main: !!o.runId && o.stream === true, runId: o.runId ?? null },
      model: o.apiModelId,
      messages: structuredClone(o.messages ?? []),
      ...(Array.isArray(o.tools) ? { tools: structuredClone(o.tools) } : {}),
    }),
    streamProviderCompletion: async (o: any) => {
      const payload = o.payload ?? {};
      const text = (() => { try { return JSON.stringify(payload); } catch { return String(payload); } })();
      const messages: any[] = Array.isArray(payload.messages) ? payload.messages : [];
      const tools: any[] = Array.isArray(payload.tools) ? payload.tools : [];
      const runId: string | undefined = payload.__ma?.runId ?? undefined;
      const main = payload.__ma?.main === true;
      let script = runId ? runScripts.get(runId) : undefined;
      // the first call of a run can arrive before POST /agent/runs has answered: wait for the binding when the payload
      // carries the marker of a script that has no run yet
      if (!script && main && runId && [...text.matchAll(MARK_RE)].some((m) => scripts.get(m[3])?.runIds.size === 0)) {
        for (let i = 0; i < 60 && !script; i++) { await sleep(50); script = runScripts.get(runId); }
      }
      const rec: OutboundRecord = {
        seq: ++seq,
        at: Date.now(),
        main,
        runId,
        token: script?.token,
        runAccount: script?.account,
        markerAccounts: markerAccountsIn(text),
        ctxAccount: ctxAccount(),
        text,
        tools: tools.map(toolName).filter(Boolean),
        signal: o.signal,
      };
      outbound.push(rec);
      if (!main || !script) return reply(o, opts.defaultText ?? 'ok');
      const token = script.token;
      // where this run's own user message sits (results are read from the messages after it)
      let markIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user' && msgText(messages[i]).includes(script.marker)) { markIdx = i; break; }
      }
      // step = how many times the loop has asked for this run so far (does not depend on how the engine replays
      // rejected / unknown tool calls in history)
      const step = script.requests.length;
      script.requests.push(rec);

      // results of this run so far: assistant tool calls after the marker + the tool messages answering them
      const byId = new Map<string, { name: string; args: Record<string, unknown>; step: number }>();
      let turn = 0;
      const results: ToolResult[] = [];
      for (const m of messages.slice(markIdx + 1)) {
        if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          for (const tc of m.tool_calls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc?.function?.arguments || '{}'); } catch { /* keep {} */ }
            byId.set(String(tc.id), { name: String(tc?.function?.name), args, step: turn });
          }
          turn++;
        } else if (m?.role === 'tool') {
          const c = byId.get(String(m.tool_call_id));
          results.push({ callId: String(m.tool_call_id), name: c?.name ?? '?', args: c?.args ?? {}, output: msgText(m), step: c?.step ?? -1 });
        }
      }
      script.results = results;

      const g = gates.get(`${token}:${step}`);
      if (g) { g.signal = o.signal; g.hit(); await g.promise; }

      let out = script.plan.get(step);
      if (!out) {
        const schemas = new Map<string, any>(tools.map((t) => [toolName(t), t?.function?.parameters ?? t?.parameters ?? {}]));
        out = await script.next({ step, offered: new Set(rec.tools), schemas, results, record: rec });
        script.plan.set(step, out);
      }
      if ('calls' in out && out.calls.length && tools.length) {
        for (const c of out.calls) script.called.add(c.name);
        return {
          content: '',
          reasoning: '',
          toolCalls: out.calls.map((c, j) => ({ id: `call_${token}_${step}_${j}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          finishReason: 'tool_calls',
        };
      }
      return reply(o, 'text' in out ? out.text : `Finished ${script.label}.`);
    },
  };

  function reply(o: any, content: string) {
    // stream in two halves so a canary in the reply is split across token events
    const cut = Math.floor(content.length / 2);
    o.onToken?.(content.slice(0, cut));
    o.onToken?.(content.slice(cut));
    return { content, reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
  }

  const fakeModels = [{ id: MODEL_ID, name: 'Fake model', provider: 'fake' }];
  const brain = {
    llm,
    users: { getUserById: async (id: string) => ({ id, username: id, role: 'USER' }) },
    // replaced by the caller with the local (per-home) memory brain, exactly like standalone assembly does
    memory: { getMemory: async () => ({ content: '', updatedAt: null }), appendMemoryEntry: async () => ({ appended: false }), appendLogEntry: async () => ({ date: '', time: '' }), getLog: async () => ({ date: '', content: '', updatedAt: null }) },
    assets: { getSkill: async () => null, listCustomTools: async () => [], listForcedCustomTools: async () => [], listSkills: async () => [] },
    search: { runSearch: async () => ({ provider: 'fake', text: 'no results', results: [] }) },
    models: {
      listGlobalModels: async () => fakeModels,
      listModelsForProject: async () => ({ models: fakeModels, defaultModelId: MODEL_ID, backgroundModelId: MODEL_ID, reachable: true }),
      hasDirectModel: () => false,
    },
    storage: {
      listDirectory: async () => { throw new Error('cloud storage is not available in this test'); },
      createDirectory: async () => { throw new Error('cloud storage is not available in this test'); },
      getFileContent: async () => { throw new Error('cloud storage is not available in this test'); },
      updateFileContent: async () => { throw new Error('cloud storage is not available in this test'); },
      uploadFile: async () => { throw new Error('cloud storage is not available in this test'); },
      deleteItem: async () => { throw new Error('cloud storage is not available in this test'); },
    },
  };

  return {
    brain,
    outbound,
    scripts,
    script(account, label, next) {
      const token = randUpper(10);
      const s: Script = {
        account, label, token, marker: `MA-MARK(${account}/${label}/${token})`, next, plan: new Map(), results: [], requests: [], called: new Set(),
        runIds: new Set(),
        bindRun: (runId: string) => { s.runIds.add(runId); runScripts.set(runId, s); },
      };
      scripts.set(token, s);
      return s;
    },
    gate(token, step) {
      let release!: () => void;
      let hit!: () => void;
      const promise = new Promise<void>((r) => { release = r; });
      const reached = new Promise<void>((r) => { hit = r; });
      const g = { promise, release, reached, hit, signal: undefined as AbortSignal | undefined };
      gates.set(`${token}:${step}`, g);
      return { release, reached, signal: () => g.signal };
    },
  };
}

/** A script from a fixed list of steps; a step may be a function of the context. Ends with `final`. */
export function steps(list: Array<StepOut | ((ctx: ScriptCtx) => StepOut | Promise<StepOut>)>, final: string): Script['next'] {
  return async (ctx) => {
    let i = ctx.step;
    // skip steps that resolve to no calls
    for (;;) {
      const s = list[i];
      if (s === undefined) return { text: final };
      const out = typeof s === 'function' ? await s(ctx) : s;
      if ('calls' in out && out.calls.length === 0) { list.splice(i, 1); continue; }
      return out;
    }
  };
}

// ── HTTP client that keeps every response ────────────────────────────────────────────────────────────────────────
export interface Resp {
  seq: number;
  user: string | null;
  method: string;
  url: string;
  status: number;
  contentType: string;
  text: string;
  json: any;
  sent: string;
  label?: string;
  events?: any[];
}
export interface CallOpts {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  /** read a text/event-stream response for this long, then hang up */
  streamMs?: number;
  timeoutMs?: number;
  noAuth?: boolean;
  authToken?: string;
  label?: string;
}
async function readBody(res: Response, ms: number, ac: AbortController): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  const end = Date.now() + ms;
  try {
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) break;
      const p = reader.read();
      p.catch(() => {});
      const r = await Promise.race([p, sleep(left).then(() => null)]);
      if (!r || r.done) break;
      out += dec.decode(r.value, { stream: true });
    }
  } catch { /* aborted */ }
  try { ac.abort(); } catch { /* ignore */ }
  return out;
}

export class Client {
  log: Resp[] = [];
  private n = 0;
  constructor(readonly base: string, readonly token = LOCAL_TOKEN) {}

  url(path: string, query?: Record<string, unknown>): string {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(query ?? {})) for (const x of [v].flat()) if (x !== undefined && x !== null) u.searchParams.append(k, String(x));
    return u.toString();
  }

  async call(user: string | null, method: string, path: string, o: CallOpts = {}): Promise<Resp> {
    const url = this.url(path, o.query);
    const headers: Record<string, string> = {
      ...(o.noAuth ? {} : { Authorization: `Bearer ${o.authToken ?? this.token}` }),
      ...(user !== null ? { 'X-Forsion-User': user } : {}),
      ...(o.headers ?? {}),
    };
    let body: string | undefined;
    if (o.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      body = JSON.stringify(o.body);
      headers['Content-Type'] = 'application/json';
    }
    const ac = new AbortController();
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: 'manual' });
    } catch (e: any) {
      const r: Resp = { seq: ++this.n, user, method, url, status: -1, contentType: '', text: String(e?.message || e), json: null, sent: `${url}\n${body ?? ''}`, label: o.label };
      this.log.push(r);
      return r;
    }
    const contentType = res.headers.get('content-type') ?? '';
    const text = await readBody(res, contentType.includes('text/event-stream') ? (o.streamMs ?? 800) : (o.timeoutMs ?? 30_000), ac);
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    const r: Resp = { seq: ++this.n, user, method, url, status: res.status, contentType, text, json, sent: `${url}\n${body ?? ''}`, label: o.label };
    this.log.push(r);
    return r;
  }

  /** Raw request with exact header lines (duplicates, empty values). */
  /** A request sent byte-for-byte as given: no URL normalization (`..`, `%2e%2e`, backslashes reach the server as typed). */
  raw(method: string, path: string, headers: Record<string, string | string[]>, body?: unknown): Promise<{ status: number; text: string }> {
    const u = new URL(this.base);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (payload) headers = { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(payload.length) };
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          const r = { status: res.statusCode ?? -1, text: buf };
          this.log.push({ seq: ++this.n, user: null, method, url: u.origin + path, status: r.status, contentType: String(res.headers['content-type'] ?? ''), text: buf, json: null, sent: JSON.stringify(headers), label: 'raw' });
          resolve(r);
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  /**
   * Follow a run's event stream until done/error (or `until`). Approval requests are approved and inquiries answered
   * by the same account unless told otherwise — an adversarial user approves whatever their own run asks for.
   */
  async follow(user: string, runId: string, o: { timeoutMs?: number; autoApprove?: boolean; autoAnswer?: string | false; until?: (ev: any) => boolean } = {}): Promise<{ status: 'done' | 'error' | 'until' | 'timeout' | 'http'; httpStatus: number; events: any[]; text: string; final: string }> {
    const url = this.url(`/agent/runs/${encodeURIComponent(runId)}/events`, { fromSeq: 0 });
    const ac = new AbortController();
    const events: any[] = [];
    let text = '';
    let status: 'done' | 'error' | 'until' | 'timeout' | 'http' = 'timeout';
    let httpStatus = -1;
    const side: Promise<unknown>[] = [];
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}`, 'X-Forsion-User': user }, signal: ac.signal });
      httpStatus = res.status;
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        text = await res.text();
        status = 'http';
      } else {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        const end = Date.now() + (o.timeoutMs ?? 60_000);
        outer: for (;;) {
          const left = end - Date.now();
          if (left <= 0) break;
          const p = reader.read();
          p.catch(() => {});
          const r = await Promise.race([p, sleep(left).then(() => null)]);
          if (!r || r.done) break;
          const chunk = dec.decode(r.value, { stream: true });
          text += chunk;
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              let ev: any;
              try { ev = JSON.parse(line.slice(6)); } catch { continue; }
              events.push(ev);
              if (ev.type === 'approval_request' && o.autoApprove !== false && ev.payload?.approvalId) {
                side.push(this.call(user, 'POST', `/agent/runs/${runId}/approvals/${ev.payload.approvalId}`, { body: { action: 'approve' }, label: 'auto-approve' }));
              }
              if (ev.type === 'inquiry_request' && o.autoAnswer !== false && ev.payload?.inquiryId && !String(ev.payload.inquiryId).startsWith('ui_') && !String(ev.payload.inquiryId).startsWith('cc_')) {
                side.push(this.call(user, 'POST', `/agent/runs/${runId}/inquiries/${ev.payload.inquiryId}`, { body: { answer: o.autoAnswer ?? 'ok' }, label: 'auto-answer' }));
              }
              if (o.until?.(ev)) { status = 'until'; break outer; }
              if (ev.type === 'done') { status = 'done'; break outer; }
              if (ev.type === 'error') { status = 'error'; break outer; }
            }
          }
        }
      }
    } catch { /* aborted / closed */ }
    try { ac.abort(); } catch { /* ignore */ }
    await Promise.allSettled(side);
    const final = events.filter((e) => e.type === 'done').map((e) => String(e.payload?.content ?? '')).join('');
    this.log.push({ seq: ++this.n, user, method: 'GET', url, status: httpStatus, contentType: 'text/event-stream', text, json: events, sent: url, label: 'follow', events });
    return { status, httpStatus, events, text, final };
  }
}

/** Start a scripted run (script from fake.script()); binds the new runId to the script. */
export async function startRun(c: Client, user: string, script: Script, o: { sessionId?: string; text?: string; agentConfig?: Record<string, unknown>; headers?: Record<string, string> } = {}): Promise<{ resp: Resp; runId?: string; sessionId: string }> {
  const sessionId = o.sessionId ?? randomUUID();
  const resp = await c.call(user, 'POST', '/agent/runs', {
    body: { session_id: sessionId, model_id: MODEL_ID, message: `${script.marker} ${o.text ?? ''}`.trim(), ...(o.agentConfig ? { agent_config: o.agentConfig } : {}) },
    headers: o.headers,
    label: `run:${script.label}`,
  });
  if (resp.json?.runId) script.bindRun(resp.json.runId);
  return { resp, runId: resp.json?.runId, sessionId };
}

export async function runToEnd(c: Client, user: string, script: Script, o: Parameters<typeof startRun>[3] & { timeoutMs?: number; autoAnswer?: string | false } = {}) {
  const started = await startRun(c, user, script, o);
  if (!started.runId) return { ...started, follow: null as null | Awaited<ReturnType<Client['follow']>> };
  const follow = await c.follow(user, started.runId, { timeoutMs: o.timeoutMs ?? 60_000, autoAnswer: o.autoAnswer });
  return { ...started, follow };
}

// ── canary scanning ─────────────────────────────────────────────────────────────────────────────────────────────
function decodedForms(s: string, out: string[]): void {
  const b64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
  if (s.length >= 12 && b64.test(s)) {
    try { out.push(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { /* ignore */ }
  }
  for (const m of s.matchAll(/base64,([A-Za-z0-9+/=]{12,})/g)) {
    try { out.push(Buffer.from(m[1], 'base64').toString('utf8')); } catch { /* ignore */ }
  }
  if (s.includes('%')) { try { out.push(decodeURIComponent(s)); } catch { /* ignore */ } }
}

/** Which of `needles` occur in `text`, also inside JSON strings, SSE frames (token deltas reassembled), base64, %-encoding. */
export function leakHits(text: string, needles: string[]): string[] {
  const hits = new Set<string>();
  const live = needles.filter(Boolean);
  const check = (s: string) => { if (s) for (const n of live) if (s.includes(n)) hits.add(n); };
  check(text);
  const strings: string[] = [];
  const walk = (v: any): void => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  try { walk(JSON.parse(text)); } catch { /* not json */ }
  const deltas: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const ev = JSON.parse(line.slice(6));
      walk(ev);
      if ((ev?.type === 'token' || ev?.type === 'reasoning') && typeof ev.payload?.delta === 'string') {
        const k = `${ev.type}`;
        deltas[k] = (deltas[k] ?? '') + ev.payload.delta;
      }
    } catch { /* ignore */ }
  }
  Object.values(deltas).forEach(check);
  const extra: string[] = [];
  for (const s of strings) { check(s); decodedForms(s, extra); }
  decodedForms(text, extra);
  extra.forEach(check);
  return [...hits];
}

export function respLeaks(r: Resp, needles: string[]): string[] {
  const hits = new Set(leakHits(r.text, needles));
  if (r.events) {
    // token deltas are reassembled per run from the parsed events too
    const tok = r.events.filter((e) => e?.type === 'token').map((e) => String(e.payload?.delta ?? '')).join('');
    for (const h of leakHits(tok, needles)) hits.add(h);
  }
  return [...hits];
}

export function describeResp(r: Resp): string {
  return `${r.method} ${r.url} [${r.user ?? '-'}] → ${r.status}${r.label ? ` (${r.label})` : ''}\n${r.text.slice(0, 600)}`;
}

// ── route enumeration (express 4) ───────────────────────────────────────────────────────────────────────────────
export interface RouteEntry { method: string; path: string; kind: 'route' | 'mount' | 'regex' }

function mountPathOf(layer: any): string {
  const re: RegExp | undefined = layer?.regexp;
  if (!re || (re as any).fast_slash) return '';
  let src = re.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  let i = 0;
  const param = () => `:${layer.keys?.[i++]?.name ?? 'param'}`;
  // path-to-regexp 0.1.x spells a segment param as (?:\/([^/]+?)) or (?:([^\/]+?)) depending on version
  src = src.replace(/\(\?:\\\/\(\[\^\\?\/\]\+\?\)\)/g, () => `/${param()}`).replace(/\(\?:\(\[\^\\?\/\]\+\?\)\)/g, param);
  src = src.replace(/\\\//g, '/').replace(/\\-/g, '-').replace(/\\\./g, '.');
  if (/[\\()[\]^$*+?|{}]/.test(src)) throw new Error(`cannot recover the mount path of a router layer from ${re}`);
  return src;
}

export function enumerateRoutes(app: any): RouteEntry[] {
  const router = app?._router ?? app?.router;
  if (!router?.stack) throw new Error('express app has no router stack');
  const out: RouteEntry[] = [];
  const seen = new Set<string>();
  const add = (e: RouteEntry) => { const k = `${e.method} ${e.path}`; if (!seen.has(k)) { seen.add(k); out.push(e); } };
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) {
          if (typeof p !== 'string') { add({ method: '*', path: String(p), kind: 'regex' }); continue; }
          const methods = Object.keys(layer.route.methods ?? {}).filter((m) => layer.route.methods[m]);
          for (const m of methods) add({ method: m === '_all' ? 'ALL' : m.toUpperCase(), path: (prefix + p).replace(/\/{2,}/g, '/'), kind: 'route' });
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack, prefix + mountPathOf(layer));
      } else {
        const mp = mountPathOf(layer);
        if (mp && mp !== '/') add({ method: 'USE', path: prefix + mp, kind: 'mount' });
      }
    }
  };
  walk(router.stack, '');
  return out;
}

export const routeKey = (method: string, path: string) => `${method.toUpperCase()} ${path}`;
export const paramNames = (path: string) => [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
export function fillPath(path: string, value: (name: string, path: string) => string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)\??/g, (_, k) => encodeURIComponent(value(k, path)));
}

// ── file tree snapshots ─────────────────────────────────────────────────────────────────────────────────────────
export type Snap = Map<string, string>;
export function snapshotTree(root: string): Snap {
  const out: Snap = new Map();
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      const rel = relative(root, abs).split(sep).join('/');
      if (st.isSymbolicLink()) { let t = ''; try { t = readlinkSync(abs); } catch { /* ignore */ } out.set(rel, `L:${t}`); }
      else if (st.isDirectory()) walk(abs);
      else if (st.isFile()) {
        let h = '';
        try { h = createHash('sha1').update(readFileSync(abs)).digest('hex'); } catch { h = 'unreadable'; }
        out.set(rel, `F:${st.size}:${h}`);
      }
    }
  };
  walk(root);
  return out;
}
export function diffSnaps(a: Snap, b: Snap): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  for (const [k, v] of b) { if (!a.has(k)) added.push(k); else if (a.get(k) !== v) changed.push(k); }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);
  return { added, changed, removed };
}
/** Wait until the tree and the fake model's call count stop changing. */
export async function waitQuiet(root: string, counter: () => number, o: { quietMs?: number; maxMs?: number } = {}): Promise<Snap> {
  const quietMs = o.quietMs ?? 700, end = Date.now() + (o.maxMs ?? 12_000);
  let last = snapshotTree(root), lastN = counter(), stableSince = Date.now();
  for (;;) {
    await sleep(150);
    const s = snapshotTree(root), n = counter();
    const same = n === lastN && diffSnaps(last, s).added.length + diffSnaps(last, s).changed.length + diffSnaps(last, s).removed.length === 0;
    if (!same) { last = s; lastN = n; stableSince = Date.now(); }
    if (Date.now() - stableSince >= quietMs || Date.now() > end) return s;
  }
}

/** What a refused tool call answers (an unknown or unavailable tool, a denied path, …). */
export const REFUSAL_RE = /error|unknown|not (available|allowed|found|permitted|enabled)|denied|refus|disabled|unavailable|no such tool|does not exist/i;

/** First step of a script: load the named tools that this run was not offered (deferred tools), if load_tools exists. */
export const loadToolsStep = (names: string[]) => (ctx: ScriptCtx): StepOut => {
  const missing = names.filter((n) => !ctx.offered.has(n));
  return { calls: missing.length && ctx.offered.has('load_tools') ? [{ name: 'load_tools', args: { names: missing } }] : [] };
};

// ── engine-level session registry ───────────────────────────────────────────────────────────────────────────────
/**
 * Session ids are one namespace across accounts in multi-account mode, so the engine keeps one registry outside every
 * account folder: `<TANGU_HOME>/session-owners.db` (+ its -wal / -shm). It is the only engine-level file an account's
 * activity may write, and it may hold nothing but "session id → account" plus timestamps.
 */
export const OWNER_REGISTRY_FILE = 'session-owners.db';
export const OWNER_REGISTRY_RE = /^home\/session-owners\.db(-wal|-shm|-journal)?$/;

/**
 * Problems with the registry: anything besides one `session_owners` table (plus its indexes), columns other than
 * session_id / account_id / *_at, rows whose account is not one of `accounts` or whose session id is not an id, timestamps that are not timestamps,
 * and any needle in its rows or in the raw bytes of the db / -wal / -shm. `minRows` guards against an empty scan.
 */
export function ownerRegistryProblems(home: string, needles: string[], accounts: string[], minRows = 1): string[] {
  const file = join(home, OWNER_REGISTRY_FILE);
  if (!existsSync(file)) return minRows > 0 ? [`${OWNER_REGISTRY_FILE} does not exist`] : [];
  const problems: string[] = [];
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    if (!existsSync(f)) continue;
    const hits = needles.filter((n) => n && readFileSync(f).toString('latin1').includes(n));
    if (hits.length) problems.push(`${f.split(sep).pop()} bytes contain ${hits.join(', ')}`);
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const objs = db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ type: string; name: string; tbl_name: string }>;
    const tables = objs.filter((o) => o.type === 'table').map((o) => o.name);
    if (tables.join(',') !== 'session_owners') problems.push(`tables: ${JSON.stringify(tables)} (only session_owners allowed)`);
    for (const o of objs) if (o.type !== 'table' && !(o.type === 'index' && o.tbl_name === 'session_owners')) problems.push(`schema object ${o.type} ${o.name}`);
    if (!tables.includes('session_owners')) return problems;
    const cols = (db.prepare('PRAGMA table_info(session_owners)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const need of ['session_id', 'account_id']) if (!cols.includes(need)) problems.push(`column ${need} missing (${cols.join(', ')})`);
    const extra = cols.filter((c) => c !== 'session_id' && c !== 'account_id' && !/_at$/.test(c));
    if (extra.length) problems.push(`columns beyond session_id / account_id / *_at: ${extra.join(', ')}`);
    const rows = db.prepare('SELECT * FROM session_owners').all() as Array<Record<string, unknown>>;
    if (rows.length < minRows) problems.push(`${rows.length} rows (expected at least ${minRows})`);
    for (const r of rows) {
      if (!accounts.includes(String(r.account_id))) problems.push(`row account ${JSON.stringify(r.account_id)} is not one of ${accounts.join(', ')}`);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(r.session_id))) problems.push(`row session id ${JSON.stringify(r.session_id).slice(0, 80)} is not an id`);
      for (const [k, v] of Object.entries(r)) {
        if (/_at$/.test(k) && v != null && typeof v !== 'number' && !/^\d{4}-\d\d-\d\d[T ][\d:.]+(Z|[+-]\d\d:?\d\d)?$/.test(String(v))) problems.push(`${k} is not a timestamp: ${JSON.stringify(v).slice(0, 80)}`);
      }
    }
    const dump = JSON.stringify(rows);
    const hits = leakHits(dump, needles);
    if (hits.length) problems.push(`rows contain ${hits.join(', ')}`);
  } finally {
    db.close();
  }
  return problems;
}

/** Files under `root` (except those `skip` accepts) whose bytes contain any needle. */
export function grepTree(root: string, needles: string[], skip: (rel: string) => boolean = () => false): Array<{ file: string; needle: string }> {
  const out: Array<{ file: string; needle: string }> = [];
  for (const [rel, sig] of snapshotTree(root)) {
    if (!sig.startsWith('F:') || skip(rel)) continue;
    let buf: Buffer;
    try { buf = readFileSync(join(root, rel)); } catch { continue; }
    const s = buf.toString('latin1');
    for (const n of needles) if (n && s.includes(n)) out.push({ file: rel, needle: n });
  }
  return out;
}
/** Absolute paths of files under `dir` whose content contains `needle`. */
export function findFilesContaining(dir: string, needle: string): string[] {
  if (!existsSync(dir)) return [];
  return grepTree(dir, [needle]).map((h) => join(dir, h.file));
}
/** Databases, logs and snapshot copies also hold the text; they are not "the file". */
const NOT_THE_FILE = /\.(db|db-wal|db-shm|sqlite|jsonl|log)$|\/(checkpoints|trash|\.trash|activity|human-history)\//;
/** The plain file under `dir` holding `needle`: the one named `name` if given, else the first that is not a db / log / copy. */
export function findFile(dir: string, needle: string, name?: string): string {
  const all = findFilesContaining(dir, needle).filter((p) => !NOT_THE_FILE.test(p));
  return (name ? all.find((p) => p.split('/').pop() === name) : undefined) ?? all[0] ?? '';
}

// ── engine boot ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface MaEngine {
  app: any;
  server: import('node:http').Server;
  base: string;
  client: Client;
  fake: FakeBrain;
  routeAllowlist: ReadonlyArray<{ method: string; path: string }>;
  toolAllowlist: ReadonlyArray<string>;
  routes: RouteEntry[];
  scope: any;
  dispose: () => Promise<void>;
}

/**
 * Boot the multi-account engine through its test entry, the same function the standalone entry uses.
 * The brain passed in mirrors what the standalone assembly hands over (local per-home memory and skills overlays)
 * with the model replaced by the fake and **without** outbound masking: the entry itself must wrap it.
 */
export async function bootMultiAccount(o: { bundleDirs?: string[] } = {}): Promise<MaEngine> {
  const scope: any = await import('../../src/core/accountScope.js');
  const ma: any = await import('../../src/standalone/multiAccount.js');
  if (typeof ma.createMultiAccountApp !== 'function') throw new Error('src/standalone/multiAccount.ts does not export createMultiAccountApp');
  const { createLocalMemoryBrain } = await import('../../src/adapters/standalone/localMemoryBrain.js');
  const { createLocalAssets } = await import('../../src/adapters/standalone/localAssetsBrain.js');
  const fake = createFakeBrain({ currentAccount: () => scope.currentAccountId?.() });
  spawnSpyState().currentAccount = () => scope.currentAccountId?.();
  const brain = {
    ...fake.brain,
    memory: createLocalMemoryBrain({ deviceId: 'multi-account-test-device', deviceName: null }),
    assets: createLocalAssets(fake.brain.assets as any, false),
  };
  const created = await ma.createMultiAccountApp({ localToken: LOCAL_TOKEN, brain, defaultModelId: MODEL_ID, bundleDirs: o.bundleDirs ?? [] });
  const server = created.app.listen(0, '127.0.0.1') as import('node:http').Server;
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const routes = enumerateRoutes(created.app);
  return {
    app: created.app,
    server,
    base,
    client: new Client(base),
    fake,
    routeAllowlist: created.routeAllowlist,
    toolAllowlist: created.toolAllowlist,
    routes,
    scope,
    dispose: async () => {
      try { (server as any).closeAllConnections?.(); } catch { /* ignore */ }
      await new Promise<void>((r) => server.close(() => r()));
      await created.dispose?.();
    },
  };
}

// ── tools ───────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Tools multi-account mode keeps out (host commands / subprocesses, Muse, schedules and automation,
 * MCP, browser, channels, inbox, hooks, external engines, cloud account, publishing, store, git), plus tools that read
 * the host machine rather than any account (screen, computer history).
 */
export const FORBIDDEN_TOOL_RE =
  /^(run_bash|run_background|run_python|pip_install|kill_process|list_processes|read_process_output|write_process_input|view_video|read_document|publish_web_page|forsion_account|forsion_account_action|search_marketplace|get_marketplace_plugin|plugin_sandbox|plugin_sandbox_inspect|desk_screenshot|desk_present|read_computer_history)$|muse|schedule|automation|mcp|browser|channel|wechat|inbox|hook|engine|^git/i;

/** Names a forbidden-tool probe asks load_tools for. */
export const FORBIDDEN_PROBE_NAMES = ['run_bash', 'run_background', 'run_python', 'manage_mcp', 'manage_schedule', 'manage_automation', 'browser_navigate', 'channel_send_file', 'inbox_send', 'muse_space', 'publish_web_page', 'forsion_account', 'read_document', 'view_video'];

export interface HostileTargets {
  fileAbs: string;
  dirAbs: string;
  sessionId: string;
  runId: string;
  agentSlug: string;
  skillSlug: string;
  shellMarker: string;
}

const READISH = ['list', 'read', 'get', 'search', 'status', 'show', 'view', 'query', 'info'];
/** Fill a tool's JSON-schema parameters with the other account's paths / ids / slugs. */
export function hostileArgs(schema: any, t: HostileTargets): Record<string, unknown> {
  const props: Record<string, any> = schema?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) {
    const type = Array.isArray(p?.type) ? p.type.find((x: string) => x !== 'null') : p?.type;
    const n = k.toLowerCase();
    let v: unknown;
    if (Array.isArray(p?.enum) && p.enum.length) v = p.enum.find((e: unknown) => READISH.includes(String(e))) ?? p.enum[0];
    else if (type === 'array') v = /name|tool/.test(n) ? [...FORBIDDEN_PROBE_NAMES] : /session/.test(n) ? [t.sessionId] : /slug|agent/.test(n) ? [t.agentSlug] : [t.fileAbs];
    else if (type === 'boolean') v = false;
    else if (type === 'number' || type === 'integer') v = 5;
    else if (type === 'object') v = {};
    else if (/path|file|dir|cwd|root|source|target|dest|folder|location/.test(n)) v = /dir|folder|root|cwd/.test(n) ? t.dirAbs : t.fileAbs;
    else if (/url|uri|href|link/.test(n)) v = `file://${t.fileAbs}`;
    else if (/session/.test(n)) v = t.sessionId;
    else if (/run/.test(n)) v = t.runId;
    else if (/skill/.test(n)) v = `local:${t.skillSlug}`;
    else if (/slug|agent/.test(n)) v = t.agentSlug;
    else if (n === 'id' || /_id$/.test(n) || /Id$/.test(k)) v = t.sessionId;
    else if (/command|cmd|code|script|shell/.test(n)) v = `touch ${t.shellMarker}`;
    else if (/query|pattern|search|^q$|term|keyword|contains|glob|include/.test(n)) v = n === 'include' ? '**/*' : 'ALICE_CANARY';
    else v = 'probe';
    out[k] = v;
  }
  return out;
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Replace the given values (longest first) and uuids / digit runs, so two responses can be compared. */
export function normalize(text: string, values: Array<[string, string]>): string {
  let s = text;
  const pairs = values.filter(([v]) => v).sort((a, b) => b[0].length - a[0].length);
  for (const [v, ph] of pairs) s = s.split(v).join(ph);
  for (const [v, ph] of pairs) s = s.split(encodeURIComponent(v)).join(ph);
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/[0-9a-f]{16,}/gi, '<HEX>')
    .replace(/\d+/g, '0');
}

export { randomUUID };
