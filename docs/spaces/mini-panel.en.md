---
title: Mini Panel
description: A floating desktop panel with quick actions for the task at hand.
---

# Mini Panel

Mini Panel is an extension panel of a Space. Open it with `⌘/Ctrl+Shift+M` or the command palette, switch capabilities with the Space buttons at the top, and click "Show in main panel" to continue with the current conversation, note or plugin item.

There are three built-in adapters today:

- **Tangu**: switch conversations, start a new chat, send messages.
- **Amadeus**: pick or create a note and edit it in place.
- **ToDo List**: the Calendar Space's to-do adapter: tick off tasks, and add one quickly when a writable to-do table exists. Task data stays in the original notes or tables.

The card opens at 320×420. Move the pointer onto any edge or corner of the card, and when it turns into a double arrow, drag to resize (minimum 260×160, maximum 640×900); when there are only a few to-dos you can make the card shorter instead of leaving a lot of empty space. Closing and reopening keeps the last size; after you quit the app it returns to the default.

Only Spaces with a dedicated adapter appear here. Plugins can provide adapters too, which are enabled and disabled with their parent plugin; plugins can also open their own compact view directly without creating a full Space. Mini has its own Space state: it doesn't change the main window's startup Space and doesn't restore the full workspace layout of the old Mini.

On macOS, when Computer Use in the currently running conversation starts operating an external app and focus leaves Forsion, Mini opens temporarily and shows the same conversation, **with no need to turn on Mini Mode beforehand**. The panel stays in the top-right corner of the screen, doesn't follow the mouse and doesn't steal focus; Computer Use clicks pass through it to the app being controlled. If it's in the way, move the pointer onto the card and drag its top bar elsewhere.

The temporary panel keeps showing progress in the gaps between tool calls within the same run. It closes when focus returns to Forsion; when the run ends it closes and **returns you to the Forsion window you were in before Computer Use started**. It is only for watching; to interact, go back to the main window, or press `⌘+Shift+M` to move the current conversation into a manual Mini. A manual Mini that is already showing takes priority; a hidden manual Mini's content, position and Space preference aren't overwritten either.

Background AX/PID calls, simply switching to another app, and calls made while focus is still in Forsion don't trigger the automatic pop-up. A manual Mini also stays where it is during Computer Use, and only lets clicks pass through while the mouse isn't over the card. This needs the matching Computer Use 0.5.2 or newer helper; upgrading the plugin replaces and restarts the old helper automatically. With an older helper you can still use Mini manually.
