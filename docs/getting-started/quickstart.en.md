---
title: Quick start
description: Connect a model, start a conversation, write your first note, and try automation in Forsion Desktop.
---

# Quick start

Once you have [installed Forsion Desktop](https://github.com/Changan-Su/Forsion/releases/latest), try the steps below. This guide uses the current English interface names; the full guides linked below are currently in Chinese.

## 1. Connect a model

Open **Settings → Models** and choose a connection:

- **Forsion account:** sign in to use Forsion-hosted models without managing an API key.
- **Your own API connection:** add a provider and its API key. Anthropic can be connected directly, and OpenAI-compatible endpoints are also supported.
- **Local model:** connect Ollama or your own compatible model endpoint.
- **Subscription login:** supported ChatGPT (Codex) and xAI Grok subscriptions can be connected through OAuth in local mode.

To use an installed Claude Code CLI, choose it as the runtime engine for a new conversation. It uses its own login state; this is separate from a direct Anthropic API connection.

Cloud-model requests are sent to the provider you select. See [models and providers (Chinese)](../chat/models-and-providers.md) and [external engines (Chinese)](../agents/external-engines.md) for connection details.

## 2. Start a conversation

Open **Agent (Tangu)**, select a model, and send a message. Responses appear as a stream; models that expose reasoning can show it in a collapsible section.

When the Agent needs to read or change files, run commands, or use other tools, its approval settings determine which actions need your confirmation. Review the requested action and its working folder before approving it. The approval modes are **Readonly**, **Auto edit**, **Full auto**, and **Custom**.

For a task you want to discuss first, enable **Plan mode**. The Agent investigates and proposes a plan before you approve execution.

Try pasting a short piece of material and asking:

> Organize this material into a note and save it to my knowledge base. Keep the main facts and add a short list of next steps.

When the window is wide enough, the task overview and generated files appear beside the conversation. You can review the plan, working folders, sources, and results there. See [tools and approvals (Chinese)](../chat/tools-and-approvals.md) and [Agent Desk (Chinese)](../chat/agent-desk.md).

### Build a webpage in Coding Studio

Open **Coding Studio** and write your goal, audience, and requirements in a project brief. Creating a project saves the brief to `FORSION_BRIEF.md` and prepares a conversation draft; the Agent starts only after you confirm and send the draft.

Inspect the webpage in the preview beside the conversation and ask for changes. See [Coding Studio (Chinese)](../spaces/coding.md) for preview modes and working with existing projects.

## 3. Write your first note

Switch to **Note (Amadeus)** and create a note, or open the one the Agent saved:

- Type Markdown; `#` followed by a space creates a heading.
- Type `[[` to link to notes, attachments, databases, or conversations.
- Type `/` to insert a database, whiteboard, code block, or other content.

Notes are Markdown files in your workspace. You can read and back them up with ordinary file tools. See the [Note overview (Chinese)](../amadeus/overview.md).

## 4. Try a follow-up task

Open **Automation** and create a rule. A rule combines a trigger with a sequence of actions: for example, a daily trigger, an Agent that summarizes the day's schedule, and a notification action.

Results arrive in **Inbox**, and each execution has a record you can review. For unattended work, give the selected Agent the permissions its task needs, or restrict it to tools that do not require approval; otherwise it may wait for approval and time out.

**Calendar** can bring together dates and to-dos from your note databases. Use it to check the records your scheduled task will summarize. See [automation (Chinese)](../spaces/automation.md), [Inbox (Chinese)](../spaces/inbox.md), and [Calendar (Chinese)](../amadeus/calendar.md).

## 5. Explore the marketplace

The marketplace offers skills, Agents, plugins, Spaces, themes, and website apps. Install an item to extend your workspace; inspect its settings and permissions as needed. See the [marketplace guide (Chinese)](../customization/market.md).

## 6. Arrange the workspace

Use the ribbon on the left to switch Spaces. Drag tabs into split panels or independent windows, and use the built-in browser and terminal when your task needs them.

The status bar shows information such as the current Space, running conversations, sync progress, and note word count. See the [workspace guide (Chinese)](workspace.md).

## Next steps

- [Core concepts (Chinese)](concepts.md) — Agents, conversations, Spaces, and approvals.
- [Agent overview (Chinese)](../agents/overview.md) — create an Agent with its own instructions and knowledge.
- [Coding Studio (Chinese)](../spaces/coding.md) — start with a project brief and inspect the webpage preview.
- [Full documentation (Chinese)](../README.md).
- [Back to the English README](../../README.md).
