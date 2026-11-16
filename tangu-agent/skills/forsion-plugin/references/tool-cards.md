# Chat cards and process-row sentences for your own engine tools

Moved out of SKILL.md (2026-11-15) to keep the skill body inside the model-visible window. Content unchanged.

### Tool result cards: ctx.registerToolResultRenderer (2026-10-19+)

A bundle whose engine half registers tools can give each tool a native result card in the chat, drawn by your
desktop half in the host's DOM (not an iframe), instead of the generic one-line tool record:

```js
ctx.registerToolResultRenderer?.({
  tool: 'make_chart',             // exactly the name your engine half registered
  title: () => (ctx.getLocale?.() === 'en' ? 'Chart' : '图表'),   // card / placeholder / Desk capsule name; default = tool name
  surface: 'inline',              // default; 'desk' = straight into the Agent Desk (see below)
  mount(el, call) {
    // call: { id, tool, args (parsed JSON), result (text the model saw), surface, state, quote }
    const view = drawChart(el, call.args, call.state.get())
    view.onZoom((z) => call.state.set({ zoom: z }))
    view.onPick((label) => call.quote(label))
    return () => view.destroy()
  },
})
```

- **Ownership**: the host only hands you calls of a tool that one of your bundle's engine plugins
  (`tangu-plugins/<id>/`) has registered right now, and that no core tool or other plugin also registers. A core tool (`write_file`…), another plugin's tool, or any tool
  while the engine list is not known yet stays a generic record. A market install whose engine half gets a
  `market_…` alias name does not match its plain tool name: ship engine + desktop halves in one bundle.
  The one exception is fixed in the host: the signed Forsion Extend may draw the core `publish_web_page` and
  `forsion_account` tools (web publishing cards), and only while the engine reports one of its engine plugins as
  official. Third-party plugins cannot get on that list.
- **Narrowing by arguments (2026-10-28+)**: add `match({ tool, args })` to take only some calls of the tool, e.g.
  `match: ({ args }) => args?.section === 'web_pages'`. `false` or a throw = the generic record. `args` is the parsed
  JSON, or the raw string when it did not parse.
- **Web page body (2026-10-28+)**: a card about a web page (a published link, a local file, a server) should mount
  `ctx.ui.mountWebCard(el, card)` instead of drawing its own thumbnail and buttons, so it reads as the same family as
  the host's own local page and server cards. See [references/host-ui-mounts.md](references/host-ui-mounts.md).
- **When the card shows**: only for finished, successful calls. While the call runs, when it failed (`isError`),
  while it waits for approval, when your `mount` throws, and while your plugin is disabled or reloading, the generic
  record shows. Disabling the plugin unmounts every card (your cleanup runs). History works: the host matches by
  tool name, so reopened conversations get the cards too.
- **What you get**: data plus two narrow actions. No file writes, no sending messages: changes go through your own
  commands or engine tools. `call.quote(text)` attaches a quote card above the chat input (same as selecting reply
  text and pressing Quote); the person decides whether to send it. `result` is what the model saw, so put the
  structured data your card needs into the tool result itself.
- **Surfaces and moving**: `inline` cards sit in the reply where the call happened, with an "Open in Desk" button.
  `surface: 'desk'` cards go straight into the Agent Desk (half width) when the result arrives live, leaving a
  placeholder in the chat (name, plugin name, "Showing in Desk", "Back to chat"); the Desk capsule's ⋯ has "Move back
  to chat". Every move remounts you in the new place after cleaning up the old one, with `call.surface` telling
  you which: keep view state (scroll, zoom, selection) in `call.state` (in memory, keyed by call id) and restore it
  on mount. Where there is no Desk (phone, Desk turned off, a window too narrow to show it) everything is inline.
- **Styling**: the host draws the frame and the header (`title · plugin name`); draw only the content, with theme
  tokens (`var(--text)`, `--text-muted`, `--border`, `--accent-ink`, `--ui-font-body`…). No fixed colors, no own
  frame or shadow. In the Desk you get the whole pane: size to the element, not to a fixed width.
- **Not this**: pages from external MCP servers (`ui://` in a sandboxed iframe) are a later, separate step; an
  Intelligent UI HTML card is drawn by the model's own built-in tool, not something you register.

### Process-row sentences: ctx.registerToolLabel (2026-11-13+)

The chat folds a reply's tool calls into one process row; expanded, every call is one line. By default a plugin
tool's line reads `<plugin name> · <tool name> <first argument>`. Give your own engine tools a plain sentence instead:

```js
ctx.registerToolLabel?.({
  tool: ['act_ui', 'observe_ui'],     // one name or several, exactly as your engine half registered them
  describe(call) {
    // call: { tool, args (parsed JSON), result?, phase: 'running' | 'done' | 'error', locale: 'zh' | 'en', earlier }
    const app = appNameFrom(call.result) ?? lastAppName(call.earlier)
    if (!app) return undefined        // nothing useful to say → the host's generic line
    return {
      text: call.locale === 'en'
        ? `${call.phase === 'running' ? 'Clicking' : 'Clicked'} “Send” in ${app}`
        : `${call.phase === 'running' ? '正在' : '已在'} ${app} 中点击「发送」`,
      icon: { appBundleId: bundleIdFor(app) },  // optional; the usual tool icon shows where it cannot be resolved
    }
  },
})
```

- **Cached, so keep it pure**: the host keeps each line and calls `describe` again only when the call, its phase, the
  locale or the earlier calls change. If a line also depends on something outside `call` (an icon table you fill in
  later), add `revision: () => counter` to the contribution and bump the counter when that something changes; the
  host re-asks when it differs. Throwing from `revision` counts as none.
- **Ownership**: same rule as tool result cards. Only tools one of your bundle's engine plugins has registered right
  now are handed to you; until the host has the engine's tool list nothing is claimed.
- **What shows**: `text` is the whole line (the host cuts it at 200 characters). The host adds no plugin name in front
  and no argument text after it. While a call runs, the folded row rolls through each step's `running` sentence; once
  every call finished, the folded row keeps the host's summary (`3 tool calls`) and the expanded list shows each
  call's `done` sentence (`error` when it failed or was cut off). The current-step line in the Tangu summary panel
  uses the same `running` sentence.
- **`earlier`**: your own tools' earlier calls in the same reply, oldest first, at most the 40 closest, each
  `{ tool, args, result? }`. Use it for names that only an earlier result carried (an observe call's app and element
  names before an act call that only has references).
- **Cheap and pure**: the host calls `describe` on every render that needs the line, again after a history reload and
  on a language switch, so it must be synchronous, fast and free of side effects. Throwing, returning nothing or an
  empty `text` keeps the generic line for that call. Registrations go away when your plugin is disabled or reloaded.
- **Icon**: `appBundleId` is a macOS bundle id. Desktop on macOS draws that app's icon; web, phone and other systems
  draw the usual tool icon.
- **Not this**: the text the model sees (tool descriptions, results) does not change; this is display only.
