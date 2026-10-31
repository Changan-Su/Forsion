/** Owner-scoped, single-inference providers. History, tools and approvals stay in Tangu. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentModel, ChatMessage, ResolvedModel, ThinkingLevel, Tool } from '../core/types.js';
import { fimUnsupportedError, type CloudBrainServices, type StreamOpts, type StreamResult } from '../seams/cloudBrain.js';
import { clampThinkingLevel, isThinkingLevel, resolveModelCapability } from './modelCapabilities.js';
import { currentRequestIsRemote, currentRunCwd, currentRunId, currentRunIsRemote, currentRunSessionId, currentRunUserId } from '../seams/runContext.js';
import { effectiveRemote, onRunTainted } from '../services/remoteOrigin.js';

export interface PluginModel {
  /** Source-local ID; the host namespaces and percent-encodes it. */
  id: string;
  name: string;
  contextWindow?: number;
  supportsVision?: boolean;
  thinkingLevels?: ThinkingLevel[];
}
export interface PluginModelReadContext { signal: AbortSignal }
/** Local adapter isolation only. Never forward this identity object to an upstream model. */
export interface PluginModelCallContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly cwd: string | null;
}
export interface PluginModelRequest {
  modelId: string;
  messages: ChatMessage[];
  tools?: Tool[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  cacheKey?: string;
  readonly context?: PluginModelCallContext;
  signal: AbortSignal;
  onToken?: StreamOpts['onToken'];
  onReasoning?: StreamOpts['onReasoning'];
  onToolCallDelta?: StreamOpts['onToolCallDelta'];
  onResponseStart?: StreamOpts['onResponseStart'];
}
export type PluginModelResult = Omit<StreamResult, 'outputItems'>;
export interface PluginModelProvider {
  /** Provider-local kebab-case ID. */
  id: string;
  listModels(context: PluginModelReadContext): Promise<readonly PluginModel[]>;
  resolveModel(modelId: string, context: PluginModelReadContext): Promise<PluginModel | null>;
  /** Exactly one inference. Return tool calls to Tangu; never execute them here. */
  stream(input: PluginModelRequest): Promise<PluginModelResult>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PLUGIN_MODEL_PREFIX = 'plugin:';
const MARK = '__tangu_plugin_model';
const READ_TIMEOUT_MS = 5_000;
interface Registration { key: string; generation: string; provider: PluginModelProvider; abort: AbortController }
const providers = new Map<string, Registration>();
const modelOwners = new WeakMap<AgentModel, Registration>();
const active = (r: Registration) => providers.get(r.key) === r && !r.abort.signal.aborted;
const revoked = () => Object.assign(new Error('Plugin model provider revoked'), { name: 'AbortError' });
const validId = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 240 && !/[\x00-\x1f\x7f]/.test(v);
const localOnlyError = () => new Error('Plugin model sources require local authorization');
function assertLocalOrigin(): void {
  const runId = currentRunId();
  // Queued native runs use their own persisted origin, never the previous HTTP request's ALS.
  if (currentRunIsRemote() || effectiveRemote({ runId }) || (!(runId && currentRunSessionId()) && currentRequestIsRemote())) throw localOnlyError();
}
function callContext(): PluginModelCallContext | undefined {
  const sessionId = currentRunSessionId(), userId = currentRunUserId(), cwd = currentRunCwd();
  return sessionId && userId && currentRunId() ? Object.freeze({ sessionId, userId, cwd: cwd && path.isAbsolute(cwd) ? cwd : null }) : undefined;
}

export function registerPluginModelProvider(owner: string, provider: PluginModelProvider): () => void {
  if (typeof owner !== 'string' || !SLUG.test(owner) || !provider || typeof provider.id !== 'string' || !SLUG.test(provider.id) || typeof provider.listModels !== 'function'
    || typeof provider.resolveModel !== 'function' || typeof provider.stream !== 'function') throw new Error('Invalid plugin model provider');
  const key = `${owner}/${provider.id}`;
  if (providers.has(key)) throw new Error(`Plugin model provider already registered: ${key}`);
  const r: Registration = { key, generation: randomUUID(), abort: new AbortController(), provider: {
    id: provider.id, listModels: provider.listModels.bind(provider), resolveModel: provider.resolveModel.bind(provider), stream: provider.stream.bind(provider),
  } };
  providers.set(key, r);
  return () => {
    if (providers.get(key) !== r) return;
    providers.delete(key);
    r.abort.abort(revoked());
  };
}

function lookup(id: string): { registration: Registration; localId: string } | null {
  if (!id.startsWith(PLUGIN_MODEL_PREFIX)) return null;
  const parts = id.slice(PLUGIN_MODEL_PREFIX.length).split('/');
  if (parts.length !== 3 || !SLUG.test(parts[0]) || !SLUG.test(parts[1])) return null;
  let localId: string;
  try { localId = decodeURIComponent(parts[2]); } catch { return null; }
  if (!validId(localId) || encodeURIComponent(localId) !== parts[2]) return null;
  const registration = providers.get(`${parts[0]}/${parts[1]}`);
  return registration && active(registration) ? { registration, localId } : null;
}

async function invoke<T>(r: Registration, fn: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal, timeout?: number): Promise<T> {
  assertLocalOrigin();
  const deadline = new AbortController();
  const runId = currentRunId();
  const offTaint = runId ? onRunTainted(id => { if (id === runId) deadline.abort(localOnlyError()); }) : () => {};
  const signal = AbortSignal.any([r.abort.signal, deadline.signal, ...(caller ? [caller] : [])]);
  const timer = timeout ? setTimeout(() => deadline.abort(new Error('Plugin model lookup timed out')), timeout) : undefined;
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    if (!active(r)) throw revoked();
    assertLocalOrigin();
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return fn(signal); }), aborted]);
    signal.throwIfAborted();
    if (!active(r)) throw revoked();
    return result;
  } finally {
    clearTimeout(timer);
    offTaint();
    signal.removeEventListener('abort', rejectAbort);
  }
}

