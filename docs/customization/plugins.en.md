---
title: Plugins
description: Desktop plugins extend the interface, engine plugins give the AI new tools, and one bundle can install both at once.
---

# Plugins

Forsion has two kinds of plugins, managed together on one page in Settings, with **built-in** and **external** plugins shown in two sections:

| Type | What it extends | Example |
|------|----------|------|
| **Forsion plugin** (desktop) | The interface and note capabilities: new views, note enhancements, data dashboards | Bluebird Folder (turns videos into notes) |
| **Tangu plugin** (engine) | The AI's toolbox: new tools for the Agent | Computer Use (lets the AI see the screen and operate desktop apps) |

## Plugin bundles

One plugin package can carry **engine plugins, Agents, skills and Spaces** together — install once and everything is in place, instead of installing in four different places. Whatever a bundle brings is managed from the parent plugin's card: enabled and disabled together, uninstalled together, with each item visible. A Space that comes with a plugin appears on the Ribbon as soon as it is installed.

## What plugins can do

The only difference between built-in and external plugins is that built-in ones are already installed; their capabilities are exactly the same. Extension points include:

- **Custom views** — open a panel or tab of the plugin's own in the workspace;
- **Floating / Mini Panel** — open a registered view as a standalone floating window or a compact quick card;
- **Block surface** — render **real note blocks** inside the plugin's own interface, with editing, wikilinks and embeds working as usual;
- **Custom file types** — claim a file extension and let the plugin open and render it;
- **Commands** — appear in the command palette, and users can pin them to the Ribbon's command area; once a toggle command declares `checked`, its pinned button shows the on / off state;
- **Top-right notifications** and **status bar items** — bring progress and results to your attention (clickable status bar items can be reached with Tab);
- **Automation events** — let [automation](../spaces/automation.md) rules be triggered by the plugin's events;
- **Bundled Spaces** — package a whole working setup.

Every plugin automatically gets a "Working folder" setting that decides where its output goes. By default it is `Plugins/<English plugin ID>` in your vault: all plugin output sits under the one `Plugins` folder, and the vault root stays free for your own notes. Plugins with settings offer a form on their **detail page**; changes apply immediately, with no config file to edit.

## Where to install from

- **Store** (recommended) — one-click install with centrally managed updates; desktop plugins and engine plugins are installed in the right place according to their actual type. See [Store](market.md);
- **Local folder** — plugins live in `~/.forsion/plugins/`, one folder per plugin; if you have a plugin package, just put it there;
- **npm** (engine plugins) — `tangu install npm:<package name>`, see [Command line](../reference/cli.md).

If a plugin depends on a program on your computer, its detail page lists it and offers a one-click install guide.

## Plugins on Android

The Forsion Android app can also install Forsion plugins, using the same plugin interface as desktop:

- **Installed only through the app market** — "⋯" menu → App market; on phones the market lists only Forsion plugins (install skills, Agents, engine plugins, themes and Spaces on desktop). Plugins are enabled right after installing, with no restart.
- **Plugins live in the app's private folder**, not in any vault; Settings → Plugins works as usual for enabling, disabling, details and uninstalling (uninstalling keeps the settings the plugin saved, so they're still there after reinstalling). There's no visible plugin folder on the phone, so there's no "Open plugins folder / Create sample plugin".
- **Desktop-only plugins** — a plugin whose manifest says `"isDesktopOnly": true` (for example one that depends on a local program, Node or an engine plugin) is refused on the phone with the reason; one already in the list shows "Desktop only", and its code never runs.
- **Commands in "⋯"** — besides the command palette, commands a plugin registers are listed directly in the top bar's "⋯" menu, in one section per plugin (titled with the plugin name), so on the phone you don't need to open the command palette first.
- **Home is a single page** — a view opened by running a plugin command on Home takes you to that plugin's own Space and opens there; if the plugin has no Space, the view covers Home for now and is closed automatically the next time you return to Home.
- Not supported on phones yet: plugin status bar items (phones have no status bar), and engine plugins / Agents / skills / Spaces inside plugin bundles.

## Security model

Plugins are powerful, and the constraints are firm:

- The npm channel **only downloads files and never runs install scripts**, so installing a package can't compromise you;
- Tools provided by engine plugins **go through the approval system**, and the plugin itself can't skip "ask you before acting"; see [Tools and approvals](../chat/tools-and-approvals.md);
- Plugins run on restricted seams and get only the capabilities they declare — anything undeclared is out of reach; a plugin failing in the interface doesn't bring down the whole app;
- MCP tools a plugin brings also go through approval, and its hooks can only watch: they can't block anything or add to the conversation (see "Bundled MCP servers, hooks and file events" in [Plugin development](./plugin-development.md)).

## Writing plugins

To write your own plugin, see [Plugin development](./plugin-development.md) in the developer section: layout, list sources, approvals, host parts and all the extension points are covered there.

## Next steps

- [Store](market.md) — find ready-made plugins
- [Tools and approvals](../chat/tools-and-approvals.md) — how plugin tools are kept in check
- [Automation](../spaces/automation.md) — trigger rules with plugin events
