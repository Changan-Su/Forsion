---
title: Quick start
description: Start with a project note, then try long-term memory, multiple Agents, proactive Muse, and plugins in Forsion.
---

# Quick start

Start with something you are already working on: a research question, an article, or a project you want to build. These steps gradually bring it into your second brain. Complete the first three, then add collaboration and follow-up as needed. The detailed guides linked below are currently in Chinese.

## 1. Connect a model

Install and open Forsion Desktop. In **Settings → Models**, choose a connection:

- **Forsion account:** sign in to use Forsion-hosted models.
- **Your own API:** add a provider and API key. Direct Anthropic connections and OpenAI-compatible endpoints are supported.
- **Local model:** connect Ollama or your own compatible endpoint.
- **Subscription login:** local mode supports ChatGPT (Codex) and xAI Grok subscription logins.

The multi-agent and Muse steps below use **local mode**. The local engine can call a cloud model you configure; requests go to the chosen provider. An installed Claude Code or Codex CLI can also connect as an external engine. See [models and providers](../chat/models-and-providers.md) and [external engines](../agents/external-engines.md).

## 2. Give the project a home

Create a project note in **Note (Amadeus)** with:

- **A goal:** what you want to make and who it is for.
- **Sources:** existing articles, files, and reference links.
- **Open questions:** what you still need to understand and what comes next.

Use `[[` to link notes, attachments, databases, or conversations. Type `/` to insert a database, whiteboard, or other content. Notes live in your local knowledge base and can be inspected and backed up with ordinary file tools.

Open **Agent (Tangu)**, reference the note or give its file path, and try:

> Read this project note. Organize the known facts, open questions, and next steps. Save the result to my knowledge base and retain the source links.

Authorize access to the material the task needs. Agent Desk can show notes and other outputs beside the conversation, where you can open, inspect, and edit them. See [Amadeus](../amadeus/overview.md), [Agent Desk](../chat/agent-desk.md), and [tool approvals](../chat/tools-and-approvals.md).

## 3. Build memory across conversations

Keep project material in the knowledge base. Explicitly tell your Agent a working preference worth retaining:

> Remember: when you help me research, put conclusions first, then sources, and call out uncertainty separately.

Open that Agent's **memory panel** and check what it recorded. Revise memories, inspect history, or remove a fact from active memory. Start a new conversation about the project and check whether it uses the appropriate context.

Agents have individually manageable personalities, Libraries, logs, and memory settings. You can enable Historian and Dream for further maintenance; automatic Dream maintenance is off by default. See [Agents](../agents/overview.md) and [memory](../agents/memory.md).

## 4. Bring different Agents into the work

Create two roles in Agent management, such as a research partner and a proposal reviewer. Give them distinct responsibilities and select their models and tool permissions.

- **Discuss approaches:** start a group chat, choose both Agents, and ask them to compare two options. They respond in turns; you can interject or @ a participant.
- **Divide the investigation:** in an ordinary task, ask the main Agent to delegate independent questions to subtasks, pass the context they need, and bring back sources and conclusions.

Save the conclusions you adopt to the project note. Group chat supports discussion; parallel subtasks support independent execution. See [group chat](../chat/group-chat.md) and [Agents](../agents/overview.md).

## 5. Arrange a proactive follow-up

Enable **Muse** in the background Agent settings. Set active hours, heartbeat frequency, budget, and permissions first. Muse is off by default. In its approval mode, actions that need your decision enter a pending queue; delegated approval and full-access modes are also available.

Ask Muse to track a next step, such as reviewing the project note at an agreed time and collecting unresolved questions. Its schedules, heartbeats, and rules trigger follow-up work, with results delivered to **Inbox**.

Respond in Inbox: ask Muse to execute a suggested task, continue in a new conversation, or dismiss it. Approve or reject pending actions there. Muse also builds up its own Library and journals, and can gradually create a Space of its own.

For a defined process, use **Automation** to create a daily trigger followed by an Agent progress summary and a notification. Use **Calendar** to bring together dates and to-dos from databases. See [Muse](../agents/muse.md), [Automation](../spaces/automation.md), and [Inbox](../spaces/inbox.md).

## 6. Extend the workflow

Open the **marketplace** and choose an extension for the task at hand. Explore Bluebird to turn videos into notes, install a Skill for a reusable way of working, or add a plugin for extra tools and interface features.

A plugin bundle can include an interface, engine tools, Agents, skills, and Spaces. Read its description, dependencies, and settings, then use it in the project. MCP can also connect external tools and data. See [plugins](../customization/plugins.md), [the marketplace](../customization/market.md), and [Skills](../agents/skills.md).

## Bring the results back

Use whiteboards, PDF annotations, or databases as the research develops. For a web prototype, open **Coding Studio**, write the project brief, and confirm and send the conversation draft it creates. Inspect and refine the result in the preview. Add the outputs, links, and next steps to the project note.

Arrange tabs, split panels, and independent windows to keep conversations beside sources. Optionally configure WeChat, Telegram, or QQ channels to reach Agents from other entry points.

- [Workspace](workspace.md) — panels, Spaces, and layouts.
- [Coding Studio](../spaces/coding.md) — from a brief to a webpage preview.
- [Channels](../chat/channels.md) — contact your Agents through messaging tools.
- [Back to the README](../../README.md).
