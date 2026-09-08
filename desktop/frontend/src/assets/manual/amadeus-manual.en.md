# Amadeus User Manual

This is the complete reference for Amadeus. It ships with the app and it is now an ordinary note in your vault — edit it, annotate it, and if you make a mess of it, delete it and generate a fresh copy from the command palette.

The manual exists as two files: `Amadeus 使用手册.md` and `Amadeus User Manual.md`, matching section for section. Switch the interface language and the command palette opens the matching one.

If you would rather learn by doing, start with the tutorial: command palette (`⌘/Ctrl + K`) → "Open the tutorial", which creates `Amadeus 使用教程.md` in your vault — the ten-minute hands-on tour. This manual is the thing you come back to when you need to look something up. The Outline panel in the right sidebar lists every chapter; click a heading to jump.

This manual **is its own demo**: click the "Document / Canvas" pill in the top bar and the whole thing spreads out as a mind map — one card per chapter, with each section hanging off the chapter it belongs to. Chapter 6 covers the canvas in detail; to just see what it looks like, switch now.

> [!note] Conventions
>
> - `⌘/Ctrl` means `⌘` on macOS, `Ctrl` on Windows and Linux.
> - Text in quotation marks is the exact wording you will see on screen.
> - Anything marked "desktop only" is unavailable in the web and mobile builds.

**What is in here**

1. About Amadeus and this manual
2. The interface at a glance
3. Your vault and its files
4. Writing: the block editor
5. Formatting and editing
6. Cards and the canvas
7. Links, tags and the graph
8. Finding things
9. Tables and databases
10. Dashboards
11. Time: to-dos, daily notes and the calendar
12. Files, media and PDFs
13. Whiteboards and drawing
14. Properties and metadata
15. Working with the other Spaces
16. Plugins and the market
17. Commands and keyboard shortcuts
18. Settings
19. When something looks broken

## 1 · About Amadeus and this manual

Amadeus is the notes Space of Forsion — where you write, connect ideas, and keep files. This manual is its full reference: not a tour, a lookup table. Read the chapter you need. This first one covers three things: what Amadeus is, where your notes actually live, and how to open this manual again later.

### If you only read one page

Three things. Everything else is detail.

| Remember | Action | Result |
|---|---|---|
| A vault is just a folder | Click "Open vault" at the bottom of the sidebar and pick any folder on your computer | Every `.md` in that folder is a note — visible on disk, backed up like any file, readable in any other editor |
| `/` opens the block menu | Type `/` in the body of a note | An insert panel appears, grouped as Basic / Lists / Advanced / Plugins: headings, to-dos, tables, code blocks, equations, databases, drawings, and more |
| `[[` links notes | Type `[[` and pick a note from the list | A wikilink is created; the linked note gains a backlink, visible in the right sidebar under "Backlinks" |

Three things you can try right now:

- [ ] Open a vault: "Open vault" at the bottom of the sidebar, or `⌘/Ctrl + K` → "Open vault…"
- [ ] Create a note: `⌘/Ctrl + N` (this key means "new note" only inside Amadeus; in other Spaces it starts a new chat)
- [ ] Type `/` in the body and insert any block

> [!note]
> Where it is stored, how you write, how you connect — every later chapter just expands one of those three.

### What Amadeus is

Amadeus is the notes and knowledge Space of Forsion — the workspace that holds notes, databases, drawing boards, dashboards and attachments.

- To enter: click the Amadeus icon in the ribbon on the far left. The other Forsion Spaces are Home, Tangu, Inbox, Coding, Automation, Public and Calendar; switching Space never touches the files in your vault.
- To start the app in your notes: press `⌘/Ctrl + ,` for settings → "Workspace" → "Spaces" → under "Startup location", set "Open the app in" to Amadeus.
- Amadeus exists in the desktop app only — it reads and writes a folder on your computer directly.

Once you are in, the screen is laid out like this:

| Area | What is there |
|---|---|
| Left sidebar | Three tabs: "Workspace" (the note tree), "Search" (full text), and "Tags". `⌘/Ctrl + /` collapses and expands it |
| Middle | The note itself. The top bar carries the "Document / Canvas" pill: one set of content, two views of it |
| Right sidebar | "Outline", "Backlinks", "Graph"; builds that include Tangu also put a chat panel first. Collapsed by default, and it has no default hotkey |
| Bottom | The status bar, which can show the current note's word count and backlink count |

A vault can hold these kinds of things, and each one is a real file on disk:

| What you create | On disk |
|---|---|
| Note | `.md` |
| Base (database) | `.db` |
| Drawing board | `.excalidraw.md` |
| Dashboard | `.dashboard.md` |
| Sub-note | a `NoteName.fd/` folder next to the note |

### Your notes are just files on your disk

Every note is a plain Markdown file. No proprietary database, no export step — open the same folder in Obsidian, VS Code or any text editor and you see the same content.

- An existing folder of Markdown files works as-is: point "Open vault" at it. There is no import wizard, and none is needed — the files are already in the right format.
- Change files with another program (a text editor, git, a sync tool) and the note tree, search, backlinks and any open note follow along automatically, with no restart.
- A deleted note goes to the trash inside the vault, not into thin air. "Trash" at the bottom of the sidebar offers "Restore" and "Empty". Nothing is purged automatically — the trash grows until you empty it yourself.

> [!warning]
> `.excalidraw.md` (drawing boards) and `.dashboard.md` (dashboards) are Markdown files on disk, but **do not hand-edit them as ordinary notes**. Also: if a name collision breaks the suffix into something like `x.excalidraw-1.md`, that file stops being recognised as a drawing board and shows up in the tree as a plain note — restore the full suffix in the file name and it comes back.

- One class of thing is **not** in the files: pins, stars and collections are stored per device, not inside the note, and do not travel with it. Renaming or moving a note silently drops its pin and its star.
- Everything else — note body, wikilinks, frontmatter properties — lives in the file and follows you to another machine or another editor.

### Opening this manual again

This manual is itself a note, created inside your vault — so you can reopen it any time, and annotate it.

| Entry point | How |
|---|---|
| Command palette | `⌘/Ctrl + K` → "Open the user manual" |
| Welcome screen | With no note open in the main area, click the "User manual" button |
| Note tree | It is right there in the tree, named `Amadeus User Manual.md` (the Chinese copy is `Amadeus 使用手册.md`) |

> [!warning]
> While the caret is inside the body of a note, `⌘/Ctrl + K` does **not** open the command palette — the editor claims that key for "insert / edit link". Click somewhere outside the body first (the sidebar, an empty part of the top bar), then press `⌘/Ctrl + K`. Nothing is broken.

- Both the Chinese and the English copy are written to the root of your vault; the one matching your current interface language is what opens.
- An existing manual is **never overwritten**. The upside: notes you wrote on it survive. The cost: after an app update your copy may still be the old version — to get the new one, rename or delete the old file and run "Open the user manual" again.
- Run the command with no vault open and you get the message "Open a vault first — the manual is created inside it": the manual needs somewhere to be written.

### This manual and the tutorial are different things

| | User manual (this document) | Tutorial |
|---|---|---|
| Purpose | Full reference — look up what you need | First stop — ten minutes of learning by editing |
| How to open | `⌘/Ctrl + K` → "Open the user manual", or "User manual" on the welcome screen | `⌘/Ctrl + K` → "Open the tutorial", or "Tutorial" on the welcome screen |
| Shape | A document you read top to bottom | A demo note: a layered lesson in doc mode, a mind map when you switch to canvas mode |
| Can you edit it | Yes — it is an ordinary note in your vault | Yes, and **it is meant to be edited** — every lesson is something you can try on the spot |
| File name | One copy per language, each with its own name | Always `Amadeus 使用教程.md`, in both the Chinese and the English interface |

- Both are created only if absent; neither ever overwrites a file you already have under that name.
- Both need a vault open first — they are written into it.
- The tutorial's file name stays in Chinese on purpose: if the name followed the interface language, switching language once would create a second copy and the old one would no longer be recognised.
- Suggested order: run through the tutorial first (it demonstrates the doc/canvas pair along the way), then come back here to look things up.

### How to read this manual

Chapters are independent — start anywhere. Look up the feature you need; you do not have to read in order.

- To search this page: `⌘/Ctrl + F`, then Enter for next, `Shift + Enter` for previous, Esc to close. To search across notes: `⌘/Ctrl + P` opens "Quick find", which covers notes, files and sessions together.
- Anything in quotation marks is the exact wording shipped in the English interface. Switch to Chinese and the button text changes; the feature does not.
- Hotkeys are always written as `⌘/Ctrl + K`: press `⌘` on mac, `Ctrl` on Windows and Linux.
- Every hotkey printed here is the **default**. To change one: `⌘/Ctrl + ,` → "Appearance" → "Shortcuts", click the shortcut on the right of a row to start recording, press the combo to set it, Esc to cancel; each combo binds to only one command.
- Paragraphs marked `> [!warning]` describe the places where, not knowing, you would assume the app is broken. Do not skip them.
- Where a feature has a precondition (a vault must be open, desktop only, a plugin must be enabled), it is stated in the same sentence, not hidden elsewhere.

> [!info]
> Rebind Amadeus shortcuts **from inside Amadeus**: the shortcuts list in settings only shows commands registered in the current Space, so from any other Space the dozen-odd Amadeus commands are simply not in the list.

## 2 · The interface at a glance

The Amadeus interface has six parts: the ribbon, the left sidebar, the main area, the right sidebar, the bottom panel and the status bar. This chapter walks through all six — how to toggle each one, what lives in it, and the handful of places that look broken but are not.

### The window at a glance

Click "Amadeus" on the ribbon and the whole workspace becomes the notes layout. There are six parts to it:

| Region | What it holds | How to toggle |
| --- | --- | --- |
| Ribbon | The vertical strip on the far left. Spaces on top; Market, Achievements, light/dark, command palette, Settings and your account below | The top-most button collapses / expands it |
| Left sidebar | Three tabs: "Workspace", "Search", "Tags" | `⌘/Ctrl + /`, or the panel button at the left end of the tab strip (tooltip "Toggle left panel") |
| Main area | Notes, whiteboards and dashboards live here, opened as tabs, splittable | Always on |
| Right sidebar | "Chat panel", "Outline", "Backlinks", "Graph" | The floating panel button at the top right (tooltip "Toggle right panel"); collapsed the first time you arrive |
| Bottom panel | Empty in Amadeus — you drag a view into it | `⌘/Ctrl + J` |
| Status bar | Current Space, cloud sync, backlink count, word count | The master switch under Settings → Appearance → Status Bar |

> [!note]
> Everything note-related needs an open vault first. Until you open one, panels like search and tags just read "Open a vault first." — that is not an error.

> [!warning]
> A fresh install does not land in Amadeus. To start in your notes: Settings → Workspace → Spaces → "Startup location" → set "Open the app in" to "Amadeus".

### The ribbon and switching Space

Each icon in the ribbon's upper zone is a Space: Home, Tangu, Inbox, Amadeus, Coding, Automation, Public, Calendar — you get the ones you have installed.

- Switch: click an icon; or press `⌘/Ctrl + N`, where N is that icon's position in the upper zone (the command reads "Switch to Space {n}"); or find the same command in the palette.
- Collapse / expand: the top-most button. Collapsed shows icons only, with the name on hover (tooltip "Expand"); expanded shows icon plus name ("Collapse"), and the first nine also show their shortcut.
- Home slot: the single centred cell, holding "Home" by default, and also the default startup target. Right-click it → "Space in the home slot" → pick any Space. Whatever you put there disappears from the upper zone, so it never shows twice.
- The fixed strip at the bottom: "Market", "Achievements", "Toggle light/dark mode", "Command palette (⌘K)", "Settings", and your account card last.
- Tidying up: drag icons to reorder within their zone (you cannot drag between the two zones); create a folder from the ＋ or right-click menu ("New folder (Spaces)") and then drag icons onto it; when a zone runs out of room the tail collapses into "More". The same menu carries "New Space" and "Add command".

> [!warning]
> The slot number follows the current order — it is not tied to a Space. Drag an icon, or turn a built-in plugin on or off, and `⌘/Ctrl + N` opens something else; the Space sitting in the home slot takes no number at all. Expand the ribbon to see which number each icon has right now.

> [!warning]
> `⌘/Ctrl + K` does not open the command palette while the caret is inside note text — the editor uses that key for editing links. Click somewhere outside the note first, then press it.

### The left sidebar: workspace, search, tags

Three icon-only tabs, named in their tooltips. Amadeus opens on "Workspace".

| Tab | What it holds |
| --- | --- |
| Workspace | The note tree. The filter box "Search notes" at the top matches names only; below it come "Pinned", "Cloud sync", "Shared with me", "Starred", "Collections" and then the vault itself ("Cloud sync" and "Shared with me" appear only when cloud sync and collaboration are available) |
| Search | Full-text search (`⌘/Ctrl + ⇧ + F`). Each hit carries a highlighted snippet, opening one jumps to the first matching block and flashes it; "Save as collection" stores the query in the sidebar for one-click replay |
| Tags | Every inline #tag in the vault with its count; click one to expand the notes carrying it, click again to collapse |

- Under the filter box sit two quick-create buttons: "New note" and "New whiteboard".
- Two items are pinned to the footer: "Trash" and the vault switcher.
- Four click meanings in the tree: click = open; `⌘/Ctrl` + click = open in a new tab; `⇧` + click = select a range; `⌥/Alt` + click = add to or remove from the selection.
- Sidebar tabs have no ×; close one by right-clicking it → "Close".
- Every section except the vault itself starts collapsed and remembers its state; folders start fully collapsed on every launch.

> [!warning]
> Pressing `⌘/Ctrl + ⇧ + F` again while "Search" is already the front tab collapses the whole left sidebar rather than returning you to the input box.

> [!note]
> `⌘/Ctrl + P` opens "Quick find", which searches notes, files and chat sessions at once. The palette also has "Quick switch note", which searches only notes but can create a missing one (the new note lands at the vault root) — reach it from the palette, or give it a key under Settings → Appearance → Shortcuts.

### The right sidebar and the bottom panel

The right sidebar is collapsed the first time you enter Amadeus. Toggle it from the floating buttons at the top right of the workspace (tooltip "Toggle right panel"), or from the palette → "Toggle right sidebar".

| Tab | What it holds |
| --- | --- |
| Chat panel | Talk to Tangu beside the note you are reading; it quotes the note in the main area for you. Present only in builds that include the Tangu Space |
| Outline | The current note's headings, indented by level; click one to scroll to it |
| Backlinks | Other notes that link here, with a snippet; the heading carries the count: "Backlinks · {n}" |
| Graph | The current note and its neighbours |

- Graph controls: drag a node to move it, drag the background to pan, scroll to zoom, double-click the background to reset, click a node to open that note. A `[[link]]` to a note that does not exist yet shows as a dimmed ghost node; clicking it offers to create the note.
- Bottom panel: `⌘/Ctrl + J`, or the "Toggle bottom panel (Ctrl/Cmd+J)" button in the floating group at the top right.
- Both sidebars and the bottom panel resize by dragging their divider, and each Space remembers its own widths and height.
- The right sidebar is collapsed on first entry and after "Reset layout"; if you leave it open, it comes back open.

> [!warning]
> The right sidebar has no default shortcut — assign one under Settings → Appearance → Shortcuts if you want it. The left sidebar is `⌘/Ctrl + /`, not `⌘/Ctrl + B`, because that key belongs to bold in the editor.

> [!warning]
> In Amadeus the bottom panel opens empty, showing "Empty sidebar" — that is not a fault, this Space simply presets nothing there. Drag a view in from elsewhere and it fills up. Closing the last view inside it closes the whole panel.

### The main area: tabs, splits and the launcher

The main area is a browser-style tab strip; notes, whiteboards and dashboards all open as tabs.

- New: the ＋ at the end of the strip (tooltip "New tab") opens the launcher.
- Close: the × on a tab ("Close"). Right-clicking a tab also offers "Move to new window".
- Back and forward: the two arrows at the left of the strip, or `⌘/Ctrl + ⇧ + [` and `⌘/Ctrl + ⇧ + ]`; `⌘/Ctrl + ⌥/Alt + ←` and `⌘/Ctrl + ⌥/Alt + →` work too. History is per tab, so switching tabs switches which history you are walking.
- Splitting: drop a tab onto another tab strip to merge, or onto the body of a pane to split. The main area takes all four directions; sidebars only top and bottom. A drop that has nowhere to land shows no target and the tab snaps back.
- The launcher (page heading "New Tab"): "Recent" at the top, then a group of native Forsion entry points, then one group per plugin. Common cards are "Home", "New Chat", "New Note", "Today", "New whiteboard", "New dashboard", "Calendar" and "To-Do List". Most cards can be dragged straight onto a tab strip or sidebar to open there; the create-something cards deliberately cannot.
- Closing the last tab does not leave an empty window — you get a placeholder page with a "New Tab" button on it.
- Layout gone messy: the first floating button at the top right is "Restore default layout for this Space", called "Reset layout" in the palette.
- Layout you want to keep: palette → "Save current layout as a Space", give it a name, and it becomes a new Space on the ribbon (desktop app).

