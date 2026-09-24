---
title: Automation
description: Build workflows that connect triggers, agents, notes and databases.
---

# Automation

Automation Space connects a trigger to an ordered chain of actions. Start from a daily reminder, agent briefing, new-record notification, or manual agent task. Templates populate an editable draft; they do not create a running automation.

## Build on the canvas

The sidebar uses Forsion's shared Workspace View for search, groups and item menus. Select a trigger or action node to open its configuration in Extend View. Closing the panel preserves the current draft. The **Add step** menu collects notification, agent, database and tool actions; the help button opens guidance. Move a step up or down in its configuration to change execution order.

Drag nodes to arrange the current view; moving them does not change execution order. Adding, removing or reordering steps arranges the chain automatically. Pan, zoom, snapping, fit and the minimap use Forsion's shared canvas controls. The current workflow model is sequential; conditional branches and parallel execution are not available.

## Configure, test and enable

1. Configure the trigger: schedule, event, file threshold, database change, or manual click.
2. Configure the actions. Notification fields offer an **Insert variable** picker for the current date and time, and database triggers also provide fields from the triggering row.
3. Follow the setup messages at the bottom. Clicking one opens the node that needs attention.
4. New workflows default to **Save paused**. Saving opens the saved rule. **Test run** executes its saved actions and opens Extend View; expand a run to inspect each step and its full result. Retry if history could not be loaded. Rules, agent schedules and system automations also provide a **Run results** entry.
5. Enable the rule through its Workspace item menu or detail actions after checking its results, or choose **Enable after saving** in the review node. Editing an existing rule preserves its enabled state.

Manual tests of database rules have no triggering-row context. Validate row variables and default row targets with a real database change. When an agent step reports that a task was queued or started, open its session to check the final output.

## Existing automations

The canvas uses the existing rule format and sequential execution engine. Existing rules need no migration or recreation; agent tool interfaces and approval rules are unchanged. Saving an edit preserves the rule ID and enabled state. As in the previous editor, legacy single-agent rules become one agent step when edited, while legacy Muse wake-up rules retain their prompt without an action chain.

After rescheduling a completed one-time rule, explicitly enable it in the review node. Manual rules created inside note buttons still default to enabled. Rules containing trigger or action fields this editor does not recognize are shown as read-only to prevent configuration loss.

## Connected to Forsion

Note buttons can run manual workflows, database changes can trigger workflows, agents can perform tasks, and notifications arrive in the inbox. Muse and Historian are managed separately under system automations. Agent schedules also appear in Automation Space and the calendar.

Tool steps use the existing automation tool catalog. Unattended agent tasks need an appropriate approval configuration. Waiting for a trigger does not consume model tokens; model work begins when an agent runs.