function modelOf(r: Registration, m: PluginModel): AgentModel {
  if (!m || !validId(m.id) || typeof m.name !== 'string' || !m.name.trim()
    || (m.contextWindow !== undefined && (!Number.isSafeInteger(m.contextWindow) || m.contextWindow < 1))
    || (m.supportsVision !== undefined && typeof m.supportsVision !== 'boolean')
    || (m.thinkingLevels !== undefined && (!Array.isArray(m.thinkingLevels) || !m.thinkingLevels.length || m.thinkingLevels.some(l => !isThinkingLevel(l))))) {
    throw new Error('Invalid plugin model metadata');
  }
  const model: AgentModel = {
    id: `${PLUGIN_MODEL_PREFIX}${r.key}/${encodeURIComponent(m.id)}`, name: m.name.trim(), provider: `plugin:${r.key}`,
    apiModelId: m.id, supportsVision: m.supportsVision === true,
    ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
    ...(m.thinkingLevels === undefined ? {} : { pluginThinkingLevels: [...new Set(m.thinkingLevels)] }),
  };
  modelOwners.set(model, r);
  return model;
}

export async function listPluginModels(): Promise<AgentModel[]> {
  const groups = await Promise.all([...providers.values()].map(async r => {
    try {
      const entries = await invoke(r, signal => r.provider.listModels({ signal }), undefined, READ_TIMEOUT_MS);
      if (!Array.isArray(entries) || entries.length > 512) throw new Error('Invalid plugin model list');
      const models = entries.map(m => modelOf(r, m));
      return active(r) ? models : [];
    } catch { return []; }
  }));
  const seen = new Set<string>();
  return groups.flat().filter(m => active(modelOwners.get(m)!) && !seen.has(m.id) && !!seen.add(m.id));
}

export async function resolvePluginModel(id: string): Promise<ResolvedModel> {
  const entry = lookup(id);
  if (!entry) throw new Error('Plugin model unavailable');
  const { registration: r, localId } = entry;
  const info = await invoke(r, signal => r.provider.resolveModel(localId, { signal }), undefined, READ_TIMEOUT_MS);
  if (!info || info.id !== localId) throw new Error('Plugin model unavailable');
  return { model: modelOf(r, info), apiKey: '', baseUrl: `plugin://${r.key}`, apiModelId: localId };
}