> [!warning]
> "Split right" (`⌘/Ctrl + \`) opens a chat pane, not a second copy of the current note. To read two notes side by side: right-click in the sidebar → "Open in new tab", then drag the new tab onto the body of another pane.

> [!warning]
> "Reset layout" has no confirmation and no undo — the tabs you had open in that Space are gone immediately.

### The note top bar and the doc/canvas control

Open a note and the top bar sits above the text; two more buttons sit below the bar and above the title.

| Control | Tooltip | What it does |
| --- | --- | --- |
| Breadcrumb | — | Click a segment to reveal that folder in the sidebar; a long path collapses to the first two levels + "…" + the parent |
| Document / Canvas | — | A two-segment pill reading "Document" and "Canvas"; click the other segment to switch presentation |
| Pin | "Pin" / "Unpin" | Pin it to the "Pinned" section in the sidebar |
| Cloud | "Turn on cloud sync" / "Turn off cloud sync (the cloud copy is kept)" | Cloud sync for this one note (local vaults only, and only when cloud sync is available) |
| Share | "Share / publish" | Share or publish this note (only when collaboration is available) |
| Source | "Switch to Markdown source" / "Switch to visual editing (WYSIWYG)" | Visual editing ↔ raw Markdown |
| Upload | "Upload files to this note" | Put files into this note |
| ⋮ | "More actions" | "Export as PDF", "Star", "Show in file manager", "Delete note" |

- The two buttons above the title: "☺ Add icon" gives the page an emoji icon, "🖼 Add cover" adds a banner image.
- Hover a cover for "Change cover", "Reposition" and "Remove"; to move the image, click "Reposition" first, drag up or down, then click "Done".
- "Toggle source / visual editing" is also in the command palette — the same thing as the top-bar button.
- Pins and stars are kept on this machine, per vault, rather than inside the note — another machine will not see them, and renaming or moving a note loses them.

> [!note]
> The Document / Canvas pill is drawn by the note into its own pane, so in a split view each pane has its own and they do not interfere. While a note is still working out its type that slot is briefly empty; it appears a moment later.

### Windows, zoom, themes and the status bar

A tab can be moved out into a window of its own, and tabs can be dragged between windows.

| Window | How to open it | Watch out |
| --- | --- | --- |
| Detached window | Right-click a main-area tab → "Move to new window", or drag the tab out of the window and let go | A full workspace, but with no ribbon — so you cannot change Space there, and there is no status bar either |
| Merging back | Drag a tab onto another Forsion window | The drop hint is a highlight around the whole window, not down to a single pane |
| Mini card | `⌘/Ctrl + ⇧ + M` (global), or palette → "Open mini card" | Chat only, no note views; if another app already owns that combination, the palette entry is the only way in |

- UI zoom: `⌘/Ctrl + =`, `⌘/Ctrl + -`, `⌘/Ctrl + 0`, from 50% to 200% in 10% steps. It scales the whole interface, not just the text. Settings → Appearance also offers Small (80%), Standard (100%) and Large (120%) presets; the shortcuts (desktop app only) and palette commands still fine-tune or reset it.
- Themes live under Settings → Appearance → Appearance, split into independent axes: "Design language" (Genesis, Genesis Glass · 「琉璃」, 「知」, plus anything you drop into the themes folder), "Color scheme" ("Accent" and "Background" are two separate axes, each offering Classic, Coral, Teal, Lavender, Zhi Blue, Custom), "Light / Dark" (Light, Dark, Follow system), "Shadow" (Raised, Flat) and "Frosted glass" (On, Off (low-power mode)).
- Light and dark also flip in one click: the moon icon at the bottom of the ribbon, or palette → "Toggle light/dark mode".
- The status bar is the last line of the window: current Space (click = open the palette), cloud-sync state (click = sync now), backlink count, word count. The master switch and the per-item visibility list are under Settings → Appearance → Status Bar, and the order is draggable.

> [!warning]
> Some design languages lock the colour scheme (Genesis Glass · 「琉璃」 is fixed to the system). The moon icon then does nothing and its tooltip changes to "This theme follows the system appearance" — not a fault, that theme simply does not allow the switch.

> [!warning]
> In the palette, "Switch theme style" changes the design language; "Switch language" is the one that switches the interface between Chinese and English. They sit next to each other — do not mix them up.

> [!note]
> The backlink and word counts appear only while the main area holds a note editor; switch to a whiteboard, dashboard, PDF or database and they vanish. Also, clicking the backlink count opens "Backlinks" in the main area, not in the right sidebar.

## 3 · Your vault and its files

A vault is just an ordinary folder on your disk. Notes are plain Markdown files and attachments are ordinary images and PDFs — no hidden database, no proprietary format, and you can open the same files with another program at any time. This chapter covers opening a vault, organising the files inside it, and which file names you must not change.

### Opening and switching a vault

Pick any folder to be your vault, and everything under it — Markdown notes, attachments, databases, drawing boards — becomes your file tree. Three entry points, all the same action:

| Entry point | Where | Label |
|---|---|---|
| Sidebar footer button | Below "Trash", pinned so it never scrolls away | "Open vault" with no vault open, otherwise "Vault: {name}" |
| Welcome screen button | The main area when no vault is open | "Open a vault folder" |
| Command palette `⌘/Ctrl + K` | Anywhere | "Open vault…" |

- The folder picker is desktop only; on the web the same footer button opens the "Cloud vault" panel instead.
- The first launch does not ask which folder you want — it creates `Forsion/Amadeus` in your home folder as the default vault and seeds a `Calendar.db` in it.
- Every launch after that reopens the last vault and returns to the note you last had open. If that folder is gone, the main area reads "Open a vault folder to get started."
- Switching vaults flushes unsaved edits back to the old vault before the root changes, so nothing leaks between libraries.
- After you switch vaults by hand you land on the first note alphabetically, not where you left off — that is normal for a switch, as opposed to a restore on launch.
- Trash, pins and stars are recorded per vault, so a different vault means a different set of them.

> [!note]
> The system folder-picker dialog is titled in Chinese ("打开 Vault 文件夹") even in the English interface. That is the operating system dialog's title and it does not affect anything.

### The note tree: browsing, filtering, selecting

The left sidebar lays the whole vault out as a tree: folders first in alphabetical order (empty ones included), then every file — notes, attachments, databases, PDFs, images, drawing boards. A note with an icon shows that icon instead of the generic file glyph. The whole tree sits in a section named after the vault folder; click that name to collapse it all.

Above the tree sit a few more sections: "Pinned", "Starred", "Collections", "Shared with me", "Cloud sync". Press and drag a section header to reorder them (mouse only); the order and each section's open state are remembered.

- The box at the top, "Search notes", filters by **file name** and replaces the tree with a flat list. It does not search note contents — full-text search is a separate command, `⌘/Ctrl + Shift + F` "Search notes (full text)"; to jump by name use `⌘/Ctrl + P` "Quick switch note".
- While the filter box has text, folders are not shown and you cannot drag a file to the vault root. With no hits it reads "No matching notes".
- Hover a row for file details: "Modified: {t}", plus "Created: {t}" where the filesystem can supply it; hovering a folder shows "{files} files, {folders} folders".
- Click the breadcrumb above a note title and the sidebar expands the parent chain, scrolls that row into view and flashes it.
- Paths deeper than three segments show as "first two + … + last" in the breadcrumb, and that ellipsis is not clickable.

Selection follows the Finder / Explorer conventions:

| Action | Result |
|---|---|
| Click | Opens it, and selects only it |
| `⌘/Ctrl` + click | Opens it in a new tab |
| `Shift` + click | Selects a contiguous range, limited to currently visible rows (does not open) |
| `Option/Alt` + click | Adds or removes one row from the selection (does not open) |
| Click blank space | Clears the selection |

With several rows selected, the right-click menu offers exactly two batch actions: "Open {n} items in new tabs" and "Delete {n} items".

> [!warning]
> Folders start fully collapsed on every launch — only the section-level open state is remembered, not the folders'. Nothing is broken.

### Creating notes, folders and other files

| To create | How | What lands on disk |
|---|---|---|
| A note | Sidebar "New note", right-click blank space or a folder, `⌘/Ctrl + N`, command palette | `untitled.md` (then `untitled-2.md` on collision) |
| A sub-note | The ＋ at the end of a note row (tooltip "New sub-note"), or right-click the note | Written into `<Note>.fd/` |
| A folder | Right-click blank space → "New folder"; right-click a folder → "New subfolder" | Default name "New folder" |
| A database | Right-click blank space or a folder → "New base" | `Untitled database.db` |
| A drawing board | Sidebar "New whiteboard", right-click, command palette | `Untitled whiteboard.excalidraw.md` |
| A dashboard | Right-click → "New dashboard", command palette | `Untitled dashboard.dashboard.md` |

- The sidebar's top strip has exactly two buttons: "New note" and "New whiteboard". Folders, bases and dashboards can only be created from a context menu (or the command palette).
- `⌘/Ctrl + N` means "New note" only inside the Amadeus space — it takes over the new-chat binding while you are there and hands it back when you leave. With no vault open the command does nothing.
- A new note really is called `untitled.md` on disk, but the title bar shows an empty field with the placeholder "New Page". Editing the title renames the file.
- Sub-notes live in a `.fd` folder named after the note. That folder is hidden in the tree; the sub-notes hang off the parent note's row, which grows a chevron and a child count.
- Creating a base with a name that already exists is rejected up front: "“{name}” already exists". That is deliberate — a table's file name and its internal title must match, and auto-appending a suffix would split them.
- If you have plugins installed, their own "New X" entries appear below these built-in ones, with the plugin's own icon and wording.

> [!warning]
> In the new-whiteboard dialog, the part that picks paper size and orientation ("纸张", "无限画布", "纵向", "横向") is in Chinese only, including in the English interface.

### Renaming and moving

Renaming has three entry points and they all do the same thing: move the file to a new name on disk, rewrite every `[[wikilink]]` pointing at it across the whole vault, and re-point any open tab that was showing it.

- Right-click a note or a `.db` in the tree → "Rename": that row turns into a text field. Enter commits, `Esc` cancels, clicking away also commits.
- The big title in the editor is the file name: click it, type, Enter commits (and the cursor slides into the body), `Esc` reverts.
- Right-click a folder → "Rename" uses a dialog (titled "Rename folder"), not an inline field; confirming rewrites links in every note underneath it.

> [!warning]
> There is **no** "Rename" item in the context menu for PDFs, images, drawing boards or plain attachments. Only notes, `.db` files and plugin file types can be renamed from the tree. To rename anything else, use "Show in file manager" and rename it in the operating system.

Moving works one way only: drag. There is no "Move to…" item in any menu.

| Drop it on | Result |
|---|---|
| A folder row, or anywhere inside an expanded folder | Moves into that folder |
| A note row that has sub-notes | Becomes one of its sub-notes (goes into `.fd`) |
| Blank space in the vault section | Moves to the vault root |
| An ordinary note row (one with no sub-notes) | Nothing happens |

- A move carries the note's `.fd` sub-note folder along with it, and rewrites links across the vault as usual.
- Drag one row of a multi-selection and the whole batch moves.
- A destination that already has a `.fd` folder of the same name is refused: "A .fd folder with the same name already exists at the destination". A note also cannot be dropped into its own `.fd`.
- While the search box has text, the "drop on blank space to move to the root" case is disabled.

### Deleting and the trash

On the desktop, deleting does **not** ask: right-click "Delete" moves the item straight to the trash with the toast "Moved to trash". Batch delete is the exception — it always confirms first with "Delete the {n} selected items?".

When you delete a note, if some attachments are referenced by that note alone, a dialog asks what to do with them:

- The dialog is titled Delete "{name}", with three buttons — "Cancel", "Delete note only", "Delete them too" — plus the checkbox "Don't ask again (change it back in Settings → Notes)".
- Attachments that any other note also references are always kept, whatever you choose.
- To change the behaviour back: Settings → Notes → "Editing and safety" → "Delete exclusive attachments with the note", with the options "Ask every time", "Remembered: delete them", "Remembered: keep them". That choice is stored on this device, not in the vault.
- Deleting a note that has sub-notes deletes its whole `.fd` subtree too; the confirmation tells you how many sub-files that is first.

The trash sits at the very bottom of the sidebar, button "Trash", with a count when it is not empty; it is desktop only — where there is no trash, deleting confirms first and then deletes for good. Items are listed newest-first, each showing where it came from ("Original location: {path}").

| Action | What it does |
|---|---|
| "Restore" | Puts it back where it came from (missing parent folders are recreated; a taken spot gets `(2)`) |
| "Delete" | Deletes it for good, confirming "Permanently delete “{name}”? This cannot be undone." |
| "Empty" | Empties everything, confirming "Empty the trash? Everything in it is deleted permanently." |

> [!warning]
> Anything in the trash disappears **immediately** from the file tree, search results, backlinks and cloud sync — the scanner skips that folder. So when a note "has vanished" or "cannot be found any more", check the trash first. The trash is never purged automatically and has no size limit; you have to press "Empty" yourself.

### What the files on disk are

There is no hidden database in the vault. Everything is a file, told apart by its extension:

| Name | What it is |
|---|---|
| `.md` | A note |
| `.excalidraw.md` (and `.excalidraw`) | A drawing board |
| `.dashboard.md` | A dashboard |
| `.db` | A database / note view |
| `Note.fd/` | That note's sub-note folder (hidden in the tree; its contents hang off the note's row) |
| `.amadeus/` | Pasted images, one folder per containing folder |
| `attachments/` | Files you dragged in (the location is configurable, see below) |
| `.trash/` | The trash |

> [!warning]
> `.excalidraw.md`, `.dashboard.md` and the compound suffixes claimed by plugins all end in `.md`, but they must never be opened or renamed as ordinary notes. The app checks the whole compound suffix before it applies the "`.md` means note" rule precisely so it never rewrites them. If a compound suffix gets broken — say a name collision turns a file into `x.excalidraw-1.md` — that file stops being a drawing board and comes back into the tree as an ordinary note.
> The other way round, the rule is the suffix table, not "has two dots": `Report.001.md` and `Note.fd.md` are genuine notes.

- Where attachments land is a setting: Settings → Notes → "Files and attachments" → "Attachment location", one of three — "attachments/ folder next to the note" (the default), "Same folder as the note", or "Fixed folder in the vault" (then fill in a path such as `assets` under "Vault-relative folder").
- Whether a dragged-in file is inserted as a preview block or a plain link is controlled by "Editing and safety" → "Preview imported files by default".
- Paste a screenshot with `⌘/Ctrl + V` and the image is saved into the `.amadeus/` folder beside the note, with a standard Markdown image inserted in the body; spaces in the file name become underscores.
- Attachments kept outside the vault cannot be previewed inline, as the hint in Settings says.

To look at the real files, right-click any item → "Show in file manager" (desktop only); the command palette also has "Reveal current note in file manager". To hand a file to your operating system's default program, use "Open with the system app" — that is also what clicking an audio or video file in the tree does, rather than opening the in-app player.

### How a note is stored

A new note is a piece of plain Markdown on disk, without even a leading `---` frontmatter block. Open it in another editor and you see exactly what you typed.

The small capsule under the title is the properties bar, reading "Properties {n}"; expand it for a key/value list of that note's frontmatter. Add one with the ＋ beside it (tooltip "Add property"), remove one with the × that appears at the end of a row on hover (tooltip "Delete property").

- There is no property-type picker: a new property is always empty text, and the control is inferred from the YAML value — `true` gives a checkbox, a number gives a number box, a string shaped `2026-09-05` gives a date picker, a list gives removable chips, and nested structures are read-only.
- To get any other type, write the value in source mode, or use a note view column.
- The page icon `icon`, the cover `cover` and its position `cover_y` are ordinary property rows too — delete them here and the icon and cover go with them.
- If the frontmatter is broken into invalid YAML, the capsule changes to "Properties (raw)" and expands into a single textarea holding the raw text, so you can repair it by hand without the app rewriting anything.

These are the app's own structural keys. They **appear only once the note actually uses columns or the canvas**, and should not be edited by hand:

| Key | When it appears |
|---|---|
| `amadeus_schema` | Whenever columns or a canvas is present; it comes and goes with them |
| `amadeus_layout` | The note uses a column layout |
| `amadeus_canvas` | The note uses canvas mode |

> [!warning]
> Editing any property from the properties bar re-serialises the whole frontmatter block, so **comments in the YAML are lost**. To keep it byte-for-byte, edit in source mode: the `</>` button in the top bar (tooltip "Switch to Markdown source"), or "Toggle source / visual editing" in the command palette. That command has no hotkey.

Source mode is the only place the frontmatter can be edited verbatim, and it is also where you give a property its type — write `done: true` and next time you get a checkbox, `count: 3` a number box, `due: 2026-09-05` a date picker, `- item` a list of chips:

```markdown
---
done: true
count: 3
due: 2026-09-05
tags:
  - reading
  - wip
---

- [ ] The body is written as usual — it is ordinary Markdown
```

### Sharing the vault with other apps

Obsidian, or any app that stores its notes as plain `.md`, just needs its folder picked with "Open vault". There is nothing to import and no import wizard — the files are already a common format, so they work as they are.

Dragging files in from the operating system has two landing places:

| Drop them on | Result |
|---|---|
| A folder row, inside an expanded folder, or blank tree space | Copied into the vault as-is, touching no note; toast "Imported {n} files to “{where}”" |
| An ordinary note row, or straight into the editor body | Saved to your configured attachment location and referenced from that note |

- Only genuinely blank space counts as "the root"; a drop on a row or a section is cancelled rather than quietly importing to the root.
- Drawing boards, dashboards, plugin files and plain attachments do not accept a body drop — drop a file on one of those rows and it lands in their **parent folder** instead. A note with sub-notes behaves the same way: the file goes into its `.fd`.
- If you switch away mid-upload the file is still saved, but the placeholder line in the body is left as it is, and the toast says so.

External changes are picked up automatically (desktop): edit, add, move or delete files in the vault with another editor, `git` or another sync tool, and the file tree, search index, backlinks and open notes all follow without a restart. While you are typing, write-back from outside is held off so it cannot eat the character you are entering.

- If search or backlinks ever look stale — usually after a large batch of changes made outside the app — use the command palette → "Rebuild full-text index". It has no progress bar and no completion toast; when it is done, it is done.
- Do not hand `.trash` to an external sync tool: it is hidden from this app, but not from the sync tool.
- Watch the compound suffixes when renaming from outside (see the warning in the previous section) — break `.excalidraw.md` and the file stops being a drawing board.
- Pins and stars are recorded on this device, not in the note file, so they do not travel with the files to another machine.

> [!warning]
> Do not keep the same note open for editing in two apps at once. This app guards against one specific thing — an external write-back eating the character you are typing — and it is not a two-way merge tool. Edit on both sides at once and whichever save lands last overwrites the whole file.

## 4 · Writing: the block editor

An Amadeus note is made of blocks: a line of text, a snippet of code, a table, a card are all blocks. There are three interchangeable ways to make one — the slash menu, Markdown prefixes, the ⠿ block handle — and knowing any one of them is enough. This chapter lists every entry point on all three.

### The slash menu ("/")

Type `/` at the start of a line or after a space in any text block and a block-type menu opens at the caret. What you type stays in the document, so no letters are ever swallowed; a space, a `]`, a newline, or going past 40 characters closes the menu and leaves `/xxx` as ordinary text.

- Keys: `↑↓` to move, `↵` or `Tab` to insert, `esc` to close. The footer reads "↑↓ Select", "↵ Insert", "esc Close", and an empty result shows "No matches".
- Keywords include pinyin aliases, so `/biaoti` finds "Heading". With an empty query items are grouped as "Basic", "Lists", "Advanced", "Callouts"; once you type it becomes one flat list ranked by match.
- After you close it with `esc`, that same `/` will not reopen the menu — delete it and type a fresh `/`.
- Enter during IME candidate selection is passed through, not taken by the menu.
- A `/` inside a code block is always a literal character; no menu opens.
- The grey hint in an empty block, "Type '/' for commands", is the only pointer to this menu.

| Menu item | What it inserts | Typed equivalent |
| --- | --- | --- |
| Text | A plain paragraph, lifting the line out of any list or quote | — |
| Heading 1 | A level-1 heading | `#` + space |
| Heading 2 | A level-2 heading | `##` + space |
| Heading 3 | A level-3 heading | `###` + space |
| Heading 4 | A level-4 heading | `####` + space |
| Heading 5 | A level-5 heading | `#####` + space |
| Heading 6 | A level-6 heading | `######` + space |
| Card | Turns the block the cursor is in into a canvas card; if the cursor was already inside a card, the new card becomes its child | — |
| Bulleted list | A bullet list | `-` + space |
| Numbered list | An ordered list starting at 1 | `1.` + space |
| To-do list | A checkbox list item | `- [ ]` + space |
| Quote | A blockquote | `\|` + space |
| Toggle | A collapsible callout block | `>` + space |
| Code block | A fenced code block | ` ``` ` + space |
| Table | A 2-column, 1-row table | — |
| Divider | A horizontal rule | `---` |
| Equation | A one-line `$$  $$` skeleton | `$$` + space |
| Link to note | `[[`, followed by the note picker | `[[` |
| Image | Opens the file picker, saves an attachment and inserts `![[filename]]` | — |
| Columns | Puts this block on its own row and opens a column to its right | — |
| Page | A child note, plus a link to it | — |
| Database | A new database file, embedded | — |
| Drawing | A new Excalidraw drawing file, embedded | — |
| Link database | Embeds a database that already exists in the vault | — |
| Note view | A view whose every row is a note | — |
| Template | Opens the template picker and inserts what you choose | — |
| Embed block | A read-only transclusion of content from elsewhere | — |
| Bookmark | One bare link, rendered as a bookmark card | — |
| Button | An unconfigured button block | — |
| Note callout | `> [!note] ` | — |
| Info callout | `> [!info] ` | — |
| Warning callout | `> [!warning] ` | — |

> [!note] Groups and gates
> The three "Callouts" items come from the built-in "Callouts" plugin, toggled in Settings → Plugins; plugin item names only follow a UI language change after a restart. "Button" is desktop only. "Card" is not offered in the touch "+" block panel. The table scaffold's header cells are always written as 「列 1」 and 「列 2」, in either language — just type over them.

### Markdown prefixes and inline syntax

Type a prefix at the start of a line and press space: the line converts on the spot — the prefix characters are removed, the caret stays put, and no new block appears.

| Type this | You get |
| --- | --- |
| `#` + space … `######` + space | Heading 1–6 |
| `-` / `*` / `+` + space | Bulleted list |
| `3.` + space | Numbered list, numbering from 3 |
| `[]` / `[ ]` / `[x]` / `- [ ]` / `- [x]` + space | To-do (the x forms start out checked) |
| `\|` + space | Quote |
| `>` + space | Toggle block |
| ` ```py ` + space | A code block in py (a bare ` ``` ` is plain text) |
| `$$` + space | An equation skeleton |
| `---` / `___` + space / `***` + space | A divider (`---` fires on the third hyphen, no space needed) |

> [!warning] Two things differ from other Markdown editors
> `>` + space gives you a collapsible Toggle block, not a quote. A plain quote is `|` + space.

- Headings are set, not stacked: typing `# ` on a level-2 heading gives you a level-1 heading, and repeating the same level does nothing.
- Heading text may start with a number: once a heading is active, typing `1. xxx` keeps `1. ` as literal heading text instead of turning the heading into a numbered list. `1. ` in a paragraph and other prefixes in a heading still convert as before.
- Inside a list item, `-` / `1.` / `[ ]` change the current list's type or checkbox state rather than nesting another list.
- Enter fires the same conversions as space: type a single `#` and press `↵` to get a heading.

Inline syntax that converts as you type:

| Type this | You get |
| --- | --- |
| `**bold**` / `__bold__` | Bold |
| `*italic*` / `_italic_` | Italic |
| `` `code` `` | Inline code |
| `~del~` / `~~del~~` | Strikethrough |
| `[text](url)` | A link, live the moment you type the closing paren |
| `![alt](url)` | An image |
| `[[` | The note picker; picking one writes `[[Note name]]` |
| `@` | The same note picker |
| `【【` | Becomes `[[`, so you need not switch keyboards |

- Links accept only `http:`, `https:` and site-relative paths; a bare domain gets `https://` added; things like `javascript:` are rejected and left as plain text. `mailto:` and `tel:` are not supported.
- `@` stops being a mention at any space, bracket, newline, or past 30 characters; an `@` preceded by a non-space character (inside an email address, say) never triggers it.
- Put the caret at the very start of a rendered heading, list, to-do or quote line and press `←` or `Backspace`: the line's Markdown marker appears and can be edited character by character. Keep the marker intact (including its trailing space) and the line keeps its type; break it and the line falls back to a plain paragraph.

### The ⠿ handle and the block menu

Hover any block and a ⠿ handle plus a ＋ button appear in the left margin.

- Click ⠿ (tooltip "Click for menu, hold to drag") or right-click the block — this selects the block and opens its menu.
- Press and hold ⠿ to drag: drop between two rows to reorder, drop on a row's left or right edge to split into columns, drop out on the canvas stage (in canvas mode) to turn the block into a card. A drop-indicator line shows where it will land.
- Click ＋ (tooltip "Add block below") to insert an empty paragraph below the current block, with the caret in it. It inserts a plain empty paragraph; it does not open the slash menu.
- Headings and list items with children get a fold chevron in the margin, with tooltips "Collapse section" / "Expand section" and "Collapse children" / "Expand children". This kind of fold is view state and is not written to the file; a Toggle block's open state is written into the Markdown and survives in other editors.
- `Esc` selects the whole block the caret is in, so copy, cut and delete act on the block; press `Esc` again to get back into the text. If a popup is open, `Esc` closes that first.
- `⌘/Ctrl + A` selects in tiers: first the current text block, then its top-level block (the whole list, the whole quote, or the block within its column), and only on the third press the whole note.
- `⌘/Ctrl + ⇧ + ↑` / `⌘/Ctrl + ⇧ + ↓` move the current block up or down among its siblings.
- Deleting a block that points at a file on disk asks whether to delete that file too; cutting does not.

The block menu, in order: the section header "Turn into", then "Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "To-do list", "Quote", "Toggle", "Card", a separator, then "Move to new column", "Return to document", "Duplicate block", "Delete".

- "Card" is hidden when the selection is a card, a column row, a column cell, a list item, or a block inside a column cell; "Return to document" appears only when what you selected is itself a card.
- Some notes use a shorter block menu instead: "Copy embed reference", "Duplicate block", "Move to new column", "Delete", with no "Turn into" section. A brand-new note you have not saved yet, and legacy-format notes opened after you switch off Settings → "Upgrade legacy notes to v4 plain Markdown on open", both behave this way. In those notes, change a block's type from the slash menu, a prefix, or the inline toolbar; their slash menu also has no "Card", and Enter does not fire the prefix conversions.

### Turning blocks into other blocks, and the inline toolbar

There are three routes to a different block type, each covering a different set:

| Entry point | Targets it offers |
| --- | --- |
| Slash menu | Every block type |
| Block menu, "Turn into" | Text, Heading 1–3, Bulleted list, Numbered list, To-do list, Quote, Toggle, Card |
| Inline toolbar, "Turn into…" | Text, Heading 1–6, Bulleted list, Numbered list, To-do, Quote, Toggle, Code block, Equation |

Headings 4–6 can only be reached from the slash menu or the inline toolbar; Divider lives only in the slash menu; Columns and Card only in the slash menu and the block menu.

Select some text and a toolbar floats above the selection: leftmost is a button showing the current block type (tooltip "Turn into…"), then "Bold", "Italic", "Underline", "Strikethrough", "Inline code", "Link", the colour menu A ▾, "Clear formatting", "Align left", "Align center", "Align right". `Esc` closes it.

- A button lights up only when the format covers the whole selection; on a half-covered run it shows inactive, so pressing it again formats the entire run.
- No toolbar appears when the selection is an image. Across blocks, the type button reads "Multiple blocks".
- Shortcuts: `⌘/Ctrl + B` bold, `⌘/Ctrl + I` italic, `⌘/Ctrl + U` underline, `⌘/Ctrl + ⇧ + S` strikethrough, `⌘/Ctrl + K` link, `⌘/Ctrl + L` align left, `⌘/Ctrl + R` align right.
- `⌘/Ctrl + K` is the same path as the 🔗 button: if the selection is already a link it removes the link, and on an empty selection it does nothing. The dialog is titled "Insert link" with the hint "Type or paste an address (a bare domain gets https:// added)".
- A ▾ opens two swatch rows: "Text color" with 10 colours and "Background color" with 10 — Default, Red, Orange, Yellow, Green, Teal, Blue, Purple, Magenta, Gray, with the background row swapping Magenta for Pink. Picking "Default" clears that colour. Colours are stored as hex in the file, so Obsidian shows them too.
- `Tab` / `⇧ + Tab` follow the first rule that matches: indent two spaces inside a code block, move to the next or previous cell inside a table, sink or lift a list item, add or remove one indent step in a plain paragraph. `Tab` never moves focus out of the editor.
- Paragraph indent has a ceiling; deeper indents in an imported file stay as text. `Tab` onto a folded previous sibling only expands it — press again to actually indent.

### Columns and cards

Putting two blocks side by side has three entry points:

- Slash menu "Columns": the current block takes a row of its own, an empty column opens to its right, and the caret moves into it.
- Block menu "Move to new column": the same result.
- Press and hold ⠿ and drop the block on a row's left or right edge to open a new column on that side. Notes that use the shorter block menu also show the hint "Drag ⠿ to a column edge to split into columns · drop between rows to add a row".

Press in the gap between two columns and drag sideways to change their widths.

> [!warning] Columns work on top-level blocks only
> Run it inside a list, or on a block already sitting in a column, and you get "Columns only work on top-level blocks — move this block out of its current column or list first." The `/columns` you just typed is already gone by then, so type it again.

Card has a sibling restriction: choose "Card" on a list item or on a block inside a column cell and you get "This block cannot be turned into a card — move it out of the list or columns first." On success you get "Turned into a card — switch to canvas mode at the top right to see it." — a new top-level card is inserted at the end of the note, which is why it disappears from where you were typing; nothing is lost. Cards are still visible in doc mode: a card with no parent looks exactly like ordinary body text, and one with a parent is indented and framed. To see how they are arranged, use the segmented control at the top right to switch to canvas mode. A card made while the caret was inside another card becomes its child.

### Code blocks, equations and callouts

Code blocks:

- Slash menu "Code block", or ` ```py ` + space at the start of a line. An empty block is replaced in place, a non-empty one gets a new block below; text after the caret moves into a paragraph after the code block rather than being swallowed.
- Hover a code block and a toolbar appears at its top right: a language dropdown (titled "Language", with a "Plain text" entry, recently used languages first), "Copy" (titled "Copy code", flashing "Copied"), "Wrap", "Numbers" (which becomes "Hide numbers"), and "Fold" (which becomes "Unfold").
- The language is the fence info and is saved to the file; wrap, numbers and fold are view state for this session only and reset when you reopen the note — deliberately, so nothing proprietary goes into the Markdown.
- Line numbers are unavailable while wrap is on, and the button explains "Line numbers are unavailable while wrapping is on (soft-wrapped lines have no number of their own)". "Fold" limits the block to 8 lines.

Equations:

- Slash menu "Equation", or `$$` + space at the start of a line, inserts a one-line `$$  $$` skeleton with the caret between the delimiters.
- It renders with KaTeX whenever the caret is elsewhere, and shows its source when the caret is on that line. Hovering the rendered result reveals a `</>` button ("View source") that jumps into the source; note links and `![[…]]` image embeds carry the same button.
- An equation that cannot be parsed shows "Formula could not be rendered".

> [!warning] An equation must be on one line
> Only the one-line `$$  $$` form renders. Two `$$` on separate lines are read as two paragraphs and will never render.

Callouts:

- A blockquote whose first line starts with `[!type]` renders as a coloured callout. The types with a colour of their own are note, info, tip, hint, warning, caution, danger, error, bug, example, quote, plus the fold type used by Toggle blocks; anything else falls back to the note colour.
- Add `+` or `-` after the type to make it foldable, and a chevron appears next to the title ("Expand" / "Collapse"). The open state lives in that one character in the Markdown, so Obsidian opens it folded too.
- While the caret is elsewhere, the `[!type]` token and any `## ` or `- ` prefix in the title are hidden; they come back when you edit the title line.

### Images, embeds, bookmarks and file blocks

- "Image" opens the system file picker, saves the image you choose as an attachment next to the note, and inserts `![[filename]]`, which renders as an image block with a resize handle. A failed save says nothing at all — if no image appears after the insert, just do it again.
- "Embed block" asks for a `note-name#block-id` (dialog "Embed a block reference", confirm button "Embed"); a note name on its own embeds that note's first block. If the clipboard already holds an `![[…]]` the field is pre-filled — "Copy embed reference" in the shorter block menu is where such a reference comes from.
- An embedded block is read-only where it sits, carrying an "↪ Embed" badge and an "Edit at the source" link.
- "Bookmark" asks for a link, with the hint "Paste a link starting with https:// — YouTube links turn into an embedded player." Only addresses starting with `https://` or `http://` are accepted; anything else is discarded. On disk it is one bare link, rendered as a bookmark card with page information.
- Pasting a link outright pops a small "Paste as" menu: "Link" (hinting the hostname), "Bookmark card" ("Default"), "Embed" ("Player / web page"). Nothing is highlighted at first, so pressing Enter right after the paste still inserts a newline; press `↑` or `↓` to pick an item first, then `↵` or `Tab` confirms — any other key dismisses the menu and goes through as normal.
- "Page" creates a child note in this note's sub-folder, inserts a `[[link]]` to it, and opens it.
- "Database" creates a database file and embeds it as `![[…]]`, rendered as an interactive table. "Link database" lists every database in the vault for you to pick from; with none there yet it shows "No databases in this vault yet (create one with /database)".
- "Note view" creates a folder plus a view definition in which every row is a note.
- "Drawing" creates a drawing file and embeds it, in the same format the Obsidian Excalidraw plugin uses, so one vault opens in both.
- "Template" opens the template picker — templates live in the vault's `templates/` folder — and inserts the one you choose at the caret.
- "Button" inserts an unconfigured button block; clicking that fresh button opens the builder, where you attach a manual automation rule, a label, an icon and an optional confirmation prompt. Desktop only.
- To tick a to-do, click the box itself: it is drawn in the list's left margin, and a click that lands on the text does nothing.

## 5 · Formatting and editing

Formatting in Amadeus happens as you type: inline formatting has both a floating toolbar and key bindings, the Markdown source is always one click away, and folding, indent and undo each behave in a definite way. This chapter is organised by what you press — every entry says where to press it, what happens, and when it will not show up.

### Select text and the toolbar appears

Drag-select a non-empty stretch of text in a note and a formatting toolbar floats above the selection (it flips below when there is no room above). There is no hotkey and no menu entry — selecting is the switch, and `Esc` dismisses it.

Twelve controls, left to right:

| Control | What it does |
|---|---|
| The leftmost button with a ▾ | Shows the current block type; opens the "Turn into…" menu |
| B / I / U / S | "Bold", "Italic", "Underline", "Strikethrough" |
| `</>` | "Inline code" |
| 🔗 | "Link"; on a selection that is already a link it removes the link |
| A ▾ | "Text / background color", opens two rows of swatches |
| T× | "Clear formatting" |
| The three rightmost | "Align left", "Align center", "Align right" |

- B / I / U / S / `</>` light up only when the whole selection carries that format. On a partly covered selection they read as inactive, and pressing once applies the format to all of it.
- "Turn into…" is a list of 14 block types: "Text", "Heading 1" through "Heading 6", "Bulleted list", "Numbered list", "To-do", "Quote", "Toggle", "Code block", "Equation". The whole block the selection sits in is converted.
- "Toggle" is not a block type of its own — it wraps the block into a callout that starts folded (see the folding section below).
- Colours come in two rows: "Text color" with 10 swatches (Default, Red, Orange, Yellow, Green, Teal, Blue, Purple, Magenta, Gray) and "Background color" with 10 (Default, Red, Orange, Yellow, Green, Teal, Blue, Purple, Pink, Gray). "Default" clears that colour.
- "Clear formatting" strips inline marks only (bold, italic, underline, strikethrough, inline code, links, colours). It does not change the block type — a heading stays a heading, a list stays a list.
- Alignment applies to paragraphs and headings only; list items, table cells and code blocks are not affected. When a multi-block selection has mixed alignment, none of the three buttons light up.

> [!warning] Toolbar did not appear? It is almost always one of these five
> - You selected an image — the toolbar stays out of the way for images.
> - One of the `[[`, `@`, `/` or "Paste as" popups is open.
> - You scrolled the page or resized the window — both close it immediately; just select again.
> - The selection spans several blocks — the toolbar is there, but the leftmost button reads "Multiple blocks".
> - You are not in the note editor: read-only views, a `.md` file opened directly in the workspace, and the hover preview of a wikilink do not have this toolbar.

### Keyboard shortcuts

With the caret inside a note body, these keys belong to the editor:

| Shortcut | What it does |
|---|---|
| `⌘/Ctrl + B` | Bold |
| `⌘/Ctrl + I` | Italic |
| `⌘/Ctrl + U` | Underline |
| `⌘/Ctrl + Shift + S` | Strikethrough |
| `⌘/Ctrl + E` | Inline code |
| `⌘/Ctrl + K` | Link; on a selection that is already a link it removes it, and it does nothing on an empty selection |
| `⌘/Ctrl + L` | Align left |
| `⌘/Ctrl + R` | Align right |
| `⌘/Ctrl + Z` | Undo |
| `⌘/Ctrl + Shift + Z` or `⌘/Ctrl + Y` | Redo |
| `⌘/Ctrl + Alt + ↑` / `↓` | Move the current block up / down (`⌘/Ctrl + Shift + ↑` / `↓` does the same) |
| `Esc` | Select the whole block; press again to go back into the text |
| `⌘/Ctrl + A` | Tiered select-all: this block → the whole top-level block → the whole note |

> [!warning] Two things that look like bugs and are not
> - The centre button's tooltip says `⌘/Ctrl + E`, but that combination is inline code inside the editor. To centre text, click the centre button on the toolbar. `⌘/Ctrl + L` and `⌘/Ctrl + R` do not have this problem.
> - While the caret is in a note body, `⌘/Ctrl + K` is "Link", not the command palette. To open the palette, click outside the note body first.

- These keys belong to the editor itself. They are not listed under Settings → Appearance → Shortcuts and cannot be rebound; that page covers app-level commands such as find in page.
- A physical keyboard is required. Mobile installs no global hotkeys — use the floating toolbar instead.
- Tiered select-all needs "Upgrade legacy notes to v4 plain Markdown on open" under Settings → Workspace → Notes to stay on (it is on by default).
- Typing Markdown is a shortcut too: `**bold**`, `*italic*`, `` `code` `` and `~~strikethrough~~` convert on the spot, and `[text](address)` becomes a live link the moment you type the closing paren.
- Link addresses go through a safety filter: only `http` / `https` and site-relative paths are accepted, a bare domain gets `https://` added, and things like `javascript:` and `data:` are rejected and left as ordinary text.

### Enter, line breaks, and indent

There are three kinds of Enter — do not mix them up:

| Key | Result |
|---|---|
| `Enter` | Starts a new paragraph. On a folded heading, the new paragraph lands after the folded section and inherits the heading's level |
| `Shift + Enter` | A line break inside the same paragraph — no new paragraph |
| `⌘/Ctrl + Enter` | Inside a quote = a line break within the quote; inside a list = same as Enter, it splits the item; everywhere else = a new empty paragraph below, without splitting the current text |
| `Tab` | Indents the paragraph one level; inserts two spaces inside a code block (a multi-line selection is indented line by line); moves to the next cell in a table; sinks a list item |
| `Shift + Tab` | The reverse of the above |
| `Backspace` at line start | First outdents one level; at the left margin it follows a ladder: a non-empty heading drops to body text in one step → the list or quote wrapper comes off → the block merges into the one above |
| `⌘/Ctrl + Backspace` | Back to the left margin in one step |

- Paragraph indent is capped at 8 levels. It is written to disk as literal leading tabs, so the indent survives in other editors.
- Enter inherits the current indent level. Pressing Enter in an empty indented paragraph **keeps the same level** — that is deliberate; to get out, press `Shift + Tab` or `Backspace` at the start of the line.
- Paragraphs inside list items and quotes do not take indent levels: lists sink and lift instead, and Markdown cannot express an indented paragraph inside a quote.
- `Tab` never moves focus out of the editor — the key is always swallowed.
- `Tab` against a folded previous sibling only unfolds it; press again to indent.
- Enter inside a quote gives you two clean quote paragraphs, not a line break. For a line break inside a quote, use `⌘/Ctrl + Enter`.
- Inside a code block, `Shift + Tab` removes up to two leading spaces per line.
- If a file brought in from elsewhere has more than 8 leading tabs on a line, the extra ones stay in the text — no characters are lost.
- Outdent-by-backspace and `⌘/Ctrl + Backspace` need "Upgrade legacy notes to v4 plain Markdown on open" under Settings → Workspace → Notes to stay on (it is on by default).

> [!note] Type `#`, `-`, `1.`, `- [ ]` or `>` at the start of a line and press space, and the line converts to that block on the spot — the trigger characters are removed and the caret stays where it is. Enter fires the same conversions (this also needs the "upgrade to v4" setting above to be on).

### Source and visual editing

A whole note can switch between visual (WYSIWYG) editing and plain Markdown source. Three entry points, none with a default hotkey:

- The button on the right of the note's top bar, tooltip "Switch to Markdown source"; in source mode it reads "Switch to visual editing (WYSIWYG)".
- The command palette (click outside the note body first, then press `⌘/Ctrl + K`) → "Toggle source / visual editing". This command is only in the palette while the Amadeus Space is active.
- On touch devices: the "⋯" on the bottom editing capsule → "Switch to Markdown source" / "Switch to visual editing". Mobile hides the whole top bar row, so this is the only way in.

What happens to the caret:

- The caret is carried across; it no longer jumps back to the top of the file.
- When the position cannot be recognised (the text around the caret is all Markdown syntax — `**bold**` is just "bold" on the visual side), the caret falls back to **the start of that block**. It will never land in a different block.
- In a split view each panel remembers its own caret.
- Switching to source and back expands every folded heading section.

To see the source of just one element, you do not have to switch the whole note:

- Equations, `[[wikilinks]]` and `![[images]]` — anything that renders into a finished object once the caret leaves the line — show a small `</>` button in their top-right corner on hover, tooltip "View source". Clicking it puts the caret into the raw Markdown; moving the caret away re-renders it.
- Touch devices have no hover state, so this is a desktop and web capability; read-only views do not get the button.
- An `![](path)` image has no literal source in the document, so clicking its button opens a one-line source input box instead of moving the caret into the text.

Line-start markers can be edited character by character too: put the caret at the very start of a line and press `←` or `Backspace`, and `### `, `- `, `1. `, `- [ ] `, `> ` turn into a real input box. Change `###` to `##` and the level drops; delete it all and the line goes back to a plain paragraph. Breaking the syntax (losing the trailing space, `##` becoming `#x`) drops the structure there and then and writes the remaining characters back as a plain paragraph — that is by design. This path covers headings, bulleted lists, numbered lists, to-dos and quotes only; toggle tokens and code fences do not round-trip this way.

### Folding: heading sections and callouts

There are two kinds of folding and they behave very differently — one is a temporary view state, the other is written into the file.

Heading section folding:

- Hover a heading line and a fold button appears in the left gutter, tooltip "Collapse section", and "Expand section" once folded; a folded heading also keeps a permanent expand button at the start of its line.
- The section ends at the next heading of the same or a higher level (or at the end of the container). Headings inside cards and inside columns fold too.
- An empty section (a heading immediately followed by a heading of the same level) gets no fold button.
- The same gutter button on a list item reads "Collapse children" / "Expand children".
- Folding is purely visual — not one character of the Markdown on disk changes.
- The fold state **lives only for this session**: switching to source mode or reopening the note expands everything again.
- There is no hotkey and no command for it.

Callout folding:

- A quote whose first line starts with `[!type]` renders as a coloured callout. The types with their own colour are `note`, `info`, `tip`, `hint`, `warning`, `caution`, `danger`, `error`, `bug`, `example`, `quote`. Any `[!word]` is accepted; the rest fall back to the default blue.
- A `-` after the type makes it start folded, a `+` makes it start expanded, and a chevron follows the title text, tooltip "Collapse" / "Expand".
- Three ways to toggle it: click anywhere on the title line, click the chevron, or press Enter while it is folded (it expands first, then breaks the line). **Double-clicking** the title line reveals the `[!note]-` token itself.
- The fold state is written into the `+` / `-` in the Markdown, so it survives reopening the note and reads the same way in Obsidian.
- To make a folded block quickly: type `>` at the start of a line and press space, or select text → toolbar "Turn into…" → "Toggle".

> [!warning] The two traps
> - `>` + space gives you a **collapsible callout**, not a plain quote. The plain quote is `|` + space.
> - A folded region is out of the caret's reach: arrow keys are pushed past it and find in page will not match folded text. That is deliberate — it stops you typing into content you cannot see.

### Undo, find in page, and word count

Undo and redo: `⌘/Ctrl + Z` to undo, `⌘/Ctrl + Shift + Z` or `⌘/Ctrl + Y` to redo. A physical keyboard is required.

- Typing is merged into chunks by short pauses rather than one step per character; structural changes (converting a block, moving one, deleting one) are one step each.
- Undoing on the canvas walks the same single timeline — text typed inside cards is on it too, and steps back in the order things happened.
- Outside changes from cloud sync, an agent writing to disk, or editing the same file in Obsidian **will not interrupt the keystroke you are in the middle of**: they wait until you stop typing, and wait indefinitely while an input method composition is open. So content that updates a beat late is this guard doing its job, not the app hanging.

Find in page: `⌘/Ctrl + F`, or the command palette → "Find in page". The bar docks to the top right of the current view.

- The input reads "Find in page…" and searches as you type; `Enter` for next, `Shift + Enter` for previous, `Esc` to close; a `3/12` counter sits on the right.
- It scans everything in the current view, not just the note body — embed cards, databases and canvas elements all count, and it works in source mode too.
- Matching is case-insensitive. A single match may span bold, links and inline code, but it **never crosses a block**.
- Text you cannot see does not match: folded sections, and card bodies replaced by a short title on a zoomed-out canvas, are skipped.
- When focus is inside the built-in terminal, a code editor or an embedded web page, the key steps aside for their own find.
- The scan re-runs automatically after the content changes (typing, streaming output). Switching away to another tab retracts the bar.
- The key can be rebound or unbound under Settings → Appearance → Shortcuts. Mobile installs no global hotkeys — use the command palette.

Word count:

- Open a note and the right end of the status bar at the bottom of the window shows "{n} chars" live. That is a **character count** (length with all whitespace removed), not a word count.
- It can be turned off on its own under Settings → Appearance → Status Bar, where the item is called "Word count".
- If you want words: command palette → "Count words", which shows a notification reading "About {chars} characters · {words} words on this page". Words are split on whitespace, so the number is of limited use in Chinese text. The command comes from a built-in plugin and disappears if you disable that plugin on the plugins page.
- The status bar belongs to the desktop shell; mobile does not have it.

### How the caret and selection behave

The smooth caret is **off by default**. Turn it on and the caret glides to its new position (Word-style):

- Settings → Appearance → the "Smooth caret" switch, or command palette → "Toggle smooth caret" (no default hotkey).
- It covers two places: the Amadeus editor and the Tangu chat input.
- It is not drawn while there is a selection; it hands over to the system caret whenever focus is in a real input box (such as the line-start marker source box from the previous section) so you never see two carets; and it steps aside entirely when a touch keyboard comes up.

Selection:

- `Esc` selects the whole block the caret is in, so copy / cut / delete act on the block; a second `Esc` puts the caret back in the text. If a popup is open, `Esc` closes that first.
- `⌘/Ctrl + A` works in three tiers: the text of this block, then the whole top-level block (an entire list, an entire quote), then the whole note.
- Deleting a block that references a file on disk asks whether to delete that file too; cutting does not ask.

Two things happen with a live selection that are worth knowing before they surprise you:

- Typing `(`, `[`, `{`, `<`, `"`, `'`, `` ` `` — or the full-width `（`, `【`, `「`, `《`, `“`, `‘` — **wraps** the selection instead of replacing it. The text stays selected afterwards, so you can add a second layer. A backtick gives you inline code straight away. Multi-block selections are not wrapped, and inside a code block a bracket is just a bracket.
- **Pasting a URL over selected text** turns that text into a link instead of replacing it. The rule is strict: a non-empty selection inside a single block, and a clipboard holding exactly one whitespace-free `http` / `https` address. It does not apply inside code blocks.

Two more caret-level details:

- A to-do's checkbox is drawn in the padding to the left of the list, and only a click in that gutter toggles it. A click even slightly to the right lands in the text and does nothing.
- An empty block the caret is sitting in shows a grey hint: a plain paragraph says "Type '/' for commands", a heading names its own level as "Heading {n}". The hint is suppressed inside quotes, callouts and code blocks.

Wrapping with paired characters and tiered select-all both need "Upgrade legacy notes to v4 plain Markdown on open" under Settings → Workspace → Notes to stay on (it is on by default).

## 6 · Cards and the canvas

A card is a movable shell wrapped around one block. The shell is what gives that block its own position, size and parent/child links, which is what lets it sit on a canvas. So a note has two views of the same content: doc mode reads top to bottom, canvas mode spreads the cards out to arrange by hand — both views share one copy of the content, and switching changes nothing you wrote.

### What a card is

A card is not a new kind of content, just a shell around one block. The text inside stays ordinary Markdown and reads the same in any other editor.

| Term | What it means |
|---|---|
| card | A block in a shell — selectable, movable, resizable, and able to have parents and children |
| main card | The body text that was never pulled out into a card; the whole flow counts as one card |
| hierarchy | The parent/child links between cards, stored in the note's frontmatter only — never in the body text |

The main card behaves almost exactly like a normal card: select it, drag it, resize it, press Space to edit it, grow children from it, and let another card adopt it as a parent. Two exceptions:

- The main card cannot be deleted — it is the note body itself, so its right-click menu has no "Delete".
- The main card can only be a parent; it can never become another card's child.

> [!note]
> Notes in the old format need an upgrade before they have cards or a canvas. Settings → Notes → "Editing and safety" → "Upgrade legacy notes to v4 plain Markdown on open" is on by default; turn it off and old notes get neither cards nor the view pill. The upgrade is written to disk only after you really edit the note.

> [!warning]
> Cards and canvas mode are not the same thing as "New whiteboard" in a folder's right-click menu. A drawing board is its own separate file; a card is another view of the same note.

To try it straight away: open the command palette (`⌘/Ctrl + K`) and search for "Open the tutorial". It creates a real note in your vault, [[Amadeus 使用教程]], where each lesson is a card and the parent/child links indent into a hierarchy in doc mode and lay out as one branch in canvas mode. You need an open vault first, or the tutorial has nowhere to go. The file name does not follow the interface language — both languages write the same file — and an existing tutorial is never overwritten, so delete it first if you want a fresh one.

### Turning a block into a card, and back

Put the cursor in a block and take either entrance:

- Type `/` on an empty line or after a space and pick "Card" from the "Basic" group (the hint column reads `Canvas`; card, 「卡片」, node and canvas all match).
- Hover the block, click the `⠿` handle in the left gutter, and pick "Card" from the "Turn into" section. Right-clicking a block in doc mode opens the same menu.

> [!warning]
> A top-level card is inserted at the END of the note — the paragraph you were typing in vanishes from where you were. The app says "Turned into a card — switch to canvas mode at the top right to see it." Nothing is lost; it moved.

Not every block can become a card. List items, column rows and columns, and anything sitting inside a column cell are refused with "This block cannot be turned into a card — move it out of the list or columns first." In those cases the block menu simply does not offer "Card" at all. The mobile `+` two-column block panel does not list "Card" either — type `/` in the note instead.

Unwrapping has exactly one entrance: the menu. Dragging a card anywhere only moves it; it never unwraps implicitly.

| Where | How | Menu item |
|---|---|---|
| Canvas mode | Right-click the card | "Unwrap into document" |
| Doc mode | Select the whole card, then `⠿` or right-click | "Return to document" |

Two ways to select a whole card in doc mode: put the cursor in the card and press `Esc` once; or hover any line inside it and click the extra `❏` button in the gutter (tooltip "Select card, hold to drag it"). Press `Esc` again for a text cursor. Note that hovering a card's **first or last line** gives that line's own `⠿`, not the whole card — use `❏` or `Esc` for the card.

> [!note]
> Unwrapping happens **in place**: the content stays where it is and turns back into ordinary blocks; it does not travel back to where it originally came from. The shell's anchor is not recycled — an inert comment stays in the file, so any `![[note#anchor]]` embed elsewhere keeps resolving, at the cost of a blank-looking empty paragraph at that spot in the editor. Unwrapping the last card dissolves the note's canvas data only when the note also has no shapes, connectors or frames left and the main card is still at its default position and width. A note that still holds any whiteboard element, or whose main card you have moved or resized, keeps its canvas data.

### Doc mode and canvas mode

The note's top toolbar carries a segmented pill (same row as the path and share controls) with two words: "Document" and "Canvas". One click switches the view.

| Entrance | Where | Label |
|---|---|---|
| Desktop | The pill in the note's top toolbar | "Document" / "Canvas" |
| Touch | The Frame-icon button in the bottom editing bar | "Switch to canvas" / "Switch to document" |

On touch devices that whole toolbar row is not rendered, leaving only the bottom-bar button. In source mode ("Switch to Markdown source" in the top bar) neither entrance appears.

- Switching a view **writes nothing to disk**. A note that has never used the canvas just gets looked at differently; its frontmatter does not even gain the canvas line.
- What is remembered is "which view this note last used on this machine", and that local memory wins over what the file records. So switching to canvas on the desktop does not make the note open as a canvas on your phone.
- Touch devices **always open in doc mode**, whatever the file says. To see the canvas, press the bottom-bar button yourself.
- There is no command-palette command for switching views; the pill and the bottom-bar button are the only two entrances.

Switch to the canvas while typing and the card holding the cursor is brought into view and stays editable; switch back and your old scroll position returns. If you were only browsing, each side keeps its own remembered position instead of jumping to a stale selection. The document scroll position lasts only for this session and is gone when you close the app; only the view itself is remembered long term.

> [!info]
> The two views share one copy of the content and one set of folds — switching only changes appearance, it does not rebuild the editor. So your undo history survives a view switch: you can move cards on the canvas, switch back to the document and press `⌘/Ctrl + Z`.

One more thing: find-in-page still locates matches in canvas mode. The canvas does not use ordinary scrolling, so a match is translated back into stage coordinates and brought to the centre of the view.

### Selecting and editing on the canvas

On the canvas a single click is reserved for selecting and dragging. **Nothing inside a card responds until that card is in edit mode — this is not a bug.** Clicking a to-do checkbox or a `[[wikilink]]` raises a hint instead of acting:

> [!warning]
> "Double-click a card (or select it and press Space) to edit — then you can tick to-dos and open backlinks"

Entering and leaving edit mode: double-click a card (caret lands where you clicked), or select it and press `Space` (caret lands at the end); `Esc` returns to the selected state. Real controls are the exception — buttons, links, the `</>` source toggle, an embed card's open button and database buttons inside a card all work without editing first, and switch the card into edit mode as they go.

| Action | Result |
|---|---|
| Click a card | Selects just that card |
| `Shift` + click or drag | Takes the card and every descendant, selected and moved together |
| `⌘/Ctrl` + click | Adds exactly this one card, without its descendants |
| Press and drag on empty space | Marquee select (mouse and trackpad only; not on touch) |
| `⌘/Ctrl + A` | Selects every card, the main card and shapes (connectors and hierarchy lines are excluded) |
| `←` `→` `↑` `↓` | Nudge by 8px |
| `Shift` + arrow keys | Nudge by 1px |
| `⌘/Ctrl + C` `X` `V` | Copy / cut / paste cards |
| `Delete` / `Backspace` | Delete the selection |

> [!warning]
> The arrow keys are the reverse of most software: a bare arrow key is the 8px big step, and `Shift` is the 1px fine step. `Shift` is also "take the whole branch" — `Shift`-click a card, press `Delete`, and every descendant goes with it. Use `⌘/Ctrl` when you mean one card.

Both cards and the main card can be resized, through two hot zones:

- **While nothing is selected**: move the pointer to the **right edge** of a card (or of the main card's body text) — there is a roughly 12px resize strip there; drag sideways to change the width.
- **While a single card is selected**: eight handles appear on the selection box — four edges and four corners. An edge changes one dimension; a corner pins the opposite corner and changes width and height together.

A card's minimum size is 168 × 72px; the main card has a larger floor of 320px wide — it is the body text, and squeezing it narrower stops being a document. A purely horizontal drag (the left or right edge, or the right-edge strip) writes no height, so the card still grows and shrinks with its content; drag vertically or diagonally once and the height is pinned. With "Snap to grid" on, the height snaps at the moment you release just as the width does. Pressing a handle without moving it writes nothing.

Cards never stack:

- However a new card is created, it is nudged clear of the cards already there instead of landing on top of them.
- Release a card overlapping another one and it slides to the nearest free spot with a short spring animation. It looks like the card "bounced back", but it is just the anti-overlap rule, and the whole gesture is still one undo step.

Right-click gives three menus, in this order:

- A card or the main card: "Connect to…", "Auto-arrange" (only when it actually has children), "Group into a frame", "Unwrap into document" (absent on the main card), "Delete" (absent on the main card).
- A shape, connector or frame: "Edit text", "Connect to…", "Group into a frame", "Delete".
- Empty canvas: "New card", "Rectangle", "Ellipse", "Text", `Frame`, "Fit to content". That `Frame` entry reads the same in both languages.

Right-clicking a card you are editing yields to the system text menu (copy, paste, spell-check) instead. On touch, a 500ms long press is the right-click. One `Esc` backs out four levels in order: close the context menu, cancel a connector in progress, return from the current tool to the select tool, clear the selection.

Copy and paste cover cards only: within the same note a paste reproduces whole cards with their geometry, arrangement and embeds; into another note or another window they are rebuilt one by one from markdown, so formatting survives but the arrangement degrades to a 24px staircase; text copied from anywhere else lands as one new card. Shapes, connectors and parent/child links are not carried on the clipboard. A paste lands at the centre of the view rather than at the pointer, and repeated pastes offset by 24px.

Copying a card and then **pasting it in doc mode** gives you its content as a run of ordinary blocks, not a second card. For a real copy use "Duplicate block" in the block menu, or hold `⌥/Alt` (`Ctrl` on Windows and Linux) while dragging `❏` in doc mode.

Besides the slash menu and the block menu, the canvas turns anything you drop on it into a card. While you drag something over the stage, the whole stage lights up as a drop zone.

| What you drop | What you get |
|---|---|
| Files from your computer (dragged in from Finder or File Explorer) | **One card per file**, holding a reference to that attachment. A placeholder card reading "Uploading {name}" lands first and is swapped for the real reference once the file is stored; if storing fails the placeholder is removed rather than left behind as an empty shell. Several files at once are staggered by 24px |
| A note, a session or a workspace file dragged from the sidebar | One card holding a `[[wikilink]]` to it |
| Text or a link from another app | One card whose content is parsed as Markdown into real blocks — headings, lists and `[[wikilinks]]` come through as real nodes |

Files and sidebar references **always belong to the stage**: even if you release them on top of a card you are editing, they mean "put something down here", not "insert into that card". Plain text is different — released inside a card you are editing, it belongs to the editor and lands at the caret. The size limits, the failure messages and where the attachment ends up are exactly as when you drag a file into the document; see chapter 12.

- [ ] Clicking a checkbox inside a card does nothing? Double-click into edit mode first.
- [ ] Deleted more than you meant to? Check whether `Shift` was held.
- [ ] Copied a rectangle and nothing pastes? The clipboard carries cards only.

### Child cards and the mind map

With exactly **one** card selected (the main card counts) and focus on the stage:

| Key | Result |
|---|---|
| `Tab` | Grows a child card |
| `Enter` | Grows a sibling card |

The mouse equivalent is the pair of ⊕ affordances that appear on a selected card: the one on the right is "New child card (Tab)", the one below is "New sibling card (Enter)". They show only on a single selection that is not in edit mode, and hide when you pick a tool other than select. The new card is placed on whichever side of the parent is emptier and nudged clear of existing cards; focus stays on the stage afterwards, so you can keep pressing `Tab` to keep growing the branch.

> [!warning]
> These two keys work only while focus is on the stage. With the caret inside a card's text, `Tab` is paragraph indent and `Enter` is a new paragraph — that belongs to the editor, and the split is deliberate.

Three more ways to change parent/child links:

- **Drag onto an edge to adopt**: drag a card so the **pointer** lands on the target's left or right edge to become its child, or its top or bottom edge to become its sibling. During the gesture the target is outlined and a label previews "Attach as child" or "Attach as sibling"; on release the card springs into the queue. The judgement is the pointer's position, not how close the two boxes are — the middle of a card is a wide neutral zone, and parking there only moves the card. Dropping a card as a top-level sibling actively detaches its old parent; that is the only drag gesture on the canvas that removes a link (dragging `❏` out of a parent's run in doc mode does too — see the end of this section). A target that would create a cycle is not even highlighted.
- **The arrow tool**: click the parent, then the child. The link is made without **moving** anything. The same thing is on each object's right-click menu as "Connect to…".
- **Delete the hierarchy line**: the drawn hierarchy line can be clicked. Select it and press `Delete` and only that parent/child link is removed — no card moves.

The main card is the root: it can have children but can never become another card's child — an attempt to link a card to it falls back to a plain connector. A card that has children gets one extra right-click item, "Auto-arrange": it holds that node still and fans all of its descendants out as a mind map, splitting the first-level branches left and right, without touching anybody else's position; one `⌘/Ctrl + Z` restores the lot. Select a card that has links and its own parent and child lines brighten while unrelated cards and lines fade; faded cards are still clickable and one click makes them the new focus.

Back in doc mode, the hierarchy shows as indent plus a rounded frame:

- Indentation goes up to 6 levels; the drawn frame goes only to the second level — from the third level down cards are indented but not boxed.
- Children of the main card are treated as level 0, so they are neither indented nor framed.
- A card's markdown always sits inside its parent's section — when you adopt a card or create a child, that card and the descendants immediately following it move as a run to just after the parent.
- Dragging the `❏` handle in doc mode to pull a card out of its parent's run detaches it. No doc-mode gesture **creates** a link; adoption is canvas-only.
- What a `❏` drag moves is **one whole unit** — that card plus the descendant cards immediately following it.
- The only legal landing place is the seam between two top-level units; a card can never go inside another card, and a drag released anywhere else simply does nothing.
- If the landing place is the lower edge of a folded heading, that heading is expanded first, so the card does not disappear into a hidden section.
- Hold `⌥/Alt` (`Ctrl` on Windows and Linux) while dragging to **copy** the card instead of moving it. The copy is minted with a fresh anchor and is a free card: it inherits neither a parent nor children.

### Panning, zooming and the view switches

Panning has four equivalent entrances: the hand tool in the toolbar, holding `Alt` and dragging, dragging with the middle mouse button, and the scroll wheel (vertical) or `Shift` + wheel (horizontal). Two-finger trackpad scrolling does the same. The hand tool, `Alt` and the middle button **do not interrupt a card you are editing** — moving the viewport should not break your typing.

Zoom runs from 25% to 250%:

| How | Anchored on |
|---|---|
| `⌘/Ctrl` + wheel | The pointer |
| Trackpad pinch | The pointer |
| "Zoom out" and "Zoom in" at the bottom right | The centre of the view, 1.2× per press |

The current percentage sits between those two buttons. Beside them are several switches:

- "Fit to content": frames everything (cards, the main card, shapes, connectors and labels) into view and centres it with a 48px margin, capped at 100%. It runs once automatically the first time you open a note's canvas. The same item is on the empty-canvas right-click menu.
- "Snap to grid": a 24px grid that cards snap to at the moment you release them, while the drag itself still tracks your pointer pixel by pixel. On by default and remembered across reloads.
- "Show minimap" / "Hide minimap": the overview at the bottom right draws cards, the main card, shapes and your current viewport box; click or drag that box to navigate without changing zoom. On by default.
- "Low-zoom overview": at or below a chosen zoom, card bodies are replaced by a title and summary while card heights and connector geometry stay put; zoom back in and the body returns. A selected card always keeps its full body.

> [!warning]
> The trigger zoom for "Low-zoom overview" defaults to 25% — it only collapses at the furthest zoom-out, which is why many people think the switch is broken. To make it kick in sooner, go to Settings → Notes → "Editing and safety" → "Zoom that collapses cards to titles" and pick 25% / 40% / 55% / 70% / 100%. The change takes effect immediately; you do not need to reopen the note.

The same page has "Focus canvas cards on double-click": when it is on, double-clicking a card both enters editing and smoothly centres the card at a readable zoom (up to 1.5×); when it is off, you edit in place and the viewport stays put. With the system's reduce-motion setting on, there is no animation — the view jumps straight to the target.

> [!note]
> "Snap to grid" and the minimap switch **share one preference with the dashboard canvas**: turn either off in one place and it is off in the other too. The canvas position and zoom are session state only — they are gone when you close the app and are never written into the note.

On touch devices (Android tablets, touchscreen laptops) the canvas answers to a different set of gestures:

| Gesture | Result |
|---|---|
| Two fingers | Pan and zoom at the same time, anchored at the midpoint between your fingers |
| One finger dragged on empty space | Pans the canvas |
| One finger dragged on an **unselected** card or shape | Also pans the canvas — a finger is less precise than a mouse and the canvas is usually crowded, so panning on empty space alone would mean barely panning at all |
| A tap first, then a drag | This is what actually moves that card |
| Double-tap | On a card it enters edit mode; on empty space it makes a new card — and the card is created the moment you **lift** your finger, so a pinch or a long press never leaves a stray card behind |
| A 500ms long press | Is the right-click |

There is no marquee select, no `Space` to edit and no `⌘/Ctrl + Z` on touch, so multi-select means tapping the cards one at a time.

### Shapes, frames and connectors

A toolbar floats at the left of the stage with eight tools; pressing one switches to it, and the creation tools return to the select tool once you are done.

| Tool | Tooltip |
|---|---|
| Select | "Select (Esc)" |
| Pan | "Pan (or hold Alt and drag)" |
| Card | "New card (or double-click empty space)" |
| Rectangle | "Rectangle" |
| Ellipse | "Ellipse" |
| Text | "Text" |
| Frame | "Frame: drag to size (or click for the default size)" |
| Arrow | "Arrow: click the parent, then the child (Shift or a shape = free connector)" |

The tools have no letter shortcuts; the only tool key is `Esc`, which returns to select. Rectangle, ellipse and frame can be dragged out to a size, falling back to a default if you do not drag; **text can only be created with a click**.

- Shapes can be dragged, reshaped from their corners (24px minimum) and given text. The reshape handles appear only on a **single selected element**.
- To edit text: double-click the shape or connector; or select it and press `Enter` or `F2`; or right-click → "Edit text". The dialog's heading follows the type: "Connector label", "Frame title", "Element text". Clearing the text removes it rather than storing an empty string.
- "Group into a frame" wraps the current selection in a frame with 32px of padding around it. With nothing selected it frames just the object you right-clicked.
- Land the arrow tool's second click on a shape or frame, or hold `Shift` for that second click, and you draw a plain connector instead of a parent/child link. `Alt` cannot stand in for `Shift` — `Alt` is already taken by panning. After the first click a rubber-band preview follows the pointer, and clicking empty space abandons it.

> [!warning]
> A frame's body ignores the pointer entirely — **only its title bar can be clicked or dragged**. Clicking inside a frame does not select it. That is a deliberate trade-off (otherwise a full-screen frame would be an invisible sheet blocking the whole canvas), not a bug.

Dragging a frame's title bar carries away every card and element that is **fully inside** it. Partial overlap does not count, and the membership is fixed at the moment you press down — it is not recomputed while you drag.

> [!note]
> A new text element's default content is written to the file in **whatever interface language was active when you created it**. Create one with the Chinese interface and it still reads 「文本」 after you switch the interface to English.

To delete: with focus on the stage press `Delete` or `Backspace`, or right-click → "Delete". Deleting also trims any connector whose end sits on the object you removed. `Backspace` while typing inside a card belongs to the editor and will not delete a selected shape by mistake.

- If a card you delete holds a file you dropped in (an attachment reference), you are asked whether to delete the file on disk too, exactly as when you delete that block in the document.
- Cutting (`⌘/Ctrl + X`) never asks — moving is not deleting, and the file has to stay for the card you are about to paste.

### Where the geometry lives, and undo

Switch to source mode ("Switch to Markdown source" in the top bar) and you can see the two things the canvas leaves behind:

- Each card's content is wrapped in a pair of comments: an opening anchor `<!-- a k1 -->` and a closing `<!-- /a k1 -->`.
- All the geometry lives in **one single line** of frontmatter called `amadeus_canvas`: the position and size of the main card and every card, the shapes and connectors, and the table of parent/child links. Coordinates are always whole numbers, and an omitted height means the card sizes itself to its content.

A note that never used the canvas simply does not have that line: skip the canvas and the file gains nothing at all.

```
---
amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"k1","x":40,"y":40,"w":300},{"ref":"k2","x":40,"y":300,"w":300}],"tree":{"k2":"k1"}}
---
```

> [!warning]
> Be careful editing that line by hand in another editor: the rule is to discard rather than guess. Only three things void the whole line: a version that is not `1`, the same `ref` listed twice in the cards list, and a coordinate or width written as a string like `"900"` — any one of those and the whole line is treated as "this note has no canvas". The line you wrote is kept verbatim, not wiped. Changing anything on the canvas then reports the failure to your face: "Canvas changes were not saved: the amadeus_canvas line in this note cannot be parsed — check it in source mode."
>
> Anchors in the body are judged one at a time, and a bad one never takes the others down with it: an anchor that is not in the list is simply skipped, so that one region does not fold into a card, and an opening anchor that appears twice in the body leaves both of those regions unfolded. Every other card still folds, the canvas line stays valid and nothing is reported — which is what lets the inert anchor left behind by unwrapping a card sit in the file harmlessly.

Undo runs on **one timeline**: text typed inside cards, card geometry, shapes and connectors, and hierarchy changes all share a single stack in the order they happened. Pressing `⌘/Ctrl + Z` while typing inside a card asks that same timeline.

| Action | Key |
|---|---|
| Undo | `⌘/Ctrl + Z` |
| Redo | `⌘/Ctrl + Shift + Z` |

- There is no `⌘/Ctrl + Y`; redo is only the combination above.
- One drag is one undo step — but dragging the same card twice within 500ms is two steps.
- "Auto-arrange" commits the whole subtree's coordinates as a single step, so one undo restores all of it.
- Undo inside a dialog's text field belongs to the system and does not touch this timeline.
- Touch devices have no undo shortcut, and there is no gesture that stands in for one.

> [!note]
> The record for shapes and connectors holds at most 50 steps, and each open note keeps its own — changing pages or closing the tab clears it.

## 7 · Links, tags and the graph

Notes in Amadeus are not islands. This chapter covers how to connect them with wikilinks: typing and autocomplete, embeds, hover preview, backlinks, tags, the graph, and what happens to links after a rename. Everything here needs a vault open and the Amadeus Space active.

### Wikilink basics

Type `[[` in a note body, then the target note name, and you have a wikilink. The full-width `【【` produced by a Chinese IME is converted to `[[` on the spot.

- `[[Target]]` — links to the note of that name
- `[[Target|alias]]` — shows the alias, still links to the target
- Move the caret off the line and the link renders as coloured text; put the caret back on the line and the raw `[[...]]` reappears for editing
- Clicking a link while the caret is on that line only moves the caret, it does not navigate
- `[[...]]` inside a code block is never rendered

Click a rendered link and the target opens in the current pane. Resolved links carry the target note's emoji icon; unresolved ones render dimmed with a dashed underline. There is no modifier-click to open a wikilink in a new tab from the note body — it always loads into the current pane.

A bare name is looked up in this order:

| Order | Where it looks |
|---|---|
| 1 | Notes in the same folder as the current note |
| 2 | The current note's own `.fd` sub-notes |
| 3 | The first note of that name anywhere in the vault |

A name containing `/` is treated as a path and skips those three steps.

Clicking a dimmed, unresolved link asks first, and tells you exactly where the file will land: the dialog is titled "New note", the message names the note that does not exist yet and the location it would be created at, and the confirm button reads "Create".

- A bare name → created in the source note's `.fd` sub-folder
- A name containing `/` → created at that path
- No source note (for example when you clicked through from a database view) → created at the vault root

`[[https://…]]` opens in your external browser; `[[table.db]]`, `[[doc.pdf#page=3]]`, drawings and mind maps each route to their own in-app view.

### The autocomplete popup and @ mentions

Typing `[[` opens a candidate list of at most 8 rows, fuzzy-ranked, with 2 slots reserved for files such as attachments and databases so they are never squeezed out by notes. Each row shows the name in bold with its folder underneath.

| Key | What it does |
|---|---|
| `↑` `↓` | Move through the rows |
| `Enter` or `Tab` | Insert the highlighted row |
| `Esc` | Close the popup |
| Letters, space, `Backspace` | Go to the editor as usual, so the query keeps updating |

Insertion picks the shortest unambiguous form: if the name is unique in the vault it inserts the bare name, otherwise it inserts `folder/Name|Name`, which points precisely and still displays cleanly.

When the query matches nothing, a final create row appears at the bottom of the list.

> [!warning]
> That row is labelled 「新建链接」 “…” — it stays in Chinese even when the interface is in English. This is a known gap in the wording, not the wrong interface language.

The `@` mention is the same thing without brackets: type `@` at the start of a line or after a space and the same candidate list appears, ordered with the last 20 notes you opened first; picking one replaces the whole `@query` with `[[Name]]`. If the query parses as a date or time, two extra rows appear at the top, "Schedule" and "Reminder", which insert a time mark instead of a link.

- `@` only fires at line start or after a space, so email addresses are safe
- A space, a newline, a bracket, or more than 30 characters cancels it — `@Alice hello` stops being a mention as soon as you hit the space
- There is no create row on `@`; an unmatched query simply stays as plain text
- The particular `@` you dismissed with `Esc` will not pop up again

> [!note]
> Moving the caret back into a `[[link]]` you already finished does not reopen the popup — only actual typing does. That is deliberate; otherwise `↑` and `↓` could not move past the line the link sits on.

### Heading anchors, block anchors and hover preview

You can write both `[[Note#Heading]]` and `[[Note#^blockid]]`, and both resolve to that note.

> [!warning]
> Clicking such a link inside a note body only opens the note — it does not scroll to the heading or the block. The thing that does scroll and flash is a citation chip in a Tangu conversation. The link's visible label is also the literal `Note#Heading`, not just the heading.

In a Tangu reply, `[[Note#Heading]]` renders as a citation chip labelled like "Note › Heading"; clicking it opens the note, scrolls to the anchor and flashes it.

- `#Heading` is matched against the heading text
- `#^blockid` comes from files imported from Obsidian; there is no way to mint one inside the app
- When the heading or block is not found, the note opens without scrolling — better to stay put than to jump to the wrong place
- PDF and media subpaths are the exception: clicking `[[doc.pdf#page=3]]` in a note body turns to page 3, and `[[clip.mp4#t=01:35]]` starts playing at 1:35 — those two subpaths do survive the click

Hover a rendered wikilink for 400 ms and a read-only preview card of the target note appears.

- Move the pointer into the card and it stays open, and you can scroll inside it
- When there is no room below, the card flips above the link
- `Esc` closes it
- Unresolved links, and links pointing at files (`[[table.db]]`, `[[photo.png]]`), get no preview
- The preview holds about 2500 characters; a longer note is cut off at the end, and an empty note shows "(Empty note)"
- Wikilinks in chat bubbles use the same preview card

The card is read-only: it is there to confirm you linked the right note. To change anything, click through and open the note.

### Embedding with ![[ ]]

When a paragraph contains nothing but `![[target]]`, it renders as an embedded object instead of text. Images are the exception: `![[image.png]]` shows as a picture wherever it sits on the line, not only alone in a paragraph. Everything else is routed in the order of this table:

| What you write | What you get |
|---|---|
| `![[https://…]]` | A web page embed |
| `![[table.db]]` | A database |
| `![[board.excalidraw]]` | A drawing board |
| `![[Note.md]]` | A read-only transclusion of the whole note |
| `![[clip.mp4#t=01:35]]` | A player starting at that time |
| `![[doc.pdf]]` and other files | A file card |
| A bare URL alone on a line | A bookmark card |

A trailing pipe refines it further: `![[table.db|viewName]]` picks which view of the database to show, and `|number` sets the width in pixels, the same way it works for images.

An embedded block carries a "↪ Embed" badge and an "Edit at the source" button; media and PDFs also get "Collapse" / "Expand" and "Open ↗".

The matching slash-menu items all sit in the "Advanced" group: "Embed block", "Link database" and "Bookmark".

When an embed does not render the way you expected, read what the block says:

- Target not found → the block reads "Embed missing: " followed by the target you wrote
- A malformed media time → the player still appears and plays from 0:00, marked "Invalid anchor · playing from 0:00"; only `#t=95`, `#t=01:35` and `#t=1:02:30` are recognised, and minutes and seconds must be two digits
- A transclusion of another note → the block is marked "Cross-note embed (read-only)"; use "Edit at the source" to change anything
- A plugin-provided embed type → the matching plugin has to be enabled

> [!warning]
> To embed a note, write `![[Note]]` and you get the whole note. `![[Note#blockId]]` only works for notes in the older format — today's default plain-Markdown notes carry no block ids, so that form will not resolve.

> [!note]
> If the transcluded note itself embeds a database or a drawing, those show up as source text rather than as live blocks.

### The backlinks panel

The backlinks panel lists every note that links to the current note with `[[...]]`, each with a snippet of the line the link sits on.

To open it: in the Amadeus Space, expand the right sidebar first — press `⌘/Ctrl + K` for the command palette, run "Toggle right sidebar", then pick the "Backlinks" tab.

> [!warning]
> The right sidebar starts collapsed and has no hotkey. "Outline", "Backlinks" and "Graph" are completely invisible until you expand it — the features are there, the sidebar is not open.

On mobile the shell is a single column with drawers, not two sidebars.

The header reads "Backlinks" followed by the count. With no note open it says "No note open"; with nothing pointing here it says "No other notes link here yet".

- Every candidate link is re-resolved in the context of its own source note, so same-named notes no longer pollute each other
- The flip side: a link counts as a backlink only if it really resolves to this note
- Embeds `![[...]]` are not counted; only `[[...]]` links are
- The panel refreshes on its own when you save, or when a note is changed outside the app

If you edited vault files outside the app and backlinks or search results look wrong, press `⌘/Ctrl + K` and run "Rebuild full-text index" to re-scan the whole vault.

> [!note]
> The rebuild shows no progress bar and no completion message. Running it once is enough — there is no need to click it again.

### Tags

Write an inline tag in a note body, for example `#idea`, and it shows up in the tags panel.

To open it: Amadeus Space → the "Tags" tab in the left sidebar. The header reads "Tags" followed by the total, and the list is sorted by how many notes carry each tag, then alphabetically. Click a tag to expand the list of notes carrying it, click a note to open it, click the tag again to collapse.

How a tag is recognised:

| Rule | Detail |
|---|---|
| Position | Must be at the start of a line, or right after a space |
| Allowed characters | Letters, digits, underscore, hyphen, slash (`#work/weekly` is valid) |
| Pure digits | `#1` and `#1/2` are never tags |
| Case | Matched case-insensitively, displayed with the casing seen first |

> [!warning]
> Only inline tags in the body count. A `tags:` entry in the YAML properties at the top of a note does not appear in this panel — a vault migrated from Obsidian that keeps its tags in properties will show an empty panel.

The panel refreshes on its own when you save and when the vault changes outside the app, so a tag you just wrote needs no manual refresh. To search the text around a tag rather than list the notes carrying it, use the "Search" tab in the left sidebar, or press `⌘/Ctrl + Shift + F` for "Search notes (full text)" and search the tag as an ordinary keyword.

The empty state spells the same rule out: "No #tags yet. Write an inline tag like #idea in a note and it will show up here."

### The graph

The graph draws the one-hop link graph of the current note: the note itself in the centre, its outgoing `[[...]]` links and its backlinks arranged around it.

To open it: expand the right sidebar → the "Graph" tab. The header says "Graph · current note".

| Action | Result |
|---|---|
| Hover a node | Highlights that node and its edges, dims the rest |
| Drag a node | Moves it, and the layout settles again |
| Drag empty space | Pans the canvas |
| Wheel | Zooms around the pointer, 0.4× to 3× |
| Double-click empty space | Resets the view |
| Click a node | Opens that note |
| Click a ghost node | Opens the same "New note" confirmation as clicking an unresolved link |

- Link targets that do not resolve are drawn as dim ghost nodes
- The graph is one hop and star-shaped: every edge runs centre-to-neighbour, neighbours are never linked to each other — the panel always draws this one note, not the whole vault
- Links pointing at files (`[[table.db]]`, `[[photo.png]]`) are excluded entirely, as neither a node nor a ghost
- Outgoing links are read from the note file on disk: a link you just typed shows up in the graph after that edit is saved, not before
- The click that ends a drag does not navigate — dragging and clicking are kept apart
- With no note open it says "No note open"; a note with neither outgoing links nor backlinks says "This note has no links yet — no outgoing [[…]] links and no backlinks."

### Renaming, sub-notes and the autocomplete setting

When you rename or move a note (or a folder), `[[...]]` and `![[...]]` references across the whole vault are rewritten so they keep pointing at the same target — the bare name if it is unique, the full path otherwise, plus a path qualifier when an incoming same-named file would otherwise shadow the link. Right-click a note in the tree and choose "Rename", or drag it into another folder; the rewrite happens on its own, with no separate command.

> [!warning]
> Three kinds of reference are not rewritten: Markdown-style links `[text](note.md)`, file references such as `[[doc.pdf]]` and `[[board.excalidraw]]`, and links that were already broken. On top of that, starred and pinned entries are not remapped — after a rename they quietly disappear and have to be starred again.

A `.fd` sub-note is a note that behaves like a folder: note X can own a folder `X.fd` next to it, holding the notes, databases and drawing boards you create "inside" X. The tree does not show the `X.fd` row itself; its children hang directly off X, and X's row gains a chevron and a child count.

| Where to create one | Detail |
|---|---|
| The "+" on a note row | Tooltip "New sub-note" |
| The note's right-click menu | The same item, "New sub-note" |
| The slash-menu item "Page" | Hinted `.fd`; it creates the sub-note and inserts a `[[link]]` to it |

- Deleting a parent note deletes its `.fd` children too — the confirmation says how many sub-files will go with it and warns that this cannot be undone
- An orphan `.fd` folder with no matching note stays visible as an ordinary folder
- Breadcrumbs hide the `.fd` suffix, so a sub-note's parent shows up as the parent note's name

Whether attachments and databases appear among `[[` and `@` candidates is a setting, on by default: Settings → "Workspace" → "Notes" → "Editing and safety" → "Suggest attachments and databases in [[ ]]". The setting exists on desktop only. You can also press `⌘/Ctrl + K` and run "Toggle attachments & databases in wikilink autocomplete", which reports back with "Wikilink autocomplete now includes attachments and databases" or "…now covers notes only".

> [!note]
> For the first second or two after launch the setting is treated optimistically as on, so you may briefly see file candidates even with it switched off. Wait a moment and it settles.

## 8 · Finding things

Finding things in Forsion is really several different jobs: searching by name, searching by content, searching the page in front of you, and jumping to an exact spot inside a file. Pick the wrong tool and it looks like the app cannot find something that is plainly there. This chapter covers what each entry point does, its hotkey, and the few behaviours that are easy to mistake for a fault.

### Pick the right entry point

Start from the clue you actually have, then pick the tool. Their jobs do not overlap.

| What you remember | Tool | Hotkey |
|---|---|---|
| A name (note, file or session) | Quick find | `⌘/Ctrl + P` |
| The content, but not the title | Full-text search (sidebar "Search") | `⌘/Ctrl + Shift + F` |
| It is on the page in front of you | Find in page | `⌘/Ctrl + F` |
| A note name, which may not exist yet | Quick switch note | Command palette |
| The handful of notes you use daily | Sidebar "Pinned" and "Starred" | None |
| A search you ran before | Sidebar "Collections" | None |
| The page you were just on | Back (this tab) | `⌘/Ctrl + Shift + [` |

The command palette is `⌘/Ctrl + K`. Everything above except find in page needs an open vault.

> [!warning] `⌘/Ctrl + K` does not open the command palette inside note text
> The editor uses that key for "insert link". Click somewhere outside the text first (the sidebar, the title bar), then press it.

> [!note] Some commands only exist in the Amadeus Space
> "Search notes (full text)", "Quick switch note", "Star / unstar current note" and "Rebuild full-text index" are all like this. In another Space the palette will not find them and `⌘/Ctrl + Shift + F` does nothing — switch to Amadeus first.

### Quick find: search by name

Press `⌘/Ctrl + P` anywhere, in any Space; in the command palette it is "Quick find". A search box floats up in the centre of the screen, with the placeholder "Search notes, files and sessions…".

- **What it covers**: note names, file names in the vault (including `.db` databases) and Tangu session titles. Fuzzy match, up to 30 rows. File rows show the extension — when you are hunting for a PDF or an image, the extension is part of the clue.
- **Scope pills**: four segments, "All / Notes / Files / Sessions", switchable by clicking. On the keyboard, think of the pills as sitting just after your text: press `→` only once the caret is at the very end of what you typed and you step into the first pill, "Notes"; from there `←` and `→` move between pills; pressing `←` on the first one puts you back in the text. "All" is not a pill you step onto — it just means the caret is still in the text.
- **With nothing typed**: it lists what you opened recently, under the heading "Recent", up to 12 rows; with no recent items at all it falls back to your most recently updated sessions.
- **Keys**: `↑` `↓` select, `←` `→` scope, `↵` open, `esc` close — the footer spells out all four. With no hits it reads "No matches"; before you have opened anything it reads "No recent items yet".

> [!warning] Quick find matches names only, never note contents
> A word written inside a note will not turn up here. To search content, use full-text search in the next section.

The "Sessions" category needs Tangu; "Notes" and "Files" need an open vault. Quick find keeps its own "Recent" list, which is unrelated to the recents that order the `@` popup inside a note.

### Full-text search: search note contents

The "Search" tab in the left sidebar of the Amadeus Space; also `⌘/Ctrl + Shift + F`, or "Search notes (full text)" in the command palette. The panel is headed "Full-text search" and the box reads "Search all notes…".

The syntax is short, and there is nothing beyond it:

| What you type | What it does |
|---|---|
| `forsion` | Matches any note whose body or title contains it, case-insensitively |
| `moc forsion` | Both words must appear, in any order |
| `moc-forsion` | Spaces, `-`, `_`, `/` and `.` all count as separators, so all three forms find each other |

There are no regular expressions, no wildcards and no field filters such as "title:". At most 50 results come back, title hits ranked above body hits, each showing the note title and a snippet with the term highlighted. Opening the panel flushes the note you are editing to disk first, so text you just typed is immediately searchable.

When something will not turn up, work through this in order:

- [ ] Check a vault is open — without one the panel says "Open a vault first."
- [ ] Try a shorter word; if it still says "No results", the index really does not have it
- [ ] If you edited files outside the app, run command palette → "Rebuild full-text index"

> [!warning] Clicking a result usually just opens the note; it does not scroll to the match
> Once it is open, press `⌘/Ctrl + F` and use find in page to land on the word.

> [!note] "Rebuild full-text index" has no progress bar and no completion message — nothing at all happens on screen after you run it, and that is not it hanging.

The left sidebar also has a "Tags" tab, listing every inline `#tag` in the vault by count; click one to expand the notes carrying it. It only sees tags written in the note body — a `tags:` entry in the properties block at the top of a note will not appear here.

### Quick switch note

Command palette `⌘/Ctrl + K` → "Quick switch note". That is its only working entry point.

> [!warning] The `⌘/Ctrl + P` shown next to it opens Quick find instead
> Both the command palette and Settings → Shortcuts display `⌘/Ctrl + P` against this command, but that combo belongs to Quick find and that is what pressing it opens. To reach the quick switcher from the keyboard, go to Settings → Appearance → Shortcuts and record a different combo for it (recording a new combo automatically unbinds whichever command held it).

Using the overlay:

- The box reads "Jump to note…" and fuzzy-matches note names across the vault, up to 30 rows; each row shows the note title on the left and its path in the vault on the right.
- `↑` `↓` select, `↵` open, `esc` close; the footer on the right reads "{n} results".
- With nothing matching it shows "No matching notes".
- If the name you typed does not exist, an extra row appears at the bottom reading "Create “name”" with the subtitle "New note"; press Enter to create and open it.

> [!warning] "Create" puts the note at the root of the vault
> It does not ask where. This differs from clicking an unresolved `[[link]]`, which asks first and creates the note inside the source note's sub-note folder.

How it divides with Quick find: the quick switcher covers notes only, but can create one on the spot; Quick find also covers files and sessions, but cannot create anything. Both need an open vault.

### Find in page

Press `⌘/Ctrl + F`, or command palette → "Find in page". A narrow bar appears at the top right, reading "Find in page…".

- `↵` next, `Shift + ↵` previous, `esc` close; the bar also carries `‹`, `›` and `✕` buttons, with a counter between them written as current over total, like `3/12`, or `0` when nothing matches.
- It searches the text actually painted in the current view, not just note text — embedded cards, databases, canvas elements and words on a drawing board are all in range. So it works in every Space and every panel.
- Matching is case-insensitive, and a match can run across inline formatting: the word inside `ap**ple**` still counts as one hit.
- When the page content changes it rescans on its own and the count updates; you do not have to reopen the bar.

> [!warning] It only finds text that is already rendered
> Collapsed sections, and the part of a long list you have not scrolled to, are invisible to find in page — expand or scroll to that part first, then search.

Inside the built-in browser and code editors, `⌘/Ctrl + F` steps aside for their own find — that is deliberate, and find behaves differently in those two places.

### Starred, pinned and collections

Three collapsible sections sit above the note tree. All three are kept per vault.

- **Starred**: right-click a note in the sidebar → "Star" (an already-starred note shows "Unstar"); the same two items are in the ⋮ menu on the note's title bar. The section is headed "Starred", is hidden entirely when nothing is starred, and starts collapsed.
- **Pinned**: drag a note from the tree into the "Pinned" section, or use the pin button at the top right of the editor. While the section is empty its hint reads "Drag a note here to pin it, or use the pin button at the top right of the editor".
- **Collections**: saved searches. Type a query in the full-text search box and a "Save as collection" button appears beside it; give it a name and a row joins the "Collections" section in the sidebar, replaying that search when clicked. Hovering shows "Search: {q}", and the ✕ on the row is "Remove collection".

> [!warning] "Star / unstar current note" in the command palette does not always take effect
> The sidebar right-click and the title-bar ⋮ menu are the reliable routes.

> [!warning] All three live on this machine only
> Stars, pins and collections are stored locally per vault, are not written into the note files, and do not travel with sync — on another machine you set them up again. Renaming or moving a note also drops its star and its pin; just add it again.

One more quirk: saving a collection under a name that already exists overwrites the old one silently.

### Jump to an exact spot: headings, blocks and citation chips

> [!warning] Clicking `[[Note#Heading]]` inside note text only opens the note; it does not jump to the heading
> Links in note text keep just two kinds of location: a PDF's `#page=` and a media file's `#t=` timestamp. To move between headings inside one note, use "Outline" in the right sidebar — it lists every heading in document order and scrolls to the one you click. The right sidebar starts collapsed; expand it with "Toggle right sidebar" in the command palette (that one has no hotkey).

The things that really do land on an exact spot are the **citation chips** in a Tangu conversation: the agent produces them when it cites your files, and one click takes you there.

| Chip | What clicking it does | Worth knowing |
|---|---|---|
| `report.pdf p.18` | Opens the annotatable PDF reader at page 18 | The reader's "Copy link to this page" button copies a link to the current page; paste it into a note and clicking it later returns to that page |
| A PDF citation carrying a quote | Turns to that page, finds the sentence, scrolls it to the middle of the screen and pulses an amber highlight once | The highlight is temporary and is never written into the PDF; if the sentence is not found the page still opens |
| `a.ts:42`, `a.ts:42-48` | Opens the file and highlights that line or range | Office documents (`.doc` `.docx` `.xls` `.xlsx` `.ppt` `.pptx`) open this way with no line number |
| `lecture.mp4 @01:35` | Plays from that second; a range reads `@01:35–02:00` | On mobile the chip carries no timestamp and playback starts from the beginning |
| `note › some heading` | Opens the note and scrolls to that heading | If no heading matches it just opens the note — it never jumps to the wrong one |
| `note › ^abc123` | Opens the note and flashes that block | `^` block anchors only exist in notes imported from Obsidian; the app never mints one |
| A plain link whose text is a quoted sentence | Opens the page in the built-in browser beside the conversation and scrolls to that sentence, highlighted | Desktop only, with Agent Desk and the built-in browser plugin both on; a quote under 8 or over 300 characters just opens the page at the top |

When two files in the vault share a name, the chip shows as a dimmed, unclickable row rather than guessing which to open. Where a chip opens things: beside the conversation when Agent Desk is on, otherwise in a main-area tab.

### Getting back to where you were

- **Per-tab back and forward**: `⌘/Ctrl + Shift + [` is "Back (this tab)" and `⌘/Ctrl + Shift + ]` is "Forward (this tab)"; there is also a pair of arrows at the top left of the main area. Each tab keeps its own history. When focus is inside a side panel the arrows look inert — they always move the history of the active main-area tab.
- **Recently opened**: press `⌘/Ctrl + P` to open Quick find and type nothing; what it lists is what you opened recently, up to 12 rows.
- **The `@` recents**: type `@` in a note and, before you type anything else, the notes at the top are the 20 you opened most recently.
- **There is no "Recent" section in the sidebar**: it was removed on purpose; the two entry points above are how you get at recents.
- **The "Search notes" box at the top of the note tree**: as soon as you type, the whole tree is replaced by a flat list of matches. It matches file names by plain substring — not fuzzy, not note contents, and not folder names. With nothing matching it reads "No matching notes". While the box has text, dragging notes to move them is switched off; clear it to get dragging back.
- **Breadcrumb reveal**: hover the editor title bar and the parent folders fade in to the left of the title; click any segment (or the title itself) and the note tree expands down to that item, scrolls it into view and flashes it. Deep paths are abbreviated in the middle, and the current title is never truncated.

## 9 · Tables and databases

Amadeus has two kinds of table. One is the markdown table in the note body — light, and it travels with the text. The other is the database: a file of its own, with column types, several views, filters and sorting, and links between tables. This chapter draws the line between them, then walks through everything a database can do.

### Two kinds of table: markdown and database

In a note, type `/` and the "Advanced" group offers two table entries: "Table" inserts a markdown table, "Database" creates a database. They are very different — look before you pick.

| | Markdown table | Database |
| --- | --- | --- |
| Where it lives | A few lines of text in the note body | Its own `.db` file, referenced from a note as `![[name.db]]` |
| Cells | Plain text | Typed: number, checkbox, date, attachment, relation… |
| Views | One look, always | Table / board / calendar / gallery / chart / form / gantt |
| Filters and sorting | None | Saved separately on each view |
| Reuse | This one note only | One table can be embedded in many notes; edit it anywhere and it updates everywhere |
| Opened in another editor | Every markdown editor understands it | Other editors see only JSON |
| Deleting it | Delete those lines and it is gone | Deleting the `![[…]]` only removes this one reference; the `.db` file stays in the vault |

Working with a markdown table:

- Insert: `/` → "Table", which gives you 2 columns × 1 row.
- Move between cells: `Tab` for the next cell, `Shift + Tab` for the previous one. `Tab` in a corner cell will not throw focus out of the editor.
- Add or remove rows and columns: visual editing has no row or column buttons, so switch to source and edit the `|` lines directly. Two ways in: the `</>` button at the right of the note top bar ("Switch to Markdown source"), or the command palette `⌘/Ctrl + K` → "Toggle source / visual editing".

> [!warning] The inserted table's header cells are hardcoded as 「列 1」「列 2」 — shown in Chinese in every language, and written to disk that way. Rename them by hand after inserting.

A database embedded in a note can be written as `![[name.db|view name]]` to pin that spot to one view; more on that later.

Which to pick: for a one-off comparison or three or four explanatory lines, use a markdown table — it is part of the prose and anything can read it. For filtering down to a subset, looking at one set of data several ways, linking to another table, or totalling anything, use a database. The rest of this chapter is about databases.

### Creating and opening a database

Four entry points, and they give you different things:

| Entry point | What you do | What you get |
| --- | --- | --- |
| File tree | Right-click a folder, or right-click empty space in the tree → "New base" | A standalone `.db` in the vault, opened as its own tab |
| Inside a note | `/` → "Advanced" → "Database" | A table in this note's sub-folder, plus `![[name.db]]` inserted at the cursor |
| Note view | `/` → "Advanced" → "Note view" | A folder plus a table whose every row is a note inside that folder |
| Reuse a table | `/` → "Advanced" → "Link database" | An existing table embedded here, sharing one set of data with everywhere else |

You are asked for a name first; the default is "Untitled database". A name collision is not auto-suffixed — it is refused, so pick another name.

The "Link database" picker lists every `.db` in the vault: type to fuzzy-filter, `↑` `↓` to move, `Enter` to insert, `Esc` to cancel. When two tables share a name it inserts the full path. You can also type it by hand: `![[name.db]]`; to pin this spot to one view, write `![[name.db|view name]]`.

Opening and renaming:

- Open as a tab: click the `.db` in the file tree, or right-click it → "Open"; the ↗ button in the table toolbar ("Open as a page in a new tab") does it too. The `.db` right-click menu has exactly three items — "Open", "Rename", "Open with the system app" — there is no delete.
- Rename: edit the title box in the table header and press Enter, or right-click in the file tree → "Rename". The file name, the name stored in the table, and every `[[ ]]` and `![[ ]]` reference in the vault all change together. Markdown-style links such as `[label](name.db)` are not rewritten.

Where a note view differs from a normal table:

- Rows come from the folder, the first column is always `Page Name`, and the rest are the union of those notes' frontmatter keys.
- Editing the first column renames the note file; deleting a row deletes the note file, after asking "Deleting this row also deletes its note file. Continue?".
- The button next to the title switches the source folder, and "Whole vault (top-level notes)" is one of the choices. Switching folders adds new columns but never removes old ones.
- Rows in a note view can never be drag-reordered.

> [!warning] A table created from the file tree gets two columns hardcoded as 「标题」「文本」 and a default view tab hardcoded as 「表格」; a column added in a note view creates a frontmatter key named 「属性」「属性2」. These names are Chinese in every language — just rename them.

### The table view: rows and cells

The table view is the default look: a ⠿ drag handle and a ✕ at the left of every row, a ＋ at the right end of the header to add a column, an add-row button under the grid, and a summary row at the very bottom (its cells read "Summary" until you pick a statistic). Above the table sits the toolbar: the "New" button, the "Search…" box, the "Filter" button, and on the right the CSV download icon and the ↗ "Open as a page in a new tab" button.

- Editing a cell: click it and type; `Enter` or `Esc` commits and leaves. Chinese IME candidate selection is not swallowed.
- Adding a row: the toolbar "New" button, "＋ New row" under the grid, or the per-group, per-lane and per-day plus buttons, which pre-fill that group's value.
- Deleting a row: the ✕ at the left of the row ("Delete row"), or the red "Delete row" at the bottom of the row editor. A normal table deletes with no confirmation; only note views ask.
- Reordering rows: drag the ⠿ handle ("Drag to reorder rows"). The order of rows in the file is the real order.
- The row editor: one vertical panel listing every column of that row, with a delete button at the bottom. Clicking a card in board or gallery, an event in calendar, or a row label or bar in gantt all open it.
- Wikilinks in a text cell: `[[wikilinks]]` render as live links you can click through; to edit the link itself, click the ✎ in the cell to go back to edit mode.

If sorting, filtering, search, grouping or hierarchy is on, dragging is locked and the handle's tooltip reads "Manual ordering is off while sorting, filtering, search, grouping or hierarchy is on — clear them first"; in a note view it is locked permanently.

Deleting a row has two knock-on effects: self-referencing relation columns in the same table drop their links to it, while relations pointing in from other tables are deliberately not cascaded and those cells show "Missing".

> [!note] The table view has no "open this row" affordance and no row context menu — the row editor is reachable only from the card-style views. There is also no `Tab`-to-next-cell in the grid; cell keyboard handling is `Enter` and `Esc` only.

### Columns and property types

Every column operation lives on the header:

- Add: the ＋ at the right end of the header ("Add column"). New columns are named "Column 1", "Column 2"… in the current interface language.
- Rename or retype: click the header to open the column menu; the first input is the name, and the "Type" section below it changes the type. Retyping does not touch your data, it only reinterprets it, so switching back brings the values back.
- Move: drag the header, or use "← Move left" and "Move right →" in the column menu.
- Resize: drag the divider on the right edge of the header, between 100 and 800 px; double-click restores flexible width ("Drag to resize · double-click for flexible width").
- Delete: the red "Delete column" at the bottom of the column menu.

The first column is the title column: it cannot be deleted, retyped, hidden or moved, and no column can be placed in front of it.

| Type | What it does |
| --- | --- |
| Text | Plain text with inline `[[wikilinks]]`; typing `[[` opens a note picker |
| Number | A numeric value, with optional display formatting |
| Checkbox | A tick box |
| Select | One option per cell, popover headed "Pick one" |
| Multi-select | Several options per cell, popover headed "Multi-select (click to toggle)" |
| Link | http(s) only; a bare domain gets `https://` prepended |
| Attachment | One cell can hold several files |
| Formula | A read-only computed column |
| Relation | Links to rows of another (or this same) database |
| Lookup | Pulls values along a relation, or rolls up in reverse |
| Date | A calendar date; this is the one calendar and gantt views recognise |
| Relation | Links to a note, stored as `[[link]]` text |
| Auto-number | The highest existing number + 1, stamped when the row is created |
| Created time | Stamped once when the row is created |
| 「修改时间」 | Re-stamped whenever the row's content actually changes |
| 「人员」 | A person's name |

Select and multi-select share one option pool per column; the input at the bottom of the popover, "Press Enter to add an option…", creates a new option on the spot, and a single select also offers "Clear". An option's colour is derived from its name, so the same name is always the same colour.

Attachments: an empty cell shows a paperclip button labelled "Attachment" ("Upload attachments (multiple allowed)"), a filled cell shows a ＋ ("Add another attachment"). Images render as thumbnails, everything else as a filename button that opens in the system app. Each attachment's ✕ is "Remove this attachment (the file stays)" — it drops the reference only, the file stays on disk.

Person: candidates come from the names already used in any person column anywhere in the vault, the eight most frequent first. `↑` `↓` to move, `Enter` to pick, `Esc` to close. The value is just a name string — no account, no avatar, and nobody gets notified. In a large vault, opening this dropdown for the first time reads every `.db`, so it may pause briefly.

Number display: on number, formula and lookup columns the menu has a "Number display (formatting only — the stored value never changes)" section with "Decimals", "Prefix" and "Suffix", plus a live "Example". Formatting adds thousands separators; clicking into the cell shows the raw value again, which is deliberate — editing the formatted string would destroy the number.

> [!warning] In the type list, 「修改时间」 (updated time) and 「人员」 (person) stay Chinese in the English interface. The English list also shows "Relation" twice: the upper one (「关联表」) links to rows of another table, the lower one (「关联」) links to a note. And an updated-time column cannot drive a calendar, a gantt view or date grouping, and filters on it use the text operators.

### Relations, lookups and formulas

A relation column links two tables:

- In the column menu, pick "Target table (cells link to its rows)" — another `.db`, or "This table (self-reference · can be the parent column of a hierarchy)". When the vault holds no other table the menu reads "No other databases in this vault".
- "Allow multiple (link several rows in one cell)" decides whether a cell can hold more than one link; "Chip label column…" decides which column of the target row the chip shows (the first column by default; formula and lookup columns cannot be labels); "Limit candidates (the picker only lists target rows that match)" filters the picker.
- Click the chip area in a cell to open the picker: the search box is "Search rows…", `Enter` takes the first match, `Esc` closes, and "Clear links" sits at the bottom. It lists at most 12 rows at a time. The ↗ button is "Open target table".
- When a target row is deleted the cell shows "Missing" — cross-file deletion deliberately does not cascade. Changing the target table clears the chip label column and the candidate filter, and detaches the lookups that depended on it.

A lookup pulls values along a relation:

- "Forward" follows a relation column on this table and reads one column of the linked row.
- "Reverse" scans the target table for rows pointing back at this row, then aggregates them.
- There are exactly five aggregates: "First" (the default), "Count", "Sum", "Average", "Join".
- Lookups do not chain — a lookup that targets another lookup column comes out empty. A reverse lookup scans the whole target table per row, so it slows down on big tables.
- Switch "Purpose" to projection and the column becomes an editable two-way link: it shows the target rows pointing back at this one, the real value still lives only on the target side, and editing here edits that file. This needs the target table to already have a relation column pointing back; otherwise the menu reads "The target table has no Relation column yet (or it is still loading)", and an unfinished setup shows "Needs setup" in the cell.

A formula is a read-only computed column — evaluated, never stored, never written to disk:

- Write the expression in the column menu's "Formula (reference a column as {column name})" section; `Enter` commits, `Shift + Enter` adds a line.
- Available functions, case-insensitive: `if and or not empty round floor ceil abs min max len lower upper trim contains replace concat number value text today days format`.
- Operators: `+ - * / %`, `== != > < >= <=`, `&& || !`, and parentheses. `today()` rolls over at local midnight.

```
if({is done}, "✓", {unit price} * {item count})
```

> [!warning] `{name}` matches the column name first — rename a referenced column and the formula silently breaks. An error renders as `#错误` and a reference cycle as `#循环`, and both markers stay Chinese in every language. Also, deleting a relation column does not delete the lookups that followed it: they go into a "needs reconfiguring" state, and switching that column's type back to Relation restores them.

### View settings: filters, sorting, grouping, hierarchy, summaries

The view tab bar sits above the table. Click a tab that is not active to switch to it; click the already-active tab (or right-click any tab) to open the view menu, whose tooltip reads "Click again to configure this view (rename, group, delete)"; the ＋ at the end is "Add view". The last view cannot be deleted.

Which view you are on is not stored in the `.db` — it is written on the reference side (`![[table.db|view name]]`), so the same table can sit on a different view in each note, each tab and each dashboard card.

| Setting | Where | What to know |
| --- | --- | --- |
| Filter | Toolbar "Filter", or view menu "Filter…" | A condition is column + operator + value; with two or more you can switch "Match all" / "Match any" |
| Sorting | The column menu for one column, the view menu for several | View only, the row order in the file never changes; with several columns the header shows a rank number |
| Search | The toolbar "Search…" box | Matches the first column's displayed value only, and is never saved |
| Grouping | View menu "Grouping (table view, by a select or date column)" | A select column, or a date column ("By day" / "By month"); click a group header to collapse it |
| Hierarchy | View menu "Hierarchy (table view, by a relation column pointing at this table)" | Builds a parent/child tree from a self-referencing relation column |
| Column visibility | View menu "Column visibility (this view)" | Click a name to toggle it, ✓ means visible; the first column is always visible |
| Column order / width | View menu "Column order / width" | With "Per-view column order and width" on, this view keeps its own set; turning it off discards that set |
| Footer summary | Click a cell in the bottom row | One statistic per column, computed over the filtered rows only |

- Filter operators depend on the column type: text and link get 「包含·不包含·是·不是·为空·不为空」; number gets 「是·不是·大于·小于·大于等于·小于等于·介于·为空·不为空」; checkbox gets 「已勾选·未勾选」; date gets 「是当天·早于·晚于·大于等于·小于等于·介于·为空·不为空」; select gets 「是·不是·为空·不为空」; multi-select gets 「含·不含·为空·不为空」.
- Footer statistics depend on the type too: a number column offers 「已填·空·求和·平均·最小·最大」; a checkbox column offers 「已勾选·未勾选·已填·空」; everything else offers 「已填·空」 only. Values are rounded to two decimals and an empty set shows `–`.
- Grouping lays out every option of the select column as a lane, including ones with no rows, and adds a "No group" lane at the end for blanks and for values whose option was deleted; date grouping only lists dates that actually occur, with "Not set" last. Month grouping does not pre-fill the date on new rows.
- Hierarchy needs a Relation column whose target is this same table; without one the menu says "No relation column points at this table yet (add a Relation column and set its target to this table)". Hierarchy and grouping are mutually exclusive: with hierarchy on, the grouping section greys out and reads "Grouping (inactive while hierarchy is on — turn hierarchy off first)".
- Collapse state, for both grouping and hierarchy, lives in memory only — switch views or reopen the app and everything is expanded again.

> [!warning] The filter operator names and the footer statistic names stay Chinese in the English interface. String comparison when sorting always uses Chinese collation, whatever the interface language is.

### The other six views

The ＋ offers exactly seven view types, always in this order: table, board, calendar, gallery, chart, form, gantt. For a tree, use the table view's "Hierarchy" setting. A new view is named after its type and becomes active immediately.

| View | What it needs | What you see without it |
| --- | --- | --- |
| Board | A select column | "Board view groups by a select column, and this table has none yet." plus a one-click "＋ Add a Status select column" |
| Calendar | A date column (date, calendar date or created time) | "Calendar view needs a date column (date or calendar date)." plus a one-click "＋ Add a Date column" |
| Gallery | Nothing | — |
| Chart | A column to group by; sum and average also need a number column | Sum and average are disabled, with the tooltip "Needs a number column" |
| Form | At least one fillable column | The body reads "No fillable fields — formula, auto-number and created-time columns never appear in a form." |
| Gantt | A calendar-date column (legacy date and created-time columns do not count) | "The Gantt view needs a date column (calendar date)." plus a one-click “+ Add a "Date" column” |

- Board: lanes come from "Group by (a select column)" in the view menu, and dragging a card to another lane changes that cell's value. "New card" at the foot of a lane pre-fills that lane's value. Dragging within a lane does not reorder anything.
- Calendar: a fixed 42-cell month grid starting on Sunday, with multi-day rows painted across every day they span. `‹` `›` change month, "Today" returns to this month, and the ＋ in a day cell is "New row on this day". Events cannot be dragged to another day — open the event and change the date in the row editor. This calendar is separate from the Calendar Space.
- Gallery: each card shows the title, up to four property previews, and a cover taken from the first image in the first visible attachment column. Relation and attachment values are left out of the previews, and checkbox properties only appear when true.
- Chart: "Chart type" offers bar, line and donut, paired with "Group by" and "Aggregate" (count rows, sum, average), plus a "Value column" when the aggregate is not count. A dashboard can host one too: add-card menu → "Chart (database)…".
- Form: you can set "Form title / submit button" and "After submitting" ("Stay on the form" or "Go to the table"); click a field name to toggle required, and defaults and hints save as you type. Formula, lookup, auto-number, created-time and updated-time columns never appear, and relation and attachment fields cannot have a default ("Default value: not supported"). The toolbar "New" button is hidden in a form view, so rows can only come from a submission; after each submit the form resets to its defaults and reports "{n} submitted".
- Gantt: row titles on the left, bars on the right, a "Day" and a "Week" scale, weekend shading and a today line, with the "Today" button scrolling to it. Rows without dates are greyed at the bottom. It is read-only — bars cannot be dragged or resized to reschedule, so change dates in the row editor.

> [!warning] The columns those one-click buttons create are Chinese in every language: board adds a 「状态」 column with the options 「待办」「进行中」「完成」, and calendar and gantt both add a 「日期」 column. The two chart messages shown when there is nothing to group by or no matching data are Chinese too.

### Export, sharing and how a database is stored

Export to CSV with the download icon in the toolbar; its tooltip spells out "Export CSV ({cols} columns × {rows} rows in this view)". What you get is exactly the view in front of you — visible columns × rows after filtering and sorting. Desktop opens a native save dialog and then reveals the file in the file manager; the web opens a browser download; mobile does not show the button at all.

| This content | Exports as |
| --- | --- |
| Formula and lookup columns | The value they computed |
| Relation columns | The chip labels (falling back to row ids if the target table has not loaded) |
| Checkbox columns | `TRUE` / `FALSE` |
| Multi-value cells | Joined with `, ` into one field |
| Numbers with display formatting | The formatted string, so a spreadsheet reads it as text |

One table shared in many places: however many notes, tabs or dashboard cards show the same `.db`, they share one set of data, and an edit in one shows up everywhere at once. Desktop also watches the file on disk, so a change made by another program (an agent, an automation, an external editor) is hot-reloaded with your unsaved edits replayed on top.

Wiring it into the calendar: view menu → "＋ Add to Calendar Space" registers the table as a member of the Calendar Space; you must map one date column and may map one checkbox column for completion. Once registered, the same entry reads "Calendar settings". That dialog is Chinese in every language (「日期属性 *」「完成勾选」「不设(纯日历)」「取消」「确定」). The mapping is stored in the vault's calendar config rather than in the `.db`, and follows the file when you rename it.

- On disk: a `.db` is a standalone JSON file in the vault holding the table name, columns, rows and views, indented with two spaces and ending in a newline so it diffs cleanly in git. Column widths, filters, sorting, grouping and the form and gantt settings all live in that file; only "which view am I on" does not.
- Syncing: it is an ordinary file, so any sync method (cloud drive, git) carries it. Writes are debounced by 500 ms and compared against the version on disk before saving.
- Editing it elsewhere: another markdown editor opening a `.db` sees only JSON, never a rendered table. An older build opening a file written by a newer one drops the settings it does not recognise when it saves.
- When the file goes wrong: corrupted content drops into read-only protection with the message "This database file is corrupted — it is now read-only." plus "Show in file manager" and "Retry", and is never written back. A missing target shows "Database file is missing: ". A file whose version is newer than the app is refused with the Chinese-only message 「版本过新(v{n}),请升级应用」.
- Publishing: when a note containing `![[table.db]]` is published, the public page renders the table's first view as a static table, honouring filters, sorting, hidden columns and that view's column order, and computing formulas. Publishing needs a Forsion cloud account. The public page cannot read other `.db` files, so lookup columns come out blank; a note view publishes its columns but no rows.

> [!warning] Only desktop watches the file and compares before writing. Web and mobile do neither, so if the same `.db` is edited in two places at once the later write simply overwrites the earlier one.

## 10 · Dashboards

A dashboard puts things from your vault on one screen: numbers, charts, a clock, weather, to-dos, a calendar, a web page — all live cards. It is itself a note, saved as `.dashboard.md`, so it stays searchable, `[[linkable]]` and syncable. Desktop only, and it needs an open vault.

### Creating and opening one

Three entry points, same result: the new file opens already unlocked, so you can start placing cards at once.

| Entry point | Action | Where it lands |
|---|---|---|
| Command palette | `⌘/Ctrl + K` → "New dashboard" | Vault root |
| Notes sidebar | Right-click a folder → "New dashboard" | Inside that folder |
| Notes sidebar | Right-click empty tree space → "New dashboard" | Vault root |
| New tab | The "New dashboard" card | Vault root |

- The name box is prefilled with "Untitled dashboard"; from a folder the prompt is titled "New dashboard in “{folder}”".
- Slashes are stripped from the name, and the `.dashboard` suffix is added for you — do not type it.
- A name that already exists is refused with a message; you never end up with a silent duplicate.
- To open one: single-click its `.dashboard.md` row in the file tree, or follow a `[[Name.dashboard]]` link; an already-open dashboard reuses its tab.
- Gates: the palette command only appears inside the Amadeus Space, and all three entry points need an open vault.

> [!note]
> There is no hotkey for creating a dashboard, and the structured grid claims no keys at all — canvas mode is the only part of the feature with keyboard control.

> [!warning]
> The `.dashboard` suffix is the file's identity. Renaming from the toolbar re-applies it automatically; if you rename the file in your operating system's file manager and lose the suffix, it turns back into an ordinary note and no longer opens as a dashboard.

### Locked and unlocked

A dashboard is only ever in one of two states, and this is the most important toggle in the whole feature: locked is the finished page, unlocked is the layout bench. The split exists because one click cannot mean both "use this card" and "move this card" — locked, the whole card belongs to its content and a click goes into the view; unlocked, the whole card belongs to layout and a click picks it up. Press "Done" when you finish arranging, or the cards will feel unresponsive.

| | Locked (finished page) | Unlocked (layout bench) |
|---|---|---|
| Toolbar button | "Edit layout" | "Done" |
| Card content | Directly clickable and usable | Covered by a drag shield in the grid; double-click to get in |
| Drag / resize | Off | On |
| ＋ "Add card" | Hidden | Shown |
| Card delete button and ⋯ menu | Hidden | Shown |
| ↗ "Open in a tab" on view cards | Shown | Hidden |

- In the grid, the tooltip on "Edit layout" reads "Edit layout (drag to reorder, resize, add or remove cards)".
- On the canvas it is the same button (labelled "Edit layout" / "Done" too), with tooltips "Unlock for editing (drag, resize, change content)" and "Lock (browse mode)".
- Locking drops you out of any card you had entered, and on the canvas it also clears the selection and any open menu.

> [!note]
> The lock state belongs to the tab, not to the file — close a dashboard and reopen it and it is locked again. The one exception is a freshly created dashboard, which is born unlocked.

### Two layouts: structured grid and free-form canvas

Every dashboard is either a structured grid or a free-form canvas. A new, empty one is always a grid.

| | Structured grid | Free-form canvas |
|---|---|---|
| Placement | Cards flow in order into a 12-column reference grid: you choose what and how big, the app chooses where | Cards sit at pixel positions on a fixed 1152×648 board |
| Window behaviour | Reflows proportionally and holds at any width | Fills the panel by percentage once locked; a very different panel shape stretches it |
| "Section heading" and "Stat card…" | Yes | No |
| Page filter bar | Yes | No |
| Card ⋯ size menu | Yes | No |
| Keyboard control | No | Yes |

- To switch: toolbar ⋯ "More actions" → "Switch to free-form canvas (advanced)" in the grid, "Switch to structured grid" on the canvas.
- Each layout keeps its own coordinates and neither overwrites the other, so switching back restores the old arrangement exactly.
- A free-positioned dashboard opens with a banner; "Switch to auto layout" folds the pixel rectangles into 12-column spans in reading order and keeps the original layout key in the file as a rollback net, while "Keep free positioning" is a permanent declaration and the banner never returns.
- A legacy (grid) dashboard shows a different banner, with the button "Convert to canvas".

> [!warning]
> Switching from the ⋯ menu records the mode only — it does not move anything. Turn a grid into a canvas and the cards land on whatever canvas coordinates the file already held; a file that never had any gets a default stack. The banner's "Switch to auto layout" is the only real geometric conversion.

> [!note]
> When a layout cannot be read the app stops rather than overwriting your arrangement: broken frontmatter raises "Could not parse this note's frontmatter ({error}). The layout is frozen and will not be rewritten — please fix the YAML first."; a layout pointing at blocks that no longer match raises "The block ids in the saved layout do not match the current blocks (the note may have been renumbered), so automatic reflow is off to avoid losing the layout." with a "Reflow in current order" button.

### The card catalogue

Unlock first, then use the ＋ "Add card" button in the toolbar. The top half of the menu is seven built-in cards, the bottom half is a "Views" section.

| Card | What it asks | Notes |
|---|---|---|
| "Section heading" | A title, prefilled "New section" | A full-width typographic divider: no border, always one row tall. Grid only |
| "Stat card…" | Pick a database, then which column and which aggregation | See the next section. Grid only |
| "Chart (database)…" | Pick a database | See the next section |
| "Text block" | Nothing | An ordinary Amadeus block, slash menu and all |
| "Clock" | Nothing | A clock ticking by the second, with date and time zone taken from your machine |
| "Weather" | A city, prefilled "上海" | Current temperature, condition icon and wind, refreshed every 15 minutes; needs internet |
| "Web page" | An address, prefilled `https://` | Embeds a live web page in the card; desktop only |

The "Views" section embeds app views as cards; the dashboard draws each title as "view name · file name":

| View | Needs a file first | Gate |
|---|---|---|
| "Editor" | Yes | — |
| "Database" | Yes | — |
| "Whiteboard" | Yes | — |
| "PDF" | Yes | — |
| "Image" | Yes | — |
| "Outline" | Yes | — |
| "Search" | No | — |
| "Tags" | No | — |
| "What's New" | No | — |
| "Messages" | No | Needs a local backend |
| "To-Do List" | No | Needs the Calendar builtin plugin on |
| "Calendar" | No | Needs the Calendar builtin plugin on |
| "Automations" | No | Needs an Automation Space |
| "Activity Log" | No | Developer view |
| "Active Window" | No | Developer view |

- Views that need a file open a picker first, titled: Pick a file for the "{name}" card…
- If a view is currently unavailable (its plugin is switched off, say), the card reads View "{type}" is unavailable instead of going blank.
- The canvas add menu is a strict subset: "Text block", "Chart (database)…", "Clock", "Weather", "Web page", plus the same "Views" section.
- Text blocks behave differently in the two layouts: in the grid they are editable both locked and unlocked, but while unlocked a drag shield covers them, so double-click to get in; on the canvas a text block is read-only until you enter its card.

> [!note]
> Two Chinese strings are stored values rather than interface text and stay Chinese in the English interface: the weather card's prefilled city "上海", and the clock's date and time formatting. Just replace the city as you add the card.

> [!warning]
> The web page card only accepts public http(s) addresses. file:, data:, localhost and every private range are rejected with "Only public http(s) addresses are allowed — file/data, localhost and private networks are rejected"; the check runs again at render time, so a dashboard synced in from elsewhere is blocked too.

### Laying out on the grid

Once unlocked, the grid gives you this:

| What you want | How |
|---|---|
| Reorder | Press a card and drag it over another; the page reflows live and settles where you see it |
| Place a card in a row by hand | Drag it into empty space inside a row and let go; neighbours shift aside and anything pushed past the end drops to the next row |
| Resize | Drag the small grip at the card's bottom-right corner, "Resize"; it snaps by whole cells |
| Pick a preset size | The card's ⋯ "Size and more" → "Size" |
| Delete a card | The trash button "Delete this card", or ⋯ → "Delete card" |
| Hand it back to automatic layout | ⋯ → "Restore automatic layout" (only on hand-arranged rows) |

The presets are "Small" 3×2, "Medium" 4×3, "Wide" 6×3, "Tall" 3×5, "Large" 6×5, "Full row" 12×4 and "Workspace" 12×8. Those numbers are columns × rows of the 12-column reference grid, not pixels, and each card type only lists the presets it supports — clock and weather offer just "Small" and "Wide", while "Workspace" only shows up on editor, database, whiteboard and PDF cards. Rows you have arranged by hand stay as you left them; rows you have never touched keep arranging themselves.

- A mouse drag starts after 4 pixels; a touch drag needs about a 150 ms hold first, so a finger can still scroll the page. Press `Esc` mid-drag to cancel.
- Deleting goes through the shared block delete: if the block has backlinks you are asked a second time.
- While locked, a view card's title bar carries a ↗ "Open in a tab" button that opens the same view, with the same parameters, in its own tab.
- A brand-new empty dashboard offers a "Start from a template" panel with two buttons: "Today" (Clock · Weather · To-dos · Calendar) and "Workbench" (Inbox · To-dos · Activity log). Workbench uses Inbox and Calendar, so if those are off those cards read View "{type}" is unavailable.
- While unlocked you can drag files from your operating system's file manager onto the dashboard; they are imported into this dashboard note the same way notes import files. While locked the drop is ignored.

> [!warning]
> As soon as you resize a card by hand, or drag it into a hand-arranged row, automatic layout stops touching its size and will no longer swap it to a different preset to fill a row. To hand it back use ⋯ → "Restore automatic layout" — note that this releases the **whole row**, not just that one card.

### Laying out on the canvas

The canvas is a fixed 16:9 board (1152×648). Cards can never leave its four edges, and the camera is clamped to it. Once unlocked:

- Drag empty board space to pan, wheel or pinch to zoom. The controls along the bottom are "Zoom out", the live percentage, "Zoom in", "Fit to content", "Snap to grid" and the minimap toggle; the toolbar also has "Reset board view (100%)".
- Click to select, `Shift` or `⌘/Ctrl` to add to the selection, drag from empty space for a marquee; a multiple selection moves as one rigid group. Cards repel each other, keep an 18-pixel air gap, and animate into place when you let go.
- A selected card shows eight handles on its edges and corners; drag one to resize (tooltip "Resize").
- Double-click a card to enter it before you can use the view inside or edit text, and click elsewhere to leave; only one card at a time. Double-click-to-enter still works while locked.
- Right-click (or long-press): on a card, "Enter card" and "Delete" (with several selected, "Delete {n} cards"); on empty board, "Add card…" and "Fit to content".

Keyboard control needs the board focused, so click it once first:

| Key | Effect |
|---|---|
| `Esc` | Clear the selection |
| `⌘/Ctrl + A` | Select all cards |
| `Delete` / `Backspace` | Delete the selected cards |
| `Space` | Enter the single selected card |
| Arrow keys | Nudge by 8 pixels (24 pixels when snap to grid is on) |
| `Shift` + arrow keys | Nudge by 32 pixels |

These keys are swallowed while you type inside a card, so nothing gets deleted by accident. All of them are canvas-only and unlocked-only.

> [!note]
> Locking the canvas turns it into a presentation page: no panning, no zooming, no dot grid, no bottom controls — the board is mapped onto the panel by percentage so it fills the space and text is never scaled. And because positions are percentages of a fixed board, a panel whose shape is far from 16:9 stretches the arrangement — which is exactly why the structured grid became the default.

> [!warning]
> Below 720 pixels of panel width the canvas abandons free positioning and shows a plain vertical card list (top to bottom, then left to right) that cannot be dragged; when empty it reads "Empty dashboard — unlock it and use ＋ to add a card." Two more things that look like faults but are not: unlocking always resets zoom to 100%, and the "Snap to grid" and minimap toggles share one preference with the note canvas, so changing them here changes them there.

### Data cards and page filters

Stat cards and charts both read a database (`.db`) — they are the seam between a dashboard and your data.

Stat card (grid only): add menu → "Stat card…" → the picker "Stat card — pick a database (.db)…" → the prompt "Which column to measure? (leave empty to count rows)" → if you named a column, "Aggregation (count/sum/avg/min/max)" (prefilled `sum`). The card face is one big number. It runs through the same engine as the database's own summary row, so the two always agree.

Chart: add menu (grid or canvas) → "Chart (database)…" → the picker "Chart — pick a database (.db)…". A chart is modelled as a view of a database — the app makes sure that database has a chart view (creating one if needed), then drops in a database card already switched to it. The shape is then configured in the card's view options:

| Setting | Choices |
|---|---|
| "Chart type" | "Bar", "Line", "Donut" |
| "Group by" | Any column in the database |
| "Aggregate" | "Count", "Sum", "Average" |
| "Value column ({agg})" | Only shown when the aggregation is not "Count" |

"Sum" and "Average" are disabled when the database has no number column, and the tooltip says why. Line charts sort by group key, not by value, so the x-axis reads as a real sequence.

Page filter bar (grid only): unlock and a "Filter" row appears under the toolbar. "Add filter" starts one — pick a property, pick an operator, type a value, commit with "Add" or Enter; remove a chip with its × "Remove this filter".

- Filters match by **property name**, so cards drawn from different databases follow along together; a card whose database lacks that property simply ignores the condition.
- The properties on offer come only from databases already loaded on this page, not from the whole vault.
- When the page has nothing filterable yet, "Add filter" is disabled with the tooltip "No filterable data cards on this page yet".
- Once locked, the bar is hidden entirely if there are no filters, and shown but not editable if there are.
- With filters active, a stat card adds a row count under the big number.
- The canvas has no filter bar at all; data cards there always compute with no page filters.

> [!note]
> A few Chinese strings are hard-wired along the chart path and stay Chinese in the English interface: the auto-created chart view is named "图表" (and that name is written into the database file); in chart group labels an empty value is "(空)", booleans are "是" and "否", and anything past the twelfth group collapses into "其他(N)"; the filter operator names ("包含", "是", "为空" and so on) are Chinese only too.

### The note behind a dashboard

A dashboard is a Markdown note. The layout lives in a few frontmatter keys and each card is a fenced code block named after its kind (clock, weather, webview, view, section, stat, chart). That is why it stays searchable, `[[linkable]]` and syncable, and why opening it in an editor like Obsidian shows an ordinary note with a few code blocks rather than damaging it.

| Key | What it holds |
|---|---|
| `dashLayout:` | `grid` or `canvas` |
| `dashboard3:` | Grid: each block's order, width and height |
| `dashboard3x:` | Rows you arranged by hand in the grid |
| `dashboard2:` | Canvas: each block's pixel rectangle |
| `dashFilter:` | This page's filters |

- Values are checked strictly: a tuple of the wrong length, or one holding something that is not a number, is never guessed at — the whole layout freezes and a banner appears.
- The fenced blocks are only activated inside the dashboard view; in a normal note they stay inert code blocks, by design.
- A few card options have no interface and are only reachable by editing the file: custom captions on clock and weather cards, a weather card's latitude and longitude, the small second line under a section heading, scoping a stat or chart to one saved view of a database, and a stat card that shows a literal number with no database behind it.

The relationship with the vault runs both ways: a dashboard reads the vault — view cards, stat cards and charts all point at real notes, whiteboards and database files, and the cards follow whenever that data changes — and a dashboard is itself a file in the vault, so it can be found by search, `[[linked]]` from another note, and carried along by sync. Whole-file actions live in the toolbar:

| Action | Where |
|---|---|
| Pin to the sidebar | The pin button, "Pin" / "Unpin"; it then appears in the sidebar's "Pinned" section |
| Rename | ⋯ → "Rename", prompt titled "Rename dashboard" |
| Delete | ⋯ → "Delete", confirmation reading Delete the dashboard "{name}"?, then the toast "Deleted" |

- "Pin" is stored in local preferences rather than in the file, so it deliberately does not travel to your other devices with cloud sync.
- The toolbar's "Pin" and pinning a card into a hand-arranged row are unrelated features that merely sound alike.
- Some plugins generate a dashboard of their own, or draw one inside their own panel; the cards, the layout bench, the dragging and the ⋯ menu are all exactly the same as here.

## 11 · Time: to-dos, daily notes and the calendar

Everything about time in Amadeus — the to-do list, the calendar, reminders — is wired up by one thing: an `@` time mark in your note text. Read the first section first: **a `- [ ]` with no `@` mark appears in no time view at all**, and that is the one rule you have to know before anything else. The rest of the chapter covers how to write dates, how the to-do list groups things, daily notes and templates, the Calendar Space, and where calendar events come from.

### The @ time mark: the gate into every time view

> [!warning] Know this one first
> Writing `- [ ] Submit the weekly report` is not enough. **A checkbox with no `@` time mark appears in the to-do list, the calendar and reminders — nowhere.** The gate is deliberate: most checkboxes in notes are formatting, not tasks.

The time views do not scan your vault looking for tasks; they honour this one explicit mark. Write an `@` time mark on any line of a note and that line joins the time views, and the line itself decides where it goes:

- A line with a Markdown checkbox (`- [ ] …`) → the "To-Do List".
- A line without a checkbox → the calendar, as an event.
- Any line carrying `@remind:` → a notification at that moment; it stacks on top of either of the above.

Four forms; what lands in your text is always this canonical shape:

| Form | Meaning |
|---|---|
| `@2026-09-01` | All day |
| `@2026-09-01T14:30` | A point in time |
| `@2026-09-01T09:00/2026-09-01T10:30` | A range |
| `@remind:2026-09-01T14:30` | Remind me then |

```markdown
- [ ] Submit the weekly report @2026-09-01
Team meeting @2026-09-01T14:30
Health check @2026-05-06 @remind:2026-05-06T08:00
```

> [!note] The space matters
> The `@` must be at the start of the line or come straight after a space, and the mark must be followed by whitespace, the end of the line, or closing punctuation. So `Meeting@2026-09-01` is not a mark, and `foo@bar.com` is never mistaken for a date.

The rest of the rules:

- Only the first schedule mark and the first `@remind:` on a line count; extras are ignored.
- Anything inside a fenced code block is never a mark.
- Impossible dates (`@2026-02-29`) are rejected.
- A line that is nothing but the mark is skipped; a heading line may carry a mark itself.
- What the time views show is the line with the `@` mark and any leading symbols (`-`, `>`, `#`) stripped off.
- Every entry remembers which note it came from and the nearest heading above it; one click takes you back there.
- Marks in note text are read by the desktop app — on web and mobile there are no note-driven to-dos, events or reminders.

If you are unsure whether a line was picked up, look where it should have gone: the "To-Do List" for lines with a checkbox, the calendar named "Notes" for lines without. Marks are not recomputed on every keystroke — they are rescanned when you switch views, switch vaults, open another note, or files are added or removed, and refresh on their own within a minute anyway.

### Type @ to write a date: the suggestion panel

You do not have to type a full date. Type `@` in a note and the mention panel opens; as soon as what you type after it parses as a date or time, two extra rows appear above the page candidates — "Schedule" and "Reminder" — with the date they resolved to in grey on the right. Press Enter on one and the canonical form is inserted.

| You type | Date inserted |
|---|---|
| `@2026-09-01` | 1 September 2026, all day |
| `@2026-09-01T14:30` | That day at 14:30 |
| `@9-1` | 1 September this year |
| `@9-1T14:30` | 1 September this year, 14:30 |
| `@14:30` | Today at 14:30 |
| `@2200` / `@930` | Today at 22:00 / 9:30 |
| `@today`, `@tomorrow`, `@后天` (day after tomorrow) | That day, all day |

- The "Schedule" and "Reminder" rows sit above the page candidates, so `@` still works for mentioning a note: when what you type does not look like a date, the panel is the ordinary mention list.
- Keyboard: `↑` `↓` to move, `Enter` or `Tab` to insert, `Esc` to dismiss (once dismissed, that same `@` will not re-open the panel).
- A trailing space is added after the insert so you can keep typing.
- Reminder only: start the query with `remind:`, e.g. `@remind:2200`, and only the "Reminder" row is offered.
- Picking an all-day date as a reminder sets it to 09:00 that day — a ping at midnight is useless.
- The panel simply closes as soon as the query contains a space, a newline or a bracket, or runs past 30 characters — so `@Li Ming hello` loses the panel at the space, and a date has to be typed without spaces in it.
- Ranges (`@start/end`) are not offered as candidates and have to be typed: insert the start from the panel, then type `/` and the end after it.
- No natural language: "next Wednesday at three" is not parsed; only the forms in the table above are.

The panel is available anywhere in the note editor and is not offered on read-only pages. The grey text on the right of each row is the full date it resolved to — glance at it before inserting, especially with a year-less form like `@9-1`, which fills in the current year.

> [!info] Loose to type, canonical on disk
> The loose forms (`@2200`, `@9-1`, `@tomorrow`) only exist inside this panel; what goes into your text is always `@YYYY-MM-DD` or `@YYYY-MM-DDTHH:mm`. When you write a mark by hand, write that canonical form — anything else is not a mark.

### The to-do list

The "To-Do List" collects everything unfinished across the vault into one list. Two ways in: the left panel of the Calendar Space, or the "To-Do List" card on the new tab page behind the `+` in the tab bar (the card can be dragged into a sidebar or a split). There is no command palette entry for it.

It draws from exactly two sources: rows of databases that have joined the calendar and have a completion checkbox column mapped, and checkbox lines in note text that carry an `@` mark.

| Group | What lands here |
|---|---|
| Overdue | Past its date and not ticked off |
| Today | Due today |
| Tomorrow | Due tomorrow |
| This week | Within the next 7 days |
| Later | Further out (collapsed by default) |
| Unscheduled | Database rows with no date, grouped again by source |
| Completed | Ticked off (collapsed by default) |

- Click a group header to collapse or expand it; empty groups are not rendered at all. The count for the group sits next to the header.
- Note to-dos and database rows share the same groups, sorted by time.
- When the list is empty it shows a hint spelling out the first one to write: `- [ ] Task @2026-09-01`.
- Each row has its checkbox on the left and its due date on the right.
- Ticking off a note to-do: click the checkbox and that line in the note is rewritten from `- [ ]` to `- [x]`. The Markdown file stays the single source of truth; the view is only a projection of it. Ticking in place is a desktop feature.
- The line is located by its content, not by its line number. If it has changed in the note since the list was loaded, the write is refused rather than guessed and you get "Can't update ... — that line in the note has changed" with an "Open note" button.
- Clicking the row text (not the checkbox) does something else: note to-dos "Open in note", database rows open their peek card.
- At the bottom is a "New to-do" box: type, press Enter, and a to-do dated today is created in the first writable calendar database. Confirming a candidate in a Chinese input method with Enter does not submit it.
- That box only appears when a writable calendar database exists — creating in the wrong place is worse than not creating.

### Reminders (@remind:)

Write `@remind:2026-09-01T14:30` on any line of a note and a sticky notification pops when that moment arrives: the title is "Reminder · source note", the body is the text of that line, and the "View" button takes you back to the note it came from. The "Reminder" row in the suggestion panel inserts exactly this string.

An event and a reminder are different things: an event occupies a slot on the calendar, a reminder just goes off once. A line can carry only a reminder, or both — a reminder stacks on top of other marks, so one line is both a to-do and a ping:

```markdown
- [ ] Submit the weekly report @2026-09-01 @remind:2026-09-01T09:00
```

- Master switch: `⌘/Ctrl + ,` opens "Settings" → "Notifications" → the event "Note reminders (@remind:)", on by default.
- A desktop feature; it relies on marks in note text being read.
- **They only fire while the app is running.** Nothing is replayed for the time the app was closed — this is the point most often mistaken for a fault.
- On launch a missed reminder is replayed only if it is less than 24 hours late; older ones are dropped, so opening the app does not bury you in stale reminders.
- Each reminder fires once. It is identified by the note's path, the reminder time and the text of that line (not its line number), so editing that text can make the same reminder fire again.
- Only the first `@remind:` on a line counts; a second one never fires. The notification body is that line with its marks stripped, so write the line so it reads on its own.
- Reminders come from note text only; a date in a database never pings on its own — write a line with `@remind:` in a note for that.
- Turning the "Note reminders (@remind:)" switch off leaves the marks in your notes; they just stop popping.
- The notification is sticky: it stays until you dismiss it.
- Ticking a to-do off does not cancel its reminder — the reminder only looks at the `@remind:` on that line, not at the checkbox.
- Choosing an all-day date as a reminder in the suggestion panel sets the time to 09:00 that day.
- To cancel a reminder, go back to the note and delete the `@remind:…` from that line.

The "View" button opens the note the line came from and stops at the nearest heading above it, so a daily note full of reminder lines still lands you in the right place.

### Daily notes and templates

A daily note is a note named after the date: `2026-09-01.md`. Press `⌘/Ctrl + K` for the command palette and run "Open today's daily note"; if it does not exist it is created. That command is only in the palette while the Amadeus Space is active; from another Space, use the "Today" card on the new tab page behind the `+` in the tab bar. Both routes need a vault to be open.

Where daily notes land: `⌘/Ctrl + ,` → "Settings" → "Notes" → "Daily notes folder", a path relative to the vault; empty means the vault root. Press "Save"; the new location applies to daily notes created after that.

Any note under `templates/` is a template. When today's daily note is created, `templates/daily.md` is applied automatically if it exists. To insert a template by hand: type `/` in a note for the slash menu → "Template" → in "Choose a template…" use `↑` `↓` to move, `Enter` to insert, `Esc` to close.

Three variables are substituted on insert:

| Variable | Becomes |
|---|---|
| `{{date}}` | Today, as `YYYY-MM-DD` |
| `{{time}}` | Now, as `HH:mm` |
| `{{title}}` | The name of the note you are in |

- Templates go into any note, not just daily notes. The content is inserted at the cursor and replaces nothing, so you can insert several into one note.
- The folder name is fixed at `templates/`; anything else will not be found. Before that folder exists, the picker offers a "Create templates folder" button.
- A template is applied **at creation only**. An existing daily note is never re-templated, even an empty one — insert the template by hand from the slash menu if you want its content.
- Whether today's note exists is checked against the disk, so a `2026-09-01.md` you created by hand in that folder is simply opened by "Open today's daily note".
- If a template fails to apply you get an empty daily note rather than an error — the note itself always gets created.

A daily note is an ordinary Markdown note: link out of it with `[[wikilinks]]`, and write `@` marks in it so the day's plans land straight on the calendar and in the to-do list. A `templates/daily.md` that already contains the headings you use every day is the cheapest way to keep that habit.

### The Calendar Space: views and navigation

Click the "Calendar" icon in the ribbon to enter the Calendar Space, or press `⌘/Ctrl + 5` (the digit is the icon's position in the ribbon; on a default install it is the fifth). There is no calendar entry in the command palette. The Calendar Space is a desktop feature.

Inside are three panels: the calendar in the main area, the "To-Do List" on the left, and a mini month calendar plus "Calendar Settings" on the right. That is the starting layout; once you rearrange the panels yourself, your arrangement is what comes back.

| View | Key | What it looks like |
|---|---|---|
| Day | `d` | One day on a 24-hour time axis |
| Week | `w` | Seven columns of time axis, scrolling sideways |
| 3 days | `3` | Three columns of time axis |
| Month | `m` | A month grid, scrolling vertically |

- The single-key switches apply to the whole window while the calendar is showing; they do not fire while you are typing in a field or a note. The toolbar dropdown holds the same four.
- Navigation: the toolbar's "Today", "Previous" and "Next", or `←` `→`. You can also just scroll — sideways in Day/3 days/Week, vertically in Month.
- The scrollable range is finite: roughly 150 days either side of today in the time views and 40 weeks either side in Month. Scrolling stops at the edge.
- Weeks start on Sunday and that is not configurable.
- Timeline density: the toolbar's "Density" → "Zoom out timeline", "Zoom in timeline", "Reset to default density"; or hold `⌘/Ctrl` and scroll over the time grid. Zooming keeps the time at the centre of the viewport fixed. Month view has no density control.
- A month cell shows at most 3 events; click the "{n} more" chip at the bottom of the cell for that day's full list.
- Mini month calendar on the right: click a day and the main area scrolls smoothly to it (only while the main area is showing the calendar). It also paints a soft band over the range currently visible in the main calendar and follows it as you scroll.
- The whole calendar can be switched off: `⌘/Ctrl + ,` → "Plugins" → "Built-in plugins" → the checkbox on the "Calendar" card. That removes the ribbon icon and the three views; your panel arrangement is still there when you switch it back on.
- The calendar opens elsewhere too: the "Calendar" card on the new tab page, and calendar and to-do cards on a dashboard. Only one calendar instance can exist at a time; the "To-Do List" can be opened several times.

### Events: creating, dragging and the peek card

There are three ways to create an event, and each opens the peek card straight away so you can name it:

- The toolbar's "New": a 30-minute event starting at the next 15-minute slot from now. With no calendar database at all the button is disabled and reads "Add a calendar database in the right panel first".
- Double-click empty space in a day column in Day/3 days/Week: also a 30-minute event, snapped to the nearest 15 minutes.
- Double-click an empty month cell: an all-day event.

New events land in the calendar starred as the default (set in the right panel; see the next section).

Dragging edits the data directly:

| Gesture | Result |
|---|---|
| Drag the block | Move it in time, or to another day |
| Drag its top or bottom edge | Change the length, snapped to 15 minutes, 15 minutes minimum |
| Drag an all-day chip into a time slot | It becomes a 30-minute timed event that day |
| Drag a month chip onto another day | Re-date it, keeping its length |

- A movement under 3 pixels counts as a click and opens the peek card instead of moving anything.
- The peek card: the source calendar and its colour dot at the top, an editable title, a time row that opens into date, time and an optional end, then the record's other properties, and at the bottom "Open note" or "Open database" and "Delete". Close with × or `Esc`; clicking outside closes it too.
- Related-row, lookup, formula and file columns are read-only on the card, with a hint reading "Edit related rows in the table".
- Keyboard, with an event selected: `⌘/Ctrl + C` remembers it, `⌘/Ctrl + V` duplicates it into its own database, `Delete` or `Backspace` deletes it — ordinary databases show a notification with an "Undo" button.
- That copy lives only in the current session and is not the system clipboard; the duplicate keeps the original time and does not land on the day you happen to be looking at.
- Read-only sources (agent schedules, `.ics` subscriptions, the other side's vault) cannot be dragged or deleted; clicking one only opens it for reading.
- Events coming from note text can be dragged: doing so rewrites the `@` string on that line, so Markdown stays the single source of truth. To change such an event's title or make it go away, edit that line in the note — the card's "Open note" takes you straight to the right heading.

### What feeds the calendar, and its settings

The calendar is not one table but several sources stacked together. The "Calendars" section of "Calendar Settings" in the right panel lists them all, each row with a type icon.

| Source | Where it comes from | Editable? |
|---|---|---|
| Databases | Databases you added to the calendar yourself | Yes |
| "Notes" | Every `@` mark on a non-checkbox line across the vault, merged into one calendar | Time only |
| Agent schedules | Plans background agents wrote themselves | Read-only |
| Subscriptions | An `.ics` / webcal subscription URL | Read-only |
| Imported `.ics` | A one-off snapshot from a local file | Read-only |
| The other vault | Local ↔ cloud: whichever side you are not in | Read-only |

- Adding a database: "Add calendar" at the bottom of the right panel → "Add database" → search (only databases with a date property show up here) → then pick which column is the date anchor and, optionally, a completion checkbox column. **Only with a checkbox column mapped do that table's rows also appear in the to-do list.**
- You can also add it from the table: open the database → view settings → "＋ Add to Calendar Space"; once added, that item becomes "Calendar settings".
- Where the date comes from: give the database a "Date" column, which holds a start date, an optional time (blank means all day) and an optional end. A plain date column or a "Created time" column can serve as the anchor too.
- On each row: the colour swatch sets the event colour, the "Show in calendar" checkbox hides or shows it, and writable databases also get a star — the starred one is where new events land.
- The row's ⋯ menu, for writable databases: "Rename", "Set as default", "Open in new tab", "Calendar settings (column mapping)", "Remove from calendar" — removing only takes it out of the calendar, it does not delete the table.
- Subscribing to an external calendar: "Add calendar" → "Subscribe to external calendar" → paste an `.ics` URL (Google, Outlook or Apple Calendar's private address all work). It refreshes every 30 minutes, and the ⋯ menu offers "Refresh now", "Rename" and "Unsubscribe". A desktop feature, and strictly one-way — your changes here never travel back to the remote calendar. A failed fetch shows "Fetch failed" next to the calendar's name.
- Importing an `.ics` file: "Add calendar" → "Import .ics file". It comes in as a static snapshot and never refreshes; files over 8 MB are rejected.
- **Colours, show/hide, the default star and the list of subscriptions all live on this machine**, not in the vault, and are not synced — set them again on another machine.
- A single database can also have its own calendar view: open it → the ＋ next to the view tabs → "Calendar". This is a simpler calendar: month only, no dragging, one table, with a ＋ on each day that creates a row already dated to that day.

## 12 · Files, media and PDFs

Files in Amadeus are not dead weight in an attachments drawer: drag one in and it lands in the vault, write it as an embed line and it becomes a resizable image, a player that can start at a given second, an annotatable PDF, or a web card. This chapter covers how files get in, where they are stored, what each kind looks like inside a note, and how to cite an exact page, second or line back into a note or a conversation.

### Getting files in

There are many ways to hand a file to Amadeus, and they all end the same way: the file is copied into the vault at the attachment location, and a reference is left in the note.

| What you do | What happens |
| --- | --- |
| Drag from Finder / File Explorer onto a note body | Saved to the attachment location, reference inserted at the cursor |
| Drag onto the stage in canvas mode | One card per file, each holding a reference to it (see chapter 6) |
| Drag onto a folder row in the sidebar | Copied into that folder like a file manager, no note text touched |
| Drag onto a note row in the sidebar | That note opens and the files go into its body |
| Drag onto blank sidebar space | Imported to the "Vault root" |
| Drag from the workspace file panel into the sidebar | Same as the two rows above; desktop and local vaults only |
| `⌘/Ctrl + V` with an image on the clipboard | Saved into the vault and inserted as an image, immediately resizable |
| `⌘/Ctrl + V` with files on the clipboard | One embed block per file, in paste order |
| Note toolbar → "Upload files to this note" | Opens a file picker, same as dragging in |
| Slash menu `/` → "Image" | Image-only picker, inserts `![[name.png]]` |
| Slash menu `/` → "Embed" | Type any embed target, inserts `![[ ]]` |

Typing `[[` in a note also completes attachments, databases and drawings — that is how you hand-write a reference like `![[report.pdf]]` without leaving the keyboard.

- A ⏳ placeholder line appears while the file uploads and is replaced in place when it finishes. A failure leaves a visible "⚠️ Upload failed: {name}" line you can delete; the placeholder plus its replacement is two undo steps.
- If you switch notes mid-upload, the file still lands in the original note and you are told: "The file was saved to the original note (you switched pages, so the placeholder line was left as is)".
- Cloud vaults cap each file at 5 MB; over-limit files are skipped and named in the toast with the reason "over 5 MB". Local disk vaults have no cap.
- Files dragged from the workspace file panel into a note body are capped at 50 MB, reported as "{name} (over 50 MB)"; unreadable ones as "unreadable".
- File names containing `[` `]` `|` `#` cannot use the embed form and fall back to a `[name](path)` link.

> [!note]
> Dropping a file on a surface that does not accept files (a Space view, an empty panel, the sidebar background, the tab bar) does nothing at all — that is deliberate, otherwise the whole window would navigate away to that file. While you drag, the window shows a highlight.

### Where attachments go

Every entry point shares one set of settings, all under Settings → "Notes".

| Setting | Panel | What it does |
| --- | --- | --- |
| "Attachment location" | "Files and attachments" | Which folder dragged-in files are saved to |
| "Vault-relative folder" | "Files and attachments" | Only shown for the fixed-folder option; defaults to `assets`, press "Save" |
| "Preview imported files by default" | "Editing and safety" | Insert a preview embed or a plain link; on by default |
| "Suggest attachments and databases in [[ ]]" | "Editing and safety" | Whether `[[` also completes attachments, databases and drawings; on by default |
| "Delete exclusive attachments with the note" | "Editing and safety" | "Ask every time" / "Remembered: delete them" / "Remembered: keep them" |

The hint in Settings spells the behaviour out: "Where dragged-in files are saved. “attachments” auto-creates an attachments/ subfolder beside the note."

"Attachment location" offers three choices:

- "attachments/ folder next to the note" — the default; the subfolder is created automatically if it does not exist.
- "Same folder as the note" — attachments sit beside the note.
- "Fixed folder in the vault" — one place for the whole vault. That folder must be inside the vault or inline previews will not work.

When you delete a note whose attachments no other note references, a dialog asks whether to "Delete them too" or "Delete note only", with a "Don't ask again (change it back in Settings → Notes)" checkbox. Deleting a whole file-reference block asks the same thing, with "Keep files" instead.

- Files another note links to are always kept and never appear in that dialog.
- Cutting a reference block is not deleting — it is moving, so nothing is asked. Hand-editing the characters away asks nothing either.
- The dialog needs the desktop app; other ends never ask, and therefore never delete anything for you.
- An embed can name just the file (`![[pic.png]]`, `![[report.pdf]]`) — the whole vault is searched for that name, so moving an attachment between folders does not break the reference.
- When two files share a name, a note opens the first match; a chat citation chip instead shows as dimmed and unresolved rather than guessing.
- With "Suggest attachments and databases in [[ ]]" off, typing `[[` completes notes only — attachments can still be referenced by hand-writing the file name, you just get no suggestions.

### Images

Images are directly manipulable objects in a note — you never have to switch to source to work on one.

- Click an image to select it (it stays rendered; the source is not revealed) and a handle grows on its right edge with the tooltip "Drag to resize". The width previews live and commits as one integer on release, as a single undo step. The minimum is 40 px; clicking the handle without moving it writes nothing at all.
- Once selected, copy, cut, delete and typing over it behave like any normal editor operation.
- Double-click an image for a full-screen lightbox at natural size; close it by clicking anywhere in the overlay or pressing `Escape`.
- Hovering an image reveals a `</>` button: for the `![[…]]` form it moves the cursor into that literal text; for the `![](path)` form it floats an editable line above the image with the path in readable, decoded form. `Enter` or blur commits, `Escape` cancels; an edit that is no longer valid is discarded rather than written back broken.
- There are two forms on disk and they feel identical: dragging in or the slash menu writes `![[pic.png|200]]` with the width after the pipe; pasting or uploading writes `![caption|200](path)` with the width in the alt text, which is Obsidian's convention. Paths with spaces or brackets are escaped on save.

Clicking an image file in the sidebar opens it in its own tab: the image is centred, and clicking it toggles between fitting the window and actual pixel size. There is no zoom slider, rotate or pan — just those two states; switching files returns to fit-to-window.

Cover images are the other place images show up: hover the note title area → "🖼 Add cover". The picker has three tabs, "Gallery", "Link" and "Upload"; on a note that already has one the title area offers "Change cover", "Reposition" (then "Done") and "Remove".

- "Gallery" ships 12 featured covers that work on every end; the search box above them searches the online image library (Openverse) and needs the desktop app.
- A failed search says so: "The image library is unreachable right now — pick a featured cover above, or use Link or Upload."
- "Upload" saves into the vault at the attachment location set in Settings → Notes, and the hint says exactly that.

> [!warning]
> A `.ico` file opens in the image tab from the sidebar, but written as an embed in a note it is **not** rendered as an image — you get a plain file card.

### Audio, video and time anchors

Put a media file on its own line in a note, for example `![[lecture.mp4]]`, and it renders as a card: a 🎬 / 🎵 icon, the file name, "Collapse" ⇄ "Expand", "Open ↗" (opens with the system default app), and a player underneath.

Add a time anchor after the file name and the player starts there; write a range and it pauses automatically at the end point. The time format is strict:

| Written as | Meaning |
| --- | --- |
| `![[lecture.mp4#t=95]]` | Starts at 95 seconds; the card shows a "Start time" badge |
| `![[lecture.mp4#t=95.5]]` | Seconds may carry a decimal |
| `![[lecture.mp4#t=01:35]]` | 1 minute 35 seconds — minutes and seconds must both be two digits |
| `![[lecture.mp4#t=1:02:30]]` | 1 hour 2 minutes 30 seconds |
| `![[lecture.mp4#t=95,120]]` | Starts at 95 seconds and pauses at 120 |
| `![[lecture.mp4#t=1:35]]` | Not recognised (minutes are one digit) — plays from 0:00 and shows "Invalid anchor · playing from 0:00" |

- "Open ↗" on the card hands the file to the system default app; "Collapse" folds the player away and leaves just the file name, which helps in a note carrying many recordings.
- Video cards carry a "✂ Capture this frame" button: it saves the current picture as a PNG attachment and inserts two paragraphs below the video block — the image, and a link back to that exact moment. When frames are unavailable the button is disabled with "Frames are unavailable here — the video loaded without cross-origin access"; a failure reports "Cannot capture a frame from a cross-origin video" or "Frame capture failed" inline and clears after three seconds. The button exists only on video cards inside a note.
- The recognised extensions are deliberately narrow: video `.mp4` `.webm` `.mov` `.m4v`, audio `.mp3` `.wav` `.ogg` `.m4a` `.flac`. `.mkv` and `.avi` stay plain file cards on purpose rather than becoming a black frame that will not play.
- The card's right edge can be dragged to set a width, written as `![[lecture.mp4#t=95|400]]`.
- Large files stream as you play, so scrubbing a multi-gigabyte lecture recording does not wait for the whole file.
- To write a time-anchored reference without leaving the keyboard, type `[[`, let it complete the file name, then add the anchor by hand.

> [!warning]
> Clicking an audio or video file in the sidebar (or right-clicking it and choosing "Open") opens the **system player**, not the in-app one. The in-app player has exactly two entry points: an embed card in a note, and a time-anchored citation chip in a conversation. A plain `[[lecture.mp4]]` link with no time anchor also goes to the system player.

### Web embeds and bookmark cards

A note line that contains nothing but an http(s) URL renders as a bookmark card: cover image, title, description, favicon and site name. When no cover can be fetched, a colour gradient generated from the host is used, so every card has one — you never get a hole.

Pasting a URL into an empty paragraph pops the "Paste as" menu with three choices; `↓` `↑` to move, `Enter` or `Tab` to confirm, `Escape` or a click elsewhere to dismiss.

| Option | Hint | Result |
| --- | --- | --- |
| "Link" | The host name | An inline link whose text is the host name |
| "Bookmark card" | "Default" | Choosing nothing and closing the menu gives you this |
| "Embed" | "Player / web page" | Video links become a player, everything else an embedded page |

- The slash menu's "Bookmark" item does the same, prompting "Paste a link starting with https:// — YouTube links turn into an embedded player."
- Hovering a bookmark card reveals two tools: ✎ "Edit link URL", and ▶ "Embed the player" for video links or ⤢ "Embed this page (live page, frozen by default)" otherwise. Frozen pages and the inbox stream have no ✎.
- YouTube and Bilibili links embed the platform's official player, with a footer carrying the site name, an optional "Start time" badge, "Open in browser" and "Convert to bookmark card". The start time is read from the URL in `90`, `1m30s` or `01:30` form. Only these two platforms are supported.
- Embedded pages are frozen by default: you first see the bookmark card plus a "▶ Wake page" button, next to the note "Pauses automatically while you edit this paragraph". Once woken it is a real page with a small bar carrying the site name, "⏸ Freeze" and "Open in browser ↗". Desktop only; elsewhere it falls back to a card with the note "Embedded web pages are not supported here, so this fell back to a bookmark card."
- Only public http(s) addresses are allowed. file, data, javascript, localhost and private-network addresses are refused: "Blocked: web embeds only allow public http(s) addresses — file/data/javascript, localhost and private networks are rejected."
- Fetching the title and cover needs the desktop app; elsewhere the card still renders, with the generated cover and the raw URL as the title.
- Video, audio, PDF and web cards can all be dragged by the right edge to set a width, written as `![[target|560]]`. Databases, drawings, plugin embeds and note-in-note embeds have no such handle — the pipe means something else there.

> [!warning]
> A live page freezes the moment your cursor enters its paragraph — the card says so; that is by design, not a crash. Changing the start time remounts the player, and committing a width reloads a playing video or a live page once. Pasting a video URL gives you a **bookmark card, not a player** — click ▶ on the card for the player. One more: pressing `Enter` in the "Paste as" menu without having pressed an arrow key first picks nothing — the menu closes and that `Enter` inserts a line break as usual.

### Reading and annotating PDFs

Right-click a `.pdf` row in the sidebar → "Open (annotatable)", or just click the row, and the reader opens in the app. Several PDFs can be open as separate tabs at once and are restored with the layout; a vault must be open first, and until then the pane only says it is waiting for one. **Annotations are written into the PDF file itself**, so any other PDF reader sees them, and there is nothing to save by hand.

The toolbar holds 13 tools:

| Tool | How you use it |
| --- | --- |
| "Pointer (select text, scroll)" | Select text, scroll, select existing annotations |
| "Highlight (select text; drag on a blank area for a free-form highlight)" | Select text to highlight it, or drag on blank space |
| "Underline (select text to mark it)" | Select text to mark it |
| "Squiggly underline (select text to mark it)" | Select text to mark it |
| "Strikethrough (select text to mark it)" | Select text to mark it |
| "Add text (click the page to type)" | Click anywhere on the page and type |
| "Sticky note (click the page to place one)" | Click the page to drop a note |
| "Pen (pressure-sensitive ink written into the PDF; stylus supported)" | Write directly; a stylus gives pressure |
| "Eraser (drag across ink to erase it)" | Drag across ink to remove it |
| "Rectangle (drag on the page)" | Drag out a rectangle |
| "Ellipse (drag on the page)" | Drag out an ellipse |
| "Line (drag on the page)" | Drag out a straight line |
| "Arrow (drag on the page)" | Drag out an arrow |

- Selecting text on a page pops a floating highlight button, so you can highlight without switching to the Highlight tool first. Read-only PDFs do not get it.
- The "Annotation color" row offers seven: Yellow, Green, Blue, Pink, Orange, Red, Black (black is meant for the pen).
- Picking a shape tool adds a filled/outline toggle, "Stroke width" (1, 2, 3, 5, 8 pt) and "Opacity" (100%, 75%, 50%, 25%); Line and Arrow have no filled state. Picking the pen adds "Pen thickness" (0.35 to 5 pt) and the same opacity choices.
- With the Pointer tool, click an annotation to select it, or drag on blank page area to marquee-select several. Ink, rectangles, ellipses, lines, sticky notes and text boxes can be dragged to a new position. A floating bar offers "Delete" ("Delete {n}" for a multi-selection), plus "Edit" for a single sticky note. On the keyboard, `Delete` or `Backspace` removes the selection and `Escape` clears it. Clicking on text yields to the native text selection instead of starting a marquee.
- Undo is `⌘/Ctrl + Z`; redo is `⌘/Ctrl + Shift + Z` or `⌘/Ctrl + Y`.
- The left-most "Sidebar (thumbnails and outline)" button opens a panel with two tabs, "Thumbnails" and "Outline"; an empty outline reads "No outline or bookmarks". "Add bookmark (written into the PDF outline, visible in any reader)" writes the current page into the PDF's own outline, titled "Page {n}" by default.
- The floating bottom bar carries "Zoom out", "Zoom in" and a zoom menu ("Fit width", "Fit page", 50% to 300%), "Previous page", "Next page", and an editable page box — type a number and press `Enter`. `⌘/Ctrl + scroll wheel` over the page, or a trackpad pinch, zooms too.

> [!warning]
> Three behaviours that look like breakage: the eraser removes **only** pen ink, not shapes or text markup; `⌘/Ctrl + Z` does nothing while "Highlight" or "Add text" is the active tool (those two keep their own undo stack — switch tools and it works again); and a protected or damaged PDF cannot be written, which raises the banner "Could not save — this PDF may be protected or damaged". Separately, a PDF embedded in a note and a PDF opened from an absolute path outside the vault are both read-only: paging and zoom work, but there is no toolbar or sidebar and nothing is ever written — to annotate one, click "Open ↗" on the embed card (tooltip "Open in a Forsion tab (with annotations)") for an annotatable tab.

### Citing a page, a second, a line

Reading a page you want to note down: click "Copy link to this page" on the right of the reader's toolbar (tooltip "Copy a note link to this page") and the clipboard holds a link to that page; the button flashes "Copied". Paste it into a note and clicking it brings the reader back to that page — and if the PDF is already open, it **jumps in place** instead of reloading.

- What is copied is the bare file name, with no path. A note resolves it by searching the whole vault, so it still opens; but when two PDFs in the vault share that name, a chat citation chip shows dimmed and unresolved rather than guessing.
- You can also write one by hand: `[[report.pdf#page=18]]` opens page 18.

After Tangu has read a document, its reply carries citation chips that jump straight to the source. With Agent Desk on they open beside the conversation; otherwise they open as a main-area tab.

| Chip | Reads as | What clicking it does |
| --- | --- | --- |
| PDF page | `report.pdf p.18` | The annotatable reader stops on page 18 |
| PDF page plus a quoted sentence | Same as above | Stops on that page, scrolls to the sentence and paints an amber band that pulses once on arrival |
| Media moment | `lecture.mp4 @01:35` | The player starts at 1:35; a range reads `@01:35–02:00` |
| Code line | `a.ts:42` or `a.ts:42-48` | Opens the file, scrolls to and highlights that line |
| Note heading | `note › heading` | Opens the note and scrolls to that heading |
| Note block anchor | `note › anchor` | Opens the note and flashes that block |
| Office document | The file name | Opens `.doc` `.docx` `.xls` `.xlsx` `.ppt` `.pptx` directly |

- The quote highlight is transient: it is never written into the PDF and vanishes on reload. If the sentence is not found the page still opens, just without the band.
- Heading matching is exact first, then format-stripped, then case-insensitive; if nothing matches, the note simply opens and never jumps to the wrong heading.
- An unparseable time anchor still opens the player, from the start, and the hover text says "(invalid time anchor — playing from the start)". A broken range end degrades to the start point with "(invalid range end — ignored)".
- A plain quoted-sentence link in a conversation opens in the built-in browser beside the chat and scrolls to that sentence in amber — this needs the desktop app with both Agent Desk and the built-in browser plugin enabled; with any of those off it is treated as an ordinary external link. Link text under 8 characters or over 300 is not located, and the page just opens at the top.
- On mobile, media citation chips carry no timestamp and play from the start.

### Supported file types

Any file can go into the vault and any file can be referenced from a note — the only difference is what it renders as. The same file is also treated differently inside a note and in the sidebar; this table is the complete picture.

| Kind | Extensions | Inside a note | Clicked in the sidebar |
| --- | --- | --- | --- |
| Images | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.avif` `.bmp` | Rendered inline, selectable, width draggable | Image tab |
| Icons | `.ico` | Plain file card | Image tab |
| Video | `.mp4` `.webm` `.mov` `.m4v` | Player card with time anchors | System player |
| Audio | `.mp3` `.wav` `.ogg` `.m4a` `.flac` | Player card with time anchors | System player |
| PDF | `.pdf` | Collapsible read-only preview card | Annotatable reader |
| Drawings | `.excalidraw.md` | Embed card | "Open whiteboard" |
| Databases | `.db` | Embed card | Table view, with "Rename" |
| Everything else | `.mkv` `.avi` `.zip` `.docx` … | 📄 file card | System default app |

- Compound extensions win: `.excalidraw.md` is a drawing and `.dashboard.md` is a dashboard, never opened as a plain Markdown note.
- An unrecognised type is not an error — it simply renders as a 📄 file card, and "Open ↗" on the card hands it to the system default app.
- Right-clicking any file in the sidebar offers "Open with the system app", "Show in file manager" and "Delete". PDFs add "Open (annotatable)", images and databases get "Open", drawings get "Open whiteboard", and file types registered by a plugin get "Open" too.
- With "Preview imported files by default" turned off, imported files are inserted as `[name](path)` links instead of embed cards; clicking such a link also opens the file with the system default app.
- Attachments are served with range requests, so paging through a very large PDF or scrubbing a long video fetches as you go rather than waiting for the whole file.
- A plugin can register its own file types; once it does, those files get their own "Open" in the sidebar and the plugin decides what happens.
- The recognised media extensions are deliberately narrow so that formats which cannot play never render as a black frame: better an honest file card that hands the file to a program on your machine that really can play it.

## 13 · Whiteboards and drawing

A drawing board is a freehand canvas driven by the Excalidraw engine. It is its own file in the vault, opens in its own tab, and can also be embedded whole inside a note. This chapter covers how it differs from canvas mode, how to create one, the tools and pens, paper and grid settings, and one naming rule that damages the file if you break it.

### A drawing board is not canvas mode

Both let things float freely on a surface, but they are not the same feature.

| | Drawing board | Canvas mode |
|---|---|---|
| What it is | A separate file driven by the Excalidraw engine | Another layout for one note |
| Where it lives | Its own `.excalidraw.md` file | Inside that note's own `.md` |
| What is in it | Strokes, shapes, text, images | That note's own blocks as draggable cards, plus rectangles, ellipses, text, frames and connectors |
| How to get there | Open a board file from the sidebar, or embed one in a note | The "Document" / "Canvas" switch in the note's top bar |
| Can you draw | Yes — draw, highlighter and eraser are all there | No freehand strokes, but rectangles, ellipses, text and frames are there, and the arrow tool draws connectors |

Canvas mode is the segmented switch in a note's top bar: "Document" and "Canvas", labelled "Editing mode" for screen readers. On mobile it is the frame icon in the floating toolbar, with the tooltips "Switch to canvas" and "Switch to document". The switch is hidden in source mode.

Which one to reach for:

- Freehand sketching, flowcharts, marking up a rough drawing → a drawing board.
- Spreading one note's paragraphs out to reorder them → canvas mode.

They are easy to tell apart in the sidebar too: board files carry a pen-nib icon at the start of the row, while canvas mode has no file of its own and travels with the note.

One naming trap: the app labels the same thing two ways — the sidebar and the command palette say "New whiteboard", while the slash menu inside a note says "Drawing". Both mean the drawing board described in this chapter.

> [!note] The in-app tutorial describes canvas mode as arranging blocks "like a whiteboard". That is only a comparison — canvas mode has no pens, so there are no freehand strokes; rectangles, ellipses, text and frames are all there, and the arrow tool draws connectors.

### Creating a drawing board

Three ways in. All of them need a vault open and Amadeus as the current Space:

- Command palette `⌘/Ctrl + K` → "New whiteboard". Creates it at the vault root.
- The pen-nib button "New whiteboard" at the top of the sidebar, next to "New note". Also creates it at the root; the button row is hidden while there is text in the sidebar search box.
- Right-click a folder → "New whiteboard". Creates it inside that folder, then expands the tree and opens it. The folder menu order is fixed: New note / New subfolder / New database / New whiteboard / New dashboard.

All three open the same dialog, which asks three things at once: the name (prefilled "Untitled whiteboard"), the paper, and the orientation. Paper is either an infinite canvas (the default) or A4, A5, B4, B5; a portrait/landscape row appears only once you pick a paper. Enter confirms; Esc or a click outside cancels.

The paper is only a starting default — you can change it at any time later from the board's ☰ menu.

The name is cleaned up: slashes are stripped, and a `.excalidraw` or `.excalidraw.md` ending you typed yourself is removed before the app appends the full one. A duplicate name is refused on the spot, with a message of the form "Sketch.excalidraw.md" already exists.

The palette matches the command on a wide set of words: whiteboard, drawing, excalidraw, 「白板」 and 「画板」 all find it.

> [!warning] With no vault open, "New whiteboard" in the command palette does nothing at all — no dialog, no error. Open a vault first.

> [!note] The body of this dialog is shown in Chinese, on the English UI as well: 「纸张」 is paper, 「无限画布」 is infinite canvas, 「纵向」 is portrait, 「横向」 is landscape, 「取消」 is cancel and 「创建」 is create. Only the title and the prefilled name follow the interface language.

### The tool capsule and the pens

Every board has a tool capsule across the top, split into three segments by two divider lines. Only the middle segment carries number keys, assigned by position from left to right.

| Tool | Segment | Number key | What it does |
|---|---|---|---|
| Keep tool selected | Left | — | Pins the current tool so it does not snap back to selection |
| Hand | Left | — | Pans the canvas |
| Selection | Middle | `1` | Select, move and resize elements |
| Shape | Middle | `2` | Rectangle / diamond / ellipse |
| Line | Middle | `3` | Arrow / line |
| Draw | Middle | `4` | Freehand, with the 7 pens |
| Highlighter | Middle | `5` | Jumps straight to the highlighter pen |
| Text | Middle | `6` | Type on the board |
| Eraser | Middle | `7` | Erase |
| Frame | Right | — | Frame a group of elements |
| Laser pointer | Right | — | Point at things while presenting, leaves no element |

Number keys only fire while the focus is on that board; typing in an input or a text element does not trigger them. "Keep tool selected" is a toggle, not a tool — it applies to whichever tool is current.

"Shape" and "Line" are merged buttons and open no dropdown: swap the member in the left properties panel, section "Shape" (rectangle / diamond / ellipse) or "Line" (arrow / line). The button remembers the member you used last.

With "Draw" active the properties panel gains a "Pen" section holding seven fixed pens: "Default", "Fine tip", "Fountain pen", "Marker", "Highlighter", "Thick to thin", "Tapered ends". Click the same pen again to go back to your own colour and width. With the highlighter picked the panel also shows a "Stroke" section: "Flat cap" and "Round cap", flat by default. Width and colour are still set with Excalidraw's own stroke controls.

To add an image, paste it onto the board.

Press and drag any tool button to move it, across segments too. Because the number keys follow position in the middle segment, dragging deliberately changes the shortcut. The order is one global setting (the panel marks it "All boards"), not per file and not per window.

> [!warning] Pens that only apply to freehand, such as the marker and the highlighter, hand your colours back when you leave the draw tool. So picking the highlighter and then drawing a rectangle will not give you a highlighter-coloured rectangle.

### Paper, pages and grid

The ☰ menu at the top left of a board holds Excalidraw's own items — export, save as image, search, clear canvas and so on — and below them the app's own settings.

| Section | What it does | Scope |
|---|---|---|
| Paper | "Infinite" or A4 / A5 / B4 / B5, then "Portrait" or "Landscape" | This board |
| Page layout | "Top to bottom" (default) or "Left to right" | This board |
| Grid | Spacing for "Horizontal" and "Vertical" lines, plus an "Opacity" slider | This board |
| Properties panel | "Standard" or "Compact" | All boards |
| Toolbar | "Reset to default order" | All boards |

Once a paper is chosen the page edge is drawn, and panning is held to the page strip so you cannot drift far off into empty space.

Adding pages: move the pointer into the margin past either end of the page strip and a "+ New page" button fades in. A blank page you added by hand can be removed with the "−" button beside it, tooltip "Delete this blank page"; a page with content on it cannot be removed. Pages also grow on their own to cover whatever you have drawn.

Grid: tick "Horizontal" or "Vertical" and set the spacing (20 px by default), then use "Opacity" for how strong the lines look. The slider is greyed out when both sets of lines are off. Lines that would sit too close together at the current zoom are not drawn at all.

The "Toolbar" section is hidden while the order is still the factory one — there is nothing to reset.

> [!warning] Changing "Page layout" really does move your content: every element travels with its page. Press `⌘/Ctrl + Z` to put it back.

> [!note] "Properties panel" ships set to "Compact", a narrow strip on the left that folds its groups into popovers. Switch to "Standard" for the full properties island.

> [!note] Paper only holds panning. A stroke started on the page can still be dragged past the page edge.

### Putting a board inside a note

A board can live inside a note as a live, editable block that you draw on in place.

- Insert it: on an empty line in a note type `/` → group "Advanced" → "Drawing" (the hint column reads Excalidraw). On mobile, use the "+" button in the floating toolbar (tooltip "Insert block") → "Advanced" → "Drawing".
- This path does not ask for a name: the file is named with a timestamp, such as "Whiteboard 2026-09-05 12.30.00", is always an infinite canvas, and is stored next to the note.
- What stays in the note is a single reference line, written in the `![[Name.excalidraw]]` form. What you draw goes into the board file, not into the note.
- The same board can be open in a tab and in several notes at once. Edit it anywhere and every other place updates immediately.
- A plain link without the exclamation mark, `[[Name.excalidraw]]`, opens the board in a whiteboard tab when clicked instead of creating a note of that name.
- A reference carrying a `#` block anchor or a `|` alias is not treated as a board; it stays an ordinary reference.
- A board can also sit on a dashboard as a widget: unlock the dashboard and add it. Two sizes are offered, full and workspace.

Opening from the sidebar: board files carry a pen-nib icon at the start of the row; click it and the board opens in its own tab. A board that is already open is brought forward rather than opened twice. Select several rows and right-click the "Open 3 items in new tabs" entry to open a batch at once.

The right-click menu for a board has four items: "Open whiteboard", "Open with the system app", "Show in file manager" and "Delete".

> [!warning] The ✕ on an embedded board removes only that reference line from the note. The board file stays where it is on disk. To delete the file itself, right-click it in the sidebar and choose "Delete".

### File format, syncing, and what not to rename

A board has no save button. It writes itself to disk about a second after you stop drawing, and flushes again when the tab closes or the app quits.

The file is a `.excalidraw.md`, the same format the Obsidian Excalidraw plugin writes, so one vault can be opened from both apps. Only the drawing section is ever rewritten; the front matter, the text-element section and the link section are preserved as they were. Paper, page layout and grid settings live in the front matter, where they are harmless to Obsidian.

If the same board changes elsewhere — another window, another device, a cloud sync — those strokes are merged element by element into the canvas you have open, instead of one side overwriting the other.

> [!warning] `.excalidraw.md` is one whole ending and must not be split. Rename the file to `Name.md` or `Name.excalidraw-1.md` and the app stops recognising it as a board and opens it in the note editor, which rewrites the drawing data inside. Always keep the complete `.excalidraw.md` ending.

A few more naming rules:

- The board's right-click menu has no rename item. Use "Show in file manager" and rename it there, keeping the ending intact.
- A board inserted from a note is referenced by name. Rename or move it and the block in the note goes to its missing state.
- If the name is taken at creation time and the file gets auto-renamed into a broken suffix, the app stops there and tells you to rename it back to `.excalidraw.md` before opening it.

Other things worth knowing up front:

- Saving is delayed by about a second. Force-quitting inside that window can lose the last few strokes.
- Strokes merged in from elsewhere do not enter your undo stack, so `⌘/Ctrl + Z` will not undo someone else's change.
- If the scene data cannot be read, the board enters read-only protection and stops writing to disk, so a damaged file is not made worse.
- Opening a `.excalidraw.md` from the workspace file panel shows its source read-only. That is deliberate, to keep it from being edited as an ordinary note.

> [!note] These state messages are shown in Chinese, on the English UI as well: 「画板文件缺失」 means the board file is missing, 「画板文件读不出场景数据」,「已进入只读保护」 means the scene data could not be read and the board is read-only, 「重试」 is retry and 「在文件管理器中显示」 is show in file manager.

## 14 · Properties and metadata

Properties are the block of YAML at the very top of a note, between two `---` lines — Obsidian calls it frontmatter. It holds information *about* the note: status, date, tags, page icon, cover. This chapter covers how to read and write it from the interface, which editors you get, where those values flow, and which keys belong to the app and should be left alone.

### The properties bar

Open a note and a small chip sits directly under the title reading "Properties 3" — the number is how many properties the note has. Click it to expand a key/value list (the chip turns to ▾), click again to collapse it (back to ▸).

- It is collapsed by default, and **it re-collapses every time you switch to another note**. That is by design, not a lost setting.
- With no properties at all it reads "Properties 0", and the expanded panel shows one line: "No properties yet."
- The panel edits the key/value pairs inside that `---` block. The app's own structural keys never appear here, and keys that plugins (canvas, mind map, and so on) use to store their data are hidden so you cannot corrupt them by hand. They stay safe either way: editing an unrelated property never drops them.
- If the YAML is broken and the app cannot parse it, the chip becomes "Properties (raw)". Expanding it gives you a monospace text box holding that text verbatim so you can repair it; click away to commit. In this state the app never rewrites anything for you.
- Requires a vault open in Amadeus. Database, dashboard, drawing board and PDF tabs have their own interfaces and show no chip, and it is hidden entirely while a note is in canvas mode.

> [!warning]
> Editing **any** property from the panel re-serialises the whole YAML block — comments you wrote in the frontmatter are lost at that moment. To keep comments byte for byte, edit in source mode (see the last section of this chapter).

### Adding, renaming and deleting properties

- **Add**: the ＋ next to the chip (tooltip "Add property") opens a dialog whose field is labelled "Key name written to the note frontmatter". Type the key, press Enter to confirm, Esc to cancel. The new property lands as empty text and the panel expands.
- **Three ways an add is refused**: a key starting with `amadeus_` raises "amadeus_* keys are reserved"; a key a plugin owns raises "This key is managed by a plugin"; a key the note already has is **silently ignored** — no error, nothing added, it looks like nothing happened.
- **Rename**: expand the panel, click the key on the left of a row, then click away (blur) to commit. The value and the key's position in the YAML block are both kept.
- **Rename refusals are all silent**: the field simply snaps back to the old key with no message. An empty key, the app's five structural keys, a key a plugin owns, and a key the note already has (including the hidden ones) all snap back like this.
- **Delete**: hover a row and an × appears on the right (tooltip "Delete property"); one click removes it. There is no confirmation and no undo in the panel, and the change is written to disk immediately.

> [!warning]
> That delete × is fully transparent until the row is hovered. On a touch screen it amounts to tapping blind — delete properties on the desktop.

### Property types

The control you get on each row is inferred from **what that key's value currently looks like**:

| Value in the YAML | Control you get |
|---|---|
| `done: true` | checkbox |
| `count: 3` | number box (re-parsed on blur) |
| `due: 2026-09-05` | date picker |
| `tags: [reading, wip]` | removable chips plus an input |
| `note: some text`, or an empty value | text box |
| a nested map, or a list containing maps | read-only monospace YAML preview |

> [!note]
> There is **no type picker** in the panel. A newly added property is always empty text. To get a checkbox, number, date or list, take one of two routes: write the value in that shape in source mode (`done: true`, `count: 3`, `due: 2026-09-05`, or one `- item` per line), or add a column in a Note view (see the next section).

- Chips: type in the trailing input and press Enter or comma to append one; press Backspace on an empty input to drop the last one; each chip's × removes just that one; duplicates are refused. While the list is empty the input reads "Press Enter to add…".
- The chips control only appears if the key is **already** a list in the file — the panel has no "turn this into a list" action.
- Text and number boxes **commit on blur only**: typing without clicking away saves nothing. The date box commits as soon as it changes.
- Put something that is not a number into a number box and it is stored as text instead, quietly turning that row into a text property.
- Nested structures are read-only here; hovering one shows "Edit nested values in source mode".

### Page icon and cover

Both of these are properties, they just have dedicated buttons. Hover the title area and a row of buttons appears above it.

- **Add an icon**: click "☺ Add icon" and the app assigns a random emoji straight away — the first click does not ask, it just gives you one to change.
- **Change or remove**: click the large emoji above the title to open the picker (tooltip "Change or remove the page icon"). Inside is a grouped grid plus a search box that matches Chinese and English keywords, placeholder "Search emoji (Chinese or English), or paste any character and press Enter…". Enter takes the first hit; with no hits, Enter uses whatever you typed — so any symbol from the OS emoji panel can be pasted in as the icon. Once an icon is set the picker also offers "Remove icon". Esc or a click outside closes it.
- The bundled emoji table is a curated subset, not all of Unicode, and the group headings (「常用」, 「表情」, 「手势人物」, …) stay Chinese in the English interface. If a character is missing, paste it.
- Once an icon is set it replaces the generic file glyph in the file tree row, on the tab, and in the `[[` link suggestion list.
- **Add a cover**: click "🖼 Add cover" to open the picker, which has three tabs — "Gallery" (12 featured covers, plus an online image search box on hosts that support it), "Link" (paste an `https://…` image address, then Enter or "Set as cover"), and "Upload" (pick a local image; it is saved into the vault at the attachment location set in Settings → Notes). Clicking a thumbnail applies it at once and **deliberately leaves the popover open** so you can try several in a row.
- **Change a cover**: hover the cover banner and "Change cover", "Reposition" and "Remove" appear. "Reposition" unlocks the banner so you can drag the image up or down to set the vertical focal point; click "Done" when it looks right.

> [!warning]
> "Gallery" and "Link" store a **remote address**, not a local copy — go offline, or let the far end drop the image, and the cover goes blank. A failed image is never reported either; the banner just fades, which looks like a bug. "Upload" stores a relative path, so moving the note without its attachment breaks the cover too.

> [!note]
> The "Reposition" drag is mouse-only: on a touch screen you can enter the mode but the image will not move, so adjust it on the desktop. The buttons above the title are also hidden until hovered, which makes them invisible on touch.

### Where properties go: databases, search and dashboards

A Note view is the thing that turns properties into a table — one row per note, one column per property key.

- In a note body type `/` to open the block menu → group "Advanced" → "Note view" (hinted `Bases`). The app creates a folder and a view file and embeds the view in the current note; the view file lives in the note's `.fd` sub-folder, which you will see in the file tree.
- Every row is a note in the source folder, every column is a key found in those notes' frontmatter, and the column type is guessed from the value. Nothing is copied into the view file — the rows are read from disk every time.
- The folder button in the header switches the source (tooltip "Choose the source folder (each row is a note inside it)"). Its first entry, "Whole vault (top-level notes)", covers top-level notes only, not sub-folders; a folder likewise counts only its direct children. Switching folders **adds** columns but never removes old ones.
- Editing a cell edits that note's property. The first column, "Page Name", is the filename, so editing it renames the file and references across the vault follow.
- Adding a row really creates a note in the source folder; deleting a row really deletes that `.md` file, behind the confirmation "Deleting this row also deletes its note file. Continue?".

> [!warning]
> In a Note view, **clearing a cell or unchecking a checkbox deletes the key**, rather than storing an empty value or false. Also, a newly added column writes a key literally named 「属性」, then 「属性2」, 「属性3」… into every note, in Chinese, whatever the interface language; the Board layout's "＋ Add a Status select column" and the Calendar layout's "＋ Add a Date column" likewise write the Chinese keys 「状态」 and 「日期」 (with the options 「待办」 / 「进行中」 / 「完成」). Rename the column from its menu if you want a different key — that rewrites every note in the source folder at once, and the table cannot undo it.

Two boundaries are worth knowing before you rely on properties.

> [!warning]
> Full-text search (`⌘/Ctrl + Shift + F`) and the quick switcher (`⌘/Ctrl + P`) look at the title and the body only — **the properties block is not indexed**, so a value that exists only there will not be found. The sidebar's "Tags" panel works the same way: it counts `#tags` written in the body, and a `tags:` list in the frontmatter is just an ordinary list property that never shows up in that panel.

- A dashboard's "Stat card…" and "Chart (database)…" ask you to pick a `.db`. A Note view keeps no rows of its own in the file, so those two cards report "No data" when pointed at one. To put a Note view on a dashboard, use "Add card" → "Views" → "Database" and pick the file — that gives you the live table.

### Keys that belong to the app

A few kinds of key inside that `---` block are not your data — they are the app's and the plugins' bookkeeping:

| Key | Who uses it | What to do |
|---|---|---|
| `amadeus_page` `amadeus_schema` `amadeus_layout` `amadeus_canvas` `amadeus_next_id` | the note's own structure | never shown in the panel, and you cannot rename another key to one of these. You can see them in source mode — leave them alone |
| `icon` `cover` `cover_y` | page icon, cover, cover focal point | ordinary editable rows in the panel, but change them with the icon and cover buttons. Deleting the `cover` row by hand strands a lone `cover_y` |
| `dashboard` `dashboard2` `dashboard3` `dashboard3x` `dashFilter` | dashboard card layout and page-level filters | dashboards show no properties panel, so these surface only in source mode. Break one and the layout scrambles |
| `canvas`, `mindmap`, `mindmap_rel` and similar | plugins (canvas, mind map, …) storing their own data | hidden in the panel; editing other properties never touches them |

- One exception: the raw mode you get after the YAML breaks **hides nothing**. If the note carries plugin data keys, a line is printed above the text box first: "⚠️ This file contains plugin data keys (…) — leave those lines untouched while fixing the YAML." Do what it says.
- **Source mode is the only place that edits the `---` block byte for byte**: comments survive there, and it is where non-text types get written. On the desktop, click the `</>` button at the top right of the note (tooltip "Switch to Markdown source"); coming back, the tooltip is "Switch to visual editing (WYSIWYG)". On mobile, use the bottom capsule's "⋯" → "Switch to visual editing". The command palette (`⌘/Ctrl + K`) also has "Toggle source / visual editing"; that command has no hotkey.
- Note that this switch is **app-wide state**, not per-note — once you flip it, every note you open is in source.

A fully filled-in frontmatter block looks roughly like this:

```yaml
---
icon: 📌
cover: https://example.com/banner.jpg
cover_y: 38
状态: 进行中
due: 2026-09-05
done: false
tags:
  - reading
  - wip
---
```

## 15 · Working with the other Spaces

Amadeus is not an island. What lives in your vault reaches the other Spaces along a few fixed channels, and some of them write back. This chapter goes neighbour by neighbour: what crosses the boundary, how to turn it on, and what does not cross. Everything below describes the full Forsion desktop build; anything marked "desktop only" is absent on the web and mobile clients.

### Tangu: chatting beside your notes

The first tab in the Amadeus Space's right sidebar is Tangu's "Chat panel". The right sidebar ships collapsed; three ways to open it: the "Toggle right panel" button on the right edge; the command palette `⌘/Ctrl + K` → "Show chat panel"; or the palette → "Toggle right sidebar" (no hotkey).

> [!warning]
> The side chat and the main chat area are the same session, not "the conversation about this note". Switching sessions in one switches the other.

- **The note you are reading is attached automatically**: with a note open in the main area, a "Selected:" reference chip appears above the input, so you can just say "summarise this". The chip's × ("Remove") only mutes the current note; open another one and it comes back. The chip exists in local sessions only — cloud sessions do not show it. It carries the path alone, so the assistant still has to read the file itself.
- **`[[` picks a note**: type `[[` in the input to open the picker. Candidates are ordered vault notes → files under the session working folder → your other conversations. `↑` `↓` move, Enter or Tab picks, Esc closes. Picking deletes the `[[` text you typed and turns it into a chip above the box.
- **`@` delegates to an agent, it does not pick notes**: the menu header reads "Delegate to agent · runs as subagent". Notes always go through `[[`.
- **Drag notes into the chat**: drag one row or a multi-selection from the note tree onto the chat area and it becomes a reference chip; the same drag onto the editor becomes a `[[wikilink]]` instead.
- **Citations in the answer are clickable**: `[[…]]` in an assistant message renders as a citation chip covering notes, headings, block anchors, a PDF page, a moment in audio or video, a range of source lines, and past sessions. Hovering a note citation shows the preview card. Anything that cannot be resolved renders as grey unclickable text rather than erroring, and a bare filename matching more than one file deliberately refuses to guess.
- **Select text inside a message**: two buttons float up, "Quote" and "Ask in side panel"; the second sends the selection to the docked chat panel.

| Boundary | Detail |
|---|---|
| What crosses | The path of the current note, notes / files / sessions you pick by hand, citations in the assistant's answers |
| How to turn it on | Just open the right sidebar; the chip appears on its own, everything else goes through `[[` or a drag |
| What does not cross | Note bodies are not put into context automatically (the assistant reads them); `@` never lists notes; the side panel has no session of its own |

### Tangu: letting the assistant work in your vault

In a local session the assistant knows where your vault is, and is told plainly that notes are real files on disk to be read and written with the ordinary file tools. Just say "tidy up the project plan in my vault" — there is no switch to flip. If the vault directory does not exist, none of this is handed to the assistant.

- **It is warned in advance about the formats it must not rewrite wholesale**: notes carrying structured properties or block anchors, mind maps, drawing boards, `.db` databases, and canvas-mode notes. It also knows the `X.md` plus `X.fd/` subpage convention, so "add a subpage under X" works.
- **Listing notes**: the assistant can list the Markdown notes in your vault, filtered by a fragment of the path. Only `.md` is listed — `.db` files, PDFs and images are not.
- **Calendar**: it can list calendars, list events, and create, edit or delete them. A "calendar" here means any `.db` database with a date column. Times are written `YYYY-MM-DD` (all day) or `YYYY-MM-DDTHH:mm`. With no calendar named, a new event goes into the first one it finds, and the title goes into that table's first column.
- **Session files land in the vault**: unless you set a working folder yourself, a new session's working folder is `<vault>/Sessions`. Files the assistant produces show up in the note tree and can be `[[linked]]`. Setting a working folder in settings takes it off this path.
- **It can read your other conversations**: pick a session with `[[`, or just ask "when did we last talk about this". Only your own sessions are reachable, and never the current one.
- **During a run it can drive the window in front of you**: open a note / drawing board / dashboard / PDF / database (optionally scrolled to a heading or a block), switch Space, start a new chat, open settings. So "write it and then open it for me" works. It can also change interface settings: language, light/dark, accent, background, fonts, and interface zoom.

> [!warning]
> The command palette lists "Open note" and "Switch Space", and running them by hand does nothing at all — they are carriers for the assistant, not entries meant for you.

> [!warning]
> Overwriting a whole database or a whole canvas note destroys its column definitions and card positions. When you ask the assistant to touch those files, say which one part to change.

| Boundary | Detail |
|---|---|
| What crosses | Read and write over the whole local vault, creating and editing calendar events, your own past sessions |
| How to turn it on | Automatic in local sessions, as long as the vault directory really exists; a chat started from Home carries the vault too |
| What does not cross | Cloud sessions never touch the local vault; Muse and Historian write nothing into it |

### Calendar: what actually feeds the grid

Calendar is a built-in plugin, desktop only. Turn it on or off in Settings → "Plugins" → "Built-in plugins" → the "Calendar" card. It has no command-palette entry and no hotkey — the only way in is the "Calendar" icon on the ribbon. Inside: to-dos on the left, the calendar grid in the middle, calendar settings on the right. Three things feed it.

- **Databases, by explicit membership**: only a `.db` you add yourself reaches the calendar. Route one: Calendar Space → right panel → "Add calendar" → "Add database". Route two: open a `.db` → click the active view tab → "＋ Add to Calendar Space". Adding it asks for a column mapping: which column anchors the date (required) and which column is the completion checkbox (optional; leave it unset and the table contributes events but no to-dos).
- **`@` time marks in notes**: write `@2026-09-01T14:30` on any line and that line becomes an event, folded into a read-only synthetic calendar named "Notes". If the same line also carries `- [ ]`, it goes to the to-do list instead of the calendar.
- **Read-only overlays**: `.ics` subscriptions and imports, calendars in the other side of your vault, and each agent's own schedule. All of these can be viewed but not edited.

> [!warning]
> A `- [ ]` with no `@` appears in no view at all — the `@` mark is the only gate.

> [!warning]
> The one-time auto-enrolment happened at first launch. A database you create later, even with a date column, does not join the calendar until you add it by hand.

> [!warning]
> The column-mapping dialog is in Chinese only, including on the English interface: 「日期属性 *」 is the date property (required), 「该库没有日期列」 means the table has no date column, 「完成勾选」 is the completion checkbox, 「不设(纯日历)」 is none (calendar only), 「取消」 is cancel, 「确定」 is confirm.

> [!warning]
> `@remind:` reminders only fire while the app is running; one that came due more than 24 hours ago is dropped rather than replayed.

Write-back is real: dragging or resizing a note-sourced event rewrites the `@` string on that line of the note, and ticking a note-sourced to-do rewrites `- [ ]` to `- [x]`. The line is found by its text, not by its line number — if that line changed underneath, the edit fails loudly with "Can't update \"{name}\" — that line in the note has changed" plus an "Open note" button.

| Boundary | Detail |
|---|---|
| What crosses | Rows of member databases; note lines carrying `@` (two-way, they can be written back) |
| How to turn it on | Databases must be added as members and mapped by hand; notes only need the `@` |
| What does not cross | The synthetic "Notes" calendar cannot be recoloured, hidden or made default; note-sourced events cannot be deleted or duplicated; the dashboard's calendar and to-do cards omit note-sourced items |

### Home: exactly one connection

Home is a built-in plugin, registered as the first ribbon slot. Turn it on or off in Settings → "Plugins" → "Built-in plugins" → the "Home" card. It gives you a wallpaper, a clock and greeting, a full Tangu composer, and a shelf of Spaces along the bottom.

> [!warning]
> Home shows nothing from your vault — no recent notes, no to-dos, no calendar widget.

- **The composer is the only connection**: it is the real Tangu composer (model, mode, attachments, references, voice, skills, slash commands). Sending switches to the Tangu Space and starts a new conversation; if that session runs on this machine, your vault root is added to the folders the assistant may reach. So asking "look at the weekly report in my vault" straight from Home does work.
- **It always starts a new session**: it never continues the chat you were last in. The composer is disabled while the backend connection is down.
- **The shelf is a projection of the ribbon's upper zone**: one order and one set of folders — reorder on the shelf and the ribbon follows, and the other way round. Only the first six tiles show; the rest live behind "All Spaces". Home itself never appears as a tile.
- **Pinned zone**: dragging a Space onto "Pinned Spaces" adds a Home-only copy that leaves the ribbon order alone; drag it back out to remove it.
- **Folders**: "New folder" creates one, then drop Spaces onto it. Right-click a folder for "Rename" and "Dissolve folder"; right-click an item inside one for "Move out". Right-click blank background to open or close the "Space organizer".
- **Home slot**: the centred ribbon cell holds Home by default. Right-click that cell → "Space in the home slot" to swap in any Space; Settings → "Spaces" → "Ribbon home slot" is the same switch.
- **Startup location**: Settings → "Spaces" → "Startup location" → "Open the app in", three choices — the Space in the home slot (default), the last Space on exit (with its tabs), or a fixed Space. Only the second one restores the tabs you had open.

| Boundary | Detail |
|---|---|
| What crosses | Your vault root is attached to the conversation started from Home |
| How to turn it on | With the Home plugin on and a Tangu Space registered, the composer is simply there |
| What does not cross | Notes, to-dos and events never reach Home; pinned copies never reach the ribbon |

### Inbox: notes render here, messages never land in the vault

Inbox sits behind the ribbon's "Inbox" icon: "Messages" on the left, "Message" in the main area. Messages come from agents, the Forsion server and the system. It exists on desktop and mobile, not on the web client. The direction is one-way: things in your vault can be rendered into the inbox, but nothing in the inbox lands in your vault.

> [!warning]
> There is no "save as note" anywhere in the inbox. The only button pointing back at your notes is "Go to the source" on an embed.

- **A standalone `![[target]]` line renders as a live embed**, dispatched in a fixed order: images (`|number` sets the width) → a URL becomes a bookmark card (deliberately not a player here) → `.db` becomes a database → drawing boards → plugin files such as mind maps become an "Open in a Forsion tab" card → plugin-provided embeds → `.md` becomes a note embed → audio and video (with `#t=` start anchors) → PDFs get a read-only inline viewer → any other file gets an "Open with the default app" button.
- **A `.db` embed is genuinely writable**: editing a cell in the inbox edits that table on disk.
- **Cross-note embeds** carry an "↪ Embed" badge and a "Go to the source" button; anything unresolvable shows "Embed missing: " plus the target. Embeds resolve once when the message opens, so later edits to the source note do not show up in that message.
- **The list**: filters "All", "Unread", "Archived"; search is local and only matches the title and body of what the current filter has already loaded. The header also has "Mark all as read" and "Fetch new messages". Right-click a row for mark as read / unread, archive / unarchive, and delete (it confirms, and it is gone for good).
- **The reader**: when the sender is a known agent the header offers "Chat with {name}" — it switches to the Tangu Space and starts a fresh conversation, it does not continue an old one. Messages with attachments show "Attached items" and a "Claim" button under the body.
- **Getting things in from outside the app**: that runs through the external MCP endpoint, covered in the last section of this chapter.

| Boundary | Detail |
|---|---|
| What crosses | Notes, databases, drawing boards, images, PDFs and media can all be embedded in a message and used in place |
| How to turn it on | Nothing to configure; a `![[…]]` on its own line in a message body just renders |
| What does not cross | A message never becomes a note; embeds do not track later edits; PDFs here cannot be annotated |

### Automation: buttons in notes, rules that watch databases

Automation lives behind the ribbon's "Automation" icon, in three panes: "Automations", "Automation detail", "Run history". Desktop only, and it needs the local engine running. There is no hotkey.

> [!warning]
> The rule engine runs alongside Forsion — while the app is closed, timer, event and database rules do not fire at all.

- **Buttons in a note**: type `/` in a note → "Advanced" → "Button". A fresh button reads "＋ Set up button"; clicking it opens the builder in place, locked to the "Manual (button)" trigger. Saving pops the appearance panel: "Name", "Icon", "Confirm before running" (leave it blank to run immediately). The gear reopens that panel, and "Edit actions" inside it goes back to the builder. On disk a button is an ordinary fenced code block, so it survives any Markdown editor; break the text by hand and it falls back to a plain code block shown verbatim — the app never rewrites it for you.
- **Triggers that watch your vault**: "Database" (a row was added to a chosen `.db`, or a watched column's cell changed; up to 10 extra conditions) and "File threshold" (a file reached N non-whitespace characters). "Database" accepts classic databases only — picking a note-view database is refused.
- **Actions that write back**: "Add table row" and "Edit table row", which can pull from the triggering row with `{{row.ColumnName}}`.
- **The other actions**: "Notify" (posts into the Inbox), "Run agent", "Run tool". The chain is fail-stop, and "Run agent" only waits for the run to be queued, not finished — which is why a button reports "Ran {n} steps · agent started (still running in the background)".
- **"Test run"**: the ▶ button on the detail card runs the chain once immediately without touching the normal schedule.
- **System rows**: "Muse patrol" periodically works out what to do for you, and "Historian memory upkeep" summarises sessions and maintains logs and memory — neither writes anything into your vault. "Agent schedules" lists only entries that have both a date and a prompt.

> [!warning]
> A button stores only a reference to a rule, never the actions. A note synced or copied from another machine shows "The linked automation no longer exists (it may have been deleted, or this note came from elsewhere)" and clicking does nothing. A disabled rule reports "This automation is disabled — enable it in the Automation panel first", and a click while the last run is still going reports "The previous run is still going".

> [!warning]
> Turning off Settings → "Developer" → "Record in-app activity" silently kills every Event-triggered rule for good, with no warning anywhere.

| Boundary | Detail |
|---|---|
| What crosses | Row changes in a database fire rules; rules add and edit database rows; a button puts a rule inside a note |
| How to turn it on | Automation Space → "New automation", or `/` → "Button" inside a note |
| What does not cross | Rules do not edit note bodies, only databases; a rule the builder does not understand can only be changed by asking the assistant in chat |

### Public: publishing, sharing, and exactly what becomes visible

Public is the ribbon's "Publish" icon; the page is titled "Published" and has three sections: "My sites", "Published notes", "Shared notes". Each row offers open, copy link, and a two-click "Unpublish".

> [!warning]
> This Space only manages — it creates nothing; both publishing and sharing start from the note itself. It also needs a Forsion account: signed out, all it says is "Sign in to Forsion to see your published content".

- **Publishing a note (public, read-only)**: open the note → the toolbar's "Share / publish" icon → the "Publish" tab → "Publish to a public link". Anyone with the link can read it with no account at all. The card always shows "Published {used} / {total} pages." and refuses past your quota with "Plan limit reached". Publishing a page also publishes its `.fd` subpage tree.
- **Publishing a whole folder**: right-click a folder in the notes sidebar → "Publish this folder (public link)". That publishes the entire subtree at once and copies the link to your clipboard in the same action.
- **Sharing a note (collaboration)**: the same "Share / publish" icon → the "Share" tab → "Turn on live sharing". You set "Link access" (can edit / read-only), "Open for", and a "Password", and manage people under "Participants · {n}". "Stop sharing" cuts everyone off at once, and rotating the link kills the old one instantly.
- **"Shared with me"**: a section in the notes sidebar listing pages other people shared with you. It renders nothing at all when the list is empty, so not finding it is normal.
- **Who may act**: only the vault owner can manage publishing and sharing; a participant is told "Only the vault owner can manage sharing and publishing." Live sharing is also plan-gated, and free plans are asked to upgrade to Plus or Pro.

> [!warning]
> Share and publish expose different things: someone you share with must have a Forsion account and accept the invite, while a published link is readable by anyone with no account.

> [!warning]
> Folder publishing has no confirmation dialog — one click makes the whole subtree public — and that right-click menu has no unpublish, so you must go to the Public Space to take it down. The note right-click menu has no publish item at all; only the toolbar button.

> [!warning]
> If you set "Open for" to 30 days and save, reopening the card shows 7 days. The real duration is whatever you saved.

| Boundary | Detail |
|---|---|
| What crosses | A note body and its subpage tree → a public URL; a whole folder → one public link; a collaborated page → the people you name |
| How to turn it on | The note toolbar's "Share / publish"; folders through the sidebar right-click; everything is managed afterwards in the Public Space |
| What does not cross | The rest of your vault stays private; taking things down happens only in the Public Space or the share card |

### Coding, and the doors from outside the app

What you build in the Coding Space can be published straight to a public web app: the Globe icon on the toolbar, "Publish", opens the "Publish to Forsion" dialog, where you fill in an "App name", a "Link slug" and an "Entry page". `.ts` and `.tsx` are transpiled on publish, no build step; use relative paths for assets. A project with no `.html` entry is refused with "No .html entry in this project yet — generate a page first".

> [!warning]
> This publishes a Coding project, not a note — it is a completely separate mechanism from the note-side "Publish".

- **Manage it afterwards in the Public Space**: every row under "My sites" can "Apply to list" in the Forsion app market (a human reviews it), "Re-apply", "Withdraw" or "Delist". Visitors sign in with their own Forsion account and spend their own quota. The number of published slots is limited by your plan.
- **The external MCP endpoint**: Settings (`⌘/Ctrl + ,`) → "Advanced" → "MCP endpoint" → tick "Expose to external agents (Claude Code / Codex / OpenCode, etc.)". The panel gives you the endpoint address, a copy button, and ready-made connection snippets for Claude Code, Codex, OpenCode and "Generic JSON". Off by default, desktop only.
- **The endpoint exposes exactly two tools**: `inbox_send` (post a titled message into the inbox of the running app on this machine) and `transcribe_audio` (transcribe a local audio file). No MCP tool reads or writes notes.
- **The snippets carry the token, so treat them as secrets** and do not paste them anywhere public. The endpoint binds to 127.0.0.1. Port 3591 is the default, and if it is taken the app climbs to the next free one — so re-copy the snippet after a restart.
- **`forsion://` deep links**: the packaged desktop app registers this scheme, so a browser, a terminal or another app can bring Forsion forward and navigate straight to something. The forms are `forsion://note/<vault-relative path>`, `forsion://session/<id>`, `forsion://space/<id>` and `forsion://agent/<slug>`. There is no "copy link" button anywhere, so you write these by hand. Absolute paths and `.` / `..` segments are rejected.
- **Forsion Unit (same local network)**: the Unit switcher at the top of the ribbon → "Allow other devices to connect"; once on, it prints "Direct address: {addr}" underneath. From the other machine, open the same switcher → "Connect by address…". This machine pops a native confirmation showing the visitor's name, IP and a 6-digit code you compare by eye before letting them in. Paired devices are listed under "Paired devices" and can be revoked one at a time, taking effect immediately.

> [!warning]
> The remote surface is allow-list only: dialogs and anything touching the system shell (opening a vault, opening an attachment, exporting PDF or CSV, revealing in the file manager, installing or removing plugins) never work from the far device. If the port was taken at startup the app silently picks another, so check the printed address again.

| Boundary | Detail |
|---|---|
| What crosses | A Coding project → a public URL; an external agent → your inbox; `forsion://` → opens a note, session or Space |
| How to turn it on | Connect is on the Coding toolbar; the MCP endpoint and Unit are both off by default and you turn them on yourself |
| What does not cross | MCP can neither read nor write notes; Unit is same-LAN direct only |

## 16 · Plugins and the market

Forsion is a shell; most of what it does arrives as plugins. This chapter covers what a plugin can add to Amadeus, what each built-in plugin does, how to install more from the market, and where to look when one misbehaves. The plugin page and the market are desktop only.

### What a plugin can add

A plugin hooks into the surfaces below. Most plugins use only two or three of them.

| Surface | Where you see it |
|---|---|
| `/` menu item | Type `/` in a note; the item lands in the "Plugins" group, or a group the plugin names |
| Command | Searchable in the command palette `⌘/Ctrl + K`; also one button per command under "Commands" on the plugin's detail page |
| Hotkey | Every plugin command gets a row on the "Shortcuts" page, where you bind your own key |
| View | The plugin's own group on the new-tab page; open it as a tab, drag it into either sidebar, and a Space remembers it |
| Custom file type | Files carry the plugin's icon in the file tree and open straight into the plugin's editor |
| "New X" | Right-click the vault root or a folder in the file tree; the entry sits after the built-in ones |
| Embed preview | Write `![[filename]]` in a note and it renders in place; the `</>` button on hover flips back to source |
| Database column type | Click a column header in a database to change its type; the plugin's type sits after the built-ins |
| Status bar item | The status bar at the bottom of the window |
| Notification | A card in the top right, attributed to the plugin |
| Font | The "From plugins" group in the three font dropdowns on the "Appearance" page |
| Sidebar list source | The mode picker at the top of the workspace sidebar, after "Auto", "Sessions", "Files" and "Notes" |
| Achievement series | The achievements panel, below the official series |
| Bundled content | A plugin can carry engine plugins, agents, skills and Spaces, toggled along with it |

Two more things have no UI of their own: a plugin can change typing behaviour in the note editor (intercept keys, expand snippets), live in every note while it is enabled; and it can read and write files and databases inside your vault, by default in its own working folder.

> [!note] Everything above appears and disappears the moment you toggle the plugin. No restart.

### The plugins that ship with the app

The "Built-in plugins" section at the top of the plugin page holds six items that ship with the app and are on by default. Each card has a checkbox.

| Card | What it gives you | What turning it off removes |
|---|---|---|
| Browser | Open web pages and local HTML inside the app; the command "Open browser" | The browser view and that command |
| Terminal | A real terminal inside the app (login shell; vim/top/ssh work); the command "Open terminal" | The terminal view and that command |
| Home | Home Space: wallpaper, a clock, the full Tangu composer, and an organized shelf for your Spaces | The whole Home Space, taken off the ribbon |
| Calendar | Calendar Space: aggregates date and to-do properties across your vault, with .ics subscriptions | The whole Calendar Space, along with the to-do list and calendar config |
| Callouts | Three entries in the "Callouts" group of the `/` menu: "Note callout", "Info callout", "Warning callout", in Obsidian syntax | Those three `/` entries |
| Word count | The command "Count words", which reports the page's characters and words | That command; the live word count in the status bar is unaffected |

- The Browser card carries an extra checkbox, "Open in-app links in the built-in browser". Uncheck it and every external link goes to your system browser instead.
- Calendar registers no command at all; its Space is the only door.
- These switches are stored per machine and are not synced with your account; other windows on the same machine follow instantly.
- The terminal depends on a native component shipped with the app; on the odd machine where it is not ready, opening it says so outright.

> [!warning] Turning off Home or Calendar does not close a panel — it takes the whole Space off the ribbon. Come back to this page and re-check the box to get it back.

### Turning plugins on and off

Press `⌘/Ctrl + ,` to open settings, then "Extensions" → "Plugins" in the left nav. This page is desktop only. It has two sub-tabs: "Forsion plugins" for interface plugins, "Tangu engine plugins" for the half that gives the AI its tools.

- Check or uncheck the box on a card to enable or disable it. It takes effect instantly, with no restart.
- Click a card for its detail page: version, a "Built-in" or "External" badge, description, "Settings", one button per entry under "Commands", "Bundled content", "Companion app", the README, and an expandable "What's New". Leave with "Back to list".
- "Uninstall" appears only for external plugins. The confirmation spells it out: the folder is deleted whole, bundled engine plugins and Spaces go with it, seeded agents are kept.
- Every enabled plugin automatically gets one extra setting, "Working folder" — where it reads and writes inside your vault. Leave it empty to fall back to the default, the plugin's name.
- A plugin with settings of its own also gets a direct entry in the "Extensions" group of the left nav.
- A greyed-out card badged "Requires app version ≥ …" or "Requires plugin API v…, incompatible with this app" is a version mismatch; its checkbox will not respond.
- When a plugin declares a setup flow, its card carries a "Setup pending" badge and the detail page gains a "Run setup" button. The setup card collects the settings it needs and installs its companion content in one click.
- The "Companion app" block handles plugins that need another program running: "Check connection" probes it, "Install" runs the app's own whitelisted installer, and "Open website" is the manual fallback.

> [!warning] Engine plugins can be installed from npm. Take the line on the install dialog literally: "Plugins run with your full system permissions — only install sources you trust."

### The market

The market has exactly two doors: the store icon at the bottom of the ribbon (tooltip "Market"), or the command palette `⌘/Ctrl + K` → "Market". There is no default hotkey. It is a full-window overlay rather than a tab; "Back to app" in the top left leaves it. Desktop only.

| Left nav group | What is in it |
|---|---|
| Discover | Store home: community pick, recently added, popular |
| Categories | Skills, Agents, Plugins, Spaces, Themes, Web Apps |
| Manage | Installed, Updates, Submit |

- Installing: click "Install" on a card or detail page (it reads "Installing…" while it runs). An installed item's button becomes "Reinstall", or "Update" when a newer version exists. A Forsion plugin hot-loads the moment it lands — its views, commands and `/` entries work immediately; a bundled Space appears at the top of the ribbon; a plugin with a setup flow pops its card right away.
- Uninstalling: the trash button on the card, confirmed with "Uninstall \"{name}\"? Its install directory will be deleted." Agents and skills add a warning line: an agent's memory and logs go with it and cannot be recovered; for a skill, your own edits go too.
- Updating: the "Updates" page lists everything with a newer version, one click each. An item whose version is not plain numbers is not flagged here.
- "Web Apps" are web apps other people built with Coding Space. "Open" runs one in the built-in browser, and the hint says AI features spend the visitor's own account quota. With the built-in Browser plugin turned off, it opens in your system browser instead.
- "Submit" is only a signpost: "Open submission page" opens the web submission page in your system browser. The search box and sort control are hidden on that page.

> [!warning] The "Plugins" category mixes Forsion plugins and Tangu engine plugins, and the card does not tell you which is which. The toast after installing does: "Forsion plugin \"{name}\" installed and loaded" is an interface plugin, "Plugin installed and enabled" is an engine plugin. They land in the two different sub-tabs of the plugin page.

### Where plugins live on disk

The plugin folder is `~/.forsion/plugins/`, one folder per plugin, and market installs land there too. Three buttons under "External plugins" on the plugin page manage it.

| Button | What it does |
|---|---|
| Open plugins folder | Opens the plugin folder in your system file manager |
| Reload | Rescans the folder and tears down and rebuilds every external plugin |
| Create sample plugin | Generates a working sample plugin: one command, one `/` entry, one view |

- When the folder is empty, this section reads "No plugins yet."
- A plugin you dropped in by hand does not appear on its own — "Reload" picks it up, and it is also what makes edited plugin code take effect.
- A plugin's private data sits next to the plugin folder and travels with the app rather than the vault — switching vaults does not lose it.
- What a plugin writes into your vault goes in its working folder (the plugin's name by default; change it on the detail page).

> [!warning] After you uninstall a plugin that owned its own file suffix, those files stay in your vault and are never rewritten as ordinary notes. You will see that they no longer open — reinstall the plugin and they open again. The files are not damaged.

> [!note] What you put in the plugin folder must be a complete plugin package (what the market installs has exactly that shape). A folder you made yourself with a few files in it will not appear, however often you click "Reload".

### When a plugin misbehaves

| Symptom | What to do |
|---|---|
| A plugin you dropped in by hand does not show up | Click "Reload" on the plugin page; if it still does not appear, that folder is not a complete plugin package |
| A greyed-out card badged "Requires app version ≥ …" | Update the app, then come back and check the box |
| A panel reads "Plugin view failed to load (see console)" | Toggle the plugin off and on again, then check "Updates" in the market for a newer version |
| You switched interface language but the plugin's `/` entries and command names are still in the old one | Toggle that plugin off and on, or restart the app. Those names are fixed at the moment the plugin is enabled and do not follow a mid-session language switch |
| One plugin sends too many notifications | Settings → "Appearance" → "Notifications" → "Plugin notifications", and switch off its row |
| An unwanted item in the status bar | Settings → "Appearance" → "Status Bar", uncheck it; drag to reorder |
| A message reading "… bundled engine plugin(s) failed to toggle along (engine offline?)" | Wait for the engine to come back, then flip that plugin's switch once more |
| You uninstalled an engine plugin but its AI tools are still there | Restart the backend; the message says so too |
| A rule you turned off in Automation comes back after a plugin reload | That rule was seeded by the plugin. To stop it for good, disable the plugin itself |
| You changed a plugin setting and nothing happened | Some plugins pick up the new value on their next refresh; wait a moment, or toggle the plugin off and on |

> [!note] Once a plugin is disabled it can no longer touch your files — not even through background work it had already started.

## 17 · Commands and keyboard shortcuts

Every action in Amadeus has a name, and the names all live in the command palette. This chapter lists every command in it, the shortcut each one ships with, and the keys that belong to the editor, the canvas and the app as a whole. You do not have to memorize them — press `⌘/Ctrl + K` and type.

### Command palette

The command palette is the single entry point for every command. Press `⌘/Ctrl + K`, or click the icon at the bottom of the ribbon — its tooltip reads “Command palette (⌘K)”.

- Type to fuzzy-match; Chinese, English and pinyin aliases all hit.
- `↑` `↓` select, `↵` runs, `Esc` closes.
- The input reads “Run a command…”, the footer shows “{count} commands”, and an empty result shows “No commands”.
- At most 40 rows are listed at a time; keep typing to narrow it down.

> [!warning] With the caret inside note text, `⌘/Ctrl + K` does not open the palette — the editor claims that key to add a link (the same action as the toolbar’s “Link” button). Click somewhere outside the text first (the sidebar, a tab, empty page area), then press `⌘/Ctrl + K`.

The shortcut shown on the right of each row is the command's **default** key, not your own rebinding. Once you have rebound something, trust what Settings → Appearance → Shortcuts shows.

Three overlays that look alike — do not mix them up:

| Overlay | How to open | What it searches |
| --- | --- | --- |
| Command palette | `⌘/Ctrl + K` | Commands |
| Quick find | `⌘/Ctrl + P` | Note names, files in the vault, chat sessions; lists “Recent” before you type |
| Quick switch note | Command palette → Quick switch note | Notes only; if nothing matches it offers to create one, at the vault root |

All three overlays work the same way: `↑` `↓` select, `↵` confirms, `Esc` closes. In Quick switch note, if what you typed matches no existing note, the last row reads “Create “{name}””. In Quick find, press `→` past the end of what you have typed to jump up to the category pills — All, Notes, Files, Sessions — then use `←` `→` to move between them and narrow the results.

The command list is one flat global list with no Space scoping: the Amadeus commands are added when you enter Amadeus and removed when you leave. So pressing `⌘/Ctrl + K` in Tangu or on Home will not find New note. When a command is missing, check which Space you are in first, then check whether a vault is open.

The palette's own `⌘/Ctrl + K` can be rebound too. It sits on the first row of the Shortcuts page, listed as Command palette.

### Every Amadeus command

These commands come from Amadeus. They appear in the palette only in the desktop app and only while Amadeus is the active Space. Most also need an open vault — without one they do not complain, they simply do nothing.

| Command | Shortcut | What it does |
| --- | --- | --- |
| New note | `⌘/Ctrl + N` | Creates an untitled note at the vault root and opens it |
| New whiteboard | — | Creates a drawing board and opens it |
| New dashboard | — | Creates a dashboard and opens it |
| Quick switch note | — | Opens the jump overlay over every note; offers to create one if nothing matches |
| Search notes (full text) | `⌘/Ctrl + Shift + F` | Opens the full-text search panel in the sidebar and searches every note body |
| Open the tutorial | — | Writes a demo note into your vault and opens it — a real note you can edit |
| Open the user manual | — | Writes and opens this manual, in the language the interface is currently in |
| Open today's daily note | — | Opens today’s daily note, creating it and applying the daily template if needed |
| Star / unstar current note | — | Toggles the star on the current note; starred notes show in the sidebar under “Starred” |
| Toggle source / visual editing | — | Switches between WYSIWYG and raw Markdown; the caret is carried across |
| Open vault… | — | Opens the folder picker so you can choose or switch your vault |
| Reveal current note in file manager | — | Opens Finder or Explorer with the file selected |
| Rebuild full-text index | — | Rebuilds the search index when results look stale or incomplete |
| Toggle attachments & databases in wikilink autocomplete | — | Decides whether typing `[[` suggests notes only, or attachments, databases and drawing boards too |
| Count words | — | Shows a notification with the character and word count of this note |

> [!warning] Quick switch note shows `⌘/Ctrl + P` both in the palette and on the Shortcuts page, but pressing it opens Quick find — that key is already taken. To give it a working key, record a combo for it in Settings → Appearance → Shortcuts.

> [!note] Star / unstar current note and Reveal current note in file manager may do nothing when run from the palette. The reliable entry points are the ⋮ menu above the note, or a right-click on the note in the sidebar.

- `⌘/Ctrl + N` means New note only inside Amadeus; in every other Space the same key starts a new chat.
- Rebuild full-text index has no progress bar and no completion message — it fires and returns.
- Neither Open the tutorial nor Open the user manual ever overwrites a copy that already exists, so your edits are safe. The tutorial file keeps a Chinese name in both interface languages, so switching language does not spawn a second copy.
- Count words comes from a built-in plugin and can be switched off under Settings → Plugins. It is a global command, findable in every Space; if you switch interface language mid-session its title only follows after a restart.

### App-wide commands and shortcuts

These work in every Space, whether or not a vault is open.

| Command | Shortcut | What it does |
| --- | --- | --- |
| Quick find | `⌘/Ctrl + P` | Search note names, vault files and chat sessions |
| Find in page | `⌘/Ctrl + F` | Find text on the current surface; `↵` next, `Shift + ↵` previous, `Esc` closes |
| Toggle left sidebar | `⌘/Ctrl + /` | Collapse or expand the left sidebar |
| Toggle right sidebar | — | Collapse or expand the right sidebar (chat, outline, backlinks, graph) |
| Toggle bottom panel | `⌘/Ctrl + J` | Open or close the bottom dock |
| Back (this tab) | `⌘/Ctrl + Shift + [` | Step back in this tab’s own history |
| Forward (this tab) | `⌘/Ctrl + Shift + ]` | Step forward in this tab’s own history |
| Split right | `⌘/Ctrl + \` | Splits the main area and puts a chat in the new pane |
| Settings | `⌘/Ctrl + ,` | Opens the settings window |
| Zoom in | `⌘/Ctrl + =` | Scales the whole interface up one step |
| Zoom out | `⌘/Ctrl + -` | Scales the whole interface down one step |
| Reset zoom | `⌘/Ctrl + 0` | Returns the interface to the default scale |
| Open mini card | `⌘/Ctrl + Shift + M` | Pops up the small always-available floating window |
| Toggle light/dark mode | — | Swaps between light and dark |
| Change accent color | — | Cycles the accent color |
| Switch theme style | — | Cycles the design language — not the interface language |
| Switch language | — | Swaps the interface between Chinese and English |
| Toggle smooth caret | — | The caret glides to its new position in the editor and chat input; off by default |
| Reset layout | — | Rebuilds the current Space’s panels from its default arrangement |
| Save current layout as a Space | — | Saves the current arrangement as a new Space and adds its icon to the ribbon |
| Show chat panel | — | Opens chat in the right sidebar so you can ask about the note you are reading |
| Market | — | Install plugins, themes and Spaces |
| Achievements | — | View your achievements |
| Feedback | — | Report a problem or send a suggestion |

- The three zoom commands, Toggle bottom panel and Open mini card exist only in the desktop app; mobile has none of them.
- `⌘/Ctrl + Shift + M` for Open mini card is an operating-system-level shortcut and fires even when Forsion is not in front. If another app already owns that combo the registration fails silently and only the palette entry works; it is also absent from the Shortcuts page, so it cannot be rebound.
- Toggle left sidebar uses `⌘/Ctrl + /` rather than the more common `⌘/Ctrl + B`, because that one is bold inside the note editor.
- Reset layout does not ask for confirmation — the tabs and pane sizes in that Space are gone immediately.
- Find in page only counts text you can actually see: collapsed sections, and card bodies that have shrunk to titles on a zoomed-out canvas, are skipped. When focus is in the built-in terminal, a code editor or an embedded web page, the key steps aside for their own find bar.
- Split right gives you a chat pane, not a second copy of the note. For two notes side by side, right-click a note in the sidebar, choose “Open in new tab”, then drag the tab across.

### Editor keys

These keys belong to the note editor itself. They work only with the caret inside note text and only in visual editing mode. They do not go through the command list, so they are not on the Shortcuts page and cannot be rebound. On touch devices there are no physical keys — select text and use the floating format toolbar that appears above it.

Inline formatting:

| Key | What it does |
| --- | --- |
| `⌘/Ctrl + B` | Bold |
| `⌘/Ctrl + I` | Italic |
| `⌘/Ctrl + U` | Underline |
| `⌘/Ctrl + Shift + S` | Strikethrough |
| `⌘/Ctrl + K` | Link the selection; on an existing link it removes the link; with no selection nothing opens |
| `⌘/Ctrl + L` | Align left |
| `⌘/Ctrl + R` | Align right |

There is no working shortcut for centering; use the center button on the floating toolbar.

Structure, indent and undo:

| Key | What it does |
| --- | --- |
| `Tab` / `Shift + Tab` | Indent or outdent a paragraph one level, up to 8; in a list it sinks or lifts the item; in a code block it inserts two spaces; in a table it moves to the next cell |
| `⌘/Ctrl + Backspace` | Back to no indent in one step |
| `Backspace` at line start | Steps back one rung at a time: un-indent, heading down to text, strip the list or quote wrapper, merge with the block above |
| `←` or `Backspace` at line start | Turns the line-start marker into editable text, so `###` can be typed down to `##` |
| `↑` `↓` | On a code block, divider, table or embed, selects the whole block instead of entering it |
| `⌘/Ctrl + Z` | Undo |
| `⌘/Ctrl + Shift + Z` or `⌘/Ctrl + Y` | Redo |

Type to convert:

| Type this | Result |
| --- | --- |
| `/` | Opens the block menu — headings, lists, tables, code blocks, cards and more |
| `# ` through `###### `, `- `, `1. `, `- [ ] ` at line start | Turns the block into a heading, bulleted list, numbered list or to-do on the spot |
| Select text, then type `(` `[` `{` `"` or a backtick — full-width `（` `【` `「` `《` too | Wraps the selection instead of replacing it, and keeps it selected so you can wrap again |
| Select text, then paste a URL | Links that text instead of replacing it |
| `【【` | Becomes `[[` automatically and opens note autocomplete |

> [!warning] Two line-start forms are the reverse of standard Markdown: a pipe character followed by a space gives you a **quote**, and `>` followed by a space gives you a **toggle** (a collapsed block).

Changes arriving from elsewhere — cloud sync, or another program editing the same file — never interrupt the keystroke you are in the middle of. They wait until you stop typing, and wait indefinitely while an input method is composing.

### Canvas keys

Canvas mode spreads one note out as a surface you can arrange freely. Switch with the “Document | Canvas” pill above the note; on touch devices that whole toolbar row is not rendered, and a button in the bottom editing bar, reading “Switch to canvas”, takes its place. There is no palette command for switching to canvas — the pill and the bottom-bar button are the only two entrances.

Every key below needs focus on the stage — a card selected, rather than you typing inside a card.

Selecting and entering editing:

| Action | Result |
| --- | --- |
| Click a card | Selects it; you can then drag it |
| `Shift` + click or drag | Takes the whole branch below it — selected and moved together |
| `⌘/Ctrl` + click | Adds just that one card, without its descendants |
| Press and drag on empty space | Marquee-select |
| `Space` | Enters editing with the caret at the end of the card |
| Double-click a card | Enters editing with the caret where you clicked; by default it also smoothly centers and enlarges the card, which can be turned off under Settings → Notes |
| `Esc` | Steps out one level at a time: close the context menu, cancel the connector in progress, return to the select tool, clear the selection; while editing it returns to selected |

Building structure and placing things:

| Key | What it does |
| --- | --- |
| `Tab` | New child card |
| `Enter` | New sibling card |
| `Enter` or `F2` | With a shape, connector or frame selected, edit its text |
| `Delete` / `Backspace` | Deletes the selection; on a hierarchy line it only detaches the parent-child link, leaving both cards in place |
| `⌘/Ctrl + A` | Selects every card, the main card and the shapes |
| `←` `→` `↑` `↓` | Nudge by 8 pixels |
| `Shift` + arrow | Nudge by 1 pixel, for fine adjustment |

Clipboard, undo and viewport:

| Key | What it does |
| --- | --- |
| `⌘/Ctrl + C` / `X` / `V` | Copy, cut and paste cards; a paste lands at the center of the stage, not at the pointer |
| `⌘/Ctrl + Z` | Undo |
| `⌘/Ctrl + Shift + Z` | Redo |
| Wheel / `Shift` + wheel | Pan vertically / horizontally |
| Hold `Alt` and drag, or middle-click drag | Pans the canvas, and does not interrupt a card you are editing |
| `⌘/Ctrl` + wheel | Zooms with the pointer as the anchor, between 25% and 250% |

- Redo is `⌘/Ctrl + Shift + Z` only; there is no `⌘/Ctrl + Y` on the canvas.
- The arrow steps are the reverse of most apps: a bare arrow moves 8 pixels, and `Shift` is the 1-pixel fine adjustment.
- The eight tools in the toolbar have no letter shortcuts. `Esc` is the only key that returns you to the select tool.
- Copy and paste move cards only. Selecting a rectangle and pressing `⌘/Ctrl + C` then pasting does not give you a second rectangle; the same goes for connectors and parent-child links.
- `⌘/Ctrl + A` leaves connectors and hierarchy lines out of the selection.
- While you are typing inside a card, `Tab` indents the paragraph, `Enter` starts a new one and `Backspace` belongs to the editor — it will not delete the selected shape by accident.
- Touch devices have no marquee selection, no Space-to-edit and no `⌘/Ctrl + Z`; select cards one at a time and double-tap to edit.

### Rebinding shortcuts

Every command's shortcut can be changed. Press `⌘/Ctrl + ,` to open settings, then Appearance → Shortcuts. The panel is titled “Commands and shortcuts · {count}”.

- Recording: click the shortcut chip on the right of a row. It turns into “Press keys…”; the combo you press is set, and `Esc` cancels. Global dispatch pauses while recording, so you cannot fire something by mistake.
- Conflicts: each combo binds to only one command. When you take one that is in use, the old holder is unbound automatically and a notice reads “Unbound this shortcut from "{name}"”.
- Resetting: every row has “Reset to default” and “Unbind”; an empty chip reads “Not set”; the top right of the panel has “Reset all to default”.
- Finding a row: the search box at the top (“Search commands or shortcuts”) filters by command name or key, and the count on the right reads “Showing {count}”.

| What you want | How |
| --- | --- |
| Give Quick switch note a working key | Record a free combo for it, say `⌘/Ctrl + Shift + O`. If you insist on `⌘/Ctrl + P`, record that — Quick find is unbound for you automatically |
| Give Toggle right sidebar a key | It ships with no shortcut; just record one |
| Free up a combo that is taken | Find the command holding it and click “Unbind” |

> [!warning] This list is built from the commands registered **right now**. The 14 Amadeus commands are in it only while you are inside Amadeus — so to rebind New note, switch to Amadeus first and then open settings, or you will conclude it does not exist.

Two families of keys are absent from this page and cannot be rebound: the editor's and canvas's own keys (bold, italic, link, `Tab` indent, `Space` to edit, and so on), and `⌘/Ctrl + Shift + M` for Open mini card, which is an operating-system-level shortcut.

Rebindings are remembered — close the app and reopen it and they are still in force. “Reset all to default” discards every change you made and restores each command's shipped key, without asking twice. The first row of the list is the palette itself, Command palette, defaulting to `⌘/Ctrl + K`, and it can be moved to another combo.

One last thing worth remembering: a command with no shortcut is not a command you cannot reach. The palette is already the fastest entry point — three or four letters and `↵` beats memorizing a combo. Only the two or three commands you press a dozen times a day are worth a key.

## 18 · Settings

Amadeus settings live across a few pages of the app's settings window, opened with `⌘/Ctrl + ,`. This chapter walks them page by page: attachment location, editing and safety, theme and colours, fonts and zoom, startup location, sidebar and status bar, shortcuts — with the default stated for each. All of them are stored on this device, not inside the vault.

### Where the settings live

Press `⌘/Ctrl + ,` to open the settings window. You can also click the gear icon "Settings" at the bottom of the ribbon, or run "Settings" from the command palette (`⌘/Ctrl + K`). The window is app-level, not tied to a Space; close it and you are back on the tab you left.

The left-hand nav has five groups: "Workspace", "Appearance", "AI", "Extensions", "System". The pages that affect Amadeus sit in the first two and in "System".

| Page | Group | What it holds |
|---|---|---|
| "Notes" | Workspace | Attachment location, daily notes folder, editing and safety |
| "Spaces" | Workspace | Which Space the app opens in, the ribbon home slot |
| "Sync" | Workspace | "Online sync" and "Vault remote sync" |
| "Appearance" | Appearance | Design language, colour scheme, light/dark, fonts |
| "Shortcuts" | Appearance | Rebind any command |
| "Status Bar" | Appearance | What the bottom bar shows |
| "Advanced" | System | The "Restore default layout" button |

- "Notes" and "Sync" appear only in the desktop app; the web client and device pages do not have them.
- "Spaces" appears only in the desktop app.
- The two sub-pages under "Sync" each need their own capability: "Online sync" needs cloud sync, "Vault remote sync" needs remote sync. With neither present the sub-nav is empty.
- Plugin switches are on the "Plugins" page in the "Extensions" group — a separate chapter.

> [!warning] Everything in this chapter is stored on this device. None of it is written into the vault or carried by note sync. On a second computer you set it up again.

### Notes → files and attachments

Settings → "Notes" → the "Files and attachments" panel. This decides where dragged-in files land on disk, and which folder daily notes are created in.

| Setting | Options | Default |
|---|---|---|
| "Attachment location" | "attachments/ folder next to the note" / "Same folder as the note" / "Fixed folder in the vault" | "attachments/ folder next to the note" |
| "Vault-relative folder" | A path relative to the vault root | `assets` |
| "Daily notes folder" | A path relative to the vault root, placeholder "Empty = vault root" | Empty, i.e. the vault root |
| "Preview imported files by default" | On / off | On |

- The "Vault-relative folder" row appears only when "Attachment location" is set to "Fixed folder in the vault"; switch back and it folds away.
- With "attachments/ folder next to the note", an `attachments` subfolder is created beside the note if there isn't one already.
- "Preview imported files by default" on: an `![[file]]` preview block is inserted — images inline, other types as a clickable file card. Off: a `[name](path)` link is inserted instead.
- "Daily notes folder" is where "Open today's daily note" creates `YYYY-MM-DD.md`. If the vault has a `templates/daily.md`, a new daily note is created from it.
- Attachments kept outside the vault cannot be previewed inline; they open as links only.

> [!warning] "Vault-relative folder" and "Daily notes folder" are text boxes, each with its own "Save" button beside it. Typing alone does **not** persist — you have to click "Save".

### Notes → editing and safety

Settings → "Notes" → the "Editing and safety" panel. Format upgrades, wikilink autocomplete scope, canvas interaction and delete protection all live here.

| Setting | Options | Default |
|---|---|---|
| "Upgrade legacy notes to v4 plain Markdown on open" | On / off | On |
| "Suggest attachments and databases in [[ ]]" | On / off | On |
| "Focus canvas cards on double-click" | On / off | On |
| "Zoom that collapses cards to titles" | 25% / 40% / 55% / 70% / 100% | 25% |
| "Delete exclusive attachments with the note" | "Ask every time" / "Remembered: delete them" / "Remembered: keep them" | "Ask every time" |

- The upgrade is written to disk only after you actually edit the note; merely opening it changes nothing. Turn this off temporarily if some device still runs a version older than 2.7.8.
- With "Suggest attachments and databases in [[ ]]" on, typing `[[` also completes attachments, databases (.db) and drawings; off, it completes notes only. The palette command "Toggle attachments & databases in wikilink autocomplete" is the same switch, and it shows a toast telling you which way it went.
- "Focus canvas cards on double-click" on: double-clicking a card enters editing and also glides it to the centre at a readable zoom; off: it edits in place and the viewport stays put. A single click only selects; Space also enters editing.
- At or below the chosen zoom, canvas cards show a title summary instead of their body. The default 25% collapses only at the furthest zoom-out; a higher value collapses sooner.
- The delete policy only touches attachments referenced by that note alone; anything another note links to is kept whichever option you pick.

> [!note] The canvas has three more buttons at its bottom right: "Snap to grid", the minimap and the summary toggle, all on by default. The first two share one preference with the dashboard canvas — turn one off in either place and it is off in both.

### Appearance → theme, colours and light/dark

Settings → "Appearance" → "Appearance". "Appearance" is both the group name and the page name, hence the repetition. Amadeus takes its whole look from this page; it has no separate theme settings of its own.

"Design language" sets structure, radius, typography and overall character:

| Design language | What it is |
|---|---|
| `Genesis` | The default. Paper feel, charcoal accent, soft shadows instead of rules |
| `Genesis Glass · 琉璃` | Genesis structure with a native glass shell; body cards stay fully opaque |
| `知` | Compact structure, small radius, very thin shadows |

Two buttons sit at the top right of the panel: "Open themes folder", where third-party themes go, and "Reload themes", which makes a newly added one appear in the list. If the selected theme exposes its own options (Glass has a set for surface opacity, blur and hairlines), an options panel appears under the cards.

"Color scheme" is two independent axes, "Accent" and "Background", sharing one swatch row: "Classic", "Coral", "Teal", "Lavender", "Zhi Blue", "Custom". The same id on both = the original combined scheme; "Custom" adds a colour picker.

| Setting | Options | Default |
|---|---|---|
| "Accent" | Six swatches | "Classic" |
| "Background" | Six swatches | Follows "Accent" |
| "Light / Dark" | "Light" / "Dark" / "Follow system" | "Light" |
| "Shadow" | "Raised" / "Flat" | "Flat" |
| "Frosted glass" | "On" / "Off (low-power mode)" | "On" |
| "Smooth caret" | On / off | Off |

The command palette has five switches that skip the settings window: "Toggle light/dark mode", "Change accent color", "Switch theme style", "Switch language", "Toggle smooth caret". Note that "Switch theme style" cycles the design language, not the interface language; the interface language is "Switch language", and the palette is its only entry point.

> [!warning] While "Genesis Glass · 琉璃" is active, light/dark is locked to the system: the "Light / Dark" buttons are greyed out, the moon icon on the ribbon does nothing, and the hint reads "This theme follows the system appearance". Switch to another design language to control it by hand.

### Fonts and interface zoom

Settings → "Appearance" → "Appearance" → the "Typography" panel. Three slots, each a dropdown, all defaulting to "Follow theme" — the current design language's own stack.

| Slot | Options |
|---|---|
| "Interface font" | "Follow theme" / "Inter (modern sans)" / "Noto Sans SC" / "LXGW WenKai (reading)" / "System default" |
| "Body font" | Same as "Interface font" |
| "Monospace font" | "Follow theme" / "JetBrains Mono" / "System default" |

- Presets only — you cannot type an arbitrary family name. Preset fonts ship with the app rather than relying on what is installed locally, so a vault looks the same on every machine.
- "Body font" covers note text, "Interface font" covers the shell (sidebar, tabs), "Monospace font" covers code blocks.
- Fonts contributed by plugins appear under a "From plugins" group in the dropdown; disable the plugin and that slot falls back to "Follow theme".

Interface zoom is a separate thing: it scales the whole interface in 10% steps between 50% and 200%, remembered across launches.
The "Display and motion" panel under Settings → Appearance offers Small (80%), Standard (100%) and Large (120%) presets and shows the current zoom percentage.

| Action | Hotkey | Command |
|---|---|---|
| Zoom in | `⌘/Ctrl + =` | "Zoom in" |
| Zoom out | `⌘/Ctrl + -` | "Zoom out" |
| Reset | `⌘/Ctrl + 0` | "Reset zoom" |

> [!note] The three presets and the hotkeys use the same zoom path, and the hotkeys are bound in the desktop app only. Interface zoom scales the entire shell: sidebar, tabs and note text all move together. It is not a note font-size control.

### Startup location and Spaces

Settings → "Spaces" (desktop app only). This page decides where the app lands at startup and what sits in the centred cell of the ribbon.

The "Startup location" panel has two rows. The first is "Open the app in":

| Option | Where you land |
|---|---|
| "Space in the home slot (default — now “{name}”)" | Whatever Space is in the centred ribbon cell |
| "Last Space on exit (with its tabs)" | The Space you were in when you quit, tabs restored |
| A specific Space by name (notes is `Amadeus`) | Always that one |

The second row, "Ribbon home slot", changes which Space sits in the slot; right-clicking the centred ribbon cell opens "Space in the home slot" and does the same.

- The Space placed in the home slot disappears from the group of icons above it, so it never shows twice.
- Choosing the home slot or a fixed Space restores *that Space's own* last layout, not the layout of the Space you last quit from.
- Below, "Installed Spaces · {count}" lists every Space. Ones badged "Built-in" ship with the app and cannot be removed; ones badged "Custom/Market" have an "Uninstall" button, which deletes their on-disk layout recipe.
- To keep the arrangement you have now, run "Save current layout as a Space" from the command palette, give it a name, and it appears at the top of the ribbon straight away.

> [!warning] A fresh install does **not** open in Amadeus: the default is the home slot, and the home slot holds Home by default. To start in your notes, set "Open the app in" to `Amadeus`. This default has changed twice historically, so a long-time user's landing Space may have moved without them touching the setting.

### Sidebar, layout and the status bar

Sidebars and panels have no settings page of their own; they are driven by commands, dragging, and what the app remembers.

| Action | Hotkey | Command |
|---|---|---|
| Collapse / expand the left sidebar | `⌘/Ctrl + /` | "Toggle left sidebar" |
| Collapse / expand the right sidebar | No default | "Toggle right sidebar" |
| Open / close the bottom panel | `⌘/Ctrl + J` | "Toggle bottom panel" |

- In Amadeus the left sidebar holds "Notes", "Search" and "Tags"; the right sidebar holds chat, outline, backlinks and graph, and starts collapsed.
- The left sidebar uses `⌘/Ctrl + /` rather than `⌘/Ctrl + B` because the latter is bold in the note editor. The right sidebar has no default key — assign one on the "Shortcuts" page if you want it.
- Drag the divider to resize a sidebar or the bottom panel. Widths are remembered per Space; a sidebar you have never dragged sits at the default width.
- The blocks above the notes tree — "Pinned", "Cloud sync", "Shared with me", "Starred", "Collections" — can be reordered by dragging their headers. Mouse only: touch and pen will not start the drag, and only the header is a handle — dragging from inside a block drags a note instead.
- "Pinned", "Starred" and "Collections" are stored on this device, per vault. Rename or move the vault folder and those blocks come back empty.

The status bar is at Settings → "Appearance" → "Status Bar": the "Display" panel has one master switch, "Show status bar" (on by default), and the "Status bar" panel below is a checkable, drag-to-reorder list holding "Current Space", "Running sessions", "Sync status", "Backlinks", "Word count" and "Inbox unread". Turn the master switch off and the whole bar goes away, giving the height back to the workspace.

> [!warning] "Backlinks" and "Word count" show up only while the active tab is a note editor. Switch to a whiteboard, dashboard, PDF or database and they disappear — that is by design, not a fault.

> [!warning] "Reset layout" (from the command palette, or the button of the same name at Settings → "Advanced") has no confirmation. It immediately discards the panel arrangement and open tabs of the current Space, and there is no undo.

### Shortcuts

Settings → "Appearance" → "Shortcuts". The panel is headed "Commands and shortcuts · {count}" and lists the command palette itself plus every currently registered command with the key it currently answers to.

- Click the shortcut chip on a row to start recording, press the combo to set it, `Esc` to cancel. Global dispatch pauses while recording, so nothing you press fires another command by accident.
- Each combo binds to only one command. On a collision the older binding is released automatically and a notice names the command that lost it.
- Every row has "Reset to default" and "Unbind"; a row with no key shows "Not set". "Reset all to default" at the top of the panel clears every override at once.

The built-in keys you will use most:

| Hotkey | What it does |
|---|---|
| `⌘/Ctrl + K` | Open the command palette |
| `⌘/Ctrl + ,` | Open settings |
| `⌘/Ctrl + P` | Quick find: notes, files and sessions across Spaces |
| `⌘/Ctrl + F` | Find in page |
| `⌘/Ctrl + /` | Collapse / expand the left sidebar |
| `⌘/Ctrl + J` | Open / close the bottom panel |

> [!warning] The Amadeus commands appear in this list only while Amadeus is the active Space. To rebind a note-related command, switch to Amadeus first and then open settings, or you will conclude they do not exist.

> [!note] Both this list and the command palette show each command's **default** key, not your override. To confirm what you bound, trust the combo you pressed while recording.

> [!warning] With the caret inside note text, `⌘/Ctrl + K` does not open the command palette — the editor uses that key for "edit link". Click outside the note body first, then press it.

## 19 · When something looks broken

This chapter is arranged as symptom, cause, and what to do. Most "broken" moments are deliberate trade-offs: a switch that is off, a precondition that is not met, or an action that belongs to a different gesture. Rule out the five things in the next section first, then look up your symptom below.

### Rule these five things out first

Almost every "the feature is gone" report lands in one of these five. Run through them before looking up a specific symptom.

| Symptom | Why | What to do |
|---|---|---|
| The note commands are not in the command palette | The whole set is registered only inside the Amadeus Space and withdrawn when you leave | Switch to Amadeus first, then press `⌘/Ctrl + K` |
| A command does nothing and shows "Open a vault first — the tutorial is created inside it" | No vault is open | Click "Open vault" at the bottom of the sidebar and pick a folder on disk |
| To-dos, `@` events and `@remind:` reminders do not exist at all | They are built from the desktop vault index | Use the desktop app; the web and mobile shells carry the notes themselves only |
| No "Calendar" icon in the ribbon, and "To-Do List" will not open | The built-in plugin is switched off | Settings (`⌘/Ctrl + ,`) → "Plugins" → "Built-in plugins" → tick "Calendar"; the ribbon icon comes back on the next launch |
| On a second machine, Starred, Pinned and Collections are all empty | All three are stored on this device only and do not travel with the files | Mark them again on the new machine |

> [!note]
> A few labels still read in Chinese in the English UI: the calendar's column-mapping dialog, the due chip at the end of a to-do row, the paper-size dialog for a new whiteboard, the "新建链接" row in the `[[` completion, the `| 列 1 | 列 2 |` header of a table inserted from the slash menu, and the leftmost button on the inline toolbar that shows the current block type. That is how they ship — your language setting is fine.

### Nothing responds on the canvas

Canvas mode keeps the single click for selecting and dragging. This is the most commonly reported "bug" here, and the easiest to explain.

| Symptom | Why | What to do |
|---|---|---|
| To-dos inside a card will not tick, `[[wikilinks]]` will not open | Outside edit mode a click only selects | Double-click the card, or select it and press `Space`; `Esc` goes back to selection. The app says so itself: "Double-click a card (or select it and press Space) to edit — then you can tick to-dos and open backlinks" |
| Yet `</>`, an embed card's "Open ↗", external links and database buttons do work on the same card | Those controls are a deliberate exception | Just click them; no edit mode needed |
| Clicking anywhere inside a Frame does nothing | The frame body takes no clicks at all — only its title bar is clickable and draggable | Click the title bar; dragging it moves everything fully inside the frame along with it |
| On a touch screen, dragging a card pans the whole canvas instead | A one-finger drag on an unselected card is a pan | Tap to select first, then drag |
| An arrow key sends the card flying | A bare arrow key is an 8-pixel step | `Shift + ←/→/↑/↓` is the 1-pixel nudge |
| No "Document / Canvas" pill in the top bar | It is not rendered in source mode, and legacy notes do not have it | Leave source mode; Settings → "Notes" → turn on "Upgrade legacy notes to v4 plain Markdown on open" |
| A message reads "Canvas changes were not saved: the amadeus_canvas line in this note cannot be parsed — check it in source mode." | The line holding the geometry was hand-edited into something unreadable | Switch to source mode and fix that line. Until you do, the original canvas data is kept verbatim rather than wiped |

> [!warning]
> Touch has no marquee selection, no `Space` to edit and no `⌘/Ctrl + Z`; multi-select is one tap at a time. A note on a phone always opens in doc mode — switching to canvas on the desktop does not make the phone open it as a canvas.

### A to-do or an event never shows up

The time views (Calendar and To-Do List) take exactly two kinds of thing: rows of a database that has been added to the calendar, and lines in a note body that carry an `@` time mark. Nothing else.

| Symptom | Why | What to do |
|---|---|---|
| You wrote `- [ ]` in a note and it is not in the To-Do List | A checkbox with no `@` time mark appears in no view — that is a deliberate gate, not an omission | Write `- [ ] Send the weekly report @2026-09-01`; typing `@` offers suggestions |
| You added `@` and it still does not appear | `@` must be at the start of a line or after a space, the date must be fully written out (`@2026-09-01`, `@2026-09-01T14:30`), and marks inside code blocks never count | Insert it from the "Schedule" row of the `@` suggestion panel — the format is then always right |
| The line reached the calendar but not the To-Do List | An `@` line with no checkbox is a calendar event, not a to-do | Add `- [ ] ` at the start of the line |
| A to-do dated far ahead is nowhere to be seen | "Later" and "Completed" start collapsed | Click the section header to expand it |
| Database rows do not show up in the To-Do List | That database is not a calendar member, or no completion checkbox column is mapped | Right panel → "Add calendar" → "Add database"; for one already added, use the row's ⋯ → "Calendar settings (column mapping)" |
| You just edited the note and the list is still stale | The list refreshes on page change, vault switch and structure change — not on every keystroke | Switch pages once |
| `@remind:` did not fire | Reminders only fire while the app is running, and one more than 24 hours late is dropped rather than replayed | Keep the app running; check Settings → "Notifications" → "Note reminders (@remind:)" is on |

> [!note]
> Ticking a note-backed to-do in the list rewrites that line in the note from `- [ ]` to `- [x]`. If the line changed since the list loaded, the write is refused rather than guessed: you get "Can't update "{name}" — that line in the note has changed" with an "Open note" button so you can edit it yourself.

### Menus and popups that will not open

Every completion popup shares one rule: once you close it with `Esc`, that same trigger character will not bring it back. Knowing that explains half the symptoms below.

| Symptom | Why | What to do |
|---|---|---|
| After closing the slash menu with `Esc`, the same `/` will not reopen it | The dismissal is remembered against that `/` position | Delete that `/` and type a new one. The `@` panel behaves the same way |
| Typing `/` just leaves a literal slash | `/` is always literal inside a code block, and mid-word `/` (as in `TCP/IP`) never triggers | Type it at the start of a line or after a space |
| The menu closes on its own and `/foo` stays in the text | A space, a `]`, a newline, or a query over 40 characters closes it | Delete those characters and start again |
| Moving the caret back into a finished `[[link]]` does not reopen the completion | It only reopens when you actually edit — otherwise `↑` and `↓` would be swallowed and the caret could not leave that line | Type one character |
| Pressing `Enter` right after pasting a link selects nothing | The "Paste as" menu highlights nothing at first, so `Enter` still inserts a line break | Press `↑` or `↓` to pick a row first, then `Enter` |
| `⌘/Ctrl + P` opens "Quick find", not "Quick switch note" | That key belongs to "Quick find" | Open "Quick switch note" from `⌘/Ctrl + K` |
| "Outline", "Backlinks" and "Graph" are nowhere to be found | The right sidebar starts collapsed and has no hotkey | `⌘/Ctrl + K` → "Toggle right sidebar" |

> [!info]
> Find in page (`⌘/Ctrl + F`) scans what is currently rendered: text inside a collapsed section, or scrolled out of a long virtualised list, is not found. Expand first, then search.

### A note does not look the way you left it

A vault is nothing but plain Markdown files on disk, so "opened in another app" cuts both ways: someone else's vault coming in here, and your notes opened elsewhere.

Someone else's note opened here:

| Symptom | Why | What to do |
|---|---|---|
| The block menu is shorter, has no "Turn into", and there is no "Document / Canvas" pill | This note opened in the legacy format | Settings → "Notes" → turn on "Upgrade legacy notes to v4 plain Markdown on open", then reopen it |
| The "Tags" panel is empty | Only inline tags in the body are counted; `tags:` written in the file header is not | Write an inline tag such as `#idea` in the body |
| Double-clicking `.excalidraw.md` or `.dashboard.md` opens an ordinary note | The compound suffix was broken (a name collision turns it into something like `x.excalidraw-1.md`) | Rename the file back to the full suffix |
| Clicking `[[Note#Heading]]` opens the note but does not scroll to that section | Wikilinks inside a note keep only `#page=` for PDFs and `#t=` for media | Open it and locate the section with find in page |

Your note opened in another editor:

| Symptom | Why | What to do |
|---|---|---|
| A Toggle block shows up as an ordinary quote | On disk it is `> [!fold]- Title`, which other editors render as a quote | Normal. Back here it is still a Toggle |
| Comments such as `<!-- a t1 -->` appear in the body | Those are the anchors of canvas cards | Leave them. Delete one and that card unwraps back into the body |
| One long `amadeus_canvas` line sits in the file header | All the canvas coordinates and parent-child links live on that line | Do not hand-edit it. If it breaks, the app says so to your face and keeps what you wrote verbatim |
| Text colour became `<span style=…>` and image width sits in `![caption|200](path)` | Deliberately inline HTML and Obsidian's own convention, so other editors read them too | Normal |

> [!note]
> Code-block wrapping, line numbers and folding, and heading-section folds, are session state only and reset when you reopen the note — deliberately never written into the Markdown, so nothing proprietary lands in your files.

### Links and embeds that stop resolving

Renaming inside the app (tree right-click → "Rename", or editing the name in the title bar) rewrites `[[…]]` and `![[…]]` across the whole vault. What it does not cover, and the ways an embed refuses to render, are below.

| Symptom | Why | What to do |
|---|---|---|
| After a rename some links are broken | The rewrite covers `[[…]]` and `![[…]]` only; Markdown links like `[text](x.md)` and file references like `[[x.pdf]]` or `[[x.excalidraw]]` are not rewritten | Rename through the app's own "Rename", then fix those three kinds by hand; links that were already broken stay broken |
| After a rename, entries vanished from Starred and Pinned | Starred, Pinned and Collections are keyed by path and are not remapped | Mark them again |
| PDFs, images and whiteboards have no "Rename" in the tree menu | Only notes, `.db` files and plugin file types can be renamed from the tree | Rename in the file manager, then fix the references by hand |
| `![[Note#blockId]]` renders as a line of ordinary text | Block ids exist only in legacy-format notes | Use `![[Note]]` to transclude the whole note |
| The embed line shows the `![[…]]` source instead of content | That line must contain the embed and nothing else | Move the surrounding text to the line above or below |
| Putting the caret on the line turns wikilinks, formulas and images into source | Deliberate: the caret on that line reveals the editable original | Move the caret away and it renders again immediately |
| Inside a transcluded note, databases and whiteboards became text | Nested embeds render one level deep only | Click "Edit at the source" and view them in the original note |
| A web embed is dead with just a "▶ Wake page" button, and a video link will not become a player | Web embeds are frozen by default and pause again whenever the caret enters that paragraph; inline players cover YouTube and Bilibili only | Click "▶ Wake page"; leave other platforms as bookmark cards and use "Open in browser" |

> [!warning]
> An equation must be the one-line `$$ … $$` form. Written across three lines it is parsed as two ordinary paragraphs and never renders. When the syntax itself is wrong you get a "Formula could not be rendered" badge.

### Starting over: delete the note, then run the command again

The built-in tutorial and user manual both follow one rule: create it if it is missing, leave it alone if it is there. They are generated into your own vault — once you have edited them they are your notes, and the command will never overwrite them. So there is exactly one way to start over:

1. Find the note in the sidebar, right-click → "Delete". On desktop there is no second confirmation: it goes straight to "Trash" with a "Moved to trash" toast.
2. Switch to the Amadeus Space and press `⌘/Ctrl + K`.
3. Search for "tutorial" or "manual" and pick "Open the tutorial" or "Open the user manual". The file is regenerated in your current interface language and opened.

| What to reset | How | Watch out |
|---|---|---|
| The tutorial | Delete `Amadeus 使用教程.md`, then run "Open the tutorial" | The tutorial's language is fixed at the moment it is generated; after switching interface language you must delete and rerun to get it in the new one |
| The user manual | Delete `Amadeus 使用手册.md` or `Amadeus User Manual.md`, then run "Open the user manual" | Both language versions are generated together, and the command opens the one matching your current interface language |
| Search or backlinks look stale | `⌘/Ctrl + K` → "Rebuild full-text index" | There is no progress bar and no completion toast; when it is done, it is done |
| You deleted the wrong thing | "Trash" at the bottom of the sidebar → find the row → "Restore" | The trash never empties itself and has no age limit — click "Empty" yourself when it grows |

> [!note]
> Both commands live in the command palette only while you are in the Amadeus Space. Run them with no vault open and you get "Open a vault first — the tutorial is created inside it" and nothing is generated.
