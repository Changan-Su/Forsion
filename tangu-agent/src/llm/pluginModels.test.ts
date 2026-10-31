import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerPluginModelProvider, withPluginModelProviders, type PluginModelProvider, type PluginModelRequest } from './pluginModels.js';
import { withOutboundMasking } from './outboundMask.js';
import type { CloudBrainServices } from '../seams/cloudBrain.js';
import { enterRunContext, runWithRemoteRequest, runWithUserAgentScope, setRunCwd, setRunSessionContext } from '../seams/runContext.js';
import { clearRunRemoteTaint, taintRunRemote } from '../services/remoteOrigin.js';

const offs: Array<() => void> = [];
let root: string;
let savedHome: string | undefined;
const localId = 'vendor/model';
const id = `plugin:panel/source/${encodeURIComponent(localId)}`;
const info = { id: localId, name: 'Native source', contextWindow: 64000, supportsVision: false, thinkingLevels: ['off', 'high'] as Array<'off' | 'high'> };
const result = () => ({ content: 'answer', reasoning: 'reason', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 3 } });
const base = () => ({ models: { listGlobalModels: async () => [], hasDirectModel: () => false }, llm: {
  resolveModelAndKey: vi.fn(async () => ({ model: { id: 'original', name: 'Original', provider: 'original' }, apiKey: 'private', baseUrl: 'https://example.invalid', apiModelId: 'original' })),
  buildProviderPayload: vi.fn(async () => ({ original: true })), streamProviderCompletion: vi.fn(async () => result()),
} }) as unknown as CloudBrainServices;
function register(overrides: Partial<PluginModelProvider> = {}, owner = 'panel') {
  const provider: PluginModelProvider = { id: 'source', listModels: async () => [info], resolveModel: async mid => mid === localId ? info : null, stream: async () => result(), ...overrides };
  const off = registerPluginModelProvider(owner, provider); offs.push(off); return { provider, off };
}
async function prepare(brain: CloudBrainServices, modelId = id) {
  const resolved = await brain.llm.resolveModelAndKey(modelId);
  const payload = await brain.llm.buildProviderPayload({ ...resolved, messages: [{ role: 'user', content: 'hello' }], thinkingLevel: 'medium' });
  return { ...resolved, payload };
}
it('preserves the source default when no thinking levels are declared', async () => {
  const metadata = { id: localId, name: 'Source defaults' };
  const stream = vi.fn(async (input: PluginModelRequest) => { expect(input.thinkingLevel).toBeUndefined(); return result(); });
  register({ listModels: async () => [metadata], resolveModel: async () => metadata, stream });
  const brain = withPluginModelProviders(base());
  const prepared = await prepare(brain);
  await brain.llm.streamProviderCompletion({ ...prepared, signal: new AbortController().signal });
  expect(stream).toHaveBeenCalledOnce();
});

beforeEach(() => {
  savedHome = process.env.TANGU_HOME;
  root = mkdtempSync(path.join(tmpdir(), 'plugin-model-test-'));
  process.env.TANGU_HOME = root;
});
afterEach(() => {
  offs.splice(0).forEach(off => off()); vi.useRealTimers();
  if (savedHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = savedHome;
  if (!path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'plugin-model-test-'))) throw new Error('Unexpected test directory');
  rmSync(root, { recursive: true, force: true });
});

it('namespaces owners, refreshes lists, hides credentials and preserves existing models', async () => {
  let listed = true;
  const { provider } = register({ listModels: async () => listed ? [{ ...info, apiKey: 'never expose' } as any] : [] });
  register({}, 'other-panel');
  expect(() => registerPluginModelProvider('panel', provider)).toThrow(/already registered/);
  expect(() => registerPluginModelProvider('panel', { ...provider, id: undefined } as any)).toThrow('Invalid plugin model provider');
  const original = base(), brain = withPluginModelProviders(original);
  const models = await brain.models.listPluginModels!();
  expect(models.map(m => m.id)).toEqual([id, `plugin:other-panel/source/${encodeURIComponent(localId)}`]);
  expect(JSON.stringify(models)).not.toContain('never expose');
  expect(brain.models.hasDirectModel!(id)).toBe(true);
  listed = false;
  expect((await brain.models.listPluginModels!()).map(m => m.id)).not.toContain(id);
  await expect(brain.llm.resolveModelAndKey('plugin:missing/source/x')).rejects.toThrow('Plugin model unavailable');
  expect(original.llm.resolveModelAndKey).not.toHaveBeenCalled();
  expect((await brain.llm.resolveModelAndKey('original')).apiKey).toBe('private');
  expect(await brain.llm.streamProviderCompletion({ apiKey: '', baseUrl: '', payload: {} })).toEqual(result());
});

