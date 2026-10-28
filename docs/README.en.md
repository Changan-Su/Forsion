---
title: Forsion Docs
description: Docs for Forsion, the second brain workbench — knowledge and memory, Muse follow-ups, multi-agent work, plugins and the whole product family.
---

# Forsion Docs

Forsion is a **local-first AI second brain**: your material, ideas and results settle into a knowledge base, agents work with you using long-term memory, Muse follows up on its own, and plugins extend the tools and the way you work. What you do next flows back into the knowledge base as background for the next round.

**Amadeus** gives you Notion-style block editing on local Markdown, with backlinks, databases, whiteboards and research material. **Tangu** brings editable memory, agents with their own personalities and parallel TEAMs; a long-running team keeps its shared rules in `TEAM.md`, and Team Desk shows what each member is doing. **Muse, automations and the inbox** keep ongoing work moving. **Plugins, Skills, MCP and Spaces** extend the environment as you need. Use cloud models or connect your own; your local notes and agent memory stay readable, editable and easy to back up.

> 📌 These docs are kept alongside the Forsion Desktop source. For what changed in the version you have installed, see Settings → About → Changelog in the app, or [GitHub Releases](https://github.com/Changan-Su/Forsion/releases). Many pages are still only available in Chinese; they open in Chinese with a notice at the top.

## Where to start

| You want to | Start here |
|---|---|
| Get it running for the first time | [Installation and updates](getting-started/installation.md) → [Quick start](getting-started/quickstart.md) |
| Learn your way around the interface | [Workspace and interface](getting-started/workspace.md) |
| Connect your own model or API key | [Models and providers](chat/models-and-providers.md) |
| Build knowledge and background that lasts | [Amadeus](amadeus/overview.md) → [Agent memory](agents/memory.md) |
| Have the AI follow up on what you asked | [Muse](agents/muse.md) → [Automation](spaces/automation.md) → [Inbox](spaces/inbox.md) |
| Let several agents discuss or split work | [Agents overview](agents/overview.md) → [TEAM and Team Desk](chat/group-chat.md) |
| Give the AI tools and set what it may do | [Tools and approvals](chat/tools-and-approvals.md) |
| Move over from Obsidian | [Amadeus overview](amadeus/overview.md) → [Editor](amadeus/editor.md) |
| Use it on a phone or in the browser | [Web and mobile](reference/web-and-mobile.md) |
| Shape the workbench your way | [Plugins](customization/plugins.md) → [Store](customization/market.md) |
| Write a plugin for Forsion | [Plugin development](customization/plugin-development.md) → [Local plugin task SDK](customization/plugin-tasks.md) |
| Something went wrong | [FAQ](reference/faq.md) |

## Getting started

- [What is Forsion](getting-started/introduction.md) — the product family and the ideas behind it
- [Installation and updates](getting-started/installation.md) — macOS / Windows / Linux, update channels, runtime
- [Quick start](getting-started/quickstart.md) — from project notes to memory, multiple agents, follow-ups and plugins
- [Core concepts](getting-started/concepts.md) — what agent, session, Space and approval level each mean
- [Workspace and interface](getting-started/workspace.md) — Ribbon, tabs, status bar, notifications, built-in browser and terminal

## Chat

- [Chat basics](chat/basics.md) — streaming, branching and editing, slash commands, interjecting and stopping
- [Models and providers](chat/models-and-providers.md) — Forsion cloud, your own keys, subscription sign-in, thinking levels, helper models
- [Tools and approvals](chat/tools-and-approvals.md) — four approval levels, plan mode, work scope, MCP, project instruction files
- [Attachments and images](chat/attachments-and-vision.md) — sending images, file previews, files the AI creates
- [Agent Desk and task overview](chat/agent-desk.md) — results beside the chat instead of buried in the thread
- [TEAM and Team Desk](chat/group-chat.md) — long-running teams, member roles, parallel sub-sessions and project dispatch
- [Channels](chat/channels.md) — reach your agents from WeChat, Telegram or QQ

## Agents

- [Agents overview](agents/overview.md) — creating agents, personality (SOUL), libraries, subtasks and self-brainstorming
- [Memory](agents/memory.md) — each agent has its own memory, local-first and the same on every device
- [Muse](agents/muse.md) — keeps an eye on tasks, notices activity, reaches out to you
- [Skills](agents/skills.md) — give the AI "how to do it" manuals
- [External engines](agents/external-engines.md) — bring in Claude Code and other third-party agents

## Amadeus notes

- [Amadeus overview](amadeus/overview.md) — a local Markdown vault, compatible with Obsidian
- [Editor](amadeus/editor.md) — block editing, slash menu, folding, callouts, source view
- [Links and properties](amadeus/links-and-properties.md) — `[[backlinks]]`, sub-notes, page properties, links that follow renames
- [Databases](amadeus/databases.md) — column types, multiple views, filters, sorting and summaries
- [Whiteboard](amadeus/whiteboard.md) — an Excalidraw-compatible infinite canvas, paper and multiple pages
- [Dashboard](amadeus/dashboard.md) — cards on a grid, turning anything into one panel
- [PDF reading](amadeus/pdf-annotation.md) — a read-only built-in reader; annotation comes from plugins
- [Calendar](amadeus/calendar.md) — databases and to-dos on a calendar, plus external calendar subscriptions
- [Sync and sharing](amadeus/cloud-and-sharing.md) — cloud vaults, third-party drives, page sharing

## Spaces

- [Spaces overview](spaces/overview.md) — what a Space is and how to manage them
- [Mini Panel](spaces/mini-panel.md) — compact Space adapters and the automatic Computer Use session panel
- [Automation](spaces/automation.md) — triggers and action chains so agents work on their own
- [Inbox](spaces/inbox.md) — messages your agents send you
- [Coding Space and publishing](spaces/coding.md) — preview web pages as you write them and publish them as web apps

## Personalization

- [Appearance and themes](customization/themes.md) — design language, colours, glass, three type sizes
- [Plugins](customization/plugins.md) — desktop and engine plugins, bundles, install channels, security model
- [Store](customization/market.md) — skills, plugins (including agents and Spaces), themes, web apps
- [Achievements](customization/achievements.md) — unlock them as you explore

## Developers

- [Plugin development](customization/plugin-development.md) — getting started, layout and panels, list sources, approvals, host parts, cards and other extension points
- [Local plugin task SDK](customization/plugin-tasks.md) — local tasks, read-only external engines, isolated Git workspaces, schedules and Desktop MCP
- [Reusable UI components](customization/ui-components.md) — mounting the Chat Box and Markdown editor in views and plugins
- [Mini Panel development](customization/mini-panel-development.md) — plugin adapters, handing over entity parameters, the automatic foreground panel
- [Floating Panel development](customization/floating-panel-development.md) — native floating windows, web overlays and the plugin API

## Reference

- [Account, quota and credits](reference/account-and-quota.md) — weekly quota, reset cards, credits, invitations and redemption
- [Command line (Tangu CLI)](reference/cli.md) — use Tangu in the terminal
- [Web and mobile](reference/web-and-mobile.md) — Forsion Web and the Android app
- [Data and privacy](reference/data-and-privacy.md) — where your data lives and what goes to the cloud
- [FAQ](reference/faq.md) — quick troubleshooting

## Still stuck?

- When the app and these docs disagree, **the app is right**: the docs follow releases and can lag a version or two.
- Check the [FAQ](reference/faq.md) first for how-to questions; for changes between versions, see Settings → About → Changelog.
- Website: [forsion.net](https://forsion.net) | Questions and feedback: [GitHub Issues](https://github.com/Changan-Su/Forsion/issues)
