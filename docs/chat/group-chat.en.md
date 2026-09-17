---
title: TEAM and Team Desk
description: Persistent teams, shared agreements, parallel member work, Team Desk, and project dispatch.
---

# TEAM and Team Desk

**English** · [简体中文](group-chat.md)

TEAM in Forsion v2.11 brings Agents together for discussion, parallel execution, and ongoing collaboration. Members work in their own child conversations; the main conversation receives progress, questions, handoffs, and public outputs.

## Start with two members

Select two or more Agents above the composer to enter team mode. Try Aria for creative directions and Recita for evidence and assumptions, then add other members as needed. These are configurable approaches to work; you retain the final judgment.

For a reusable team, create one in **Agents Space**, select its members, and assign responsibilities. Persistent teams have their own `config.toml`, `TEAM.md`, and `Library/`:

- **Members and roles:** specify a concrete responsibility, such as drafting an outline or checking whether citations support its claims.
- **TEAM.md:** record common goals and working agreements, including output format, handoffs, and how to flag unverified information.
- **Library:** store team material. Working together does not automatically share every private memory or grant access to all files.

Temporary team mode inside a project does not create a persistent team configuration.

## See the work behind the result

Members call tools and develop drafts in their child conversations, posting useful progress, questions, and final results to the main conversation. **Team Desk** shows their state, including working, waiting for approval, done, and failed. Open a member to inspect its full child conversation.

Approval requests and public outputs return to the main conversation. Review the work, handle approvals, open files, and continue editing the actual outputs.

Add context or `@mention` a member with new work at any time. Completed members stop speaking until another request arrives; the team finishes when every member is done. **v2.11 uses parallel teams in place of the earlier turn-taking and voting model.**

## Keep work in its project

Use `@project` in a private chat to dispatch a task into a new conversation in that project. The Orbits sidebar brings private chats, external engines, teams, and projects into one list, with pinning for frequent entries.

**Delegated subtasks** split independent work for a particular task. A **persistent TEAM** retains members, roles, and working agreements for repeated collaboration. Context is passed as needed, without automatically copying every conversation or Agent memory.

## Try collaboration with a concrete output

1. Write the goal and add a few sources to a project note.
2. Ask Aria to propose directions and Recita to examine the reasoning, with a defined output for each.
3. Follow progress and child conversations in Team Desk; interject or address a member when needed.
4. Review the public results, choose a direction, and save the outline, evidence, and open questions to the project.

This is a suggested exercise, not a recorded run. TEAM uses local mode and depends on configured models, material, and tool permissions. Agent personalities, memories, and permissions remain individually manageable.

## Continue reading

The following detailed guides are in Chinese:

- [Agents](../agents/overview.md) — personalities, memory, and tools.
- [Memory](../agents/memory.md) — inspect and revise lasting context.
- [Tools and approvals](tools-and-approvals.md) — configure access.
- [Muse](../agents/muse.md) — arrange a follow-up.