it('passes one native inference, tool deltas and usage without granting execution handles', async () => {
  const call = { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } };
  const stream = vi.fn(async (input: PluginModelRequest) => {
    expect(input.modelId).toBe(localId);
    expect(input.thinkingLevel).toBe('high');
    expect(input).not.toHaveProperty('apiKey'); expect(input).not.toHaveProperty('run');
    input.onResponseStart?.(); input.onToken?.('answer'); input.onReasoning?.('reason');
    input.onToolCallDelta?.({ id: call.id, name: call.function.name, args: call.function.arguments, argsDelta: call.function.arguments, argsLen: call.function.arguments.length });
    return { ...result(), toolCalls: [call], usage: { prompt_tokens: 10, completion_tokens: 3, cached_tokens: 2 } };
  });
  register({ stream }); const brain = withPluginModelProviders(base()); const prepared = await prepare(brain);
  const onToken = vi.fn(), onReasoning = vi.fn(), onToolCallDelta = vi.fn(), onResponseStart = vi.fn();
  const res = await brain.llm.streamProviderCompletion({ ...prepared, onToken, onReasoning, onToolCallDelta, onResponseStart });
  expect(stream).toHaveBeenCalledTimes(1); expect(onToken).toHaveBeenCalledWith('answer'); expect(onReasoning).toHaveBeenCalledWith('reason');
  expect(onResponseStart).toHaveBeenCalledTimes(1); expect(onToolCallDelta.mock.calls[0][0].id).toBe('call-1');
  expect(res.toolCalls).toEqual([call]); expect(res.usage.cached_tokens).toBe(2);
});

it('stays inside native outbound masking and restores returned tool arguments', async () => {
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  register({ stream: async input => {
    const content = String(input.messages[0].content);
    expect(content).not.toContain(secret); expect(content).toContain('{{API_KEY_');
    return { ...result(), content, toolCalls: [{ id: 'masked', type: 'function', function: { name: 'echo', arguments: JSON.stringify({ content }) } }] };
  } });
  const brain = withPluginModelProviders(base());
  const llm = withOutboundMasking(brain.llm, () => ({ secrets: true, personal: false, action: 'mask' }));
  const resolved = await llm.resolveModelAndKey(id);
  const payload = await llm.buildProviderPayload({ ...resolved, messages: [{ role: 'user', content: `API key: ${secret}` }] });
  const res = await llm.streamProviderCompletion({ ...resolved, payload });
  expect(res.content).toContain(secret); expect(res.toolCalls[0].function.arguments).toContain(secret);
});

it('aborts active streams on disable and blocks stale callbacks, payloads and disposers after replacement', async () => {
  let captured!: PluginModelRequest;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { off } = register({ stream: input => { captured = input; started(); return new Promise(() => {}); } });
  const brain = withPluginModelProviders(base()), prepared = await prepare(brain), onToken = vi.fn();
  const pending = brain.llm.streamProviderCompletion({ ...prepared, onToken });
  const rejected = expect(pending).rejects.toThrow('revoked'); await ready; off(); await rejected;
  expect(captured.signal.aborted).toBe(true); captured.onToken?.('late'); expect(onToken).not.toHaveBeenCalled();
  expect(await brain.models.listPluginModels!()).toEqual([]);
  register(); off();
  await expect(brain.llm.streamProviderCompletion({ ...prepared })).rejects.toThrow('revoked');
  expect((await brain.models.listPluginModels!()).map(m => m.id)).toEqual([id]);
  await expect(brain.llm.buildProviderPayload({ ...prepared, messages: [] })).rejects.toThrow('revoked');
});

it('honors caller abort even when the provider ignores it and never starts a pre-aborted request', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const stream = vi.fn(async () => { started(); return new Promise<ReturnType<typeof result>>(() => {}); });
  register({ stream }); const brain = withPluginModelProviders(base()), prepared = await prepare(brain);
  const ac = new AbortController();
  const pending = brain.llm.streamProviderCompletion({ ...prepared, signal: ac.signal });
  const rejected = expect(pending).rejects.toThrow('user stopped'); await ready; ac.abort(new Error('user stopped')); await rejected;
  await expect(brain.llm.streamProviderCompletion({ ...prepared, signal: ac.signal })).rejects.toThrow('user stopped');
  expect(stream).toHaveBeenCalledTimes(1);
});

it('bounds source lookups and rejects missing telemetry rather than reporting zero', async () => {
  vi.useFakeTimers();
  const { off } = register({ resolveModel: () => new Promise(() => {}) });
  const brain = withPluginModelProviders(base());
  const pending = brain.llm.resolveModelAndKey(id); const rejected = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(5001); await rejected; off();
  register({ stream: async () => ({ ...result(), usage: undefined } as any) });
  const prepared = await prepare(brain);
  await expect(brain.llm.streamProviderCompletion(prepared)).rejects.toThrow('Invalid plugin model result or usage');
});

