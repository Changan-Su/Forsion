---
title: Local plugin task SDK
description: APIs for plugins to create hidden task sessions, Git workspaces and scheduled automation locally on desktop.
---
# Local plugin task SDK

These APIs run locally on desktop. They require a host build that contains this SDK; the released 2.12.2 does not include them. Feature-detect the interfaces rather than comparing version numbers. The canonical type declarations are in `tangu-agent/plugin-api/tangu-agent.d.ts`.

| API | Contract |
| --- | --- |
| `ctx.tangu.request(engineId,path,options)` | The renderer calls a JSON route of an engine plugin in the same bundle through the host. The host authenticates the request, restricts which routes can be reached and cancels requests when the plugin is disabled; no credentials are returned. The host builds the route prefix from the bundle's install folder name; desktop 2.13.3 and earlier used the manifest `id`, so on those versions every call from a bundle whose folder name differs from its `id` returns 404. |
| `ctx.tangu.openSession(id)` | Loads the hidden task session's real model and configuration, then opens native chat; it does not start a run. |
| `ctx.registerScopedRoutes(register)` | Routes are mounted at `/extensions/<bundle install folder name>/<engineId>` (the folder name on disk wins, not the id the bundle declares). The host checks for a local origin and a signed-in user, and revokes the routes when the plugin is disabled. Use `req.user.userId` as the owner, never an owner supplied in the request body. |
| `ctx.paths.dataDir` | A stable, host-assigned plugin data directory, separate from the installed code. |
| `sdk.runs.context(sessionId,userId)` | Reads saved `sessionId/cwd/modelId/thinkingLevel/approvalMode` metadata from an existing session owned by that user; missing values are `null`. Never reads chat messages. Missing, foreign or empty session/user IDs throw. Disabled plugins, non-local engines and remotely initiated runs are denied. |
| `sdk.runs.start(options)` | Creates a hidden `kind=task` session owned by the plugin. Save your intent first, then submit with a fixed `requestId`; if the outcome is unknown, retry with the same ID. Native approvals and questions remain active. |
| `runs.status/sessionRuns/events/subscribe/stop` | All check plugin and user ownership. `sessionRuns` includes native continuations, events are bounded, and subscriptions are cleaned up when the plugin is disabled. |
| `runs.usage(sessionId,userId)` | Token totals plus the number of unreported runs; missing telemetry from external engines must not be treated as zero. |
| `runs.followupParent(options)` | Continues only the tool-restricted director session linked to the subtask. A fixed request ID prevents duplicates, and native approval still applies. |
| `sdk.engines.list()` | Lists local external engines and their availability; availability does not prove the CLI is signed in. |

`runs.start` accepts `readOnly`, `toolNames` and an external `resumeSessionId`. The tool list may contain only tools owned by the plugin plus an explicit `ask_user`. Native read-only tasks use an exact allowlist of read tools, and native continuations cannot lift it. External read-only mode accepts only explicitly adapted Claude Code/Codex ACP identities and capabilities; unknown adapters are rejected. For Claude, built-in tools and the user's tool configuration are disabled, and scoped MCP calls still go through host approval one by one (including argument edits made while approving); Codex uses its native read-only sandbox. Resuming an external session requires the same engine and working directory, and an adapter that supports session/load.

## Reusing the current session's project and model

Read the active session ID from `ctx.tangu?.agentStatus?.()?.sessionId` in the renderer and pass it through `ctx.tangu.request` to your bundle's engine route. That route must call `ctx.sdk.runs.context` with the host-authenticated `req.user.userId`, never a user ID from the request body:

```js
// Inside a handler registered with ctx.registerScopedRoutes:
const context = await ctx.sdk.runs.context(req.body.sessionId, req.user.userId)
res.json(context)
```

Feature-detect `typeof ctx.sdk.runs?.context === 'function'` on older hosts. A new-chat draft has no session ID. If no ID exists or `cwd` is `null`, ask the user to select a project; never guess a home or default working directory. This is a saved session snapshot, excluding unsaved composer drafts. Missing model, thinking or approval settings stay `null`; an unknown nonempty approval mode is restricted to `readonly` under the host's rules. Reading a normal session's metadata grants no permission to run in it or read its messages. Create a separate task with `runs.start`; do not reuse the source ID as the task's `sessionId`. `approvalMode` is informational and grants no authorization to a new task; execution still uses `runs.start`'s project approval settings and native approval flow.

## Workspaces and automation

`sdk.workspaces.prepare` creates a Git worktree owned by the plugin; `inspect(id,userId)` returns the diff and revision; `merge(id,userId,revision)` merges only what the user inspected and requires a clean, unchanged destination, and conflicts stay in the task worktree; `archive(id,userId)` moves the workspace aside, keeps ignored and untracked files, and can recover after an interrupted move. Merge and archive take the native task maintenance lock on both the source and destination directories and refuse if they cannot get it. These locks are not distributed across multiple engine processes on the same machine.

```js
sdk.workspaces.prepare({id,userId,cwd,baseRef?,trust?})
```

`sdk.automation.save(key,input)` requires local UI authorization, uses native trigger storage and schedule history, and can call only tools this plugin declares as `automationSafe`; the ID is always `plugin:<owner>:<key>`. `remove(key)` revokes this plugin's triggers, including from an approved Stop tool. `notify(userId,title,body)` writes to the Inbox and is not forwarded to external message channels. Your plugin is responsible for validating the trigger origin and authorization nonce, and for handling missed slots and overlapping runs.

## Desktop MCP

Desktop MCP's `plugin_tools` / `plugin_call` list and run only tools in the final resolved set that come from an enabled plugin and explicitly declare `capabilities.externalMcp`; the host's external MCP switch must also be on. Read-only tools run directly. Write tools create a native run awaiting approval, which supports Stop, editing the approved arguments, and a recheck right before the call that the tool has not been revoked. A disabled plugin's declaration can never indirectly expose a core tool of the same name.