function validateResult(value: PluginModelResult): PluginModelResult {
  if (!value || typeof value.content !== 'string' || typeof value.reasoning !== 'string' || !Array.isArray(value.toolCalls)
    || !value.usage || !Number.isSafeInteger(value.usage.prompt_tokens) || value.usage.prompt_tokens < 0
    || !Number.isSafeInteger(value.usage.completion_tokens) || value.usage.completion_tokens < 0) throw new Error('Invalid plugin model result or usage');
  const ids = new Set<string>();
  for (const call of value.toolCalls) {
    if (!call || typeof call.id !== 'string' || !call.id || ids.has(call.id) || call.type !== 'function'
      || typeof call.function?.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string') throw new Error('Invalid plugin model tool call');
    ids.add(call.id);
  }
  for (const key of ['cached_tokens', 'cache_write_tokens', 'reasoning_tokens'] as const) {
    if (value.usage[key] !== undefined && (!Number.isSafeInteger(value.usage[key]) || value.usage[key]! < 0)) throw new Error('Invalid plugin model usage');
  }
  const usage = { prompt_tokens: value.usage.prompt_tokens, completion_tokens: value.usage.completion_tokens } as StreamResult['usage'];
  for (const key of ['cached_tokens', 'cache_write_tokens', 'reasoning_tokens'] as const) {
    if (value.usage[key] !== undefined) usage[key] = value.usage[key];
  }
  return structuredClone({ content: value.content, reasoning: value.reasoning,
    toolCalls: value.toolCalls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.function.name, arguments: call.function.arguments } })), usage,
    ...(typeof value.finishReason === 'string' ? { finishReason: value.finishReason } : {}) });
}

/** Install inside outbound masking, so callbacks receive only the host's filtered payload. */
export function withPluginModelProviders(brain: CloudBrainServices): CloudBrainServices {
  return { ...brain,
    models: { ...brain.models, listPluginModels,
      hasDirectModel: id => !!lookup(id) || !!brain.models.hasDirectModel?.(id),
    },
    llm: { ...brain.llm,
      resolveModelAndKey: id => id.startsWith(PLUGIN_MODEL_PREFIX) ? resolvePluginModel(id) : brain.llm.resolveModelAndKey(id),
      refreshModelKey: id => id.startsWith(PLUGIN_MODEL_PREFIX) ? Promise.resolve(null) : brain.llm.refreshModelKey?.(id) ?? Promise.resolve(null),
      buildProviderPayload: async opts => {
        if (!opts.model.id.startsWith(PLUGIN_MODEL_PREFIX)) return brain.llm.buildProviderPayload(opts);
        assertLocalOrigin();
        const r = modelOwners.get(opts.model);
        if (!r || !active(r)) throw revoked();
        opts.signal?.throwIfAborted();
        const thinkingLevel = opts.thinkingLevel && opts.model.pluginThinkingLevels
          ? clampThinkingLevel(resolveModelCapability({ thinkingLevels: opts.model.pluginThinkingLevels }), opts.thinkingLevel) : opts.thinkingLevel;
        return { [MARK]: { key: r.key, generation: r.generation }, request: structuredClone({
          modelId: opts.model.apiModelId, messages: opts.messages, tools: opts.tools, toolChoice: opts.toolChoice,
          temperature: opts.temperature, maxTokens: opts.maxTokens, thinkingLevel, cacheKey: opts.cacheKey,
        }) };
      },
      streamProviderCompletion: async opts => {
        const mark = opts.payload?.[MARK];
        if (!mark) return brain.llm.streamProviderCompletion(opts);
        const r = providers.get(mark.key);
        if (!r || !active(r) || r.generation !== mark.generation) throw revoked();
        return invoke(r, async signal => {
          let finished = false;
          const context = callContext();
          const guard = <T extends (...args: any[]) => void>(cb: T | undefined): T | undefined => cb && ((...args: Parameters<T>) => {
            if (!finished && !signal.aborted && active(r)) cb(...args);
          }) as T;
          try {
            return validateResult(await r.provider.stream({ ...structuredClone(opts.payload.request), signal,
              context, // Always override any similarly named field in a supplied payload.
              onToken: guard(opts.onToken), onReasoning: guard(opts.onReasoning),
              onToolCallDelta: guard(opts.onToolCallDelta), onResponseStart: guard(opts.onResponseStart),
            }));
          } finally { finished = true; }
        }, opts.signal);
      },
      fimCompletion: async opts => {
        if (opts.modelId.startsWith(PLUGIN_MODEL_PREFIX) || !brain.llm.fimCompletion) throw fimUnsupportedError();
        return brain.llm.fimCompletion(opts);
      },
    },
  };
}