it('binds frozen user/session context from native scope, isolates the same cwd and ignores payload identity', async () => {
  const seen: Array<PluginModelRequest['context']> = [];
  register({ stream: async input => { seen.push(input.context); if (input.context) expect(Object.isFrozen(input.context)).toBe(true); return result(); } });
  const brain = withPluginModelProviders(base()), cwd = path.resolve('shared-project');
  await Promise.all(['alice', 'bob'].map(user => runWithUserAgentScope(user, 'agent', async () => {
    enterRunContext(user, `run-${user}`); setRunSessionContext(`session-${user}`, false);
    enterRunContext(user, `run-${user}`, 'resolved-agent'); // Agent refinement retains this run's identity.
    setRunCwd(cwd);
    const prepared = await prepare(brain);
    expect(JSON.stringify(prepared.payload)).not.toContain(`session-${user}`);
    expect(JSON.stringify(prepared.payload)).not.toContain(user);
    prepared.payload.request.context = { userId: 'forged', sessionId: 'forged', cwd: '/forged' };
    await brain.llm.streamProviderCompletion(prepared);
  })));
  expect(seen).toEqual(expect.arrayContaining([
    { userId: 'alice', sessionId: 'session-alice', cwd }, { userId: 'bob', sessionId: 'session-bob', cwd },
  ]));
  await runWithUserAgentScope('alice', 'agent', async () => {
    enterRunContext('alice', 'first'); setRunSessionContext('first-session', false);
    enterRunContext('alice', 'second'); // A queued run must not inherit a previous session.
    const prepared = await prepare(brain);
    prepared.payload.request.context = { userId: 'forged', sessionId: 'forged', cwd };
    prepared.payload.request.cacheKey = 'also-not-a-trusted-session';
    await brain.llm.streamProviderCompletion(prepared);
  });
  expect(seen[2]).toBeUndefined();
});

it('rejects an initially remote native run and aborts a local inference tainted during streaming', async () => {
  let input!: PluginModelRequest, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const stream = vi.fn(async (request: PluginModelRequest) => { input = request; started(); return new Promise<ReturnType<typeof result>>(() => {}); });
  register({ stream }); const brain = withPluginModelProviders(base());
  await runWithUserAgentScope('alice', 'agent', async () => {
    enterRunContext('alice', 'remote-run'); setRunSessionContext('remote-session', true);
    await expect(brain.llm.resolveModelAndKey(id)).rejects.toThrow('local authorization');
  });
  expect(stream).not.toHaveBeenCalled();
  await runWithUserAgentScope('alice', 'agent', async () => {
    enterRunContext('alice', 'tainted-run'); setRunSessionContext('local-session', false);
    const prepared = await prepare(brain), onToken = vi.fn();
    const pending = brain.llm.streamProviderCompletion({ ...prepared, onToken });
    const rejected = expect(pending).rejects.toThrow('local authorization');
    await ready;
    try {
      taintRunRemote('tainted-run', { via: 'tunnel', marked: true }); await rejected;
      expect(input.signal.aborted).toBe(true); input.onToken?.('late'); expect(onToken).not.toHaveBeenCalled();
      await expect(brain.llm.buildProviderPayload({ ...prepared, messages: [] })).rejects.toThrow('local authorization');
    } finally { clearRunRemoteTaint('tainted-run'); }
  });
});

it('carries authenticated HTTP origin for calls without a run while queued runs use their own origin', async () => {
  const { configureTangu } = await import('../seams/runtime.js');
  const { createTanguProfile } = await import('../profiles/index.js');
  const { authMiddleware } = await import('../core/http.js');
  register(); const original = base(), brain = withPluginModelProviders(original);
  configureTangu({ brain, profile: createTanguProfile({ sandboxMode: 'none' }), billing: {} as any,
    host: { authMiddleware: (_req: any, _res: any, next: () => void) => queueMicrotask(next) } as any });
  const request = (remote: boolean, modelId: string) => new Promise((resolve, reject) => {
    authMiddleware({ headers: remote ? { 'x-forsion-remote': 'tunnel' } : {} } as any, {} as any,
      () => { void brain.llm.resolveModelAndKey(modelId).then(resolve, reject); });
  });
  await expect(request(true, id)).rejects.toThrow('local authorization');
  await expect(request(false, id)).resolves.toHaveProperty('model.id', id);
  await expect(request(true, 'original')).resolves.toHaveProperty('model.id', 'original');
  await runWithRemoteRequest(true, () => runWithUserAgentScope('alice', 'agent', async () => {
    enterRunContext('alice', 'local-queued-run'); setRunSessionContext('local-session', false);
    await expect(brain.llm.resolveModelAndKey(id)).resolves.toHaveProperty('model.id', id);
  }));
});
