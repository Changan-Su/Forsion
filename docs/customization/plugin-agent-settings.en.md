# Exposing plugin settings to agents

UI and engine plugins share `ctx.registerAgentSettings`. This is an explicit read-only contract. It does not expose `registerSetting`, raw plugin files or secret storage automatically. Use optional chaining for older hosts.

```js
ctx.registerAgentSettings?.({
  fields: [
    { key: 'language', type: 'string', description: 'Preferred translation language', scope: 'account' },
    { key: 'apiKey', type: 'secret', description: 'Whether an API key is configured', scope: 'device' }
  ],
  read: ({ keys, userId, workspaceId, signal }) => ({
    language: currentEffectiveLanguage(),
    apiKey: isApiKeyConfigured() // boolean only, never the key
  })
});
```

Types are `string`, `number`, `boolean`, and `secret`; scopes are `device` (default), `account`, and `workspace`. Declare up to 64 unique fields with descriptions of at most 240 characters. Public values must match their types; null means unset. Secret fields accept only a boolean configured flag. Invalid values are unavailable. Only declared own data properties leave the provider; exceptions are not echoed. Results are capped at 7400 characters; `too_large` means request fewer `keys`.

Every call reads current effective values. Engine providers receive the current run's userId, workspaceId (project or directory), and cancellation signal; multi-user plugins must use that context. UI providers read their current client state, which does not represent another device or engine. Reads expire after 3 seconds. Disable, uninstall and replacement invalidate pending results. Registering again replaces the previous contribution, whose disposer cannot revoke the replacement.

Agents use `read_plugin_settings({ source: 'ui' | 'engine', pluginId?, keys? })`. Omit pluginId to list providers. `not_exposed` must not be interpreted as default settings. UI reads use the initiating client's command channel and require a capable client. Engine reads can work without a GUI. Results are fenced as untrusted data and shown as a native settings card. The card opens the current client or home-engine settings when applicable; remote-engine results do not open a local namesake.

Canonical types: `tangu-agent/src/contracts/agentSettings.ts`. Register through ctx; do not import the engine at runtime.
