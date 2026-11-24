# Translation engines and secrets (2026-11-24+)

For plugins that bring their own translation service (DeepL, a company MT API…) or hold any third-party API key. Contract source: Forsion root `docs/ToBeImproved/翻译插件设置与服务方案_2026-11-24/契约.md`. Feature-detect everything: older hosts, web and mobile lack some or all of it.

## ctx.secrets (desktop only; `if (ctx.secrets)`)

`get(key) → string | null`, `set(key, value)`, `delete(key)`, `has(key)`, `keys()`. Stored per plugin in the system keychain (Electron `safeStorage`); not synced, not in plugin data, not in diagnostics; removed when the plugin is uninstalled without "keep settings".

- key `^[a-z0-9][a-z0-9._-]{0,63}$`, value ≤ 8192 chars, ≤ 64 keys per plugin.
- Rejections carry `err.code`: `secrets_bad_key` / `secrets_too_large` / `secrets_too_many` / `secrets_unavailable` (no system encryption on this device — nothing was stored, never plaintext) / `secrets_locked` (stored but can't be decrypted now — **not** "never set": don't treat as empty, don't overwrite) / `secrets_failed`.
- Never render a stored key back into an input; show "saved, leave empty to keep".
- Same renderer as the host and other plugins: per-plugin keeps keys tidy, it isn't a security boundary.

## ctx.registerTranslationEngine(def) → unregister

Same gate as `ctx.tangu.translate`. `def = { id, name, ready?(), translate({ text, to, before?, signal }) → Promise<string> }`.

- `id` `^[a-z0-9][a-z0-9-]{0,31}$`; same id again replaces. Disable / reload unregisters.
- `to` is an English language name ('Chinese (Simplified)', 'English', 'Japanese', 'Korean', 'French', 'German', 'Spanish', 'Russian'; more may come) — map it to your vendor's codes.
- `text` already has formulas, code and link targets swapped for markers like `ZXQ1a2b3c4d_0QXZ`: keep them untouched. The host restores and validates; lost markers → one retry with your engine → `translation_format_lost`.
- `before` = the passage before the selection, for disambiguation only (DeepL `context`).
- Reject with a human message ("DeepL didn't translate: the key was rejected (HTTP 403)") — the user sees it on the card. The host never switches services silently; the card offers "Retry with Forsion models".
- `ready()` is called often: cheap and synchronous (credentials present, last check not an auth failure).

Once registered and ready, the engine shows up in the result card's service menu (`card.service`), in Settings → Models → Default models → Translate, and every `ctx.tangu.translate` call without `modelId` (editor Translate, selection bar, other plugins such as live captions) goes through it when it is the device's choice.

## ctx.translation

- `current() → { engine: { pluginId, id, name } | null, model: { id?, name } }` — `engine: null` = Forsion models (the Translate slot).
- `use(id | null)` — switch to one of **your own** engines, or back to Forsion models. Anything else rejects.
- `subscribe(cb) → unsubscribe` — choice or engine set changed (any window).
- The choice is per device (`localStorage`), like the keys.

## Result card: `card.service`

`registerSelectionAction({ …, card: { language: true, source: true, speak: true, service: true } })` (output 'preview'): the card head shows the current service as a small dropdown (every ready engine, "Forsion models · <model>", and "Translation settings…" when your plugin registered a settings page). Picking one switches the device choice and reruns. On failure the card offers "Retry with Forsion models" (that run's `ctx.tangu.translate` calls skip the engine) and "Open settings". Only meaningful when `run` translates through `ctx.tangu.translate`.

## Pattern

```js
const ENGINES = { deepl: { name: 'DeepL', call: deeplTranslate } }
for (const [id, e] of Object.entries(ENGINES)) {
  if (!ctx.registerTranslationEngine) break
  ctx.registerTranslationEngine({ id, name: e.name, ready: () => state[id]?.ok === true,
    translate: async ({ text, to, before, signal }) => e.call(await creds(id), text, to, before, signal) })
}
async function creds(id) { return JSON.parse(await ctx.secrets.get(`svc.${id}`) || 'null') }
```

Write each vendor adapter from the vendor's official API docs; list the API hosts in manifest `network` and call them with `ctx.net.request`.
