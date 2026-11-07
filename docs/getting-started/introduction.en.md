---
title: What is Forsion
description: Forsion Second Brain: knowledge and memory, proactive Agents, multi-Agent collaboration and an extensible workspace.
---

# What is Forsion

**Not just writing it down — carrying it forward.**

Forsion is a **local-first AI second brain**: organize knowledge with block editing on your own Markdown files, keep context in editable long-term memory, think alongside Agents with distinct personas, move projects forward in parallel with TEAM, and let Muse keep following up within the scope you authorize.

**Capture and connect → remember the context → think and act as a team → follow up proactively → keep the results.** Plugins add tools, skills and workspaces along this path, and what you built up last time becomes the starting point for the next piece of work.

## How the second brain connects to your work

| Capability | Value |
| --- | --- |
| [Block editing and knowledge base](../amadeus/editor.md) | Organize local files intuitively and connect sources to outputs. |
| [Long-term memory](../agents/memory.md) | Inspect, revise and reuse important context. |
| [TEAM and Team Desk](../chat/group-chat.md) | Keep members and their roles, and see parallel work as it happens. |
| [Muse](../agents/muse.md) | Keep following up within configured boundaries and bring results back to the Inbox. |
| [Plugins](../customization/plugins.md) | Add tools, Agents, skills and workspaces. |

## Product family

| Name | What it is |
|------|--------|
| **Tangu engine** | The agent engine, the brain of the whole system. It runs models, calls tools, and manages Agents and sessions. It is embedded in the desktop app and works out of the box, and it can also run on its own on a server or in a terminal |
| **Forsion Desktop** | The desktop app (macOS / Windows / Linux) and the focus of these docs: the Tangu engine + a dockable tabbed workspace + a range of feature Spaces |
| **Amadeus** | The built-in notes system: a local Markdown vault, wikilinks, tables, whiteboards, dashboards, PDF annotation and a calendar, in an Obsidian-compatible format |
| **Forsion Web** | The browser cloud client, usable without installing the app; on a phone it switches to the mobile interface automatically |
| **Forsion Mobile** | The Android version, with an interface rebuilt for touch: a push-aside sidebar, an always-available tab switcher, and a bottom editing toolbar for notes |
| **Tangu CLI** | Tangu in the terminal, installed with one click from the desktop app and updated along with it |
| **Web apps (Forsion Connect)** | Web pages you build in the [Coding Space](../spaces/coding.md) get a public link with one-click publishing; visitors pay for AI usage with their own Forsion accounts, and the page can call cloud Agents directly. Add a one-line summary to apply for the Store's "Web apps" category |

Desktop, browser and phone share **the same account and the same sessions**: start a chat on your computer, pick it up on your phone, and the Agents' memory and your notes come along. See [Browser and mobile](../reference/web-and-mobile.md).

## Design principles

**Local first.** Your notes are Markdown files on disk, an Agent's memory is text you can open and edit, and the configuration is one JSON file. Uninstall Forsion and your data is still there, readable in any editor. When you use cloud models, account sync or sharing, the relevant content is sent to the service in use; check where data goes based on your actual connections and settings. See [Data and privacy](../reference/data-and-privacy.md).

**Agents are long-term partners, not one-off sessions.** Each Agent has its own persona, separate memory, library and log, and understands you better the more you use it. See [Agents overview](../agents/overview.md).

**AI should take the initiative.** Beyond "you ask, it answers", Forsion has a whole set of mechanisms that let the AI act on its own:

- [Muse](../agents/muse.md) watches things according to the rules you set, and reminds you when it should;
- [Automation](../spaces/automation.md) is "trigger × action chain" — a schedule, an event or a button in a note can all be triggers, and a trigger can chain several steps such as sending a notification, running an Agent or calling a tool directly;
- Results all land in the [Inbox](../spaces/inbox.md), and important ones can be forwarded to WeChat / Telegram / QQ;
- The other way round, you can reach the AI from a [channel](../chat/channels.md): send it a message in WeChat on your phone and it works on your computer;
- Finished work is more than a block of text. [Agent Desk](../chat/agent-desk.md) lays out outputs such as notes, images, web pages and code to the right of the chat, and you can watch files being written in real time.

**Everything is swappable.** Model providers can be changed, appearance themes changed, feature Spaces added or removed, and plugins installed — the [Store](../customization/market.md) installs skills, plugins (including agents and Spaces), themes and web apps in one place.

## Next steps

- [Installation and updates](installation.md)
- [Quick start](quickstart.md)
- [Core concepts](concepts.md)
