---
title: Plugin model providers
description: Offer a model through the native Tangu inference boundary while keeping history, tools and approvals in the host.
---
# Plugin model providers

A local engine plugin can register a model source with `ctx.registerModelProvider(provider)`. The model appears in the native model catalog and can be selected by normal Tangu conversations and plugin tasks. This is a single-inference interface: Tangu owns history, the agent loop, tool execution, approvals and usage recording. Do not start another agent loop or execute returned tool calls in your provider.

Feature-detect `typeof ctx.registerModelProvider === 'function'`. Registration requires a local engine; it is not a cloud-provider registration API. Use the canonical `tangu-agent/plugin-api/tangu-agent.d.ts` types.

Host startup must configure the native runtime before activating plugins. Run `npm run test:plugin-model-boot` in `tangu-agent` to build and verify the real standalone cold boot, model catalog and disable/re-enable lifecycle in an isolated home.

```ts
ctx.registerModelProvider({
  id: 'source',
  listModels: async ({ signal }) => readEnabledModels(signal),
  resolveModel: async (modelId, { signal }) => readEnabledModel(modelId, signal),
  stream: async input => inferOnce(input),
})
```

`id` is a provider-local kebab-case slug, 1–64 characters. The host supplies the owning engine plugin identity, including marketplace installation identities. Full model IDs are `plugin:<engineId>/<providerId>/<encodeURIComponent(model.id)>`. A source-local model ID may contain `/`; it must be 1–240 characters with no control characters. Sources cannot replace a built-in model or another plugin's namespace. Duplicate registrations in the same activation throw.

| Member | Contract |
| --- | --- |
| `listModels({signal})` | Re-read enabled models from the source. Return at most 512 `PluginModel` records. A failed or invalid list is omitted from the catalog; no empty result is written back to the source. |
| `resolveModel(modelId,{signal})` | Re-read the source-local ID. Return matching metadata or `null` when unavailable. Missing or revoked plugin models fail explicitly and never fall through to a cloud model. |
| `stream(input)` | One inference with the host's prepared messages and tool definitions. Return a `PluginModelResult`; source credentials remain in your closure/service. No key or endpoint is exposed to the renderer or native catalog. |

`PluginModel` contains `id`, `name`, optional positive integer `contextWindow`, optional `supportsVision` (default `false`), and optional nonempty `thinkingLevels` from `off/minimal/low/medium/high/xhigh/max`. The host applies its normal context-window policy and clamps thinking requests to declared levels. Omit unknown capabilities rather than inventing them.

`PluginModelRequest` supplies the source-local `modelId`, `messages`, optional `tools`, `toolChoice`, `temperature`, `maxTokens`, `thinkingLevel`, `cacheKey`, and an `AbortSignal`. Messages use the native OpenAI-style roles and tool-call fields; image parts are already in message content. Streaming callbacks are `onResponseStart()`, `onToken(delta)`, `onReasoning(delta)` and `onToolCallDelta({id,name,argsLen,args,argsDelta})`. `args` is cumulative JSON argument text, `argsDelta` is the newly arrived fragment, and `argsLen` is its cumulative character count.

During a native run, `input.context` is a frozen, read-only `{sessionId,userId,cwd}` object for local adapter isolation; `cwd` is nullable. Identity comes from the run row already loaded by the host, with no extra database read. It is never derived from `cacheKey`, request fields, or the project directory. Bind stateful external context to both user and session: two sessions in the same directory must remain separate. This object is supplied outside the inference payload and **must never be forwarded to the upstream model**. Calls without a bound native session omit it; do not guess a session or home directory. Initially remote runs, runs tainted by remote steering, and remote HTTP inference calls cannot use these local sources. A run tainted during inference is aborted; queued native runs use their own origin, not the previous request's origin.

The required result is `{content, reasoning, toolCalls, usage, finishReason?}`. `toolCalls` are `{id,type:'function',function:{name,arguments}}`, with JSON argument text. `usage` requires nonnegative integer `prompt_tokens` and `completion_tokens`; optional counters are `cached_tokens`, `cache_write_tokens` and `reasoning_tokens`. Map real source telemetry: missing usage is an error, never fabricated zero. Both text fields and the tool-call array are required even when empty. The source must return final aggregated text/tool calls as well as streaming callbacks. FIM, image generation and opaque provider-specific output items are outside this interface.

Model list/resolve calls receive a signal with a five-second deadline. Inference receives the caller's cancellation combined with activation revocation; forward it to every upstream request. Disabling, unloading, failed activation or replacing a plugin removes its catalog registrations and aborts active operations. Late callbacks/results and payloads from old activations are rejected; a stale disposer cannot unregister a replacement. The host can stop waiting even if a provider ignores abort, but providers must still cancel their own network/compute work.

Plugin inference is registered **inside** the native outbound masking layer: prepared message content is filtered before your callback receives it, and placeholders in returned text/tool arguments are restored by the host. Do not bypass this boundary with a second model call from an agent tool. A projectless panel should follow [the task SDK context contract](plugin-tasks.en.md) and ask the user to choose a project.
