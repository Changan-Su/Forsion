---
title: Spaces overview
description: Forsion organizes its features into Spaces — each with its own views and data, enabled as you need, and more available from the Store.
---

# Spaces overview

A Space is how Forsion organizes its features. Each Space is a **recipe**: it defines which views the Space opens, what goes in the sidebars, and which data it works on. Switch Spaces and the whole workspace takes on a different face.

Space icons sit at the top of the Ribbon; click one to switch.

## Built-in Spaces

| Space | What it's for |
|------|--------|
| **Chat** | Chatting with Agents, where everything starts |
| **Amadeus** | The [notes system](../amadeus/overview.md): documents, tables, whiteboards, dashboards, PDFs |
| **Calendar** | [Brings together everything with a date](../amadeus/calendar.md) |
| **Inbox** | [Messages Agents send you on their own](inbox.md) |
| **Automation** | [Let the AI work by rules on its own](automation.md) |
| **Coding** | [Write code and preview it on the spot](coding.md) |
| **Public** | Manage the web apps you've published and your [note sharing links](../amadeus/cloud-and-sharing.md) in one place |

## Enabling, disabling and the default Space

Spaces you don't use can be turned off in Settings for a cleaner interface; you can turn them back on at any time, and your data isn't affected.

You can also choose **which Space to enter at startup** — a cold start goes straight into its default layout instead of restoring how things were when you last quit.

## Spaces from plugins and the Store

Plugins can bring their own Spaces: they appear at the top of the Ribbon once installed, with no restart. The [Store](../customization/market.md)'s "Plugins" category also has third-party Spaces (marked Space on the card), each with its own description; uninstall one if it doesn't suit you.

## Spaces and the interface

Content in a Space opens in tabs, which you can drag into split views, drag out into separate windows, or pin as a Mini card. A Space recipe can also declare native splits in the main area directly: from the second item of `layout.main` on, write `"split":"right"` or `"split":"down"` and the host creates real Dockview panel groups; older recipes without `split` still open as tabs in the same group. For how each part of the interface works, see [Workspace and interface](../getting-started/workspace.md).

By default an item splits from the previous one; `splitFrom` picks an earlier item by its index (starting at 0). For example, a video, a document split to the right, and a Chat with `split:"down", splitFrom:0` give you the video at top left, Chat at bottom left and the document full height on the right. Splits inside Main don't change the outer panel boundaries: the left panel spans the full height, the right panel sits to the right of all of Main, and the bottom panel spans Main and the right panel. Old interleaved layouts are put back into their regions on restore. Regression instruments: `npm run check:splitregions` under `desktop` (uses the 5273 dev renderer by default) and `npm run check:bluebirdspace`.

Pinned views: an item in `layout.main` / `left` / `right` can set `"pinned": true`, meaning that panel always keeps at least one view of that type — it can't be closed or dragged out of its panel; opening a different type on it opens a new tab, while the same type still navigates in place. Extra tabs of the same type can still be closed; only the last one in the panel is protected. The bottom panel doesn't support pinning. Use it to make sure "however you switch, the original interface can always be found again". When you upgrade to a version that supports pinned views, each Space's saved layout is reset once.

Default main page: one item in `layout.main` can set `"mainPage": true` (at most one, and only in main). Entering the Space — switching to it from another Space, launching into it, or clicking its icon again while already in it — brings this view to the front, instead of whatever was in front when you left; other tabs stay open, just behind it, and the view is opened if Main doesn't have it. Without it, the default is "restore how it was when you left". The built-in Home is declared this way. Usually pair it with `"pinned": true`, or an in-place open right after switching in can replace it.

New tab page: each Space gets a tile under "Open", with the Space's own name and icon. Clicking the tile opens the first item of `layout.main` in the current tab; the other items of `layout.main` and the other views registered by the Space's plugin go into that tile's expand menu, which ends with "Enter Space". Spaces whose main area holds only `chat` / `amadeus-editor` without a file path get no tile (their entries are "New" and "Recent"); plugin views without a Space are listed under "Not in any Space".

## Next steps

- [Workspace and interface](../getting-started/workspace.md)
- [Automation](automation.md)
- [Store](../customization/market.md)

## Mini Panel

Adapted Spaces can be used in a separate floating panel; today that covers Tangu, Amadeus and ToDo List. See [Mini Panel](./mini-panel.md). Plugin authors can read the [adapter contract](../customization/mini-panel-development.md).
