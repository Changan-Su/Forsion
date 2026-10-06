# Forsion changelog

<!-- English edition of CHANGELOG.md: same "## <version> (<date>)" headings, one bullet per Chinese bullet. Add both when releasing. -->

## 2.13.0 (2026-10-06)

- **A native shell on Android.** The top bar, bottom navigation bar and half-screen sheets now use native system controls: opening a Space shows its list first, tapping an item opens the main area, and Back returns to the list. The avatar menu switches between local and cloud, switches Units and opens Settings. You can also install and run external plugins on your phone. Other phone improvements: badges and haptic feedback on the bottom bar, a long-press menu on messages, voice input, Share to Forsion from other apps, the + button split into Camera, Photos and Files, dropdowns shown as half-screen sheets, times on session rows and a clearer offline message. System notifications tell you when a background task finishes or needs your approval, and command confirmations can be denied or allowed right on the notification.
- **Open a whole Space in its own window.** Right-click it on the Ribbon, ⌘/Ctrl-click it, or drag its icon off the Ribbon. Each Space gets one window, and its position and size are kept across restarts. The middle of the Ribbon now lists recently used Spaces; set how many in Settings → Appearance, or turn the list off.
- **A new default splash screen, Tree shadow.** Window light and branch shadows on a wall with a line of Fusang poetry, in daylight for light mode and moonlight for dark mode, with the version number in the lower left. The earlier tree-mark animation is still there as Splash media → Classic icon. You can also use your own splash media and app icon in Settings → Appearance → Splash & icon. On Windows, starting in dark mode no longer flashes a light background first.
- **Each Space can have its own appearance.** In Settings → Space → Space appearance, set the design language, accent color, background color and light or dark mode for each Space. Tinting the shell from content is now off by default and can be turned on in Settings.
- **Interface**: the layers of the dark theme have been retuned, and there is a new Ink color scheme. Primary buttons in dark mode are no longer a block of white. Two new appearance switches, Relaxed text and Gentle transitions, are on by default, and Dim surroundings is off by default. The Ribbon returns to its place after you scroll it, which you can turn off; its command area now keeps five items in view instead of four, and expanding or collapsing it is animated. The slash menu no longer shifts when you switch categories, and the model menu's submenu is no longer taken over by rows you pass on the way.
- **Hand work to agents from a note**: three new blocks — Page instructions, Agent task and Reusable prompt. Type `@Agent` to insert a task to hand off; it runs in the background while the note stays open. AI commands in the slash menu are grouped into Writing, Instructions, Tasks and Prompts.
- **PDF**: the built-in PDF reader is now read-only and reloads in place when the file changes. Plugins can take over .pdf files, and Settings lets you choose the default opener. Built-in PDF annotation is removed in this version and will come back as a plugin.
- **Image Studio** now uses a project-and-detail layout: project navigation on the left, a launchpad or the canvas in the main area, and the conversation on the right beside the properties.
- **Links**: web links in the app open in your system browser by default, and web citations in chat follow the same setting. You can switch back to the built-in browser in Settings.
- **Voice**: Qwen-Audio-Realtime is available for calls. You can choose the cloning model for read-aloud voices, and the app guides you through recording a sample and checks it locally. Fixed voice sample uploads timing out from outside mainland China.
- **Memory and self-improvement**:
  - Memory is split into project and global scopes. When a project's memory is full, the model tidies it before saving, and sentences that were merged or dropped can be restored one by one in the project details.
  - Working notes are now called the Evolution Record. Agents can write to it themselves, and you accept or discard risky entries one at a time. Agents put away tools and skills they rarely use, and Muse reviews usage weekly.
  - Background reviews start as soon as something goes wrong: you correct the agent, you stop it, tools fail repeatedly, or it says it finished when it did not.
  - Automatic recall in a project session no longer brings in what was said in other projects. Sessions for team members, discussions and sub-agents follow the project they belong to.
- **Agents can read and change some settings on this device.** Every change takes effect only after you confirm it. Credentials, approval levels and permission settings are not available to agents.
- **Plan mode is no longer available in team mode.** Its menu item is dimmed and says why.
- **More reliable subscription sign-in**: tokens renew automatically when they are used, including for image generation, image editing and read aloud.
- **Cloud sync**: agent-level collaboration notes (HUMAN.md) are now synced, and log sync no longer loses the cloud header. Syncing across devices takes effect once the server is updated.
- **Windows**: running commands no longer opens a console window, and no child processes are left behind after a timeout, a cancel or a stop.
- **Plugins (for authors)**:
  - `ctx.tangu.mountChat` mounts the native conversation in a plugin's own view, and `ctx.app.trash` moves files in the vault to the trash.
  - A Space can declare pinned Views (`pinned`) and use its own icon file (`iconFile`).
  - Plugins can take over a file type with `override: true`. Only .pdf is open for now.
  - Mount APIs return a `{ render, dispose }` handle. Extend View has a new close reason, `layout`, so layout changes are no longer reported as the user closing the view.
  - During voice calls the host provides the audio level through `agentStatus.speechLevel`, which plugins can use for lip sync.
  - Local plugin task APIs: `ctx.tangu.request` calls routes of an engine plugin in the same bundle, `ctx.tangu.openSession` opens a task session, `ctx.registerScopedRoutes` registers ownership-checked routes, `ctx.paths.dataDir` gives a stable data directory, and the `runs` APIs create and track background tasks. Tools provided by plugins can be called through the desktop app's outward MCP, on this device only.
- **Unit**: the command line can update a plugin while Unit is running. A new optional management interface shows status, registers release packages and runs updates; it is off by default and is turned on in `unit.json`.
- Fixed the layout being saved to the wrong place when startup temporarily fell back to another Space. A plugin Space set as the startup target is now opened when it finishes loading late.
- Fixed the height of plugin views opened directly in the bottom panel, and stopped a chosen skill's full text from being pasted into the conversation.

## 2.12.2 (2026-10-02)

- **Real-time voice calls**, like GPT Live. When the input box is empty, the send button starts a call. The call runs in the Mini card with the agent's avatar, a hang-up button and a microphone picker. Hand work off to the agent during the call and it reads the result back when it's done. You can also type during a call and the text goes straight into it, and voice transcripts are corrected with what the real-time model actually heard. If the service drops the connection with an error, the call reconnects instead of ending, and results from work handed off during the reconnect aren't lost. Calls replace hands-free auto-send.
- **Voice settings are split into Voice calls, Voice input and Read aloud**, with separate voices for calls and for reading aloud.
- **Notes**: browse and restore earlier versions from ⋯ → Version history. Type footnotes directly, click a superscript to jump to its definition and hover to preview it. `:emoji:` shortcodes autocomplete as you type, and ⋯ → Copy as Markdown is new. Collapsible blocks can hold code, tables and other special content, and code blocks detect their language automatically.
- **Canvas**: objects snap and show guides when you drag or resize them near other objects. Shapes, frames and connections can be copied and pasted, and Mod+D duplicates them. Change the arrowheads on either end of a connection, drag an end to reconnect it, or drag a new connection out of a card's edge handle. Dragging a note from the sidebar onto the canvas adds an embedded card (hold Alt for a link card), and the context menu has Add note…. Canvases can be exported one way to JSON Canvas.
- **Turn a conversation into a note**: save a whole conversation as a note in one step, and add interactive blocks (```forsion-sketch) to notes. Charts and flowcharts in chat have a clearer look.
- **A calmer interface**: a lighter Ribbon, the status bar off by default, frame icons that light up only on hover, and an option to hide chat avatars. Scroll the Ribbon's Space and command areas to see more icons; scrolling follows your input and snaps when you stop, and … now opens on click. Spacing and type rhythm are tuned throughout, and message action rows show the time.
- **Sessions and onboarding**: Historian picks an emoji icon for each session, new sessions that haven't started hide the Agent Desk, and onboarding lets you choose the default background agent.
- **Backpack and submissions**: the avatar menu in the lower left has a new Backpack, where you can view and use items and vouchers from Forsion Cloud. You can submit plugins and manage your submissions right in the store, or from Settings → Forsion Cloud → Plugin submissions.
- **Easier updates**: core plugins check for updates together, the plugin market adds an npm channel, and each installed market plugin can update automatically. When an update is ready, a Restart to update entry stays on the Ribbon. If tasks are still running, Forsion asks whether to restart later or quit and update now.
- **Plugins**:
  - Plugins can declare required plugins. A plugin can't be turned on until the plugins it needs are installed and running. When a required plugin stops, the plugins that depend on it pause, and they resume when it comes back. Settings lists what's missing and links to it in the market.
  - Turning engine plugins on or off, updating them and uninstalling them no longer restarts the backend. A few packaging styles still need a restart, and Forsion says so when they do.
  - Plugin views can dock in the native bottom panel and switch between a launch layout and a project layout, like Coding Studio.
- **More reliable agents**:
  - Unattended runs such as Muse and automations no longer wait for answers or approvals that nobody is there to give.
  - After the engine restarts, interrupted tasks are no longer rerun from the start, and replies written before the interruption are kept. A normal exit waits for running tasks to wrap up.
  - Runs no longer retry once your subscription quota is used up, and Codex tells you when its quota resets.
  - Tool arguments with broken JSON are no longer run as empty arguments, and calls to tools that don't exist suggest similar tool names.
- **Models**: Codex direct connections support GPT-6.1 Sol.
- **Computer Use 0.6.1**: turning the plugin off and on repeatedly without restarting the engine no longer piles up process exit listeners.
- Fixed example messages in theme previews showing a date in 1970.

## 2.12.1 (2026-09-30)

- Fixed conversations failing when a plugin or custom tool has an invalid definition. Invalid tools are now isolated so other tools remain available, and feedback logs identify the affected tool and its source.

## 2.12.0 (2026-09-29)

- **New: HUMAN.md, a collaboration handbook between you and your agents**. Write down how you like to work together in a readable, editable handbook with two levels: the agent level holds working preferences that apply across projects (for example, "When there is a design choice, give me two comparable options first"), and the project level holds only the goals, division of work and acceptance criteria of the current project (for example, "I do the visual review before this release"), stored in the project's `.tangu/HUMAN.md` (a HUMAN.md already in the project root or in `.forsion/` is still read). When you give clear feedback, the agent updates the handbook itself, sparingly and with immediate effect, and leaves an update card in the chat that you can view, edit, undo or expand to see the reasoning; the card is still there after you reopen the session. The "Collaboration" tab on agent details and project details lets you edit the handbook directly, read the raw text, see the file location and browse the change history (the last 40 versions, kept on this device and never written into the project repository).
- Handbook boundaries: what you say right now always takes priority; the handbook only describes how to work together and grants agents no tool permissions; saving is version-checked, so it never silently overwrites your manual edits (on a conflict your draft is kept and you review the latest version before merging); undo only applies to an update that is still the latest version; and agents that share memory do not share each other's handbooks.
- **New thinking level: Ultra**. The thinking-level slider gets an eighth notch after Max (you can also type `/think ultra`): thinking is always at its highest, context goes up to the model's limit, and the agent proactively hands work that can run in parallel to several sub-agents at once. It is available only in local work sessions; web, Chat mode, external engines and team sessions don't have it. Each time you turn it on, a dialog explains that token use can be several times the usual and offers "Also switch this session to Full access" (unchecked by default, since parallel sub-agents each wait for your approval) and "Don't show this again". Sub-agent usage also counts toward the per-run cost cap.
- **Approvals now wait in a tray above the input box, and the agent keeps working while you decide**. Pending confirmations stack above the input box: the oldest is expanded and ready to approve, the rest are listed as rows (click a row to expand it), and the tray can be collapsed; the chat itself keeps a single line such as "N actions are waiting for your approval". When an action needs your approval, the agent parks it, carries on with the steps that don't depend on it, and runs it at the next step once you approve; it only stops and waits when it has nothing else to do. The agent's questions and plan approvals use the tray too (the plan text stays in the chat, the decision buttons are in the tray). After you move to the next card, its buttons are briefly on cooldown so a double click can't approve the next item by mistake. Sub-agents, external engines, the terminal TUI, message channels and Muse still wait for each approval in turn.
- **You can keep sending commands and messages while a task is running, and they queue**. `/compact`, `/refine` and the messages sent after them wait in the area above the input box and run one after another when the current run ends (click × to remove one, ↑ to take it back into the input box); before, `/compact` during a run only showed "Compression failed". The terminal TUI and `/retry` in the desktop app queue the same way.
- **New: Computer history (macOS only, off by default)**. Turn it on in Settings → Computer history to let Forsion record what you do on this Mac: app switches, window titles, URLs, changes to the text in the focused input field, and the names of controls you click and keyboard shortcuts you press. It never records raw keystrokes or screenshots, and password managers, Keychain, secure input fields and private windows are excluded automatically. Records stay on this Mac for 7 days; you can pause, exclude apps or sites, or clear them. Today's records show as a 20-minute timeline with real app icons, and you can browse the last 7 days. Agents read them through the `read_computer_history` tool (visible only when the feature is on, and unavailable in remote sessions, message channels and teams), and Muse also looks at a summary of the last few hours. Clearing the records does not delete conversations or Muse journal entries that already quoted them. Requires Computer Use 0.6 and the macOS Accessibility permission.
- **Tangu can work in the Chrome you are already using, and there is a new Tangu for Chrome extension**. Agents can now list, read and drive the tabs you already have open in Chrome, Edge or Brave (new `browser_tabs` tool; it needs remote debugging turned on in the browser, which asks "Allow remote debugging?" once per new connection). With the extension installed (Settings → Browser has three installation steps), reading, clicking and typing happen in background tabs without taking focus or showing the debugging banner, pages Tangu opens itself go into an orange "Tangu" tab group and need no approval, and you pair only once. Clicks and typing in your own tabs still need approval, and unattended runs such as Muse and automations never touch your browser.
- **Documents work out of the box**. The desktop app now ships Python with 15 pinned libraries for office and data work (python-docx, python-pptx, openpyxl, pandas, matplotlib, reportlab and more), so agents no longer run `pip install` on the spot when handling docx, pptx, xlsx and PDF files. It also bundles a LibreOffice conversion engine, so `read_document` reads doc, docx, xls, xlsx, ppt, pptx, odt, ods and odp by converting to PDF first and parsing real pages, with no separate LibreOffice install. Git is bundled on Windows and macOS too (Linux still uses the system git), and Windows includes the VC++ runtime the engine needs.
- **Project details can now run Git actions**: create a repository, commit (it lists every change first, then writes the message with the session's model and lets you edit it), create a branch (with a prefilled prefix) and push. Settings → General → Git sets the branch prefix (default `tangu/`), commit message guidelines and whether rewriting remote history is allowed, and agents follow them when you ask them to create a branch or write a commit; agents never create a repository or commit on their own. If a repository's own configuration can run programs (filters, hooks and the like), Forsion doesn't read its Git status until you choose "Trust and continue".
- **Agents can offer to turn what they build into a creation**. Web pages and tools made in a chat used to have no way into Creations. Now an agent shows a card when it fits: "Make it a creation" creates a folder in your Creations location and moves the session there to carry on, and "Add to Creations" takes in an existing project in place without copying it (project details has "Add to Creations" too). In any Space, a creation now saves a version after each run (desktop only).
- **Generative AI right in your notes**. Select text and use "AI ▾" in the toolbar, type `/ai`, or press Space on an empty line (turn it on in Settings → Notes → Behavior) to improve writing, fix spelling and grammar, shorten, expand, summarize, translate, continue, or give a custom instruction. The result streams into a preview first and nothing is written until you confirm (and the write can be undone). The selection toolbar and the ⠿ block menu also have "Ask Tangu", which hands the selection to the side chat, and every assistant answer in a chat has "Insert into note" to put it back into a note in one step. When Tangu edits a note you have open, the changes are marked in the text and a bar at the bottom shows "Tangu changes: N" so you can review each one, revert all or keep them.
- **Links and formatting in notes, a big batch of improvements** (benchmarked against Notion and Obsidian): the backlinks panel lists each mention with its context and turns unlinked mentions into links in one click; `[[` completion puts recently used notes first and supports `#heading`, `#^block` and aliases; `#tags` render as clickable pills with completion; renaming a note on web and mobile now rewrites `[[links]]` across the whole vault; `==highlight==` and `%%comment%%` preview live, and `<kbd>`, `<sub>` and `<sup>` are editable in place; the note ⋯ menu adds full width, small text and a page font (default, serif or monospace), and you can lock a page; cursor and scroll position and fold state are remembered per note on this device.
- **Editing and canvas improvements**: in-page find supports replace, replace all, match case and regular expressions (source mode too); tables support continuous editing with Enter, Tab and Shift+Enter, and the block menu has a "Table" section; Cmd/Ctrl+D duplicates a block, Shift+↑↓ extends the selection by block, and Alt+Enter follows the link at the cursor; the status bar now counts visible text only and adds word and selection counts. On the canvas, cards, shapes, frames and connectors can have colors, dragging to the edge of the view pans automatically, and holding Space pans while Cmd/Ctrl + =/-/0 zooms. A batch of save and sync fixes for problems that could lose or overwrite content also landed.
- **Muse and background agents are easier on you**: Muse decides on its own how long to sleep based on your routine (any activity from you wakes it, and rule-triggered wake-ups and due schedule items still wake it); Muse and automations that use the cloud default background model have their own background quota, so they no longer eat into your chat quota, and when it runs out they pause by default unless you choose to continue on the main quota (requires server 2.3.21); each Muse cycle now starts a new session, so the opening context no longer snowballs from cycle to cycle and each cycle costs fewer tokens; the Muse Space previously failed to render and now does; and Spaces that agents build for themselves can read and update their own data (to-dos, schedule, Library) and render from it.
- **The Automations Space is now a node canvas**. First-run templates (daily reminder, agent briefing, notify on a new table row, one-click agent) get you started; the canvas can be dragged, panned, zoomed and auto-arranged, and each node edits a trigger or a notification / agent / database / tool step; new rules are saved paused; notification titles and bodies can insert date, time and trigger-row variables; each run has an expandable ledger with step summaries and full errors (a trial run really executes); and deleting an automation can be undone for 5 seconds instead of asking for confirmation.
- **Context ring details**: click the context ring in the input box to see a color-coded segmented bar (the striped end is the space reserved for auto-compaction), how much room is left before auto-compaction and a "Compact now" button; click the header to expand a breakdown (history, tools and this turn, system prompt, memory, project and files, skills and more). When signed in to Forsion, a "Forsion quota" section at the bottom shows today's and this week's usage as percentages, a countdown to the daily reset at 00:00 Beijing time and the weekly reset time, and turns to a warning color when 15% or less is left.
- **Images, audio and video show up directly in chat**: a paragraph in an assistant message that contains only `![[…]]` is rendered in place as an image or a media player, for both vault-relative paths and absolute paths outside the vault (local desktop sessions only; files over 50 MB fall back to a reference bar).
- **Tangu can operate your Android phone (experimental)**. After you turn on "Allow Tangu to operate this phone" in Settings → Advanced → Experimental features in the Android app (and confirm in the system dialog), Tangu can use system capabilities in conversations started on the phone, such as opening apps and maps; it asks once more before opening apps other than the browser and maps. Only tasks started on the phone itself can drive the phone, accessibility-based screen reading and tapping is not included yet, and remote drivers such as the computer, WeChat or Muse are not supported.
- **Settings has a new top-level page, "Forsion Cloud"**, so you can take care of your account without leaving the desktop app: Account (photo, nickname, linked phone and email, membership tier), Quota & points (today's and this week's quota, quota reset cards, points and top-ups, background quota, invite and redemption codes), Security (re-link, change password, sign out everywhere, delete account), Usage and Feedback. AI quota is shown only as the percentage left. These pages update with Forsion Extend.
- **Announcements are new, and automatic points deduction is retired**. When Forsion posts an important notice, a card pops up when you open the desktop app and doesn't come back once you choose "Got it" or close it; links in announcements open in your browser. Using a quota reset card now plays a quota-restored animation. "Pay with points automatically" is gone: when your AI quota runs out, points are no longer spent to keep going, and points can still be exchanged for reset cards (updates with Forsion Extend 0.7; requires server 2.3.26).
- **Computer Use**: fixed agents having no computer-use tools at all on a fresh Windows install (the bundled plugin was off by default and the helper lacked the VC++ runtime); the macOS helper is now signed with a fixed certificate so updates no longer drop its Accessibility permission, and after upgrading from an older version you need to grant Accessibility to tangu-computer-use once more in System Settings; the automatic Mini window no longer follows the cursor, now sits in the top-right corner where you can drag it, and returns to the Forsion window you started from when the run ends.
- **The first-run guide has a "Local environment" step again, and Settings has a "Local environment" page**. The guide lets you choose the official source or a mainland China mirror (recommended by time zone, system language or IP region) and checks local tools such as npm, git and docker; the page under Settings → General puts the developer tools list first and lets Tangu install what's missing. One-click install on Windows no longer hangs (install commands run non-interactively, and a download page is offered when there is no package manager).
- **A large batch of interface polish** from two rounds of UI/UX review: in Settings, the backend mode card only edits a draft and switching takes a button that states the consequences, instant toggles no longer overwrite settings you are editing, items that need a restart appear in a sticky save bar, and settings can be searched; "Restore default layout" can be undone; dates and times are formatted consistently and labels follow one wording and punctuation style; the Calendar and Creations no longer flash a skeleton on first open; in-app notifications can have a custom duration; the Inbox left column can be resized; the first day of the week in Calendar follows the language (Monday in Chinese, Sunday in English, adjustable in Calendar settings). After installing or uninstalling a plugin in the Settings window, the main window follows right away without a refresh, and a "Restart backend" button appears when one is needed.
- **The changelog now has an English edition** that follows the interface language (a version missing from the English file shows its Chinese text).
- **A NoExtend desktop installer is now available** on macOS, Windows and Linux alongside the standard installer with Forsion Extend. Both variants keep the same app identity and local data. NoExtend has its own update feed, so later updates stay on that variant.

- Permissions for Load in Forsion and desktop shortcuts now also check when the folder was created, so a folder deleted and recreated at the same path no longer inherits the earlier permission. Permissions saved by older versions lack this record and need to be confirmed once: opening such a shortcut asks you to choose Add to desktop again in Creations, and the Sandbox panel in the Coding Studio asks you to choose Load again.
- **The device page (this computer's Forsion opened from another device) is safer**. The following now only work on this computer itself: installing plugins; changing external engines, messaging channels, model providers, web search, hooks and approval rules; permanently deleting sessions or messages in a session; listing read-aloud voices; and emptying the notes trash or permanently deleting items from it. Trying them on the device page shows "This action is only available on that device itself, not over a remote connection". Archiving sessions still works.
- Tasks started from the device page run at most in the "Auto edit" approval mode by default, even when "Full auto" is selected. On the device page, approval cards can only be approved or rejected as is: the command can't be edited and "Always allow this session" isn't offered. Sessions from the device page can't use the filesystem root, the home folder or a folder holding protected configuration as their working folder.
- The host files the device page can browse are limited to the working folder, the notes vault and the project folders this computer already has; after the update, sessions whose folder was changed from the device page, and project sessions started by device-page tasks, no longer widen what can be read. A project you later open elsewhere on this computer by other means (for example from the command line) becomes browsable on the device page once you pick its folder with "Add local project" on this computer. Right after updating, the device page may briefly report that the engine isn't ready.
- Tasks started from the device page also can't create or change this computer's agents, skills, working notes, long-term memory, schedules or automations. Those changes affect every later conversation on this computer, so make them on the computer itself. Conversations driven from the device page aren't written into long-term memory by Historian either.
- On the device page, a session's approval mode can only be made stricter, not looser; a session that never had one can only be set to "Read only".
- Device-page sessions also can't use an app's own data folder as their working folder (~/Library on macOS, AppData on Windows, ~/.config on Linux and similar). Projects in cloud drives (Dropbox, OneDrive, Google Drive and others) and in iCloud Drive are unaffected.
- Agents can no longer read Forsion and Tangu configuration and secret files, including config.json, .env, MCP and model provider settings, the WeChat channel token, plugin settings, the agent browser's sign-in data and Forsion's app data folders. This applies to conversations on this computer too; reading them from the command line needs your approval.
- Shortcuts (symlinks) in an agent's private Library folder that point outside it can no longer be read.
- The local engine now uses its own local token instead of your Forsion account token.
- MCP: the server names `dev` and anything starting with `dev_` are reserved for built-in developer tools. Existing servers with those names stop loading and show an error in their status; renaming them brings them back. Error and text results from MCP tools are marked as external data before they reach the model, and images they return are treated as untrusted content.
<!-- P1-K5 -->
- **This computer's device credentials are now encrypted**. The pairing credentials behind "Allow other devices to connect" and the token for an external engine are now kept in the system keychain (macOS Keychain, Windows DPAPI, or GNOME Keyring or KWallet on Linux) instead of in plain text in a configuration file, and they no longer appear in the configuration the app's interface can read. They move over automatically the first time you start the new version.
- On macOS, after an update the system may ask for keychain access the first time Forsion reads these credentials. Choose "Always Allow". If you deny it, this computer won't switch to a new device identity and won't fall back to storing them in plain text; it only stops connecting to your other devices for now (direct LAN connections keep working). The system won't ask again while Forsion is running, so the notice offers "Restart Forsion": restart and choose "Always Allow" to recover. If the saved credentials can no longer be decrypted (for example, the keychain was reset), click "Retry", or confirm "Re-register this device" in the system dialog (your other devices will need to trust it again).
- If the token for an external engine can't be read, the external connection panel in Settings › Connection shows a notice. You can retry, restart, or enter the token again.
- On Linux without a usable system keyring (for example, no GNOME Keyring or KWallet installed), these credentials are stored as before and the device switcher shows a notice. Remote sessions can't be turned on in this state.
- What encryption covers: the Windows and Linux keychains aren't isolated per app, so other programs running as the same user may still read them. It protects against the credentials being read straight from a configuration file or carried off in a backup or sync copy.
- If you go back to an older version of Forsion, this computer registers again as a new device and your other devices need to confirm it again. You'll also need to re-enter the token for an external engine.
- The LAN pairing prompt, the repeated-crash dialog, the download-complete notification and the titles of system file pickers now follow the interface language. They used to always be in Chinese.
<!-- /P1-K5 -->

<!-- P1-K1 -->
- **Approval cards now say which device a request came from**. When a task started from another device (a phone or the device page) asks for approval, the card shows its source under the title: a device registered to your account and recognized by the server appears as "From a remote session · device name" (the name it was registered with; renaming it later doesn't change this. If that name has only invisible characters, it shows "a registered device"); clients that can't be tied to a specific device, such as the device page in a browser or the web app, appear as "an unidentified client on your account", and LAN-paired devices and peer-to-peer connections are labeled too. Tasks started on this computer show nothing extra. Recognizing specific devices requires server 2.3.24.
- The device switcher no longer lists phones. A phone only drives your computers and doesn't accept connections, so it used to show up as a device that was always "offline".

<!-- P1-K10a -->
- The session workspace (the files panel, attachments you send and artifacts you download, including when you use this computer remotely from the device page or your phone) only reads and writes files inside the workspace: shortcuts (symlinks) that point outside it are never listed, downloaded or written through, even when the whole session folder has been replaced by one, and a named pipe in the workspace no longer makes requests hang. Workspaces synced to the cloud skip such shortcuts too when pulling attachments and sending artifacts back.

<!-- P1-K4 -->
- **New "Allow remote sessions" switch**, in Settings › Remote sessions and under "Allow other devices to connect" in the device switcher. When it's off, other devices (a phone, another computer, the device page in a browser) can still view sessions, answer approvals and stop tasks, but can't start or continue sessions on this computer, upload attachments, or hand a Muse to-do over to Muse; turning it off doesn't stop tasks that are already running. Until now, having "Allow other devices to connect" on was enough for other devices to start tasks here; from this update they need this switch too.
- If "Allow other devices to connect" was on when you updated, "Allow remote sessions" is turned on as well and "This account's browsers and web app" is marked as allowed in advance, so the device page keeps working. To tighten this, revoke it in Settings › Remote sessions › Allowed devices: browsers, the web app and P2P connections can then only view, answer approvals and stop tasks, and this computer won't ask again until you choose Allow in the same place. (If you weren't signed in to Forsion when you updated, you'll confirm it once on this computer the first time the device page in a browser starts a task.) On new installs, and if you never turned on connecting, it's off by default.
- **The first time another device asks to run sessions on this computer, this computer asks you to confirm**, showing the name the device was registered with, its type and its registration date. Devices that aren't in your account's device list are refused without a prompt. Device pages opened in a browser, the Forsion web app and older app versions can't be told apart, so they share one entry, "This account's browsers and web app", which is confirmed once the first time it asks. P2P connections from the device switcher use this entry too, but they never ask: to let a P2P connection run sessions, allow this entry in Settings › Remote sessions on this computer (or open the computer once through Relay). After you decline, you won't be asked again for 10 minutes; if no one answers a prompt within 2 minutes, it won't come back for a minute. Every allowed device is listed in Settings and can be revoked at any time. When a request is refused, the device page now says why (declined, revoked, that computer isn't signed in, the device isn't in your account, too many pending requests and so on) instead of always saying it's waiting for confirmation.
- **New "Highest approval mode for remote sessions"** (Readonly, Auto edit or Full auto; Auto edit by default). Sessions started from other devices, including the device page, never go above it, and it can only be changed on this computer. Choosing Full auto requires ticking "I understand the risk" and confirming: commands in remote sessions are then no longer checked one by one, and approvals are no longer guaranteed to come from a person.
- This switch only covers Agent sessions: while "Allow other devices to connect" is on, paired devices and devices signed in to the same account can still browse files in this computer's working folders and read and write the vault from the device page, as before.
- Remote sessions can't be turned on while the device credentials aren't stored encrypted (for example, on Linux without a usable system keyring). Clearing desktop data also resets the remote session switch and the allowed devices.
<!-- /P1-K4 -->

<!-- P1-K3 -->
- **This computer now shows a system notification when a remote session needs your approval**. When a task running here from your phone or the device page needs an approval or an answer, you get a notification such as "Remote session from Pixel 9 needs your approval" even if the Forsion window is closed. It only names the session and the tool, never the command itself, and has no "Approve" button: click it to open the session and decide there. New requests in the same session within 30 seconds are grouped into one notification, and the notification is withdrawn once the request is handled elsewhere. Tasks started on this computer are still only shown in the window.
- **If nobody responds within a minute, your phone's inbox gets a reminder**. When a remote session's request has been waiting on this computer for a minute, your account receives an inbox message "An agent is waiting for you" (it only contains the computer's name and the number of items, no session content). Open the inbox on your phone to see which computer is waiting and how many items there are. Opening that session straight from the message comes in a later release, once your phone can open sessions that live on your computer; until then, "Open session" in the message only works for sessions your phone already lists. There is at most one reminder per session every 10 minutes, and reminders are archived after 24 hours. While the phone app is in the background or closed, the reminder doesn't pop up on its own; you'll see it the next time you open the app (real push notifications come in a later release). Requires server 2.3.24.
- **The session list shows a "waiting for you" dot**: sessions with an approval or a question waiting for you get a small warning-colored dot on the corner of their icon (it takes priority over "running" and "unread"), and hovering shows how many. It also lights up for sessions you haven't opened and sessions started from another device.
- **Actions that touch protected configuration can only be approved on the computer running them**. Actions that would change Forsion's local configuration or credentials can now only be rejected from a phone, the device page or a messaging channel, not approved (they could be before); the approval card explains why. You can still approve them on this computer. In a messaging channel (such as WeChat) you're told right away to approve it on the computer, and once you do, the task's result is still sent back to that chat.
- Messages with an expiry date in the phone inbox are now archived automatically once they expire, the same as on desktop, and the inbox is refreshed as soon as you return to the app.
<!-- /P1-K3 -->

<!-- P1-K2 -->
- **New emergency stop**. Press ⌃⌥⇧. (Ctrl+Alt+Shift+. on Windows and Linux), choose "Stop all remote tasks" in the menu bar icon, or click "Emergency stop" in Settings › Remote sessions to immediately end every task on this computer that you didn't start at the keyboard: remote sessions from your phone, the device page or other computers, tasks from messaging channels such as WeChat, and Muse and automations. Background processes they started are ended too, and to-dos you handed to Muse from your phone that haven't been finished go back to pending. Conversations you started on this computer are not affected. It works offline as well, and a notification tells you what was stopped.
- **After an emergency stop, remote access stays locked, even across restarts**. While locked, other devices can only view sessions and stop tasks. They can't start, continue, approve or change anything, pair new devices or open direct connections, and your phone and the device page say "Remote access to that computer is locked. Unlock it on the computer itself". Muse, watch rules and Agent schedules on this computer pause too; anything that came due runs after you unlock. You can only unlock on this computer. Choose "Unlock…" in the menu bar or in Settings and verify it's you. Macs with Touch ID use Touch ID. Without Touch ID, administrator accounts enter the login password, and standard accounts, Windows and Linux confirm in a dialog. Clearing desktop data doesn't remove the lock.
- **The menu bar shows remote sessions**. While a remote session runs on this computer, the menu bar icon shows "Remote" and the menu says "Remote session running · device name" (and notes when an approval is waiting for you); while locked it shows "Locked". A notification appears when a new device starts a remote session (at most once every 10 minutes per device).
- You can change or turn off the emergency stop shortcut in Settings › Remote sessions (pressing the current shortcut while recording a new one doesn't trigger an emergency stop). If another app has taken the shortcut, both the menu bar and Settings say "Emergency stop shortcut unavailable", and you can still stop from the menu bar.
- While a remote task is running, this computer won't go to sleep when idle, regardless of the "Stay awake while sessions run" setting (closing the lid still puts it to sleep).
<!-- /P1-K2 -->

<!-- P1-K6 -->
- **On your phone, you can now choose to run Tangu on one of your computers** (that computer needs "Allow other devices to connect" turned on). New chats then run in that computer's real folders (in its default workspace unless you pick another), and the Agents and models offered for new chats are that computer's. Approvals, progress and artifacts come back to the phone through the Forsion cloud. Settings, the inbox and automations stay on the phone. Your choice is remembered the next time you open the app.
- Each conversation stays on the computer it was started on. Switching where to run later only affects new conversations: messages, approvals, stopping and files for existing ones still go to their original computer, including after you reopen the app. Conversations on different computers can run at the same time, and one computer going offline doesn't affect the others.
- When that computer is offline, its Forsion engine isn't running, it rejects the connection, or it can't confirm this device, a notice above the input box says which one. A task that was running while the connection dropped isn't marked as failed, and it picks up where it left off once the computer is back. The phone reconnects on its own when the connection returns, with no need to retry. For problems that aren't retried automatically, such as this device not being recognized or its credentials being rejected, the notice has a Retry button. If that computer refuses only one action (for example, it's still waiting for you to allow this device there), only that action fails, and viewing sessions and receiving new messages keep working.
- While running on another computer, approvals can only be approved or rejected as is, and hard-deleting sessions, rewinding messages, restoring code checkpoints and external engines aren't available. Image thumbnails load through the relay, and attachments are limited to about 9 MB per send.
<!-- /P1-K6 -->

<!-- P1-K8 -->
<!-- Integration note: actually switching to the picked computer is wired by K6-S2 (setFocusTarget, via UnitsSheet's selectRunLocation, a no-op today); until then picking a computer only registers the phone, asks for trust and probes the engine. -->
- **Choose where to run in the Android app**. The devices sheet at the bottom of the left drawer now has three parts: "Run on" lists Forsion cloud and every computer on your account, with whether each can be used right now (available, engine not running, offline, waiting for that computer to allow this phone, declined, remote sessions turned off, and so on); "Open device screen" moves into a second, collapsible part and works as before; "This phone" shows this phone's registration. Phones no longer appear in the list.
- The first time you pick a computer, the app registers this phone as a device on your account and asks that computer to allow it. The prompt appears on the computer, and the phone shows "Allow this phone on "computer"" for up to two minutes. Registration only happens the first time you pick a computer, so the feature adds no device if you never use it. You can remove the registration under "This phone"; computers stop trusting this phone after that. Removing it switches back to Forsion cloud first, and the phone isn't registered again in the background; that only happens the next time you pick a computer.
- The phone's device identity is kept in storage encrypted by the Android Keystore. It never passes through the web layer, is never logged, and is left out of system backups and device transfers. Each Forsion account gets its own identity. After reinstalling the app or clearing its data, the phone registers again with a new identity and has to be allowed on your computers again.
- Requests to your computer get this phone's identity attached by the app at the system level, so the computer knows which phone is acting. If the identity can't be obtained, the request is not sent. A lost connection or a temporary server error is treated as offline and picks up again once it recovers, an expired sign-in asks you to sign in again, and an outright refusal shows "This phone couldn't verify its identity". With an older server the app shows "The server is too old to run from a phone" and doesn't add this phone to your device list. Reloading the app also closes any open connections to your computers.

<!-- P1-K10b -->
- When you use this computer remotely from the device page or your phone, reading the background agent settings now only returns whether Historian and Muse are on and how often they run. Historian's custom and default prompts, the folders Muse may read, the models both use, Muse's active hours and token budgets, and notification and escalation settings are no longer sent to the remote side. This does not cover Muse's permission level, heartbeat interval or persona, which the remote side can still read (the device page's Muse page shows the permission level). On the device page, Settings › Agents › Background agents is now read-only and says these can only be set up on this computer (it used to show every setting, but changes could not be saved).
- Read-only git commands such as `git status` now ask for approval when the workspace contains a planted, fake git directory. Before, an agent could use such a directory to run commands as you without any approval, and a remote session could use it to raise its own approval limit. Read-only git commands still run without approval in normal repositories, git worktrees, submodules and folders that are not in any repository.
<!-- /P1-K10b -->

<!-- P1-KF -->
- **System notifications, prompts and the tray menu now use the app's language**. When the app picked Chinese from your system language or region without you choosing a language in Settings, remote session approval notifications, the "Remote session request" prompt and the tray menu could still show up in English (and the other way round). Before the Forsion window opens, for example in the tray menu right after launch, the last app language is used.
- In the phone's "Run on" list, cases where that computer won't show a prompt at all (it isn't signed in to Forsion, it can't find this phone in its account, too many requests are waiting, nobody answered the last prompt, and so on) now say why right away, instead of showing "Allow this phone on "computer"" and waiting for two minutes. Only a computer that chose Don't allow shows "You can ask again in 10 minutes". If the prompt on the computer closes without an answer, the phone stops waiting and asks you to tap again. If a computer couldn't be reached earlier, tapping it again shows its current answer instead of staying on "Can't reach it right now". When the prompt on the computer times out, the phone says nobody answered instead of still asking you to allow it there.
- When that computer refuses something while you run tasks on it from your phone or use its device page, the message also gives the actual reason instead of always saying it's waiting for that computer to allow this.
<!-- /P1-KF -->

<!-- P1-M1 -->
- **Agents on your computer can now find files you attach from your phone (or the device page)**. The file already reached that computer, but in sessions that run in a folder on the computer the agent didn't know where it was and had to search the whole disk. Now the file's location on that computer is handed to the agent with your message, just like a file dragged in on the computer, and the agent reads it from there. When you reopen the session, a file tag for it shows at the start of the message. Small files picked with "Add › File" in sessions that run in a folder on the computer work the same way. If a file uploads from your phone but the message itself isn't sent, the file isn't attached to the next message you send on the computer.
- Conversations run on this computer from your phone or the device page no longer flow automatically into background agents and other conversations on this computer: the recent session titles, daily log summary and activity that Muse sees leave them out, and the related past excerpts that local conversations attach automatically no longer come from them (you can still find them when you ask an agent to search your history in a local conversation). Remote conversations also no longer write to an agent's daily log (neither Historian nor the agent itself), in line with them not writing long-term memory. A conversation from this computer that you continued or renamed on your phone is treated the same way: when you carry on with it on the computer, Historian no longer writes daily log entries, long-term memory or working-note suggestions from it (titles and summaries still update). A note you add when rejecting a background agent's pending action on your phone is no longer written to that agent's daily log.
- When you use this computer remotely from the device page or your phone, the agent list you get no longer includes each agent's persona and developer instructions (both fields are empty when you open an agent's profile on the device page; agents could already only be changed on that computer), and the approval mode shown is the one that actually applies to remote tasks. The Muse status you get no longer includes local folder paths, the run budget or error details.
<!-- /P1-M1 -->

<!-- P1-M1 -->
- **See and download a remote session's files on your phone**. After you switch Tangu on your phone to one of your computers, the Workspace panel on the right starts with a "Session files" group that lists the attachments and outputs this session has on that computer, including attachments you sent from the phone, each with a download button. That computer's project folders are still listed below it. Files here can't be deleted while you run on another computer.
- **The download button in the Android app now actually saves the file**: it goes to the phone's Downloads folder, and a message shows the name it was saved under (files with the same name are numbered automatically). Before, tapping it did nothing. The phone can save up to 50 MB at a time and tells you when a file is larger; this requires Android 10 or later.
- **Your phone now shows where an approval was answered**. When a task started from your phone is approved or rejected directly on the computer, the outcome line in the phone's chat reads "Approved on the host computer (computer name)" or "Rejected …"; approvals answered on another device show that device's name, and the ones you answered on this phone aren't labeled. Collapsed approval cards also show the computer name, and connection notices use the computer's name instead of "your computer".
- While your phone waits for a computer to allow it, the "This phone" row already shows its registered name instead of "Not registered yet".
- After the connection to a computer drops and reconnects, replies that were already shown are no longer occasionally shown a second time.
<!-- /P1-M1 -->

<!-- P1-K7a -->
- **See your computers' sessions in the phone sidebar**. Below the session list in the left drawer, each computer on your account now has its own section. Each lists that computer's recent sessions (including ones started on the computer itself) and shows its current state: online, offline, agent engine starting, engine not running, remote sessions turned off, waiting for that computer to allow this phone, and so on, each shown differently. An offline computer shows only its name and state, and its sessions come back once it's online again. Tap a session to open it on the phone and carry on; approvals, stopping and files go to that computer, and they keep going there after you switch new sessions to the cloud or another computer. These sessions are fetched live while the app is open and aren't stored on the phone. From the phone you can rename and archive them but not delete them for good. Until the phone has picked a computer once (so it isn't registered yet), each section only shows the computer's state; sessions appear after that.
- **New chats show where they will run** (in Chat mode too), right above the input box: the cloud or a computer, plus that computer's current state. Tap it to open the "Run on" sheet. The place you pick is remembered: new chats go back to that computer by default only while it's online and available, and use the cloud otherwise. Sessions created on a computer no longer carry the phone's notes vault path, cloud project name, external engine, or image and vision model settings.
- "Open session" in the inbox reminder about an agent waiting for you now opens that session directly, without first switching the phone to that computer.
- When a computer refuses to create a session (for example, remote sessions are turned off there), the message now says why instead of only saying the session couldn't be created.
- **With "Allow other devices to connect" on, the desktop app now reports its agent engine state (running, starting, not running) to your account**, so the phone can tell "the computer is online but its engine isn't up" from "ready to use". The desktop main window, the web app and the device page don't show these sections or the "Run on" pill.
<!-- /P1-K7a -->

<!-- P1-G5 -->
- **On a Mac, commands approved in a remote session can no longer change this computer's Forsion settings**. When a task started from your phone or the device page runs commands on this Mac (`run_bash` and background processes), they run inside a system write protection. They can't write Forsion settings and sign-in data (including the highest approval mode for remote sessions, the allowed devices list and the emergency stop state), agent configuration, skills, plugins and hooks, `.tangu` folders in projects, shell startup files such as `~/.zshrc`, dotfiles in your home folder such as `~/.gitconfig`, `~/.config` or `~/Library/LaunchAgents`, and neither can any program the command starts. The workspace, agents' Library folders and cache folders such as `~/.npm` stay writable. Before, with the host sandbox off (the default), a command you approved on your phone could rewrite these files directly, for example to raise the remote session's own approval limit, and the command itself (`python3 fix.py`, or `npm install` with an install script) may not have made that obvious. Tasks started on this computer are not affected, and with the host sandbox on, its own sandbox applies as before.
- In remote sessions, tools that set up their own sandbox (such as `swift build` or `swift package`) can't start it inside this write protection and fail; the tool result suggests adding `--disable-sandbox` or running them on this computer. If the system's write protection isn't available, commands from remote sessions are not run and the reason is shown; they never run unprotected. Background processes started on the computer without this protection no longer accept input from a remote session. Each remote command takes about 9 ms longer to start.
- Forsion now reads a project's Git status (the Git status attached when a task starts, and the project details panel) inside this write protection no matter where the task was started, and so do Git commands an agent may run without approval (such as `git status`). A Git filter or similar program a remote command left in the repository still runs, but can't change the files above; if the protection isn't available, Forsion skips these Git reads and such commands need approval. On every platform, `git status` and similar commands need approval when the repository's own configuration sets up programs Git would run (filters, Git LFS extensions, fsmonitor, hooks, external diff and the like). On Linux and Windows, Forsion no longer reads the Git status of a repository that configures a filter or a Git LFS extension, and the project details panel shows no Git information for it.
- **Linux and Windows don't have this protection**: a command you approve on your phone can change Forsion settings on this computer, including the highest approval mode for remote sessions, and the command may not make that obvious. Settings › Remote sessions now says so. On Linux, setting "Local command and file sandbox" to "Workspace writes only" prevents it; Windows doesn't have such a sandbox yet, so only approve commands you understand.
<!-- /P1-G5 -->

## 2.11.4 (2026-09-23)

- **New "PROJECT details"**. In the Tangu Space, when the current session belongs to a local project folder (including the Tangu default folder, but not the vault), the details panel on the right turns into a project page, just like TEAM details: "Agents" lists the agents and teams that have worked in this project, and you can start a new session with any of them or set one as the project default; "Git" shows the branch, how far it is ahead of / behind upstream, changes and recent commits, and opens the project in a terminal with one click.
- Under "Configuration" on the project page, you can edit the project instruction file AGENTS.md (create `.tangu/AGENTS.md` with one click if it doesn't exist, or let Tangu read the project and generate it for you), manage project skills, view approved plans, and set the project's default agent or team, model, thinking effort and approval mode. These defaults stay on this device and are never written into the project repository; they are applied automatically when you start a new session in this project.
- **New side chat (/btw)**: ask a quick side question with the current session's context. The answer appears in a floating panel that follows the session and is never written into the main conversation, and you can ask even while the main task is running. Type `/btw`, click "Ask aside" in the text-selection toolbar, or press ⌘; (Ctrl+; on Windows) to open it; if an answer is useful, click "Quote in chat" to attach it to the main conversation's input box without overwriting the draft you're writing. Side chat counts toward your quota too; the web and mobile apps require a server update.
- **Shell code blocks in chat can now be run directly**. bash / sh / zsh code blocks get a "Run" button that opens a new terminal in the bottom panel to execute them (commands that ask for a password still take input as usual); when it finishes, the output and exit code are sent back to the session automatically and the agent picks up from there. Note that the output is sent to the model as-is. Shell code blocks in notes can be run too, but their output isn't sent back. Desktop only.
- **Databases now have record bodies and page previews**. Each record can hold a body of text: click the open button in the first column to view and edit it in a side, centered or full-page preview, with previous / next navigation, and the open mode is remembered per view. Also new: list view, view duplication and search across properties. Databases that contain record bodies can no longer be edited by older versions of Forsion, so update all your devices together.
- **Smoother database editing and a more consistent interface**: cells support typing directly, arrow-key navigation, continuous editing with Enter / Tab / Shift+Tab, and Esc to cancel, and confirming a candidate in a Chinese input method no longer submits by mistake; single-select / multi-select menus can be searched, navigated with the keyboard, and used to create new options; editing a database embedded in a note no longer exposes its Markdown source. Font sizes, selection outlines and icons across the grid, menus, toolbars and record pages now follow one system; auto-fit, grouping and row folding move into the "Layout" section of view settings, and the cover picker has been reorganized.
- **Global skill library**. The long skill list in Settings becomes a "Global skills" library: grouped by source and searchable, it lets you read SKILL.md and its bundled files, and supports creating, importing from a folder, duplicating, editing, disabling and deleting skills (deletions keep a backup); skills that ship with the app are read-only, but you can duplicate one and edit the copy. Skill details now render their body as Markdown, and code blocks there have only a copy button, no "Run" button.
- **Agent management moves into the Agents Space**. Creating agents, setting the default, reordering and deleting all happen in the Agents Space, and the roster is now a collapsible, resizable left sidebar; each agent's skill panel separates its own skills from inherited ones, with Auto, Custom or Off modes, and you can disable a specific skill for a single agent. Settings for background agents (Historian / Muse) now take effect only after you click "Save", and your input is kept if saving fails.
- **Agents can borrow each other's skills**. Coding's web-building skill can now be borrowed on demand by other agents (for example, to build a web page in the Tangu Space), and agents also know which teammates they can hand work to or discuss things with. Lent skills carry a "Shared" tag in the list; for your own agents, add `shared: true` to a skill's SKILL.md to share it.
- **Redesigned onboarding**: instead of carrying over settings one by one, it now comes down to a few key choices — connecting services, default model, appearance, working directory and optional device permissions — with entry points to everything else on the finish page. The default model picker is grouped and searchable just like the chat box's model menu, and you get a live preview while picking a style, color scheme and font for the appearance.
- **A more compact, consistent interface throughout**: font sizes, corner radii and spacing everywhere follow a single hierarchy, and menus and popovers use lighter, closer shadows and open with a subtle fade-and-expand. The raised / flat toggle in "Appearance" stays, with raised as the default.
- **Support for GPT-6 Sol / Luna and Claude Opus 5.5**. Signing in with a Codex subscription now lets you see and pick GPT-6 Sol / Luna, and thinking effort is sent at the levels each model actually supports (Sol / Luna can turn thinking off); when you connect Claude Opus 5.5 with your own API key, thinking is always on, choosing "Thinking off" no longer errors, and thinking summaries are visible between tool calls.
- **Context window capped at 272k by default**. Models with a 1M context now use only up to 272k by default; when you need a longer context, switch "Context limit" in the chat box's model menu to the maximum (applies to all sessions with that model; adjustable on desktop only). If you had set a low auto-compaction threshold, compaction will kick in earlier accordingly.
- **Feedback replies now arrive in your Inbox**. After you submit feedback, each reply is delivered to your Inbox as a message; open it to see the full exchange for that feedback and all its replies, and reply directly, with images, text or JSON files attached. Desktop only; requires a server update.
- Agents no longer stuff work logs into long-term memory: a single memory over 300 characters is rejected with a hint to record it in the work log instead, updating an old entry edits it in place rather than appending one "correction" after another, and Dream memory consolidation no longer keeps failing when there are many memories. Long entries already saved are not shortened automatically; you can trim them manually in the memory panel.
- Session titles arrive faster: within seconds of sending a message, the session is titled from what you said, without waiting for the reply to finish; titles you've changed manually are never overwritten.
- For your own agents, you can rename the folder directly in the header of the details page, and references in related sessions, teams and channels are updated along with it; built-in agents, agents synced to the cloud, agents provided by plugins, and agents that are currently running can't be renamed.
- The mode menu no longer lists every agent in one long row: switching agents now lives in a "Current agent ›" submenu to the right of "Standard mode". The old "Group chat mode" entry has been renamed "Team mode" everywhere, with its description updated to reflect how parallel work happens now.
- Opening skill details from a sidebar such as Tangu details now temporarily covers the current content and offers a "Back" button, and your scroll position and drafts are still there when you return; in the main area it opens in a temporary tab alongside.
- When the chat column is very narrow, the input card switches to a compact style (shorter placeholder, icon-only stop button); in short conversations the last message sits close to the input card instead of across a big empty gap.
- After a reset card is used successfully, a quota restore animation plays: the card lights up, today's and this week's quota refill in turn to their actual values, and the number of remaining cards is shown.
- Images that sit on their own line in a note can be dragged directly, with no need to find the ⠿ handle; a single click still selects the image.
- When you ask Tangu to "Merge conflicts" and a conflict copy is only a subset of the original with no unique content, it now deletes the copy directly (canvas and table notes included) instead of leaving you to delete it by hand. Sync also no longer creates a conflict copy when another device rewrites the same content verbatim.
- Themes: the built-in design language "Zhi" is retired, and anyone using it moves back to Genesis; the color scheme of the same name is now called "Clear blue". Theme cards and Glass settings now have full English text, and agent portraits with hard-to-read text under some color schemes have been fixed.
- Fixed: in direct chats with an agent, the approval mode / thinking effort shown in the input box didn't match what was actually in effect (for example, showing "Approve for me" while actually asking every time per the agent's "Read-only" setting). The input box now shows the mode actually in effect, and `/status` notes whether the approval mode comes from the session, the agent or the default.
- Fixed: when dragging blocks in columns, blocks couldn't be dropped into a shorter column, the indicator line lingered after release, horizontal and vertical lines appeared at the same time, ⠿ couldn't drag after an image was selected, and handles of right-column blocks were out of reach. Blocks now land exactly where the indicator line is drawn, and releasing with no indicator line doesn't move anything.
- Fixed: dragging a block or file above or below a divider did nothing or landed one position off; dragging into a collapsed section made the block "disappear" on the spot, and that section now expands automatically. After selecting a block with ⠿, pasting or uploading a file inserts it after that block instead of at the end of the document.
- Fixed: after opening a note from the file tree in the left sidebar, the tree highlight, status bar word count and outline stayed on the note shown at startup; on first entering Note Space, the tree highlighted a note that wasn't actually open; closing the current editor made the highlight jump back to the start page. The sidebar chat not automatically referencing the current note in the main area is fixed as well.
- Fixed: with smooth caret on, pressing Backspace at the start of the lower of two empty lines left the caret stuck in place.
- Fixed: when selecting text near the left edge of a narrow sidebar, the selection toolbar was partly cut off.

## 2.11.3 (2026-09-21)

- **New "Creations" Space**. What you build in the Coding Space now has a home: web apps and Forsion plugins are listed here. Click to open one, or run it in a separate window, go back to the Coding Space to keep editing, rename it or move it to the trash. Work already published online carries a "Published" badge. If you don't need it, you can turn it off in "Settings → Plugins".
- **Add creations to your desktop**. Choose "Add to desktop" in Creations to put an icon on your desktop; double-click it to bring up Forsion and open that creation in its own window (installed version only). The desktop icon keeps working even if you rename or move the project folder.
- **Web creations' local data no longer resets on restart**. Previously, the preview address changed every time Forsion started, so data a creation stored in the browser (localStorage, IndexedDB) was lost. Each creation now has a fixed address, and previewing it in the Coding Space and opening it from Creations use the same data.
- **You can now build Forsion plugins in the Coding Space**. New projects get a "Forsion plugin" starting point, and plugin projects get a **Sandbox** panel in the bottom toolbar: click "Load in Forsion" to install the plugin straight from the project folder into the running Forsion, with automatic reload on save; `setup` errors, view mount errors and the plugin's own console output are collected in the panel and can be sent back to the chat with one click so Coding can keep fixing. Note that this is a "development load", not an isolated environment: the plugin runs in the real app against your real vault, with the same permissions as installed plugins; plugins that declare custom file types need to be installed before testing.
- **Coding Studio version history now uses git** (requires git on your machine). After each conversation turn, if the project has changes, Forsion saves a version automatically, named after what you said in that turn; you can also save a named version manually at any time. Before restoring an older version, the current state is saved as a backup first, so a restore can itself be undone. Without git, the "Versions" panel prompts you to install it; previously saved snapshots can still be found and restored at the bottom of the panel. If the project is already your own git repository, Forsion only shows its history and never modifies it.
- Coding now knows how to handle plugin projects: it reads the Forsion plugin development skill first and guides you to load and debug with the Sandbox panel.
- **With "Full access" selected in a team session, members no longer ask for approval every time**. Previously, team members kept the approval mode from their own settings (such as "Auto edit"), or the mode in effect when the team started working, so even after switching to Full access, members running commands or writing files still asked you for approval again and again, and file writes were often flagged as "Write outside workspace". Members now always follow the approval mode currently selected for the team session.
- **Switching the approval mode takes effect immediately**. After you switch modes in the input area, a running task follows the new mode from its next action, without waiting for the turn to end; switching in a team session applies to all members at once.
- **In a team member's sub-chat, the approval mode shown and changed is the team's**, with a title stating that "changes apply to the whole team" (previously it showed the member's own setting, which had no effect).
- **An approval mode that failed to save is now reported honestly**: for example, if the engine is temporarily unreachable, the input area falls back to the mode actually in effect and lets you know, instead of showing an unsaved mode while tools still run without approval.
- **Session settings are now saved per item**: changing thinking effort, plan mode, approval mode and so on in different windows no longer writes settings just changed elsewhere back to old values.
- **Installing GitHub-hosted plugins from the Market is more reliable**: downloads try a direct connection and several proxy mirrors in turn (mirrors first when "Use China mainland mirrors" is on), and each address has a timeout so it no longer spins forever; the install button shows connection / download progress, and failures explain the reason right in the Market along with network suggestions.
- **Action results in Settings and Feedback are now visible**: the success or failure of actions such as uninstalling a plugin / Space or rescanning plugins shows at the top of the panel instead of passing silently; "Send test notification" pops up a real notification card in the main window.
- "Reset layout", "Uninstall Space" and "Diagnose in chat" run from the Settings / Feedback windows now act on the main window (previously they only changed the Settings window itself); achievement unlock pop-ups triggered in Settings also play in the main window. Command buttons in plugin details are now offered only in the main window's ⌘K.
- **The backend no longer spawns a pile of engine processes when the engine exits during startup**. Previously, if the engine silently exited before becoming ready, the desktop would stack two restarts at once, leaving multiple orphan processes and ending up showing only "Crashed"; it now retries along a single chain, and won't relaunch the engine while quitting, clearing data or installing an update. The engine writes to the backend log which startup phase it stopped at, visible in feedback exports.
- **With Docker installed but not running, startup no longer prints two warnings with stack traces**. This check is no longer printed when the sandbox isn't using Docker; when a Docker sandbox is in use, it reports a single line with the reason it can't connect.
- Agents that share the default memory are no longer asked for approval every time as "Write outside workspace" when writing material to their own Library.
- The timeline in feedback exports now includes the reason for each approval and the mode in effect at the time, making "why is it asking me again" easier to investigate.
- In the English interface, failure reasons for cloud sync and for uninstalling Spaces / plugins no longer show the original Chinese text.
- Fixed: the line-number column of code diffs in approval cards overflowed the card and covered the "Approve" button, making it unclickable.

## 2.11.2 (2026-09-21)

- **New built-in "Image Studio"**: create an Image Studio from the main interface to generate, edit and organize images. It supports text-to-image and reference-image editing, cropping, rotating and flipping, color adjustment, layers and blending, transparent backgrounds, scene extension, and exporting the whole board. The canvas has a full context menu ("Download image" / "Download original" / "Export selection" / "Add to chat" / "Layer order" / "Lock" / "Delete"); downloaded images include your current edits, while "Download original" keeps the original file.
- **Image generation now lets you pick a rendering quality**, and sizes no longer come out wrong. The quality level (low / medium / high, with higher levels on some models) is passed all the way from the interface to the model; ratios such as 16:9 are converted using the size table each model family actually supports, so you no longer get cropped images like 1024×576. New image models from Seedream and Qwen are supported.
- **Image generation is billed per image**. When a single request asks for multiple images, pricing follows the number of images actually produced (previously only one request's worth was charged); different quality levels can have different prices. Requires server 2.3.15.
- **Early warnings when your quota is running low**. The top of the Chat View warns in three steps at 15% / 10% / 5% remaining, based on whichever of today's or this week's quota is tighter, with a separate notice when it runs out, plus "Upgrade membership" and "Use a reset card" entry points; you can dismiss the current level, and it reappears when you reach the next, tighter one. The notice disappears as soon as quota is restored. Requires server 2.3.15.
- **A dot-matrix wave animation while generating images**: the `generate_image` row in progress is no longer a plain tool audit card but a full dot-matrix wave that follows the theme colors; click it to play Snake (arrow keys / WASD / touch swipes, you can wrap through the left and right walls, click again to exit). With the system's "Reduce motion" on, it falls back to a static dot matrix. Only the running row is replaced; other tools running in parallel display as usual.
- **Changing theme / font / zoom / smooth caret / interface language in Settings now updates other windows immediately**. Settings has been a separate window since 2.11.1, and until now these changes only applied to the Settings window itself.
- **Plugin setup guides are now checklists that can actually be verified**. Previously, almost every plugin popped up a card after installation, mostly restating its instructions, and clicking "Finish setup" merely closed the card. Now only plugins that genuinely need setup before they can work show a card (for example, a countdown with no date set, calls with no server configured, or computer use without macOS permission); the card lists "what's still missing" item by item for you to fill in on the spot, and the host actually checks whether each requirement is met. Other plugins' instructions move to "How to use" on the plugin's details page, with nothing left out.
- **Databases get "Row folding"**. The table view toolbar gains "Row folding": check the fold keys (only rows with the same values in these columns fold together), and optionally choose a time column and time window (in minutes, default 30, aligned to your local clock); rows within the same window collapse into a single **summary row**: numbers are summed, columns with more than one distinct value list the values they contain and their counts, and dates show "earliest – latest"; click a summary row to expand it back into individual rows. Sorting applies to the summary values; it can be combined with property grouping (folding within groups) and has no effect in hierarchy view. It only changes presentation, not data, and the configuration is saved with the view. Plugin tables can use it too via `TableSpec.fold` (`ctx.table.caps.fold`).
- **The auto-compaction threshold for long conversations is now adjustable** (Settings → Models). With a 1M context window, the default trigger was so high that compaction almost never happened; you can now set a percentage at which compaction starts. The context progress bar updates as soon as compaction finishes, without sending another message.
- **Teams no longer say the same thing twice**. Repeated speech by a member within the same activation is blocked; a Chinese sentence ending in `。DONE` is correctly recognized as finished; and when there's nothing new, the next member is no longer woken up for nothing.
- **Diagnostic attachments in the Feedback panel can be exported to a local file**: click "Export log file" before submitting to keep a copy yourself, and attachments in the admin Feedback Center have their download button back (requires server 2.3.15).
- **Settings and Feedback panels now attach to the session you're viewing**: exporting session logs from "Advanced › UI & sessions" no longer exports the first session in the list.
- **Agent Desk supports a 3D companion avatar** (with the Live3D plugin); avatars are bound per agent with an adjustable idle pose, and the companion is captured when an agent takes a screenshot.
- **Live island on Android**: while a session is running, progress shows in the status bar / live island, and it tucks away automatically when done.
- The three command palette entries in Developer options (mobile UI preview, live activity log view, foreground window sampling) now appear in ⌘K as soon as you turn them on, without restarting the app.
- Fixed: the Node bundled in the Windows installer didn't include npm, making external engines (codex) sit idle for 30 seconds at startup.
- Fixed: the "Paste as" menu occasionally flew to the top-left corner of the window.
- Fixed: malformed requests are no longer reported as server errors (requires server 2.3.15).

## 2.11.1 (2026-09-19)

- **Cloud sync per-file limit now scales with your membership tier**: Free 5 MB, Plus 10 MB, Pro 500 MB (note body text stays at 5 MB). Large attachment uploads and downloads no longer get cut off by a fixed 2-minute timeout.
- **New sixth panel type: Floating Panel.** Settings, Market, Achievements and Feedback no longer take over the main window; on macOS / Windows they open in separate windows you can drag, resize, minimize and close, and on the web they appear as a fixed, centered floating panel. Floating and Mini Panel are both open to plugins. Auxiliary windows no longer replay the startup animation.
- **Attachments can be copied straight out**: select an image or attachment in a note and copy it, then paste it into external chats, documents and folders (on macOS both the native image and the file are written). Images and attachments stay rendered when the cursor passes over them, and the source only opens when you hover `</>`; image dragging, "Move to new column" and resize handles are fixed as well; the outline relationship graph no longer resets its layout on regular saves or cloud sync.
- **Editor save fixes**: strikethrough turning into literal `~~` after a while, the second marker failing when italic sits right next to bold, and `[[links]]` after a code block in a list being saved as broken `\[\[` links are all fixed. Chinese punctuation directly next to `**` / `*` / `~~` is now parsed with CJK-friendly rules (e.g. a bold label ending in a full-width colon, followed immediately by more text, now bolds correctly), consistently in the editor and chat bubbles.
- **Search, tags and wikilinks now read the decoded body text**: character references no longer make search miss words, and a multi-character Chinese tag is no longer cut down to its first character.
- **Agent details reorganized**: "Growth" combines memory and evolution, there is a separate "Schedule" tab, and built-in skills are collapsed by default; a new "Evolution" tab shows working notes, candidates awaiting review and nomination reminders, and skills you created yourself carry a "Self-built" badge. TEAM supports image avatars, and names and bios are edited in place in the details header.
- **Agents take better care of themselves**: after upgrading, self-evolution auto mode, Dream automatic memory consolidation, Muse and Historian are on by default (if you turn them off later, that choice is kept); changes to an agent's name or bio take effect on the next turn.
- **Thinking effort now defaults to "Medium" across the board** (Arioso / Aria presets, the chat default and Muse's background cycle); Muse's default token budget goes from 100k to 1M.
- **Fixed: Muse's schedule was always empty**: the original Muse instructions written at install time by older versions are upgraded once, so Muse can schedule tasks normally.
- **Grok Build (xAI subscription login) compatibility**: requests now go through Grok Build's CLI proxy and headers, and old credentials are migrated automatically.

## 2.11.0 (2026-09-17)

- **The session sidebar gets a new "Orbits" view.** Direct chats with an agent, external engines, teams and projects share one list sorted by latest message time, and the ones you use often can be pinned with right-click "Pin to top". The old sidebar is renamed "Sessions (legacy)", and you can switch back at any time.
- **Teams can now work in parallel.** Pick two or more agents above the input box to enter team mode, or set up a long-term team. Members start working at the same time, each in their own sub-session, while the team session only coordinates; Team Desk shows what each member is doing and lets you open the details. Members who say they're done stop speaking, and the session wraps up only once everyone is done; when a member needs approval, the request goes straight to the main chat, and public outputs sync back to the main session.
- **In a direct chat you can @ a project to dispatch a task**: the agent opens a new session in that project to do it.
- **New Agents Space**: view agent and team details and assign members to teams; sub-sessions can be viewed in full in the side panel.
- **Built-in personas are now Arioso, Aria, Recita, Coding and Muse**, and the old built-in agent roster entry is removed.
- **Realtime voice supports hands-free conversation**: pause after you finish speaking and it sends automatically, no button needed; the call continues when you switch to another view and hangs up when you open another existing session. If sending fails, what you said goes back into the input box.
- **Context compaction for long conversations is rebuilt**: the compaction point is saved, so reopening a session no longer compacts again; compaction kicks in early when nearing the limit, and when the context overflows it compacts automatically and retries. Prompt cache hit rates are higher too, so you use fewer tokens.
- **This turn's stats appear while waiting for a reply**: elapsed time, token count and thinking time; the blinking cursor at the end of streaming output is gone.
- **Feedback panel upgraded**: open it by typing `/feedback` or clicking the feedback icon at the bottom of the Ribbon; choose a feedback type and optionally attach diagnostics (version, UI state, errors, runtime timeline and usage) and the current session's contents.
- **Prevent sleep while sessions are running** (Windows / macOS, off by default): once enabled in "Settings → General", your computer won't go to sleep from inactivity while a session is running, and returns to normal once everything finishes.
- Home wallpapers add a Hack2Gate poster.
- **Open file tabs follow renames and deletions**: after you rename, move or delete a file in the tree, open PDF, image, whiteboard, database, plugin file and dashboard tabs follow it to the new path or close automatically, including tabs collapsed in the sidebar and in other windows; tabs for attachments deleted along with a note, or files deleted along with a reference block, close too.
- **Dashboard fixes**: no more endless loading skeleton after a rename or delete, icons no longer vanish en masse after the file structure changes, and multi-block column dragging is supported; dashboard tabs also support back / forward, appear in Recent and are highlighted in the tree.
- Switching to another Space and back no longer loses the file view; when focus leaves the main area, the current main-area tab is still identified correctly.
- **Cloud sync guards against accidental deletion**: a large burst of deletions in a short time is paused first and only synced after you confirm (requires server 2.3.12). Fixed: per-item sync silently disappearing after upgrading to 2.9.9; the same account now reconnects to its original sync automatically.
- When you have Tangu merge sync conflict copies, changes from both sides are kept; canvases and tables are not merged automatically.
- Multiple windows or processes changing settings at the same time no longer overwrite each other; the external MCP server no longer hangs on startup.
- Muse's token budget is counted by billed usage, excluding cache hits; background calls no longer refresh the current session's context progress bar.
- **Mobile**: creating whiteboards and dashboards in a local vault and pasting images or files in the editor work again; files and feature views opened in the single-column layout are recorded in back history and Recent.
- **Line breaks in the Inbox are finally line breaks.** A single line break in server broadcasts and agent messages used to be merged into the same line (standard Markdown semantics); messages now display line by line, like a letter. Blank lines still separate paragraphs.
- **The Inbox supports images.** Illustrations in the body of Forsion broadcasts now display directly.
- **Android now gets update notifications.** It checks for a new version at launch and shows an "Update" page when one is available, and "Download update" fetches the installer directly from an address reachable in mainland China; previously Android had no update prompt at all, and "Check for updates" in settings only opened the website.

## 2.10.4 (2026-09-11)

- **Muse's to-do suggestions can be handled right in the Inbox.** Every to-do Muse proposes comes with a task card: "Let Muse do it" approves it to act right away (operations beyond its permissions still send you an approval request), or you can choose "Run in new session" or "Ignore". The outcome syncs back to Muse's to-do list, and handled cards no longer show buttons.
- **Agent messages in the Inbox are easier to read.** Messages are laid out as documents with the conclusion first; items that need follow-up come with a task card you can click to continue in a new session. When the body is too long, the agent is asked to shorten it, so endings no longer get cut off.
- **Context windows can be set per model.** In "Settings → Models → Groups & display" you can set a context window for each model, or leave it blank for auto-detection. The default window for unknown models rises from 128K to 272K; if the real limit is smaller, it shrinks automatically after the first overflow. Context windows set for models in the admin console now take effect correctly too (requires server 2.3.10).
- **Word documents can be read without LibreOffice.** When reading a .docx fails, it falls back to plain-text reading (no pagination, formulas shown as text) instead of throwing an error.
- **Fixed: Coding Studio not seeing file changes on Windows.** Creating, modifying or deleting files in the project directory now updates the file tree in real time.
- Fixed: an occasional "Missing parameter" error with no UI response when an agent adjusts the interface.

## 2.10.3 (2026-09-11)

- **Fixed: long-term memory unusable on Windows.** Since 2.10.0, Windows users opening the memory panel saw "Failed to load memory: EPERM: operation not permitted, fsync", and long-term memory couldn't be read in conversations. It recovers automatically on first use after updating, and existing memories are not lost.
- **Fixed: writing to an exited process could crash the local engine.** When an agent writes to a background process or browser task that has just exited or closed its input, it no longer raises an uncaught error.

## 2.10.2 (2026-09-11)

- **Inbox redesigned.** The left column is now a unified list you can view by All, Unread, Sender and Archived, and a right-click marks messages as read, archives or deletes them; message bodies render as read-only Amadeus pages, and approval requests and task suggestions from agents can be approved, rejected or handed to a new session right in the message.
- **System rewards support claim conditions.** System messages with rewards can require a minimum client version or membership tier; if you don't meet them you can still read the message as usual, the claim button shows which condition is missing, and you can still claim after upgrading or subscribing.
- **Muse becomes a proactive agent.** Three new permission levels, "Ask me", "Approve for me" and "Full access": out-of-scope actions can queue for your approval, be approved once by the default agent on your behalf, or run directly. Muse wakes up on heartbeats, schedules and rules, and its output goes to the Inbox. Task cards in chats let you run here, open a new session, hand off to Muse to track, or ignore.
- **Muse can build its own Space.** Like a plugin developer, Muse writes its own Space and refines it cycle by cycle, reloading automatically when the content updates; until it's ready, its Library files are shown, with Markdown rendered read-only by Amadeus.
- **Muse settings reorganized.** They're split into four groups: Basics, Cadence, Notifications and Budget; the heartbeat interval is now set in minutes, check frequency adjusts automatically with the heartbeat, and the actual number of runs is still capped by the budget.
- **The model picker is grouped by source.** Models are split into two tiers, "Forsion Cloud" and "Local"; cloud groups, ordering, labels and cost multipliers are maintained centrally by admins, while local models can be custom-grouped and shown / hidden one by one or in bulk from search results, with preferences saved only on the current device.
- **Model settings reorganized by purpose.** "Models" now has five pages: Default models, Groups & display, Providers, Web search and Voice; provider account login, API connections and model fetching all live under "Providers".
- **Databases add grouping and auto-fit column widths.** Group by text, single-select, multi-select, checkbox, number or date properties, with groups that can be collapsed, sorted or hidden; column widths fit the header and main content by default, so secondary content like emails and descriptions doesn't widen the whole column. Turn it off to keep resizing manually; settings are saved per view.
- **Temporary secondary Views are 20% wider by default.** New forms and detail pages no longer squeeze into the regular sidebar width; existing sidebar sizes and manually dragged widths still take precedence.
- **Faster web lookups.** When Tangu looks up real-time information it prefers web search, opening the browser only when search fails or a page needs to be operated; failed browser page snapshots are reported explicitly instead of returning empty results that lead to repeated searches.
- Fixed the frosted-glass effect on overlays such as submenus and the command palette in the Genesis Glass theme, and re-tiered menu and input box transparency; fixed the smooth cursor lagging behind text during continuous typing.

## 2.10.1 (2026-09-10)

- **Stopping a task now waits for it to actually exit.** Stopping no longer just clears the UI while the task keeps running in the background; if the exit hasn't been confirmed, the running state is kept and you can retry, and late events from the old task won't pollute the next one.
- **"Interject now" no longer cancels and restarts the original task.** Interjecting only interrupts the model reply being generated; completed tool operations, queued images and the current task are all kept and continue at a safe boundary.
- **Long conversations and image context are more stable.** Images are no longer mis-counted in tokens by their Base64 text size; measured usage, new content after compaction and tool results are continuously counted toward the budget, avoiding repeated useless compaction or silently dropped original attachments.
- **Tool call evidence is preserved when restoring history.** Reopening a session restores tool calls and their results in pairs, with missing results clearly marked as unknown instead of old actions being assumed successful or accidentally redone; tool loading hints also distinguish "Available", "Just loaded" and "Currently unavailable".
- **Built-in Tangu Computer Use upgraded to 0.5.4.** Windows / Linux guidance now starts from window discovery instead of requiring a launch tool that only macOS supports; builds on all three platforms verify the bundled tools and the prompt contract.

## 2.10.0 (2026-09-10)

- **Agent memory system upgraded.** A new memory panel and management API let you view, record, organize and clean up long-term memory; session recall is isolated per agent, and candidate screening, Dream consolidation and benchmarks improve recall quality.
- **Safer, more controllable local execution.** New Host Sandbox settings and path protection, plus unified cancellation and timeout behavior for approvals, file search, command execution, Hooks and the Docker lifecycle; long tasks keep reporting progress, and stopping no longer leaves background processes behind.
- **First-run onboarding and settings redesigned.** Settings are regrouped by purpose, making models, Channels, Hooks, notifications, shortcuts, Spaces and theme configuration easier to find; first-run setup and sync use a new step-by-step onboarding with an appearance preview.
- **Moving and syncing notes is more reliable.** File / folder moves wait for data to be written to disk and guard against race conditions, and cloud renames, refreshes and bulk deletions no longer bring old content back; sharing, account switching and folder publishing now fully recover from errors.
- **Fixed Enter behavior when editing headings.** Pressing Enter in the middle of heading text keeps the first half as the heading and turns the second half into body text; headings no longer carry over to the next line the way bullets or lists do.
- **New shortcut for switching panel tabs.** `Ctrl+Tab` cycles tabs only within the currently focused panel group and `Shift+Ctrl+Tab` goes in reverse, without affecting other panel groups.
- **Interface zoom reset to default.** The first launch after installing or upgrading to this version returns to the current platform's default scale; any zoom you set yourself afterwards is still saved.
- Improved Amadeus structured source editing, canvas cursor and menu positioning; enhanced model waiting states and timeout diagnostics so "Waiting for first frame" and actual progress are easier to tell apart.
- Refined installer dependency filtering, Windows update progress and native helper verification for the built-in Tangu Computer Use, reducing missing dependencies and signature verification failures after install.

## 2.9.9 (2026-09-08)

- **Built-in Tangu Computer Use 0.5.1.** The computer-use plugin is ready to use right after install and upgrades along with the app; window detection and screenshots are updated, and native helpers for Windows / Linux are added.
- **New device permissions onboarding.** Permission status is visible in first-run setup and in "Settings → System → Device permissions"; when granting access on macOS, instructions and the name of the app to authorize appear next to System Settings. You can set it up later and come back anytime.
- **Add and switch between multiple accounts.** Sync registration, cloud mirror, memory and cloud layout are isolated per account; notes, tables and whiteboards are saved before switching, and if saving fails the current state is kept.
- **Stronger deletion protection for note sync.** Bulk deletions wait for confirmation first, and the pending state survives restarts; fixed blank files after switching between local / cloud, old files coming back after renames, and draft saving issues.
- Fixed cloud path mapping when sharing local notes. Public share pages now use the read-only note editor, with support for canvases, columns and embedded content.
- Fixed the installed app not finding an installed ffmpeg / ffprobe; speech recognition now suggests conversion when it gets a non-WAV file. Sub-agents run at most 24 turns and keep troubleshooting clues when they hit the cap.
- Added the GPT-6 Astra model catalog entry and thinking effort support; local Chat can pick Provider models directly.
- Conversations show "Sending context", "Waiting for model first frame" and the number of seconds waited, so you can tell which step a task has reached.
- Improved the welcome area, engine / agent pickers and zoom spacing in narrow panes and short windows; the copy, edit and rewind buttons on user messages moved below the bubble. Channel workspaces show up as soon as they connect.
- Without a manually chosen preference, all platforms now default to Work; Chat uses the default agent at creation time, and the empty state keeps only model selection.
- Appearance settings add 80% / 100% / 120% interface size presets. Notes support fuller date suggestions and keep headings that start with a number; long notes and plugins can use a unified floating table of contents.
- The mobile About page adds the app filing number, privacy policy and terms of service entries.

## 2.9.8 (2026-09-08)

- **Coding Studio rebuilt.** It now starts from a "Project brief": six editable templates (AI assistant / Data dashboard / Personal website / Interactive explainer / Image Studio / Research assistant) help you spell out what you want. Fill in the goal, audience and constraints that must be kept, and creating the project makes a new local directory, writes the full brief to `FORSION_BRIEF.md` and puts a short request into the chat draft on the left — **the model is only called once you confirm and send**. You can also use "Open local folder" to bring in an existing project; importing only opens the directory and never rewrites the files in it.
- **The workspace shows only chat and preview by default**, leaving the space to the app you're building. Brief, versions, acceptance checks, files and terminal move into the bottom toolbar, and preview settings move next to the address bar. Each tool can switch between left / bottom / right and remembers the position you picked for it in the current project; press Esc to close it when it has focus, and unsaved input survives moving or reopening it.
- **The chat sidebar adds Chat / Work modes** (the pill to the right of the new chat row). Chat lists only sessions that aren't in a project, good for quick Q&A; Work lists all projects. **Desktop defaults to Work, while web and mobile default to Chat**; once you pick one manually, it's remembered.
- **The mini window can now include a Space panel** (enable it when needed) and can follow the foreground cursor.
- **Fixed: Ctrl-C on background processes sometimes failed to stop them** (most noticeable on Linux, and more likely the busier the machine). An interrupt signal sent in the instant right after a process starts would miss, so the command looked like it was still running and nothing could stop it. The signal is now sent a second time; in testing, "4 out of 20 attempts wouldn't stop" became every attempt stopping.
- Polished a batch of Coding Studio animations and panel details; added a connectivity self-check tool for the realtime call pipeline (for development).

## 2.9.7 (2026-09-06)

- **Android build re-released** (2.9.4 through 2.9.6 all failed to ship it). This time the problem was the packaging itself: the embedded browser component used since 2.9.4 to "open device pages inside the app" requires **Android 8.0 or later**, while the project still targeted 6.0, so the manifest merge failed outright.
- ⚠️ **As a result, the Android app now requires Android 8.0 or later** (previously 6.0). Devices on Android 6.x / 7.x can't install the new version; older versions already installed are unaffected.
- **No changes to the app itself**; desktop users (macOS / Windows / Linux) already on 2.9.4 – 2.9.6 don't need to update.

## 2.9.6 (2026-09-06)

- **Android build re-released** (neither 2.9.4 nor 2.9.5 shipped it). The mobile checks in the packaging pipeline exposed three cases of their **own** aging at once: they detected crashes by the error boundary's title text (which matched changelog text in the newly added "What's New"), they didn't skip first-run onboarding (its full-screen overlay swallowed every click that followed), and they looked up Space tabs by UI text (this release renames Amadeus to Note, and in the English UI it never matched anyway). All three now rely on stable identifiers. **No changes to the app itself**; desktop users (macOS / Windows / Linux) already on 2.9.4 / 2.9.5 don't need to update.

## 2.9.5 (2026-09-06)

- **Fixed: the Android build didn't ship with 2.9.4**. The "boot smoke" check in the packaging pipeline detected crashes by the error boundary's **title text**, and the "What's New" page added in 2.9.4 renders the entire changelog — which happens to contain the very words earlier versions quoted, so the check mistook the changelog for a crash and the APK got stuck in the pipeline. The app itself was fine: the check now looks at the error boundary node itself.
- Content is identical to 2.9.4. **Desktop users (macOS / Windows / Linux) already on 2.9.4 don't need to update**.

## 2.9.4 (2026-09-06)

This release promotes **find in page** from an editor-only feature to the shell, gives Amadeus a **built-in user manual**, and lets **Tangu actually change interface settings**; the desktop capabilities needed by the call (callroom) plugin are enabled as well.

**Find and manual**

- **Cmd/Ctrl+F now works everywhere**: no longer limited to the note editor — any View, card or canvas can open the find bar, with previous / next / match count as before
- **Built-in user manual**: a 19-chapter bilingual (Chinese and English) manual ships with the app and reads like a note inside it (search "Manual" in the command palette), covering notes, canvas, databases, dashboards, plugins and agents

**Agents can now change the interface**

- Tangu can now **actually change Forsion's settings** (theme, language, layout and the like) instead of only telling you "where to click"; behavior is consistent across all three platforms (desktop / Web / mobile)
- First-run onboarding now covers Web and mobile, with steps trimmed automatically to what the host supports

**Temporary Extend View**

- Secondary content in panels (forms, details, logs and the like) now joins the tab group as a **temporary View** instead of each panel rolling its own overlay; when opened in the left or right sidebar it comes with its own title and close button
- The 17 data tables in the admin panel render as **native databases** on desktop: click headers to sort, filter / hide columns / search, drag to resize columns — and refreshing data doesn't wipe that view state

**Editor**

- Fixed: **blank lines created with Enter disappeared after switching away and back**; pressing Enter did nothing when the cursor sat before an ordered-list number
- Fixed: **copying canvas cards across files lost formatting** (they pasted as plain text)
- Fixed: switching notes within the same tab **didn't bring you back to where you left off reading**
- The `@` panel in notes supports **keyword shortcuts**: type words like "remind" to get dates and reminder items directly

**Interface**

- Space names drop their internal codenames: **Tangu → Agent, Amadeus → Note**
- Unified selected / hover backgrounds in submenus (Amadeus menus barely showed the selection, while shell menus were too faint)
- Fixed: an empty sidebar showed **two unclickable "Collapse" buttons** at the top
- Alignment between the bottom panel and the right sidebar no longer depends on the order in which they were opened or closed

**Mobile**

- Settings changes **now actually save** (previously they silently didn't)
- Device pages open in an in-app WebView instead of bouncing out to the system browser

## 2.9.3 (2026-09-03)

This release fills in **the other half of database relations** — reverse, multi-value, forms and Gantt — plus export, people, attachments and display formats. Starting with this release, the interface language is **chosen automatically from your system language and region** instead of always defaulting to Chinese.

**Databases: the second tier of relations and views**

- **True two-way relations**: a relation is stored only once, and the other side is an **editable projected column** — add or remove links on either end and the other end updates instantly, with no more maintaining two tables by hand
- **Relations can be multi-select** (one cell links to multiple rows); **reverse rollups** follow a relation to pull values back from the other side, with count / sum / average / concatenate
- Relation chips **can show any column from the other side** (not just the row title); **candidates can be filtered by conditions**; deleting a row **cleans up relations pointing to it**, so you're no longer left with a pile of "unlinked" entries
- **Form view**: turns a table into a fill-in form with conditionally shown fields; submitting adds a new row
- **Gantt view**: lays rows out as time bars by start / end date (read-only in this release)
- **Table hierarchy tree**: pick a "parent row" relation column and rows fold into an indented hierarchy; filtering and search work as usual, and a search that misses the parent row won't flatten the whole tree
- **Drag headers to reorder columns**; column order and widths are **remembered per view**, so switching views doesn't make them overwrite each other
- New column types: **Person** (suggestions come from names used across the whole vault) and **Auto number** (with an optional prefix like `PC-`); **attachment cells can hold multiple files**; **number columns support decimal places and unit prefixes / suffixes** (display only — editing shows the raw number)
- **Created time / Modified time** stamp columns (modified time only changes when the content actually changes)
- **Group by date column** (by day / by month)
- **Export CSV**: what you see is what you get — only the columns and rows visible in the current view are exported
- Fixed: when a table overflowed horizontally, the column boundaries of the header / data rows / footer were misaligned

**Automation**

- Actions can **read and write databases** directly, including writing to the projected column of a two-way relation
- Changes a rule writes itself **no longer re-trigger that rule**; when a backlog can't be drained, the rule is automatically disabled at the limit with a notice instead of spinning idle

**Canvas**

- When a card is selected, **unrelated cards and hierarchy lines fade into the background**, so the full lineage of a branch is clear at a glance
- Touch: **dragging with one finger on an unselected card pans the canvas** (it only drags the card once selected), so you no longer need to tap empty space first

**Interface language**

- The initial language is decided in this order: **your manual choice → system language → region → system language**. Installed on an English system it defaults to English, while users in China still get Chinese; once you switch manually, your choice sticks for good
- Fixed a batch of "**switched the language but it's still Chinese**" spots: default names for new notes / dashboards / whiteboards / databases are no longer hard-coded Chinese file names, and command names in the command palette follow the language too

**Other**

- The sub-item list at the top of the workspace is now a dropdown menu
- Plugins can mount native dashboards directly, **no longer requiring a vault to be opened first**

## 2.9.2 (2026-09-01)

The stars of this release are **databases** and **time in notes**: the former gains formulas and cross-table relations, while the latter truly connects Calendar / to-dos and note text in both directions. Canvas, dashboards and Home each get a round of polish too.

**Databases on par with the first tier of Notion / Feishu**

- **Formula columns**: reference other columns with `{column name}`, use arithmetic / comparison / logical operators, plus 20+ functions such as if / round / len / concat / contains / days / today. Empty cells count as 0 (or as an empty string when concatenating), formulas can reference other formulas, and circular references show a cycle marker instead of turning the whole column red
- **Relation + Rollup**: a new "Relation" column points to a row in another .db (showing that row's title; click ↗ to jump there), and a "Rollup" column follows the relation to pull in the other table's columns, with count / sum / average / concatenate
- **Filters support "any match"**, **sorting supports multiple columns in order** (headers show levels like ↑1 ↓2), and **table view can be grouped by a single-select column**, with counts in group headers, collapsible groups, and new rows in a group automatically taking that group's value
- **Attachment columns**: upload files straight into cells; images show thumbnails and everything else opens in the system app; gallery view uses the first image attachment as the card cover
- **Automation can now work with databases**: the "when table contents change" trigger and "add / update row automatically" actions the engine already supported can now be configured visually in the Automation builder, and values can use `{{row.column name}}` to reference the triggering row

**`@` time marks in notes = editable projections**

- For to-dos / events in notes with an `@` time mark, **dragging to reschedule in Calendar writes back to the note text**, and **checking them off in the to-do view also writes back** to that line's `[x]`. Lines are located by content rather than line number; if nothing matches, it would rather change nothing than edit the wrong line
- To-dos / events are now **explicitly opted in**: only `- [ ]` items with an `@` mark appear in Calendar and the to-do view, rather than "every checkbox in a note counts as a to-do"

**Canvas and dashboards**

- Selecting a card **overlays its full hierarchy of relationship lines**, so you can trace a branch's full lineage
- **Creating a card inside a card = child card**; in document mode cards can be dragged as a whole branch (Shift-drag takes the entire branch along), plus row-level handles and a card grab button
- Once the canvas is zoomed out past a certain level, card bodies automatically switch to **title summaries**; the threshold is adjustable in Settings, or you can turn it off entirely
- A built-in **canvas tutorial** note
- Grid dashboards: card sizes can be dragged freely, **charts are promoted to a type of database view** (alongside table / board / gallery), and a new "manual row" lets you place cards freely within a row and leave gaps

**Home and shell**

- Home gains a **standalone Space front area**; time is no longer shown in the stash layer; on mobile the wallpaper extends behind the top capsule bar
- The ribbon command area is slimmed down: the Quick find / Language / Feedback icons are removed (the features are still in the command palette)
- **Market and Achievements are now in the command palette**, and achievement toasts are clickable to jump straight there

**Fixes**

- **Local voice input models can finally be downloaded in mainland China**: previously the download URL was picked one-of-two based solely on the "Network environment" setting, and the default went straight to Hugging Face, so mainland networks always got stuck on a red `fetch failed` — even with a proxy, because the channel used for model downloads couldn't see the system proxy. Now both the official source and the mirror are tried (the order still follows your network environment setting), moving on to the next if one can't connect; a stalled connection is abandoned after 15 seconds for the next source, partial files are cleaned up, and large models that were already downloaded aren't downloaded again. If nothing works, you get a plain-language message that spells out which URLs were tried and what to do next, instead of a raw English error
- **Typing in an embedded database no longer turns the whole block into source**: previously, pressing Delete in the formula box of the column menu reverted the entire table to the raw `![[table.db]]` text — keystrokes inside the embed leaked into the outer editor. Search boxes, cells and plugin forms had the same problem and are fixed too
- **With "Smooth caret" on, input boxes inside embeds show a cursor again** (previously no cursor was visible in search or formula boxes)
- Note icons didn't show in the workspace and tab bar

## 2.9.1 (2026-08-30)

The first batch of fixes after 2.9.0 — all three come from real-world use.

- **Home no longer scrolls**: the wallpaper layer always carried a slight zoom to hide seams, so the main area had a nearly full-length scrollbar along both the right and bottom edges, and the interface could be dragged slightly out of place. Home is now a fixed stage; when the window gets shorter, the title and spacing shrink on their own instead of making you scroll
- **You can get into the stash layer and back out**: after right-clicking empty space to enter "All Spaces", right-click empty space again to go back the way you came; when a stash folder is open on top of the stash layer, going back one level returns to the stash layer instead of jumping straight to Home
- **Theme color and background color are chosen separately in first-run onboarding**: both rows of swatches are there, with the same meaning as in "Settings → Appearance"; the background defaults to "Classic", and picking a theme color no longer tints the background along with it

## 2.9.0 (2026-08-30)

This release rethinks "what you see first when you open Forsion": a real Home, a bottom panel on equal footing with the left and right sidebars, and a to-do list that finally recognizes checkboxes in notes. On the notes side, media, web pages and precise citations are filled in.

**All-new Home**

- After launch you land on **Home** instead of the last Space you used. Home has a dock (a projection of the upper ribbon area, sharing the same data as stash folders), quick entries and recent items; right-click empty space to jump straight to the secondary stash layer
- Three wallpaper sources: the **Bing daily image**, a custom image, or four Forsion graphic presets that change color with the theme (rings / topography / weave / horizon). Focus blur and vignette are adjustable
- Home itself is a **built-in plugin** — if you don't like it, turn it off on the Plugins page

**Bottom panel**

- A **fourth position** alongside the left and right sidebars: it uses the same Dockview, is anchored below the main area without spanning the sidebars, and toggles with `⌘/Ctrl + J`
- The Tangu Space comes with a **terminal** at the bottom, collapsed by default
- Four long-standing issues fixed along the way: expanding was clamped by the minimum size so adjacent areas flickered, fade-in replayed when views remounted, **scroll position reset to zero on layout changes** (the cause of "Calendar dates mysteriously jumping back to early April"), and rapid clicking threw errors

**To-dos**

- To-dos no longer only recognize database rows — **`- [ ]` checkboxes in notes now count too**, and those with dates are scheduled automatically
- The time window is now split into buckets: **Overdue / Today / Tomorrow / This week / Later / Unscheduled**; empty buckets are hidden, and Overdue is always expanded and pinned to the top
- First-run Calendar sample data is now generated relative to today, so it won't turn into a row of "53 days overdue" a few weeks later
- Calendar and to-dos have also been migrated entirely to built-in plugins

**Notes · media and citations**

- Audio and video support **time anchors**: `![[clip.mp4#t=90]]` starts playback at 1:30; files in the vault are streamed, and files outside the vault can be opened too
- Web pages can be **embedded** (frozen by default, click to activate); bare links always render as bookmark cards — write `![[url]]` if you want a player, and pasting offers a "Paste as" choice; set embed width with `|400`
- **Precise citation chips** are now a complete set: PDF page `#page=3`, code line `#L42`, note heading `#Section`, block anchor `#^id`, media time `#t=`, plus web quotes (located via Chromium's native text fragments). Click one to jump straight to that spot with a brief highlight

**Notes · images and PDF**

- Images: **click to select, double-click to view full size, `</>` to view source**; drag corners to resize, with the width written into the alt text. Pasted `![](path)` images now behave the same as the `![[…]]` form
- **PDF annotations**: highlight geometry reworked, and quotes can be traced back to the original text; PDFs outside the vault open read-only
- Spaces in attachment names are no longer permanently baked into links

**Canvas and dashboards**

- Canvas and dashboards now share a **common core**: zoom, pan, gestures and the minimap run on one codebase, so behavior no longer drifts between the two
- Dashboards switch to a **structured grid**: cards have size tiers and can be reordered, with remaining space arranged automatically; locked = finished page, unlocked = layout mode

**Appearance**

- **UI font presets**: four built-in options (including a Chinese fallback stack), with body and monospace fonts chosen separately
- The appearance step in first-run onboarding now uses the same **live preview** as the Settings page, so you're not picking a skin blind; choosing a theme color no longer changes the background color as a side effect
- Added instrumentation for the shadow contract of the two-axis color system, making layering more stable in dark mode

**Plugins**

- Plugins now have **their own icons** (on Market cards, the Plugins page and Space buttons); the Market supports uninstalling
- Plugins can read session context usage via `ctx.tangu`; the `amadeus-asset:` protocol is allowed for fetch (note for plugin authors: this requires a host **≥ 2.9.0**)

**Tangu and engine**

- Supports connecting the **DSH** external engine
- **Automatic context window detection**: learns the real limit from upstream "too long" rejection errors and remembers it, instead of relying only on a hand-maintained table
- New tools: `view_video` (watch videos) and `document_pages` (read documents by page)
- Hosted models can be individually marked as "no image support", and images are then automatically routed to the vision helper model
- Fixed: WeChat iLink sessions no longer silently drop after they expire

**Device connectivity · other**

- Forsion Unit adds a **P2P direct fast path**, so devices on the same LAN no longer relay through the server
- Notes / files in the sidebar can be **dragged into other apps**; drag and drop within the tree to organize
- The OS file drop zone for chat now covers the whole view, so you don't have to aim precisely at the input box
- New foreground window sampling seam (off by default, behind two switches) for plugins that need it

**Fixes**

- **Interface pushed out of place by programmatic scrolling**: some navigations would shove the whole window up by a chunk, and `overflow: hidden` couldn't stop it. It now snaps back when this is detected
- Model request timeouts now scale with the request body size, so large attachments are no longer cut off at a fixed 30 seconds; failures retry a bounded number of times
- Older local SQLite stores never got the new columns (column backfill was inconsistent across dialects), leaving data missing after upgrading

> The Android APK is published with the same build (see the Release assets). The cloud worker and server are deployed separately,
> so engine-side changes have to wait for their respective release train.

## 2.8.1 (2026-08-22)

The 2.8.0 canvas had barely landed when a pile of real-world reports came in; this release is mostly about closing the gap to "how it should feel in use".

**Canvas**

- **Double-clicking a card = enter editing + center and zoom, both at once**, with the cursor landing on the character you clicked. In Settings → Notes you can keep just the editing, without the zoom
- **Parent cards now really enclose their child cards**: in document mode, cards with parent-child relationships are nested by hierarchy, with frames drawn down to the second level (deeper levels are only indented)
- `</>`, checkboxes and embed buttons inside cards **are now clickable** (previously clicking them did nothing)
- Cards repel each other when released instead of piling up; the minimap can be clicked to navigate
- Connections, multi-select and subtree tidying got an upgrade; drag a card onto another card's edge to attach it — left / right edge = child card, top / bottom edge = sibling
- **Pasting and dropping into the canvas are complete**: OS files, note / file references from the sidebar, and text from other apps all create a card at the drop point, whether it lands on empty space or on top of a card; copying and pasting a whole card keeps its formatting and gets a new anchor; cut cards no longer ask whether to delete the file on disk
- Headings inside cards can be collapsed; copied body text includes its anchor

**Note editing**

- Structural source in document mode can be edited character by character; heading `#` marks stay visible and change level in real time, and cursor behavior across list rendering and structural prefixes has been smoothed out throughout
- Smooth caret is back, and the block highlight rhythm has been retuned
- The graph view, backlinks and the status bar backlink count **fully recognize v4** (previously they all failed on notes in the new format); after deleting / moving a note, tabs no longer hold on to a dead path
- Templates and "Today's journal" are wired into v4 routing

**⌘P quick switcher**

- Added a category bar: All / Notes / Files / Sessions, switched with `←` `→`; fuzzy search is fixed as well

**Chat**

- **Tangu Sketch**: diagrams the AI sketches on the fly are no longer a card — they blend into the message background with faint strokes on a transparent canvas, interleaved according to their semantic position in the message
- Running states converge into a narrow beam of light that sweeps once and disappears (unified across tool calls, Pin Summary and "Thinking"); with "Reduce motion" on, it falls back to static text
- **Web Q&A is noticeably faster**: English-only queries now use a global search source (previously the Chinese source returned "successful garbage" for foreign entities, forcing fallbacks all the way down to the browser); oversized page snapshots are now written to disk and read on demand; the system prompt includes today's date, so the model no longer makes up a year and spends another round searching

**Plugins**

- 20260821 batch: 4 new plugins + 3 upgrades; Bluebird Folder 1.7.0 supports clipping music and Xiaohongshu (RedNote) image posts, and "Open note" no longer hands off to the system text editor

**Mobile**

- On Android you can turn a Space into a **home screen shortcut** that opens it directly
- The left and right drawers now follow your finger: intermediate states, snapping by position or fling velocity, and no bounce-back on release
- Added the v4 canvas entry point (fixing "the whole bottom bar disappears for v4 notes on phones" along the way)

**Account and settings**

- The **"Forgot password" link** on the sign-in page has been moved into view (the feature was always there, just hidden inside the password tab)
- Genesis first-run onboarding and the settings control center are redesigned, and the remaining options are simplified across the board
- After signing in with an xAI subscription, grok models now show up in Settings; image / video generation models no longer get mixed into the chat model picker; a waiting hint is shown during subscription sign-in
- **Fixed: user avatars disappearing from time to time** — any hiccup in the cloud whoami call would wipe the local profile

**Cloud**

- **Fixed: the "Files" panel in the cloud workspace was always empty**: the files the agent wrote were all there, but the panel left out a parameter when querying by project, so the server read a different, empty tree. Listing, preview, download and delete all work again
- In cloud sessions without a Python runtime, the AI no longer keeps announcing "running the script now" while spinning idle; it produces text output instead and explains the environment's limits
- Agents support **project-level instruction files**; external engines can also serve as sub-agent backends

> The Android APK is published with the same build (see the Release assets); the cloud worker image ships on a different train, so engine-side changes wait for the worker to be rebuilt.

## 2.8.0 (2026-08-19)

**Notes now have a canvas mode.** Click the two-segment pill in the top bar and the same note turns from a document into a whiteboard:

- Body text is laid out on the canvas as cards: drag, zoom, double-click empty space to create a new card; Tab / Enter / the ⊕ on a card's side all keep creating more
- **Mind-map-style connections**: drag a card onto another card's edge to link them — left/right edge = child card, top/bottom edge = sibling, and it slots into line automatically when you let go; relationship lines can be selected and deleted, and the toolbar arrow can set parent/child directly
- Whiteboard elements: rectangle / ellipse / text / Frame / freehand pen, resize by dragging the corners, with marquee selection, a context menu and connectors all included
- **Still the same .md file** — no new file type; in document mode it's a regular note, you can switch back and forth anytime, and undo shares a single timeline
- ⚠️ Canvas notes use a new on-disk marker, so **please update the mobile app to 2.8.0 as well**, otherwise older versions will show stray comment lines in the body

**Review AI plans before approving them**: plan cards have three states — Approve / Edit and approve / Reject. Tweak a couple of lines and let it through instead of starting over

**Write your own approval rules**: besides Read-only / Auto-edit / Full auto, there's a new "Custom" mode where you write rules by tool and path; every approval prompt now explains **why it's asking you this time** (one of your rules matched, or it's writing outside the workspace)

**Open sessions in multiple tabs**: open several conversations side by side in one window, just like files; opening something in a new tab now opens it in that tab instead of pushing out the main chat

**AI can now search inside old conversations**: in 2.7.9 it could only find which session something was in; now it can search what was actually said in the session

**Code checkpoint rewind**: if the AI breaks things, you can return to the state at a given moment (it goes back to that moment, rather than undoing one step)

**Model menu is now a slider**: pick thinking effort by dragging, ChatGPT-style, instead of digging through a submenu

**Market redesign**: goes from a resource catalog to a discovery-style store, with plugins and apps merged into one category

**Plugin capabilities opened up**: plugins can add their own features to the editor (obsidian-latex-suite has been ported — quick math input), can read your vault read-only, and support both Chinese and English

**Editor gaps filled** (on par with AFFiNE): slash menu, in-page find, block selection, list folding, code block toolbar, drop-target hints while dragging, link cards

**Paragraph Tab = indent**: Tab / Shift+Tab changes a paragraph's indent level (no longer converting it to a list), and the indented subtree moves along as a whole

**See what you're spending**: cost gate and auto-compaction notices, a Context view (window source / breakdown of injected sections / instruction file list), and visible thinking effort

**Mobile**: rounded corners now fit the sidebar's peeking edge; the drawer's peeking edge is wider and body text is one size larger

- **Security fix**: shared note pages could expose frontmatter as body text (canvas notes leaked their coordinates too) — this only happened with files using CRLF line endings
- Fixed: the canvas mode pill didn't show when a note was restored on startup
- Fixed: in narrow panes the last message was covered by the floating input card
- Fixed: reference chips, empty state and width memory in the sidebar chat
- New whiteboard engine (zsviczian fork): 5 stroke widths, a compact panel, custom pens

## 2.7.9 (2026-08-13)

- **Fixed: folding a heading "folded everything to the end"** — folding should stop at the next heading of the same level, but it often swallowed the whole rest of the note. The root cause was that headings sitting in the middle of a paragraph were invisible to folding (Enter in the editor = a line break within the block); boundaries are now found line by line, and fold ranges match Obsidian
- **Fixed: heading lines couldn't be dragged** — the fold arrow sat right on top of the drag handle, so clicking the handle folded the heading instead. The arrow is now positioned by the left gutter layout and no longer overlaps the handle
- **Fixed: editing online on several devices at once stalled the IME and swallowed what you'd just typed** — as soon as another device (or the AI, or Obsidian) saved, the editor you were typing in was remounted entirely, the IME candidate window disappeared, and unsaved characters vanished with it. External changes now wait until you stop typing before merging, and merging never overwrites the other side's changes in return
- **Fixed: quota failed to load and the profile page wouldn't open in the mobile app**
- **The web version in mobile browsers gets the full account surface**: tap your avatar to see remaining quota and use reset cards; the profile and purchase pages open in the same tab (previously tapping did nothing), and your sign-in carries over automatically, so there's no need to sign in again
- **Fixed: clicking "Upgrade membership" in the web version just reloaded the app** — the purchase page wasn't being forwarded correctly
- **Smooth cursor is now off by default**: it used to be on by default, and now you turn it on yourself in Settings (after updating, the cursor feels like the native system cursor again — this is intentional)
- **Fixed: in the iOS web version, the cursor was drawn in the wrong place while the soft keyboard was up** — on touch devices, the native system cursor takes over while the keyboard is on screen, and control returns once the keyboard is dismissed
- **AI can now search your past conversations**: new session search, so asking about "that plan we discussed last time" no longer gets "I can't see the session list"; matching sessions show up in the chat as clickable links, so you can open one and pick up right where you left off
- Fixed: the load-on-demand tools in the coding preset (web search, session reading, note read/write, etc.) all actually failed to load

## 2.7.8 (2026-08-07)

- **Fixed: opening the block menu in a note pinned the menu to the top-left corner of the window** — the menu was measured before it had rendered, so it got sentinel coordinates. It now always opens next to the handle, with an automated test to prevent regressions. The menu's four icons were also switched to the same set as the other context menus
- **Opening a cloud workspace no longer "takes forever to load"**: directory trees you've already viewed are snapshotted and appear instantly on cold start, with real data catching up in the background; the mobile app also pre-warms after launch instead of waiting until you open the workspace drawer to start requesting
- **Note sidebar sections can be reordered by dragging**: grab a section title to drag any of the five sections — Pinned / Online sync / Shared with me / Collections / Note tree — and the order is remembered. Dragging and renaming note rows inside the sections is unaffected
- **Drag a note from the sidebar into the body = insert a reference**: notes land as `[[links]]`, images / PDFs / attachments land as `![[embeds]]`
- **Opening the web version in a mobile browser now gives you the mobile UI** (built from the same source as the Android app) instead of a squashed desktop layout
- **Mobile: switching away from a Space and back returns you to the note you were last viewing**
- **Calendar no longer swallows untitled events** — they show on the grid as "Untitled" and open for editing as usual
- **Market**: lists and details show skeleton screens while loading; the "Updates" page honestly shows that it's scanning while it scans, instead of briefly flashing "All up to date" first
- Fixed: after switching accounts, the workspace briefly showed the previous account's directory tree
- Fixed: images on the first screen of cloud notes occasionally failed to load (a manual refresh was needed)
- Fixed: when the background connection failed to start, the whole session silently lost contact — it now retries three times automatically and tells you clearly if it still fails
- **Security**: link previews in notes now only fetch public addresses (previously they could be tricked into requesting internal network addresses), with timeouts and size limits added so huge pages no longer stall the preview
- The cancel-membership endpoint always returned an error before (fixed on the server, so it already works without updating the client)

## 2.7.7 (2026-08-05)

- **Fixed: tapping a note / file on mobile "looked pressed but didn't open"** (most noticeable in Amadeus) — when the main view was already an editor, tapping another note didn't notify the UI, so it kept showing the old one. Now whatever you tap opens, with an automated test to prevent regressions
- **Fixed: file icons (especially md) disappearing every now and then**, both in lists and on note titles — both causes are fixed: icons no longer stay blank after the icon data fails to load (it retries automatically); and after tapping a folder / a row with child notes on a touch screen, icons were permanently hidden by the "swap to arrow on hover" rule (no longer swapped on touch)
- **Fixed: tapping the avatar in the ⋯ menu on mobile did nothing** — mobile was missing the account interface; tapping now opens the full account menu (remaining quota / reset cards / invites / user center / sign out)
- **Mobile UI overhaul (Obsidian style)**:
  - Minimal top bar: just the left/right sidebar toggles, a **tab switcher** (with a count; tap to open a list where you can switch, close and create tabs) and ⋯
  - The left and right panels now **push content aside**: as a panel slides in, the body is pushed intact to the other side; tap or swipe back to dismiss it; iOS-feel animation
  - The **Space switcher moves to the bottom of the left panel** and stays there, with the account card and the settings entry below it; account and settings no longer appear again in the ⋯ menu
  - The **note editing toolbar** stays at the bottom: insert (/ menu), upload file, undo, redo, dismiss keyboard; when the keyboard is up, it sits right above it
  - Note cover images now **run edge to edge**, and the body's side margins are halved
  - Supports Android's **predictive back** gesture; Back dismisses in order: popovers → panels → in-page back → close tab
- **When a note is renamed / moved, `[[references]]` across the whole vault follow automatically** (desktop, including cloud vaults): renaming, moving, and renaming / moving an entire folder all rewrite the notes that reference it; ambiguous duplicate names get the path filled in automatically, and aliases and anchors are preserved as-is; content inside code blocks is left untouched

## 2.7.6 (2026-08-04)

- **Fixed: the "Select workspace" dropdown on mobile didn't respond to taps** (only a long press would select) — the search box in the menu auto-focused and popped up the soft keyboard; the moment you tapped an item the keyboard retracted and the whole menu shifted under your finger, so the tap missed. Mobile no longer auto-focuses (desktop is unchanged); the model picker had the same problem and is fixed too
- **Inbox: official notices can carry rewards** (reset cards / points / membership time) — open the notice and tap "Claim" to receive them, and they're marked with 🎁 in the list; notices can have an expiry date, and expired ones are archived automatically — you can still browse them, but can no longer claim them
- **Invites and redeem codes**: invite rewards are now configurable items (what the inviter and the invitee each get is set by the platform); redeem codes gain an "Item" type; the points section of the account center is trimmed down to "Balance + Top up / Redeem reset cards in place / Redeem code", and the invite card moves into your profile (with your invite link and the number of people invited)
- **Cloud fixes, already in effect without updating**: "Failed to load session list" on the web version / mobile; and having to force-refresh manually to see a new release of the web version — it now picks up the latest version automatically

## 2.7.5 (2026-08-04)

- **Account menu (new)**: click the avatar in the bottom-left corner to open the full menu — remaining quota (weekly / daily percentage + next reset date), upgrade membership, use a reset card, invite friends, user center, sign out
- **Quota is now weekly** (it used to be monthly; the daily quota is unchanged): running out **no longer cuts you off mid-way** — the current conversation turn is guaranteed to finish, and any overage carries over into the next period. There are also two new ways to recover: **reset cards** (buy them with points in the store, or get one issued by an admin; using one restores this week's quota immediately) and an **"Auto-deduct points" switch** in the user center (off by default; when on, points are deducted automatically once quota runs out so you can keep going)
- **Calendar can connect external calendars**: subscribe to Google / Outlook / Apple ICS URLs, or import a local `.ics` file directly (read-only; recurring events, all-day events and time zones all line up)
- **Note editor**:
  - **Fold sections** from the left of a heading (like Obsidian), and the fold state is kept when you reopen the note
  - Moving the cursor into a heading line **reveals the raw `#`**, while the heading size stays the same
  - Reference / embed blocks gain an **"Open" button** — click it to open the referenced content, or ⌘/Ctrl+click to open it in a new tab
  - The inline toolbar's **"Link" button is fixed** (previously clicking it did nothing at all)
  - Fixed a batch of cursor issues: the up/down arrows **got stuck and couldn't leave** heading / numbered list / wikilink / table / code block / formula lines; pressing Backspace on a heading line made the whole editor **lose focus, so every following keystroke did nothing**
  - The title in the note top bar is now truly centered (it used to always sit half a button group off to the left)
- **Dashboard**: a card can hold **any view** — Calendar, to-dos, Inbox, activity log, search, graph, built-in browser, terminal and plugin views all work
- **Loading experience reworked across the board**: switching notes / opening sessions / expanding sidebar trees now shows **skeleton screens** instead of a blank area or a fake empty state like "Please select a note"; clicking a file navigates first and then loads; network requests now have timeouts (previously a hung request left the UI spinning forever); if one panel fails to load, only that area collapses and can be retried, instead of the whole app turning into an error page
- **Two cloud sync fixes**: the web version / mobile finally show **"Sync vault sections"** (previously all cloud content was lumped together); **subpages can be checked individually** for syncing, and you can tell which ones are "Synced"
- **Workspace files panel**: only the current workspace stays visible; the rest are tucked under "Show all workspaces"
- **Chat**:
  - The task overview's "Sources / Outputs" now lists **the most recently used items first**
  - Errors are no longer English error codes but explanations you can act on (quota used up, per-turn cost limit exceeded, input too long, etc.)
  - Fixed: in a new conversation, **the model jumped back to the default after sending** — previously only the display before sending showed the model you used last, while the message actually went out with a different model
  - Fixed: after Agent Desk opened a note, **an undeletable box appeared at the end of the chat input line**
- **Settings**:
  - "Tangu" is demoted from a top-level category to a subcategory under Forsion
  - The three model slots — auxiliary LLM / image recognition / image generation — all switch to **dropdowns** instead of laying out hundreds of models in one row; "Default model" no longer has to be typed in by hand
  - The environment check supports **"Let Tangu install it"** — hand missing Node / Python and the like straight to Tangu to install, and it picks a package manager that actually exists on this machine
  - **Bundled Node runtime**: works even without Node installed (if the system has one, the system's is used and nothing is taken over)
  - Web search: Zhipu now offers selectable **search tiers** (the default is switched to Quark, which is more accurate for long-tail Chinese queries)
- **Agents / engine**:
  - **Image recognition fallback** — when the main model can't see an image pasted into chat, the image is converted to text first and then passed along; new "Image recognition" setting with three modes (Auto / Always / Never)
  - **DeepSeek V4 support** (1M context + thinking effort); fixed V4 being misjudged as "able to see images", which wrecked the whole conversation turn
  - Background agents gain a **clone mode**: they make their judgment in passing within the full context instead of starting a separate turn
  - **Session summaries**: preview them by hovering in the sidebar; `[[` can reference sessions; `/export` now exports everything in high fidelity
  - Web fetching hardened: `web_fetch` no longer blindly follows redirects (a security hole), and body extraction is rewritten — less noise, and huge pages no longer stall
- **Bluebird Favorites plugin 1.4.1**: run queue (paste several in a row to queue them; keeps running and saving when you switch away), a progress step bar, a history list (cover / duration / author), a word-count banner and chapter jumps on the result page, JSON export; **Bilibili videos can play embedded**, and clicking a timestamp jumps there and plays
- **Plugins**: every plugin automatically gets a "Working folder" setting; the default workspace for sessions moves to `Sessions/` in the vault

## 2.7.4 (2026-07-31)

> Identical to the previously released 2.7.4-beta.1; if you already have the beta installed, just update.

- **Dashboard (new)**: a new kind of note — lay out cards freely on a 24-column grid, where a card can hold anything a note can (body text, images, embedded notes / databases / whiteboards), plus three function cards: clock, weather and web page. Once it's arranged, you can "Lock" it into browse mode (no dragging or text editing, but links still work and the clock keeps ticking). It's still a regular note, so search, wikilinks, cloud sync and opening in Obsidian all work as usual
- **Whiteboard overhaul**: choose a **finite paper size** (A4/A5/B4/B5 + portrait/landscape) and you can't draw off the page; **multi-page documents** — the page strip has a "+ New page" button at each end, and you can switch between vertical and horizontal layout anytime (content moves along with its page when you switch); **grid** horizontal and vertical lines toggle independently, each with its own spacing, and opacity is adjustable; **compact panel** (the toolbar collapses into a single row at the bottom). Also fixed drop-point offset, the paper drifting while panning, and flickering when pushing against the paper edge
- **Automation**: insert a **button** into a note that runs a preconfigured rule with one click; new "Manual (button)" trigger; database **content changes** can also be a trigger condition, and actions can **add a row / update a row**
- **Automation suggestions in chat**: when the conversation touches on something worth automating, a few clickable chips appear at the end of the reply — clicking one is the same as sending that sentence yourself, and no rule is created at that point
- **A batch of note editor updates**:
  - Callout folding interaction is finalized — **click the title line to fold / double-click to view source**, and it collapses automatically on blur; tokens like `[!note]` no longer stay visible; the left vertical bar is removed; titles support block-level syntax like `##` and `- `; expanding and collapsing are animated
  - New **`</>` view source** button: hover over the top-right corner of a formula, an image / PDF / file embed, or a plugin block and click it to see the literal source; it restores automatically when the cursor leaves
  - `[[ ]]` wikilink completion now also suggests **attachments and databases** (previously they never made it into the list once you had lots of notes)
  - Blank lines are no longer saved as `<br />` (reported as "mysterious `</br>` all over the file"); inline `![[image]]` can now sit mixed in with text; after two blocks are merged the cursor lands **at the seam** instead of at the end of the paragraph
  - When deleting a note, attachments referenced only by that note can be deleted along with it (it asks first and can remember your choice)
  - Slash menu icons are unified into one set (previously the plugin path had no icon library at all — it was all emoji)
- **Appearance**: **fonts for three slots** — UI / body / monospace — are customizable (leave blank to follow the theme); scrollbars are transparent when idle and appear only while scrolling or hovering; the gap between the top tab bar and the content is tightened
- **Chat**: `/compact` now has a progress bar (previously it just popped up a single notice and nothing followed); the slash menu can be summoned from **anywhere** in the input box, without clearing what you've already typed
- **Computer Use**: the virtual mouse and the target window's edge glow **are finally visible** (the edge glow had never actually been drawn before); clicks no longer steal focus; first install / upgrade no longer requires typing commands in a terminal
- **Mobile catch-up**: notifications now pop up; 20+ dialogs that "did nothing when tapped" (new folder, add property, save as collection…) are fixed; font settings no longer revert after a restart; the command palette / quick switcher / Achievements entry points went from "dead when tapped" to actually working
- **Agent capabilities**: subtasks can run **in parallel** and inherit the current context; new **self-brainstorm** (the same persona splits into several perspectives that critique each other, then combines the results); long tasks wrap up more solidly (output paths, literal names and web deliverables are self-checked); when command-line output is truncated, the full output is saved to disk and its path is provided
- **One-stop Windows updates**: installs silently and restarts automatically, instead of dropping you back into the setup wizard
- **Settings "Forsion plugins" page**: fixed the layout of the documentation in the details view, built-in / external plugins are split into two sections, and card styling is unified
- **Removed "Claude subscription sign-in"**: that entry kept failing with `Redirect URI … is not supported by client`, and it turned out it was impersonating Claude Code's client identity, so it has been removed entirely. To use a Claude subscription, run your local Claude Code directly under "Runtime engine"; if you have an Anthropic API key, you can connect directly (newly supported)

## 2.7.3 (2026-07-28)

- **Web apps can be listed on the Market**: Web apps published from Coding Space can apply for listing with a one-line description; once approved by platform review, they appear under "Market → Web apps" and open with one click. Check the status anytime in publishing management, where you can withdraw or unlist; rejected applications come with a reason and can be resubmitted after changes (publishing itself still needs no review)
- **Web apps can use cloud agents directly**: A single line of `forsion.ai.agent` in a page starts a cloud agent conversation (with web search and Python execution); context is managed by the platform, so you don't have to maintain a message array yourself; the model is chosen by the platform
- **Eleven Amadeus editor improvements**: Shift+Enter now does "Split block" instead of "New empty block" (a to-do split off stays a to-do), line breaks within a block are saved as a single newline following Obsidian semantics (reopening a note no longer collapses the whole block), plus line styles, heading levels, emoji, database row order, keeping the cursor when switching between edit/preview, and true split view
- **Dropbox sync now signs in via link**: One click opens the browser for authorization and the authorization code is filled in automatically, with no more manual copying (if the loopback port fails to start, you can still paste it manually)
- **Beta channel**: You can opt into beta updates in Settings (off by default); version comparison now follows standard semver, so you can move back to stable releases after using a beta
- **Auxiliary models**: Models used by background and special agents are now collectively called "Auxiliary models", with a new "Image recognition" slot — when the main model can't read images, images produced by tools like screenshots and image viewing are first turned into text by it before entering the context
- **Coding Space preview now uses the same host as the built-in browser**: Pointer lock (3D / FPS projects), fullscreen and downloads all work, with no need to fall back to "Compatibility mode"
- **Computer Use**: Coordinate clicks no longer bring the target window to the foreground, and the live view is now a persistent capture stream — no more dropped frames, and it adapts to the window size
- **Long tasks are less likely to stall halfway**: If streaming output disconnects midway, it automatically picks up where it left off (up to 3 times per task); before wrapping up, if the to-do list still has unfinished items, the agent is nudged to finish them first; `/verify <command>` can require "done only when it runs green", and if the last attempt still fails it is reported honestly rather than faked as green
- **Interjection queue**: Messages sent while a task is running first wait above the input box (not yet in the conversation) and move in only once actually delivered; each one can be deleted, recalled with ↑, or sent with "Interject now" to interrupt the current task
- **Plan mode can "Approve and start automatically"**, so you no longer need to send a message to get it going
- **Pick up where you left off after an interruption**: Interrupted replies are marked, so in the next turn the agent knows the task isn't finished and won't treat it as wrapped up

## 2.7.2 (2026-07-27)

- Fixed: The Android version showed a blank screen on launch with a "UI rendering error" message. Desktop (macOS / Windows / Linux) is unaffected and identical to 2.7.0; if you have 2.7.0 / 2.7.1 installed, **no update is needed**
- Fixed: Cloud notes on mobile and web were missing a few endpoints (reading/writing plugin custom file types, listing and revoking public links across vaults), so those actions failed when used

## 2.7.1 (2026-07-27)

- Fixed: The Android package wasn't released with 2.7.0 because of a mobile build failure. Desktop (macOS / Windows / Linux) is identical to 2.7.0; if you have 2.7.0 installed, no update is needed

## 2.7.0 (2026-07-27)

- **Agent Desk showcase panel (on by default)**: When an agent finishes its work, it can place the results right beside the chat — notes, images, web pages, code or any in-app view — and while it writes files you can watch a live "Writing" stream. The panel uses the real note editor, so you can edit directly in it; the agent can also take a screenshot to check its rendering and fix the layout itself if it's off
- **Pinned task overview card**: When the window is wide enough, the right side of the chat shows this task's plan, work scope, reference sources and output files; sources and outputs can be opened, and sections are collapsible
- **Approval modes now come in four levels** (Read-only / Approve for me / Full auto / Custom), each with an icon and a one-line description; new sessions automatically carry over the approval mode, model and thinking effort you last used
- **Thinking effort is now sent according to each model's actual capabilities**, expanded to seven levels (Off → Max). Previously it only really took effect on official OpenAI endpoints; now directly connected models such as Anthropic / Gemini / DeepSeek / Qwen / Zhipu / Kimi / OpenRouter / Ollama each receive it in their own protocol, and unsupported levels automatically step down to the nearest supported one
- **The model picker is now a two-level menu** (one page each for model and thinking); when opened, the pill and the menu share the same width
- **18 slash commands added** (`/help` `/status` `/export` `/cost` `/copy` `/retry` `/approval` `/agents` `/tools` `/mcp` `/plugins` `/memory` `/config` `/login` and more), plus support for **custom commands**: just drop an md file into `~/.tangu/commands/`; the body supports `$ARGUMENTS` / `$1..$9`
- **Work scope can include extra folders**: Let an agent read and write multiple directories in one session; each is listed in the overview card and can be removed anytime
- **Drag from the workspace into the chat to reference it**: Sessions, notes and files can all be dragged in, and dropping one creates a reference in the input box; when you drag in a session, the agent can read what was discussed there
- **Project-level instruction files**: `AGENTS.md` / `CLAUDE.md` in the working directory are read automatically (searching upward from the working directory until the project root)
- **Web search can use your own key**: Settings → Models → Web search (Bocha / Tavily / Zhipu / DuckDuckGo); it takes effect as soon as you fill it in, no restart needed
- **Automation upgraded to "trigger × action chain"**: One rule can chain multiple steps — send a notification, run an agent or call a tool directly; schedules are unified into three types, "Daily / At a specific time / Every interval", and event triggers come with a full catalog (including events declared by plugins). The Inbox's "Scheduled send" is retired and scheduled reminders are now handled by Automation (existing scheduled messages are still delivered at their original times)
- **Telegram and QQ support** (previously WeChat only): Settings → Channels shows one card per channel, each with its own enable toggle, credentials, default agent and model, and approval mode
- **Connecting a channel opens a brand-new session** instead of sharing one default session; past sessions stay in the channel folder in the sidebar so you can switch back anytime
- **Inbox can forward to channels**: Push important messages straight to WeChat / Telegram / QQ on your phone
- **Built-in browser**: Open web pages right in the app; links inside the app no longer have to jump to the system browser (can be turned off)
- **Built-in terminal**: A real login shell — vim / top / ssh / colors / Ctrl-C all work properly
- **HTML preview now runs on a local server**: 3D scenes such as three.js, external resource loading, and file import/export in web pages finally work inside the app
- **External MCP endpoint in Settings** (off by default): When enabled, Forsion Desktop can serve as an MCP server for external clients such as Claude Code; copy the setup command right from the panel
- **The startup splash now loops** and only fades out once the UI has actually rendered — no more "the animation finished but the app isn't up yet" with many plugins or a large working directory
- All-new top-right notifications: cards slide in from the right and stack automatically to fill gaps, the countdown pauses on hover, and errors stay until you close them; "Settings → Notifications & status bar" lets you toggle them per event and per plugin (with test notifications)
- New status bar at the bottom of the window that adapts to the current view and Space — current Space, number of running sessions, sync status and progress, backlinks and word count for the current note, and unread Inbox items; each item can be hidden or reordered by dragging, or the whole bar turned off (word count moved here from the editor toolbar)
- **Ribbon split into top and bottom zones**: Spaces on top, commands at the bottom; supports folders, automatically tucks overflow into "…", and lets you pin any command to the command zone; drag-and-drop was reworked so items land exactly where you drop them
- **Settings gets sub-categories**: Long pages (General / Models / Agents / Plugins / Advanced / Skills / Sync) now have a horizontal row of tabs under the title; swipe left or right to switch
- Unified borders and selected states in Settings: no more black borders in dark mode or bright borders in light mode; selection is now a thin line with a light fill instead of a double solid border
- **"Theme" is renamed "Appearance"**; smooth cursor (Word-like cursor gliding) graduates from experimental and is **on by default**
- The new tab page is reorganized by source: Recent / Forsion native / one group per plugin; cards can be dragged into the main area or sidebar to "open where dropped". "Recent" now covers all files and feature views, not just sessions and notes
- You can set which Space opens by default on launch (fixed "the default Space gets overridden by the last layout after a restart")
- Image files open in the app; click to toggle between "Fit to window / Actual size"
- Notes: `![[Note name]]` now transcludes an entire note (previously only `![[Note#block]]` was supported)
- Notes: Attachment uploads show a placeholder first and then swap it in, so you can see progress on slow networks
- Notes: Arrow keys move by visual line within a block and land on the same horizontal column across blocks; read-only blocks such as images / embeds / databases can be passed through (their source shows when selected)
- Notes: Inbox message bodies render with note rules (both `[[link]]` and `![[embed]]` work); the Calendar legend now shows the vault each calendar belongs to
- "Cloud sync" is officially renamed **"Online sync"**
- **Remote sync, round two**: Adds Dropbox; sync mode can be Two-way / Backup only (push) / Restore only (pull), and one-way modes never propagate deletions; a new "Dry run" shows exactly which files will be pushed, pulled or deleted; transfer concurrency, ignore rules and the per-file size limit are all adjustable; sync progress shows live in the status bar and panel; sync now has its own "Sync" section in Settings
- Login credentials now have a single source of truth: command-line `tangu login`, desktop sign-in and sign-out no longer disagree; the account card distinguishes "Signed out / Session expired / Engine not started", so you no longer see "signed in, but the backend isn't running". Signing out on the web now actually revokes that token (across browsers); desktop sign-ins now last 30 days instead of 7
- **Plugin bundles**: One plugin package can ship engine plugins, agents, skills and Spaces together, all set up with a single install; the plugin page in Settings is unified into one page (Forsion plugins + Tangu engine plugins), with bundled content managed as a cascade under the parent plugin card
- **Plugin capability parity**: A new "block surface" extension point lets plugins render **real note blocks** in their own UI. The only difference left between built-in and external plugins is that "built-in ones come pre-installed". Plugins can also send top-right notifications, register status bar items and declare Automation events; Spaces shipped with a plugin appear in the Ribbon as soon as it's installed
- **Coding Space can publish as a web app in one click**: You get a public link after publishing, and visitors pay for AI usage with their own accounts; Desktop adds a "Public" Space to manage published sites and note share links in one place
- Fixed: When Tangu or an external program (Obsidian, the command line) changed an open note, the UI sometimes didn't refresh until the note was reopened, and continuing to type would overwrite what had just been written. Detached windows never received these changes before; they now follow along in real time too
- Fixed: When switching between "Local / Cloud" vaults, the note open in the previous vault was written into the new one
- Fixed: Cloud models occasionally hung "with no output and no error" (heartbeats were treated as data, so the timeout never fired)
- Fixed: Context usage showed zero after reopening a past session; the "Compact context" button in the context progress ring was out of the mouse's reach
- Fixed: The opposite side flashed when expanding a sidebar, the sidebar was forcibly widened after closing split view, and multiple blinking cursors appeared in one message

## 2.6.9 (2026-07-23)

- Fixed: The installed macOS build failed to open, showing "A JavaScript error occurred … Could not find sherpa-onnx-node" on launch (affected downloaded installs of 2.6.0–2.6.8). If you've already hit this on an older version, run `xattr -dr com.apple.quarantine /Applications/Forsion.app` in Terminal to open it, or simply install this version
- After the first successful launch on macOS, the app automatically clears leftover system quarantine attributes inside its bundle — native components such as voice input and the built-in engine no longer need manual Terminal commands
- The local recognition component for voice input now loads on demand: even if it fails to load in some environments, only local speech recognition is affected, not app startup
- The installer now includes the third-party LICENSE/NOTICE files for the remotesync component

## 2.6.8 (2026-07-22)

- The first-launch onboarding page lets you switch between Chinese / English from the top-right corner
- "Connect account / AI service" in onboarding is no longer mandatory: click "Skip for now" to enter the main UI without connecting, and sign in or connect later anytime in Settings
- Fixed: Installing a Forsion plugin from the Market put it in the wrong directory, so it didn't take effect — plugins are now installed to the right location based on their actual type (Forsion plugins and Tangu engine plugins install separately), and reinstalling after upgrading automatically cleans up broken copies left in the old location
- Installing a plugin no longer jumps to the Settings page; instead, click "Open settings" on the plugin's detail page when you need it

## 2.6.7 (2026-07-22)

- New theme "Genesis Glass": native macOS glass, where the shell (ribbon / sidebar / tab bar) melts into the wallpaper behind the window while the main view's paper cards stay solid and body text never shows the background through; works with any color scheme
- Theme settings can now be tuned: select a theme on the settings page to adjust glass intensity, overlay blur, tint vibrancy, borders and more in place (themes can define these options)
- Light/dark mode adds "Follow system"; the Glass theme always follows the system appearance (switching automatically with macOS light/dark)
- Sidebars in secondary screens such as Settings and Market now also adapt to the glass effect instead of being a solid block
- Agents can now use the built-in "Forsion extension development" skill to scaffold plugins / themes / Spaces / agents from the official templates

## 2.6.5 (2026-07-19)

- The default theme is now Genesis classic colors + flat style (all platforms; users who have customized their appearance are unaffected)
- The command palette adds "Zoom in / Zoom out / Reset zoom" commands (also bound to Ctrl/⌘ +/-/0 on desktop)
- The web version is zoomed in 10% by default for more comfortable reading
- Agent memory syncs to the cloud instantly: as soon as a conversation ends, that agent's memory/logs are synced, and opening the memory view automatically pulls the latest from the cloud — memory on mobile/web and desktop no longer lags behind
- Web/mobile sessions now have Historian too: after going idle it automatically summarizes the session title and records the day's log (requires an admin to enable it in the admin console)

## 2.6.4 (2026-07-18)

- Amadeus sharing: publish status indicators added to the note list and page header; subpages inherit their parent page's publish status; public share pages can render databases
- Plugin system: plugins can register custom views (shown in the workspace panel); after installing a plugin you get an onboarding ready card, and can open the plugin directory in one click
- Fixed: Amadeus cloud sync not starting after sign-in, and the cloud sign-in prompt not going away
- Fixed: Sidebar width occasionally jittering (unstable width after dragging)
- Fixed: Speech recognition models no longer mix into the chat model list
- UI: The workspace right panel is collapsed by default and expands with one click when needed (old layouts are migrated once automatically)

## 2.6.3 (2026-07-18)

- Switching notes in cloud mode (web/mobile) is much faster: notes you've viewed switch back instantly, clicks highlight immediately, and very long notes no longer freeze the UI
- Fixed: Sending messages on mobile failed with "unknown app id"
- Mobile UI redesign: sidebar panels go full-screen (no longer running into the status bar), the settings page uses horizontally scrolling tabs at the top, and the overall display is enlarged by 15%
- Mobile supports the system back gesture: close overlays / sidebars / whiteboards and go back level by level instead of exiting the app right away
- On mobile, the sidebar selection now correctly follows when you open a whiteboard/PDF

## Forsion 2.6.2 (2026-07-17)

- **Android: Fixed cloud chat messages failing to send** — the old package reported `unknown app_id` when sending messages (it used a deprecated app identifier); web / mobile / desktop now all use `tangu`, so cloud sessions and the admin "App model configuration" are down to a single copy. **If you have the 2.6.1 or earlier APK installed, please install this version over it**
- **The web version is now titled Forsion** (it used to show Tangu); the web version no longer sends plugin probes to local addresses (red noise in the console)

## Forsion 2.6.1 (2026-07-16)

- **Fixed: Desktop installers failed to launch** — the macOS / Windows / Linux installers from v2.3.3 to v2.6.0 had a packaging defect (app dependencies weren't bundled), showing an `ERR_MODULE_NOT_FOUND` error dialog on launch. It's fixed, and a hard check has been added to the release pipeline so this kind of issue can never ship silently again
- **Android: The app name is now "Forsion"** (it was mistakenly shown as Tangu; the package name and sign-in redirect are unaffected, so you can install over the existing app)
- **Android: Sign-in fixed** — in-app sign-in now correctly points to the official Forsion server (it used to redirect to localhost, making sign-in impossible); self-hosting users can override it with the `VITE_API_ORIGIN` build variable

## Forsion 2.6.0 (2026-07-16)

- **Built-in whiteboard** — "New whiteboard" from the command palette / vault sidebar creates one you can draw on right away: freehand shapes, connectors, text, a library, and light/dark that follows the theme; whiteboards are stored in the vault in the open `.excalidraw.md` format (interoperable with whiteboard tools that support it), `[[Whiteboard name.excalidraw]]` in a note takes you straight there, and they have their own icon in the tree so they're never mistakenly opened as regular notes
- **Native PDF annotation** — annotate PDFs in your vault right in the app: highlight / underline / strikethrough / squiggly / sticky note / text / shapes / bookmarks, with annotations **written into the PDF file itself** (visible in other readers too); includes a thumbnail sidebar and an annotation list, and selecting text pops up the annotation bar
- **Sync local notes to the cloud item by item** — no need to move the whole vault: pick any folder or single note in a local vault and choose "Sync to cloud" to attach it to your cloud vault (two-way sync, works offline, keeps up with renames/moves); image attachments in the body come along; cloud attachments are visible and downloadable under Account → Cloud storage (5MB per-file limit; the sidebar clearly flags anything over the limit)
- **All-new "Automation" Space** — a rule = a trigger (schedule / event) + any agent you choose to run unattended, managed in three columns: rule list / flow builder / trigger history; agents also get their own **schedule** (pure planning reminders, or automatic execution when due; each rule's execution transcript can be reviewed)
- **Achievements** — unlock badges through everyday use (chatting, notes, themes, WeChat remote…); an animation pops up above the input box when you earn one, and the trophy icon in the left bar opens the Achievements panel where you can **claim points**; plugins can register their own achievements too
- **Voice input** — a new microphone in the chat input: choose **local offline transcription** (download the model once, no network needed afterward) or transcription by a cloud / your own provider's model; macOS asks for microphone permission on first use
- **Group chats remember what was said before** — start a group chat mid-conversation and participants can now see the earlier conversation (compressed automatically before being injected, so long chats don't overload it); follow-up messages in the group chat keep the context too
- **Three fixes for the bring-your-own-API-key (BYOK) experience** — ① after you add a direct provider, the model picker consistently lists your models grouped by provider (no longer displaced by cloud models with the same name); ② **you can chat with your own key without signing in to Forsion** (this used to fail with a cloud 401); ③ support for OpenAI's latest official models (gpt-5.x): both regular chat and thinking mode work, **the thinking process is visible**, and "function tools not supported" no longer appears
- **Default thinking depth is now "Medium"** — new sessions reason by default (adjust or turn it off anytime in the model picker); the model menu in cloud sessions explains why only hosted models are listed
- **Per-agent tool allowlists/blocklists** — allow or disable built-in tools as needed on the agent edit page; **Muse can "watch tasks"**: set schedule/event rules to wake it automatically when due (using the local activity log as its data source; can be turned off in Settings)
- **Tangu engine plugins can be installed from npm** — `tangu install npm:<package-name>` fetches the package contents directly, **runs no install scripts**, and places it atomically after verifying integrity for better safety; plugin tools can declare their own approval mode
- **Android version (preview)** — the mobile app ships in step with desktop versions (connects to the cloud by default, local mode also available); web/cloud sessions can now **create custom agents** too (synced with desktop)
- When the model automatically retries after network hiccups, the UI shows "Retry N / M" instead of just waiting; runtime error messages are easier to read
- **Calendar Space fully rebuilt** — the special "Calendar date" and "To-do" properties are no longer needed: any database with a **date property** can now join the calendar via **"+ Add Forsion database"** in the right panel or the database's **View settings → "Add to Calendar Space"**; when adding it, choose which column is the date anchor and optionally which column is the completion checkbox (both can be changed anytime). Each database in the right panel's calendar list can be **renamed / set as default / opened in a new tab / remapped / recolored / removed from the calendar**. Old calendar databases are **migrated automatically**, with no need to add them again
- **Database toolbar enhancements** — the top-right of a database adds **search** (filter rows by title), **open as a full page in a new tab**, and a **View settings** gear; View settings now include **sort** and **filter**
- **To-do list time window + settings** — the top of the to-do list can switch between **Day / 3 days / Week / Month / Custom days** (centered on today, symmetric before and after) and shows only the to-dos in that range; ⚙ settings let you **hide completed** items and sort **alphabetically / incomplete first / completed first**
- **Global quick find** — a new search icon in the Ribbon (or ⌘P) opens a centered panel for quickly jumping by name to **notes / databases / chat sessions**, listing recent items when nothing is typed; "Add Forsion database" in the right panel now uses the same centered search panel
- **Jump from a note's title into the body** — press **Enter** in the title, or **→ at the end** of the title, to go straight to the first line of the body
- **Fixed** — how the completion checkbox on event cards looks in dark/light themes
- **Detached windows (multi-window workspace)** — **drag** any tab **out of the main window**, or **right-click it and choose "Move to new window"**, and it becomes a standalone window (filling the main area by default); you can then **drag other tabs across windows** into it and arrange them side by side. Detached windows **have no left activity bar** (to tell them apart from the main window), and their position / size / layout are remembered and **restored automatically the next time you open the app**
- **Mini floating card mode (with shortcut)** — press **⌘/Ctrl+Shift+M** (or "Open Mini card" in the command palette) to pop up a compact floating card: a fixed **3:4 portrait** ratio, a Space switcher bar on top and the content directly below (a streamlined take on the mobile single-column UI with extra sections removed), **always on top and alongside the main window**; **drag the card to a screen edge and it snaps and collapses** into a thin strip, then **expands again when you hover over it**

## Forsion 2.5.2 (2026-07-11)

- **Notes now support page decorations** — above the title you can add a **large emoji icon** (click "Add icon" to get a random one first, then click it again to change or remove it) and a **cover image** (it opens straight to a set of curated photos; you can also search an online library (Openverse, no setup needed), paste an image link, or upload from your computer; hover to change or remove it; if the library can't be reached you get a clear notice and it falls back to the curated set); both are stored in the note's frontmatter (`icon:`/`cover:`), a common format other note apps can read too
- **Cover picker and cover banner redesigned** — the picker is now a popover anchored next to the button (no longer covering the whole page) with underlined "Gallery / Link / Upload" tabs (the gallery tab opens on curated picks and can also search Openverse), a four-column thumbnail grid with source credits, and a light overlay and outline on hover; **clicking a thumbnail swaps the cover without closing the picker, so you can try several in a row**, and it closes only when you click outside. **The cover banner itself** is redesigned too: it now sits inside the content area with rounded corners; hover and click **"Reposition"** to unlock it, then drag the image up or down to set the focal point (saved in the note; click "Done" to finish; locked by default to prevent accidental drags); a soft gradient at the bottom fades into the page background so it flows naturally into the body; the banner lines up with the body text on both sides and its top sits flush against the toolbar; the picker popover is now a wide horizontal panel that opens below the button and lets you try covers in a row (clicking a thumbnail swaps the image without closing; clicking outside closes it); colors, borders and light/dark all follow the current theme
- **Pinned footer in the notes and sessions sidebars** — **Trash + Vault** in the notes sidebar and **Add local project / Archived** in the sessions sidebar are now pinned to the bottom of the sidebar, so a long list never pushes them out of view; the "Recent" and "Today" entries have also been removed from the notes sidebar
- **Selected blocks can now be controlled from the keyboard** — while editing, press Esc or click a block handle to select a block (highlighted outline): Backspace/Delete deletes, Cmd+C copies, Cmd+X cuts, Cmd+V pastes as a new block, Cmd+D duplicates the block, Enter goes back to editing, and ↑↓ moves the selection
- **Columns are properly fixed** — previously, making columns split the block and every block above it into two halves; now `/columns` or "Move to new column" in the block menu puts only **the current block** on its own row next to a new empty column; **dragging a block onto the left or right edge of another block** (a drop indicator appears while dragging) places it side by side with just that block in two columns, leaving all other blocks untouched
- **Fixed a batch of menus that did nothing when clicked** — New folder, New base, Rename folder, Bookmark, Save as collection and Add property (the desktop app doesn't support the browser's prompt dialog, so all of them now use an in-app input box); "Embed block" now shows an input box when the clipboard has no reference, instead of silently doing nothing; the "Link database" list no longer occasionally comes up empty
- **Fixed: the online cover library returned no results no matter what you searched** — the search parameters exceeded the free library's anonymous limit, so every request was rejected; this is now corrected and both Chinese and English keywords return images (you only get a notice and fall back to curated picks when the service is truly unreachable)
- **Fixed: no external web images could load at all (the renderer's content security policy didn't allow https image sources)** — bookmark card site icons and preview images, URL covers and embedded YouTube bookmarks were all silently blocked by it; they're now allowed and all of the above work again
- **Fixed: after opening the slash menu, the `/` disappeared and you couldn't back out** — typing `/` now leaves the `/` visible in the text, and pressing Backspace deletes it and closes the menu (with an empty menu, one more Backspace cancels outright); when you pick a menu item, the `/` is replaced automatically
- **Undo / redo (Cmd+Z / Cmd+Shift+Z / Cmd+Y)** — note editing supports document-level undo: not just text within a block, but creating, deleting, merging, moving and slash-converting blocks can all be undone and redone step by step (each note keeps its own history after you switch notes, so you never accidentally change another note)
- **After picking from the slash menu, the current block converts in place, the `/` always disappears and the cursor stays put** — choosing Text / Heading / List / To-do / Quote converts **the current block** to that type directly; previously a `/` occasionally lingered in the line, text was lost during conversion, or the cursor lost focus; the root cause was a sync race between the editor and storage, so it's now done as a single transaction inside the editor (delete `/` + convert) and verified item by item with browser automation; only blocks that must stand alone, such as database / table / code, are created below
- **Fixed: typing `/` after a space following text didn't open the menu** — a trailing space at the end of a line is actually stored in the editor as a non-breaking space, so the old "open only after a space" check never matched; now typing `/` at the start of a line or after any space reliably opens the type menu
- **Fixed: typing `#` on a heading line stacked levels deeper or got stuck** — previously typing `## ` at the start of an H1 line turned it into an **H3** (added on top of the existing level, so the line looked like it had several `#`s); now **the level is set directly by the number of `#`s you type** (`## ` on an h1 = h2, `### ` = h3, retyping the same level changes nothing), and the `#`s are consumed as you type and never left behind as text; **typing `- `, `1. `, `> ` or `[] ` on a heading line also converts it straight to a list / quote / to-do** (previously none of these worked on heading lines); Backspace at the start of a heading line still first demotes it to a normal paragraph
- **`[] ` makes a to-do, and numbered lists can start at any number like `5. `** — typing `[] ` (or `[ ] `, `[x] `) plus a space at the start of a paragraph turns it into a to-do (previously nothing happened); an ordered list that starts with `5. ` is numbered from 5; typing `[] ` in a list item turns that item into a to-do in place, and `- ` / `1. ` switch between list types
- **Databases: your selected view is remembered** — switch to another view, leave the note and come back (or restart) and it still shows the view you last picked; it's stored in the note (written as `![[table.db|view name]]`), so the same database embedded in different places can show different views
- **The left sidebar remembers its last view and width after collapsing and reopening** — it no longer jumps back to "Tags" and resets its width every time; collapsing and expanding keeps the view you were on (Notes / Search / Tags), and the left sidebar can be freely resized with its width remembered
- Bullets and numbers in bulleted/numbered lists now have explicitly declared styles, so they always show in any environment
- Details: focusing the title of a new note no longer selects all its text (the full-line blue selection looked like a box around it), and the cursor lands at the end of the line; the outline around the title while editing (especially noticeable in dark mode) is gone too (the global keyboard focus ring was wrongly hitting the title input); the "Type something, or press "/" to pick a block…" placeholder only shows in **the empty block where the cursor is**, and other empty blocks stay blank
- **Deleted notes now go to a trash** — deleting a note, file or folder moves it to `.trash` inside the vault by default (no confirmation dialog anymore); "Trash" at the bottom of the left sidebar lets you browse it, **restore items to their original location in one click**, delete them permanently, or empty it; items in the trash are excluded from search, links and the graph
- **Code blocks fully upgraded** — syntax highlighting (37 languages, colors follow the theme), and on hover a **language picker / copy / wrap** toolbar appears in the top-right corner; the language is simply the ```` ```py ```` fence tag, and changes are written to disk right away
- **Databases: every view can now be filtered** — a "Filter" button on the right of the view tab bar lets you add conditions per column (contains / is / greater than / before / is empty…; only rows matching all of them are shown), and the conditions are saved in the view; **sorting is persisted too** (no longer lost when you switch pages); the view menu lets you **hide columns per view**; a **summary row** is added at the bottom of the table (appears on hover; choose count / sum / average / max / min / checked count)
- **Databases get a new "Relation" column** — a cell can search for and link to notes in the vault directly (stored as a `[[link]]`), and clicking the chip opens the note
- **Hover a `[[link]]` to get a preview card** — after a brief pause you see a read-only preview of the start of the target note; move into the card to scroll it, and it closes when you move away
- **Pasted URLs become bookmark cards** — a URL on its own line automatically renders as a bookmark card (site icon / title / description / thumbnail); **YouTube links embed a player directly**; the slash menu adds "Bookmark"; hover the card and click ✎ to change the URL; the note file simply stores that URL line
- **Folding** — callouts support `[!note]-` folding (click the arrow to collapse to just the first line; the state is written into the note itself); **heading sections can fold**: hover the left edge of a heading line to reveal an arrow that collapses the whole section up to the next heading of the same level (remembered for the current session only)
- **Searches can be saved as collections** — type keywords in the full-text search panel and click "Save as collection"; a "Collections" section appears in the left sidebar, and one click replays that search
- **Pages can have an emoji icon** — click to the left of the title (appears on hover) to pick one, and it shows in the tree too; the icon is stored in the frontmatter `icon:` key, a common format
- **Cmd/Ctrl+F find on page inside the editor** — the floating bar highlights every match (across blocks) as you type, and Enter/Shift+Enter jumps to the next/previous match with automatic scrolling
- **Databases now support multiple views** — the same .db can have several named views, switched with one click from the tabs at the top of the embed: **Table / Board / Calendar / Gallery**; view settings are stored in the .db file, and old files need no migration (they open in the default table view)
- **Board view** — groups cards into lanes by a single-select column (in option order, plus Ungrouped); drag cards to another lane to change their status, and "+ New card" at the bottom of each lane adds straight into that group; if there's no single-select column, one click adds a "Status" column
- **Calendar view** — lays out a month calendar by a date column (date / calendar date), with multi-day ranges shown as bars; hover a day and click "+" to create a row on that day directly, with previous/next month and Today navigation; if there's no date column, one click adds one
- **Gallery view** — a grid of cards showing the title plus a property preview (option chips / checkboxes / human-readable dates)
- **Click a card in Board / Calendar / Gallery to edit it in place** — a row editor card pops up with every property stacked vertically and editable, including deleting the row; the three new views also work in "Note view" (Bases), where dragging a board card changes the note's frontmatter directly
- **Icons fully upgraded** — 30+ icons across the slash menu, database column types, view tabs, database headers and more have moved from characters/emoji to brand-new vector icons (bundled locally, no external dependencies), in the same visual family as the "Zhi" theme
- Click the active view tab (or right-click it) to rename the view, set its grouping/date column, or delete it (the last view can't be deleted)
- **`[[` references are no longer limited to notes** — databases (.db), attachments and every other vault file now appear in completion (with a small icon and a folder subtitle; duplicate names automatically include the path); clicking `[[xxx.db]]` opens a table tab in the app, while other files open with the system app; these file links are no longer treated as "notes not yet created" (no dimmed dashed style, no create prompt, no ghost nodes in the graph)
- **"Link database" added to the slash menu** — lists every .db in the vault to pick from and inserts an `![[database]]` embed directly (unlike "Database", which creates a new one; duplicate names automatically use the full path, so nothing gets mixed up)
- Fixed: option popovers for single-/multi-select cells in "Note view" wouldn't open; clicking `[[xxx.db]]` inside a database cell now also opens it in the app (previously the system app opened the raw JSON)
- **Notes can now be shared for collaboration and published** — for any note in the cloud vault, "Share" in the top bar opens a card: the **Share** tab creates an invite link (with an optional view password, an open period that defaults to 7 days, and read-only/edit permission), and once the other person signs in and accepts, you can collaborate in real time (sub-pages included), with a participant list where you can change permissions or remove people; the **Publish** tab creates a public read-only link in one click that anyone can view without an account, and you can revoke it anytime. A "Shared with me" section appears in the left sidebar; the desktop app **syncs shared pages into a local mirror** (readable offline, with changes synced both ways); the editor top bar shows **avatar dots for online members** (highlighted when on the same page). Sharing and publishing allowances depend on your plan: Free publishes 3 pages; Plus shares 2 pages and publishes 10; Pro shares 10 pages with unlimited publishing
- **Cloud vault + "Local | Cloud" pill slider** — a minimal pill slider now sits at the top of the left "Workspace" panel (above the Sessions/Files/Notes switcher) and switches between the local and cloud worlds in one tap, never mixing them: **Notes** switch to the cloud vault (the whole notes space follows), **Sessions** list only sessions from the cloud workspace, and **Files** show only cloud workspace storage; switching back to local works the same way (the slider only appears in the left sidebar's workspace panel). The cloud vault syncs **continuously in both directions** with your Forsion cloud vault: what you write on desktop reaches the web in seconds, and what the web or a cloud agent writes lands on desktop in seconds; it reconnects automatically after going offline and catches up, and simultaneous edits on both ends never silently lose content (the losing side is saved as an "xx (conflict date)" copy). Local notes never go to the cloud; the single-file limit is 5MB; it turns on automatically when you sign in to your Forsion account (you can pause it in "Settings → Notes")

## Forsion 2.5.0 (2026-07-10)

- **Create sub-pages right from a note with `/page`** — sub-pages go into an `X.fd` folder named after the note, a `[[link]]` is inserted in the body and the sub-page opens right away; files created with `/database` and `/note view` also go into `X.fd`; the parent note's frontmatter automatically maintains a `children:` list
- **New notes put the cursor straight in the title** — the title of a new note is focused and shows a faded "New Page" placeholder, so you can type a name right away (works for every way of creating a note)
- **The slash menu now sorts by match quality** — after typing `/` and a few more characters, candidates are ranked by how closely they match what you typed, instead of always putting "Text" first
- **"Notes as folders" in the tree** — notes with sub-pages become expandable nodes in the left sidebar (the `X.fd` folder itself is hidden); dragging a note onto another note makes it a sub-page of that note; right-click to choose "New sub-note"; renaming or moving a parent note keeps its sub-page folder in step, and deleting it first warns "Contains N sub-files" before deleting them all together
- **Links to notes with duplicate names are now stable** — each `[[` completion candidate shows a folder subtitle, and duplicates are no longer merged into one entry; picking a duplicate automatically inserts a path-qualified `[[folder/name|name]]`; links with a path resolve exactly by that path; bare-name links resolve to the same folder first, then to the note's own sub-pages
- **Clicking a `[[link]]` that doesn't exist now asks before creating it** — no more silently creating a note at the vault root; after you confirm, it goes into the current note's sub-page folder (links with a path are created at that path); unresolved links appear in the body as dimmed dashed text
- **The graph shows "ghost" nodes** — link targets that haven't been created yet also appear in the graph (dashed, dimmed, italic), and clicking one likewise opens the create confirmation
- **More accurate backlinks** — notes with the same name no longer pollute each other's backlink lists and excerpts (fixed on desktop, cloud and mobile alike; for existing cloud data it takes effect after saving or rebuilding the index)
- Note (intentional behavior change): previously, a path-qualified link like `[[a/Foo]]` whose path didn't exist fell back to matching a same-named note elsewhere by file name; it's now treated as unresolved (shown dimmed), and clicking it creates the note at that path

## Forsion 2.4.0 (2026-07-09)

- **Right-click "New base" in the notes tree** — right-click a folder or empty space to create a database (.db) whose file name matches the table title from the start; after that, changing the title in the table or renaming it in the tree keeps both in sync automatically, and `![[embed]]` references in notes follow along without breaking
- **.db databases open like notes** — clicking a .db in the tree opens a table tab in the app (it used to launch the system app with the raw JSON), with a new database-style icon; right-click still offers "Open with the system app"
- **Calendar only shows named events** — rows without a name no longer appear on the calendar as a random code string; an empty name in the editor card now stays empty instead of showing the code
- **To-do items can be clicked to edit** — click a to-do's name in the Calendar Space's left sidebar to open its editor card, where you can rename it, set a time, change properties or delete it
- **Zoomable calendar timeline** — use the +/− buttons in the top bar or Ctrl/Cmd + scroll wheel to zoom the hour height in and out, anchored at the center of the viewport; your preference is remembered
- **Dragging or resizing calendar events now updates times live** — the time range on the event block and the drop indicator changes as you drag, and it's saved only when you release
- Fixed: .db files in subfolders were left out of the calendar/to-do aggregation (they silently went missing)

## Forsion 2.3.4 (2026-07-08)

- **"Test connection" for third-party API keys no longer hangs** — with a wrong key or address, the test now returns a result after a timeout, and while it runs the button turns into "Cancel" so you can stop it anytime, instead of spinning forever
- **Fixed: switching to external CLIs such as Claude Code / Codex hung on Windows** — the root cause was the way `npx` commands were launched on Windows, so the process never started while the app kept waiting; this is now corrected and a handshake timeout is added, so a failed start reports a clear error instead of spinning forever
- **More accurate environment detection on the onboarding page** — fixed node/npm/docker being reported as "Not installed" on Windows even when installed (npm and others are `.cmd` files, and the old probe always failed on Windows); common install directories are now searched too; for Docker it only checks whether the client is installed, so Docker not running is no longer misreported as not installed
- **New "Test connection" button on the onboarding and settings pages** — after switching the network mirror (Direct / Mainland China), test in one click whether the npm and pip mirrors are reachable and see their latency, instead of guessing whether the mirror took effect
- Polished a number of details in Amadeus notes (live formula preview, `[[` wiki links) and the chat input

## Forsion 2.3.3 (2026-07-07)

- **Math formulas in notes can now be edited as you write** — while you're **editing that line**, a formula shows as editable `$…$` source, and it renders as clean KaTeX only when the cursor leaves the line (live preview); `$$…$$` block formulas are centered; a broken formula is only marked red in place and never blanks out the whole note again; prices (`$5-$10`) and environment variables (`$HOME`) are no longer mistaken for formulas
- **Chat input tidied up**: mode / context / model selection are all moved into a single bottom row inside the input box; context usage is now a small ring that only expands into token details on hover, for a cleaner interface
- **Note details**: block highlights only appear on hover/selection and disappear once you start editing; the top title bar drops its glassy look and blends into the background

## Forsion 2.3.2 (2026-07-06)

- **The Market adds two new categories: "Themes" and "Note plugins"** — installed theme packs show up in Settings → Themes right away (no restart); note plugins take effect in Amadeus as soon as they're installed. Both categories support submissions and update checks
- **Plugins can now be uninstalled** — plugins installed from the Market get an "Uninstall" button in Settings → Plugins that deletes the files, clears the settings and restarts the backend in one step (built-in plugins can only be disabled)
- **New Settings → Note plugins page** — enable or disable Amadeus editor plugins, open the plugin folder, or create a sample plugin in one click; plugins can now also live in the global directory `~/.forsion/amadeus/plugins/` and apply across vaults
- **Market security hardening** — listings sourced from GitHub are now pinned to the version that passed review; later pushes from the author must pass review again before they're distributed

## Forsion 2.3.1 (2026-07-05)

- **Amadeus adds "Note view" (each row is a note)** — type `/Note view` in a note to create one: point it at a folder and every note inside becomes a row of the table. The first column, **Page Name**, is the note name (editing it renames the file); the other columns are the note's properties (frontmatter) — edit a cell and it's written back to that note, with the note's frontmatter as the single source of truth. Pointing it at an existing folder automatically imports those notes and their properties as a table (missing columns are added); adding a row creates a note, and deleting a row deletes the note (with confirmation); change a note's properties elsewhere (the properties panel or another editor) and the table updates live
- **Regular database tables now follow the same first-column rule** — the first column, "Name", can't be deleted or change type (in Note view it's the Page Name); existing regular `.db` tables work as before, and both modes coexist

## Forsion 2.3.0 (2026-07-05)

- **The app and installers are now officially named Forsion** — installers are named `Forsion-<version>-<arch>`; on macOS you can delete the old "Tangu Agent 2.0.app" after installing (Windows/Linux upgrade in place automatically)

- **Data directories move with the brand** — `~/.tangu` is automatically renamed to `~/.forsion`, and the default workspace `~/Tangu` becomes `~/Forsion` (done instantly on first launch, with no copying and no data loss); compatibility symlinks are left at the old paths, so existing references from the CLI, WeChat, plugins and so on keep working
- **The app brand is upgraded to Forsion** — the welcome onboarding, window title and About page now use Forsion as the overall brand; Tangu is the name of the conversational agent Space within it

- **Custom Spaces** — "Save current layout as Space" in the command palette saves your current combination of views as your own Space; it appears instantly at the top of the left function bar, and you can right-click its icon to delete it. Recipes are plain data files (`~/.tangu/spaces/<name>/space.json`) that can be shared directly
- **The Market adds a "Spaces" category** — Space recipes can be submitted, listed and installed, and appear in the function bar once installed with no restart (a sample, "Focus", is already live)
- **Inbox fixes** — the + new tab button in the Inbox Space now opens the launcher properly; the right sidebar can now be expanded (showing the workspace by default); the mail list tab is no longer locked and can be closed and dragged; the new tab page in any Space can open the Inbox
- **Sidebars never sit idle** — expanding a sidebar with no default content now shows a drop placeholder instead of doing nothing

## Tangu 2.2.4 (2026-07-04)

- **Amadeus notes are open to everyone** — the "Amadeus" notes Space (WYSIWYG editor, `[[]]` wikilinks, vault, database blocks), previously visible only in developer mode, is now visible by default in the desktop app: enter it from the top of the ribbon, or create notes from the new tab page. It's still being polished — feedback welcome

## Tangu 2.2.3 (2026-07-04)

- **New community plugin: "Voice messages"** — turn it on for a chosen agent and its replies **become voice messages**: in desktop chat they appear as playable voice bars (synthesized only when opened, with duration and progress; click "Convert to text" to expand the text); over WeChat remote, **a playable voice file is attached in addition to the text** (tap to listen). Toggle it "Globally / Per agent" in Settings → Plugins → Voice messages; type **`/voice`** in the chat input to switch to voice and **`/text`** to switch back to text
- Reuses the TTS model you configured for "Read aloud" (Settings → Models → Read aloud); if none is configured, only text is sent and no messages are lost
- Note: WeChat's official bot platform doesn't support sending native voice bubbles (only text, images, files and video), so on WeChat replies are delivered as a "playable voice file" rather than a voice bar
- WeChat native voice uses SILK encoding (the same format as WeChat's built-in voice), synthesized entirely locally with no third party involved; when the split-reply plugin is also enabled, each segment is sent as its own voice message

## Tangu 2.2.2 (2026-07-03)

- **You can now attach "Hooks" to agents (Settings → Hooks)** — at lifecycle points such as before/after tool execution, approval, submission, session start, before compaction and run end, run your own shell commands for deterministic guardrails and automation the model can't bypass (like git's pre-commit): for example "block `rm -rf` when it's detected", "run prettier automatically after every file edit", "send a desktop notification when a run finishes" or "inject project conventions automatically on submit". Scripts receive JSON on stdin and block with exit code 2 or `{"decision":"block"}`; because scripts read JSON from stdin with a common convention, they can be reused across tools. Local only (never runs in the cloud); newly added hooks only run after you click "Trust" in the panel
- **Assistant replies can now be read aloud (TTS voice output)** — every completed reply gets a "Read aloud" button (click again to stop), and Settings → Models adds "Read aloud": enter a model from any OpenAI-compatible speech endpoint (SiliconFlow CosyVoice, OpenAI tts-1, self-hosted Qwen3-TTS and more; a provider can declare its own list of speech models), with voice and speed options; you can turn on "Read new replies aloud when finished" (current open session only); code blocks are skipped automatically and links are read as text only
- **Direct Alibaba Cloud Bailian connection + voice cloning / voice design** — point a provider's baseUrl at Bailian (dashscope.aliyuncs.com) and it automatically uses Bailian's native protocol (the full qwen3-tts-flash family works, and one provider can run both Qwen chat and speech); "Read aloud" adds a **Bailian Voice Studio**: upload 10–20 seconds of speech to clone your voice (¥0.01 each), or describe a voice in one sentence to design one (e.g. "a gentle, clear young woman's voice", ¥0.2 each, playable as soon as it's generated); choosing a voice automatically switches to the matching synthesis model so nothing gets misconfigured; **CosyVoice** (cosyvoice-v2, real-time WebSocket synthesis) and **CosyVoice voice cloning** (finer audio quality; Bailian requires the audio sample to be a public URL) are also supported
- **File previews now open as tabs in the main area** — clicking a workspace file no longer pops up an overlay above the input box (the overlay is disabled for now); instead it opens as a proper tab alongside chats and notes: you can drag it into a split, open several at once, and opening the same file again focuses the existing tab; preview tabs for local files persist with the layout and are restored after a restart
- **Edit workspace .md files directly in the note editor** — local Markdown files in preview tabs open in Amadeus WYSIWYG editing by default (same as notes), and changes are saved back to the original file automatically; frontmatter is preserved as-is; if the file is modified externally you're prompted to "Reload / Overwrite", and it's never silently overwritten; you can switch to source view
- **Types that can't be previewed offer to open in the system default app** — new "Open with default app" (in both the toolbar and the context menu), so unsupported types no longer just say "Can't preview"
- **File panel interactions filled in** — the "Files" tree in the right sidebar now supports single-click to select and double-click to open; a context menu (Open / Open with system default / New file / New folder / Rename / Copy path / Show in file manager / Move to Trash); dragging to move into folders, Alt+drag out to the system, and dragging OS files in to copy them; inline rename and create; and the whole tree refreshes automatically when an agent finishes a run
- Previews cover mainstream types including PDF, images, video, audio, Markdown, HTML (rendered + source), code (including .py syntax highlighting), JSON, CSV, diff, docx, xlsx and pptx
- **First-run onboarding adds an "Agents" step** — after choosing a model you get to know the agent system: view the current roster (including preset assistants) and quickly create one on the spot with a name and a one-line persona; you can also turn on the background agent **Historian** in one click (auto-titles sessions and curates logs and long-term memory, with standalone or assist mode), and more options remain in Settings → Background agents

## Tangu 2.2.1 (2026-07-03)

- **Each tab now has its own back/forward** — the navigation arrows at the top left of the main area now apply only to the current tab's browsing history (switching between sessions ↔ notes ↔ WeChat and so on no longer bleeds across tabs), with new shortcuts **Ctrl+{ / Ctrl+}** (⌘⇧[ / ⌘⇧] on mac); the original ⌘/Ctrl+⌥+←/→ still works, and shortcuts can be rebound in Settings
- **Opening a new view in the current tab switches in place by default (browser-style)** — opening another main-area view from the launcher, a command or the sidebar no longer opens a new tab; to open a new one, use the + button (or ⌘-click a note)
- **Unified "Workspace" sidebar view** — the session list, workspace files and vault are merged into one "Workspace" view that switches automatically with the main view (chat → sessions on the left and that session's workspace files on the right; notes → vault on the left, with the right side auto-locating the note's folder); it can be pinned manually at the top to Sessions / Files / Notes, and the left and right sidebars are independent; old layouts are migrated automatically
- **Unified "Outline" sidebar view** — the chat table of contents and the note outline are merged: it's a message index when viewing a chat and a heading outline when viewing a note
- **The new tab launcher works across Spaces** — main-area views and "Recent" are no longer filtered by Space: from any Space you can start a new session, create a new note, or open a recent note or session directly (Amadeus items still follow the developer mode toggle)
- **The chat input supports `[[` to reference workspace files** — typing `[[` pops up completion for files in the current workspace (fuzzy search; Enter inserts the relative path, which the agent can read directly); local sessions only
- **Sidebars are done with left/right splits for good** — fixed a gap where ⌘\ or the "Split right" command could still cut a focused sidebar into left and right halves (sidebars only allow top/bottom stacking)
- **Empty sidebar placeholder** — after the last view in a sidebar is closed or dragged away, the sidebar no longer disappears entirely; it shows "This sidebar is empty — try dragging a tab here", and you can drag one straight back in
- **Amadeus editor colors now fully follow the theme** — [[wikilink]] links changed from a fixed purple to the theme accent (including light/dark and skin switches), and hard-coded colors such as database popover shadows, danger buttons and the red in context menus are all tokenized; the editor background now follows the same rule as the chat view (the main-area paper shows through, physically sharing the same base color)
- **Editor top-bar breadcrumbs now "expand on hover"** — by default only the current note title is shown (centered); when the mouse enters the top bar, the parent path fades in level by level to the left of the title (the title slides smoothly right while the whole row stays centered), and collapses in reverse when the mouse leaves; parents are muted and the current title is highlighted, and hovering any level lets you click to navigate there; more than 3 parent levels are compressed to "first 2 / … / last 1", the current title is always shown in full, and expanding or collapsing doesn't affect the word count and buttons on the right

## Tangu 2.2.0 (2026-07-03)

- **All-new "Inbox" Space** — the ribbon adds a mailbox-style Space: a message list in the left column (sender / subject / summary / unread dot, with search, All / Unread / Archived / Scheduled filters and right-click management), and a reading pane in the main area (markdown body, archive / delete / mark unread, and one click to start chatting with the sending agent)
- **Agents can now "write to you"** — the new `inbox_send` tool delivers task results, reminders and reports straight to the Inbox, and supports **one-time scheduled delivery** (e.g. "remind me at 9 tomorrow morning"), appearing with an alert when the time comes; the "Scheduled" filter lets you view or cancel messages that aren't due yet
- **New message alerts** — unread badge on the ribbon icon + mac Dock badge + system notifications (clicking a notification goes straight to the Inbox; notifications can be turned off in Settings → General while badges stay)
- **Official announcements go straight to the Inbox** — the Forsion server can send announcements to all or selected users, and the desktop app receives them automatically once you're signed in to a Forsion account (delivered within about 5 minutes, with Forsion shown as the sender)
- **The terminal `tangu` command is set up automatically with the desktop app** — after installing and first launching the desktop app, just type `tangu` in a new terminal to use the CLI (TUI chat, `tangu login` and more) with no npm install; the CLI reuses the desktop app's bundled runtime directly, so **upgrading the desktop app upgrades the CLI**, and if the app is moved or renamed the command is repaired automatically on the next launch

## Tangu 2.1.3 (2026-07-02)

- **The Amadeus "Vault" supports nested folders** — the left-column file view is renamed "Vault", and the folder tree recursively shows subfolders indented by level (folders first, alphabetical, empty folders visible too); directories created with right-click "New subfolder" now really appear nested, notes can be dragged into any level, and breadcrumb navigation expands ancestor folders level by level
- **The vault shows every file in it** — not just .md notes: attachments such as images, PDFs, audio/video and databases (including the attachments/ folder) all appear in the tree (marked 📎); click to open with the system default app, right-click to show in the file manager or delete, and drag them into any folder; when files are added to the vault externally, the tree refreshes automatically
- **Fixed: image attachments pasted or dropped into notes never showed up** — the attachments were actually saved into the vault, but the UI's content security policy (CSP) never allowed the app's own attachment protocol, so all embedded image/PDF/audio/video previews were silently blocked; it's now allowed, and pasted images show up instantly
- **New ⋮ menu at the top right of the note editor** — Export to PDF (A4 pages, keeping the current layout plus images and formulas, always exported on light paper, and revealed in the file manager after saving), Favorite, Show in file manager and Delete note
- **The new tab page (+) is unified across all Spaces** — + in the Amadeus Space no longer creates a note directly but opens the "New tab" launcher, just like the Tangu Space; the launcher lists all main-area and sidebar views available in the current Space (in Amadeus: New note / Today + Vault / Search / Tags / Outline / Backlinks / Graph), and adds **"Recent"** at the top — the specific notes and sessions you opened recently, one card each, one click away
- **Micro-animations** — arrow rotation and subtree slide-in in the vault tree, and staggered entrance for launcher cards; all respect the system "Reduce motion" setting
- **Tab widths adapt to their titles** — tabs with short titles no longer stretch to a fixed width but shrink to fit the content (browser-style); long titles are still truncated with "…" at the original limit
- **Historian runs on a single cycle** — there are no longer separate "titles every N turns / memory every N turns" settings: there's now a single "Maintain every N turns", and titles, logs/memory and assist discussions all follow the same rhythm, so what you set is what you get (old settings carry over automatically; due turns with too little content are still skipped to avoid trivial records)
- **Fixed: environment check falsely reporting "Not installed"** — when the app is launched from the Dock or desktop, the PATH the system gives it doesn't include Homebrew and similar directories, so node/git/docker showed as missing even when installed; the lookup path for detection and install commands is now fixed
- **The "Mainland China" mirror now really applies to guided installs** — install commands in the environment check now also use domestic mirrors (Tsinghua mirror for brew, Tsinghua mirror for pip, npmmirror for npm, Aliyun source for the official docker script); the GitHub proxy for Market downloads now **falls back automatically across multiple sites** (a single proxy going down no longer fails everything); in China the code sandbox base image is now pulled via DaoCloud
- **Linux install commands that need sudo now use "Copy command"** — commands that ask for a password always hang when run inside the app, so now you copy them in one click and paste them into a terminal to run

## Tangu 2.1.2 (2026-07-02)

- **Fixed: reply text occasionally swallowed, leaving only a closing phrase** — when the model "says something first, then calls a tool", that already-streamed text was lost when saved (typical symptom: after a refresh the whole reply is just a short phrase like "NOTHING"); every segment of text is now kept intact
- **Fixed: a different agent answering between two turns of the same session** — the root cause was a race at the moment a new session is created: history loading **overwrote wholesale** the just-selected agent with the server's still-empty config, so the second turn fell back to the default agent (avatar and name changing to Tangu Arioso). The race is now fixed (local config takes priority when merging + corrected creation order), and **the backend writes each turn's active agent through to the session** — sessions previously stuck on the default agent by mistake are corrected automatically with the next message; Historian assist discussions also find the right participant
- **Fixed: background discussions, group chats and subagents interrupted by thinking-mode models** — thinking mode on channels such as DeepSeek rejects some tool-call parameters with "Thinking mode does not support this tool_choice", which made Historian assist discussions fail entirely and occasionally made the final turn of group chats or subagents error out; a compatible approach is now used, and a failed vote only degrades gracefully instead of interrupting the discussion

## Tangu 2.1.1 (2026-07-02)

- **Major build-out of the Amadeus notes Space (preview, currently behind developer mode)** — a step toward a complete, modern note-taking experience:
  - **Search & navigation**: the left column adds Full-text search (jump to a hit with its block highlighted) and Tags tabs; ⌘P fuzzy-jumps to any note; ⌘K command palette integration (⌘N becomes New note, restored when you leave)
  - **Multi-tab editing**: one main-area tab per note, via ⌘-click or right-click "Open in new tab", and the layout is restored after a restart
  - **Graph**: a force-directed graph of the current note's outgoing links and backlinks in the right column — nodes can be dragged (repulsion pushes them apart, they spring back on release), hover highlights neighbors, scroll to zoom, drag empty space to pan, double-click to reset
  - **Database block**: "Database" in the slash menu is ready to use instantly — a standalone `.db` file stored in the vault and embedded in notes as `![[xxx.db]]`; seven column types (text / number / checkbox / date / select / multi-select / link), with the column menu (rename / type / sort) opened by clicking a **column header**; text columns support clickable `[[page]]` / `[[file]]` links that jump straight there; the same database embedded in multiple places syncs live, with auto-save
  - **File paste & inline preview**: pasting any file saves it as an attachment and embeds it as `![[file name]]`; PDFs can be paged through in place and audio/video plays in place (with a draggable progress bar), while other files show as cards that open in the system app on click
  - **Block menu redone**: click the ⠿ handle to the left of a block (press and hold still drags) or right-click a block to open the block menu; the floating icon on the right is removed
  - **@ mentions for pages**: typing `@` pops up candidates (recently opened first), and picking one inserts a `[[wikilink]]`
  - **File list**: notes can be dragged into folders or onto empty space to move back to the root (drop targets highlight); folders are collapsed by default
  - **Callouts** (`> [!note]` and more, 8 color-coded types), **properties panel** (compatible with the common properties format), **templates & daily notes** (a templates/ template library + "Today" in the sidebar), **Favorites/Recent** sections, an expanded slash menu (math / link / image / columns / template / database), and dragging blocks into columns
  - **Fixed: frontmatter from other apps is no longer lost** — previously, properties created by other note apps were silently wiped as soon as the note was edited
- **Background sessions all show up in the "Sub-chats" panel**: @discussions, Historian assist memory discussions and every other background session spawned from the current conversation now stay listed in "Sub-chats" in the right column (with a spinner while running) — open one to watch live or replay it in full; **they're still listed after reopening the session or restarting the app** (previously @discussions vanished on refresh and Historian discussions didn't show at all). Future background sessions of the same kind will hook in automatically
- **Fixed: sidebars often wouldn't scroll** — the window drag region was swallowing wheel events over empty parts of lists; now fixed (benefiting both chat and note sidebars)
- **Fixed: an extra blank line you couldn't type in below note blocks**

## Tangu 2.1.0 (2026-07-02)

- **Muse is now a real agent**: the background Muse is now a visible "Muse" agent in the roster (marked "Background"), with its own persona (SOUL), instructions and long-term memory — customize it just like any other agent. It can see recent activity across your agents and remembers which suggestions you accepted or ignored, so it understands you better over time
- **The Muse workspace is back**: the "Background agents" page once again offers a full TODO workspace — check items off, ignore them, or multi-select and inject them into a session to run in one click (previously view-only); injected tasks now run as the target session's own agent
- **Historian adds an "Assist" mode** ("Settings → Background agents → Historian → Working mode"): in Independent mode (the default), Historian decides on its own and writes to logs/memory; in Assist mode, when it's time, it **branches a short background discussion** off the current conversation and asks that session's agent whether anything is worth recording, and the main agent decides and writes to its own logs/memory itself — your agent has the final say over its own memory. Titles are still maintained by Historian; the first turn of every session always uses Independent mode
- The group chat engine is enhanced accordingly: discussions can inherit context from the source conversation and can skip the moderator summary (for background automation scenarios)
- **Historian fixes**: for agents with "Shared default memory" turned on, Historian previously wrote logs/memory into the wrong folder; group chats and external engine sessions now also get titles/logs maintained automatically

## Tangu 2.0.6 (2026-07-01)

- **Fixed: some Settings options couldn't be clicked** — on macOS, items such as "Community plugins" (and parts of the command palette, update banner and context menus) previously didn't respond to hover or clicks at all, because the window drag region of the underlying UI swallowed mouse events; this is now fully fixed

## Tangu 2.0.5 (2026-07-01)

- **Fixed: crash on launch** — 2.0.x installers were missing runtime dependencies (such as electron-updater), causing the error "A JavaScript error … Cannot find package 'electron-updater'" on open. This version bundles everything and launches normally.

## Tangu 2.0.3 (2026-07-01)

- **Built-in Python, no install needed**: the app ships its own standalone Python runtime, so you no longer need to install Python manually and it won't conflict with your own Python; switch between "Built-in / System" in Settings
- **One-click mainland China mirrors**: first-run onboarding and Settings add "Network environment" — choose "Mainland China" to automatically switch pip / npm / git and Market downloads to domestic mirrors for smoother access to GitHub / npm / PyPI
- **Fixed: false "25MB limit" errors when dropping in files** — files dropped into local workspace sessions are now reliably read by path instead of occasionally being treated as uploads subject to the limit (and no refresh is needed)
- **Fixed: unclickable buttons and broken styles in Settings / Market dialogs**

## Tangu 2.0.2 (2026-06-29)

- **Fixed: in-app updates found a new version but couldn't download it** — installers now use names without spaces, so the update manifest matches the download asset names (effective from this version)
- **Windows blank-screen self-healing**: when the renderer/GPU process crashes, the UI reloads automatically with no need to reopen the app; memory usage in long sessions has also been reduced
- **Expired sign-ins are flagged proactively**: when your cloud sign-in expires, you're told right away and guided to sign in again, without a manual refresh
- **Better plugin installs**: plugins appear in the list as soon as they're installed, are enabled automatically and open their settings; plugins that contribute backend routes are labeled "Restart required"
- **The Market supports versions and update checks**: skills / agents / plugins carry version numbers, and "Updates available" at the top of the Market gathers them for one-click updating
- **Fixed: ZIPs uploaded to the Market with an extra folder level couldn't be read after install** — the manifest is now detected and relocated automatically, and archive leftovers such as `__MACOSX` are filtered out
- **More reliable pasting/dropping files into the chat box**: cloud sessions no longer get local paths they can't read; agents are more aware of files already in the current workspace
- **Group chat avatar and name fixes**: after reopening a session, every message correctly shows the speaker's avatar/name, no longer duplicated or collapsed into the default name
- **Human-like split replies**: the former "WeChat split replies" is generalized into a per-agent toggle that works with any message-style channel
- **First-run onboarding**: after signing in to Forsion you can turn on cloud sync at the same time (syncs your cloud agents)

## Tangu 2.0.1 (2026-06-29)

- **Launches normally without signing in to Forsion**: on first use, a local-only secure token is generated automatically, so the local backend, BYOK and subscription sign-in can run independently; first-run onboarding still appears correctly
- **Fixed: connection race after sign-in** — after a successful sign-in, the app now waits until the backend has restarted with the new token and is ready, so it no longer gets stuck on "Connecting to backend" or fails to load the model list
- **The desktop installer bundles the full skill set**: skills shipped with the app work right after a fresh install
- **Better first install on macOS**: the app is now ad-hoc signed, and the DMG adds an "Applications" shortcut plus first-launch instructions in Chinese and English

## Tangu 2.0.0 (2026-06-28)

- **All-new 2.0: the desktop app is rebuilt on a new engine** — the whole interface now uses a "dockable workbench" engine for smoother panel dragging / split views / resizing, with layouts remembered automatically and restored on restart; all existing features (chat, group chat, WeChat, themes, agents, memory, etc.) carry over
- **Native top tab bar + rounded pill tabs**: one tab bar = view icons on the left | session tabs in the middle | view icons on the right, all draggable / splittable; the active tab is a light rounded pill; "+" at the end of the tab bar creates a new tab in one click
- **New tab = blank launcher**: click "+" to open a blank page listing every view, grouped into "Main area / Sidebar views" (New chat / WeChat / Background agents / Workspace / Outline / Memory / Sub-chat); pick one to open it in the matching area
- **Left function strip**: New, Theme, Light/Dark, Chinese/English, Feedback and Command palette are stacked vertically in a thin strip on the far left, always within reach
- **Sidebar collapse buttons moved to the panel edges**: after collapsing a sidebar the button stays in place, so you can expand it again anytime
- **Settings reorganized into four categories**: Options / AI / Core plugins / Community plugins; Back and Search stay pinned at the top (automatically avoiding the traffic-light buttons on macOS); "General settings" brings Connection and your Forsion account onto one screen
- **Custom keyboard shortcuts**: in "Settings → Shortcuts" you can record / rebind / unbind / reset shortcuts for the command palette and every command, with key-combination conflicts avoided automatically
- **Default agent renamed "Tangu Arioso"** (formerly Xyra; memory / logs carry over seamlessly) with a built-in default avatar; you can remove a custom avatar in "Settings → Agents" (if an avatar goes missing unexpectedly, the default is restored automatically unless you removed it yourself)
- **Launch splash screen**: a "Sacred Tree" animation bridges the gap between opening the app and the UI being ready, eliminating the blank white screen
- The changelog on the About page now supports inline Markdown (code / bold / links render correctly)

## Tangu Go (2026-06-27)
- **Your own messages in chat now show your avatar and name too** (taken from your Forsion account, mirroring the assistant on the opposite side)
- **Cleaner tool calls**: consecutive tool calls are grouped into one collapsible card — collapsed, it shows "Writing / Editing…" or a completion summary (e.g. "Wrote 1 file · Edited 3 files · Ran 2 commands"); expand it to see each step's action, target and lines added/removed
- **Right sidebar "Memory" becomes "Current agent memory"**: it switches live with the session / group chat participants, showing that agent's memory and logs from the last few days (collapsible); with a single agent you can append memory directly
- **Outline and floating outline**: the right sidebar "Outline" lists entries by conversation turn + heading; a new floating outline strip on the left of the message area (expands on hover, jumps on click) makes long conversations quick to navigate
- **Files panel upgraded to a workspace folder tree**: lists local workspaces, expands real disk directories level by level and previews files; the session and file panels work as a linked accordion (entering a workspace expands it and collapses the rest, kept in sync on both sides)

## 1.6.0 (2026-06-27)

- **Themes support "drop-in install"**: put a theme folder in `~/.tangu/themes/<name>/` (containing `theme.json` + `theme.css`) to install a third-party design language; "Settings → Theme" adds two buttons, "**Open themes folder**" and "**Reload themes**" — drop the files in, click "Reload themes", and the theme shows up ready to use immediately, no restart needed
- **Soft** is now a "drop-in example theme": on first launch it's seeded automatically into `~/.tangu/themes/soft/`, so you can use it as is or change its colors / corner radius to make your own theme (Lovable remains built in as the default base and is always available)

## 1.5.0 (2026-06-27)

- The interface now closely follows the Forsion unified design language (LCL) preview and is upgraded to a **dockable workbench**:
  - **Chat shell redesigned**: tool call, approval, to-do, question and other cards are unified as "neutral soft-shadow floating cards", the input box floats, and buttons / pills / icon buttons match the preview; the overall look is lighter with more generous whitespace (avatars and existing information are kept)
  - **Dockable workbench**: **the "Work sessions" panel on the left, the conversation in the middle, and "Files / Outline / Memory / Sub-chat" on the right are all part of the workbench**; every panel is a standalone card with an **icon + name** that can be **freely dragged, resized, grouped / separated and docked** (with silkier dragging); the layout is remembered automatically and restored on restart; the "Sidebar / Right sidebar" buttons in the top bar collapse / expand everything at once; panels collapse automatically when "Settings / Onboarding" is open, and Settings fills the screen
  - **More lively**: subtle animations in many places, such as expanding the session list and opening menus (with the same light feel as "Switch agent"); respects the system "Reduce motion" setting
  - **Themes upgraded to a two-axis "design language × color scheme" model** (aligned with Amadeus / LCL): the **design language** (Lovable flat paper / Soft floating cards) determines structure (corner radius / fonts / floating card layout); the **color scheme** (Cream / Coral / Soft teal / Lavender / Custom) only determines colors — the two are orthogonal and can be combined freely (e.g. "Soft teal + Soft floating cards"). In the Soft language, the sidebar / main area become rounded floating cards on a gradient stage (corner glow, soft shadows, no hard borders)
  - **Golden-ratio default layout**: the conversation takes about 62% in the middle and each side panel about 19%, for more focus; panel sizes / positions are still remembered and restored on restart
  - Panel tabs are **more compact and rounded** (tighter padding, larger corner radius)
  - Light/dark / flat / glass toggles now work consistently across every design language × color scheme
- Old themes are **migrated automatically**: Lovable → Cream, Echo → Coral, Qbird → Soft teal, Dreamer → Soft + Lavender; after upgrading you can freely combine design language and color scheme in "Settings → Theme"
- Fixed: on the **Profile** (account) page, editable cards pushed the "Save" button out of view when their content was too long — text boxes now scroll internally and the button stays visible

## 1.4.0 (2026-06-26)

- The theme system is upgraded to the Forsion suite's unified design language (LCL):
  - New skins: **Lovable** (cream paper · monochrome, default), **Echo** (coral / lavender · rounded), **QBird** (graphite · soft teal), **Dreamer** (lavender / warm peach · rounded, gradient cloud background + soft-shadow floating cards, from the same roots as Amadeus)
  - New "**Custom**" color-picker skin: pick any accent color, and the background gets a subtle tint automatically and adapts to light/dark
  - **Tool call cards** in chat are now unified full-frame cards with soft shadows (aligned with the LCL preview), consistently following skin / light-dark / flat changes
  - New "**Flat / 3D**" toggle: removes card shadows in one click (works in both light and dark)
  - QBird's accent color changes from bright teal to a gentler soft teal (#4d8794), unified with the rest of the suite
  - The old "Plain paper / Monet" themes are retired; after upgrading you're switched to Lovable automatically (you can switch back to another skin in "Settings → Theme")
- Settings now uses **category navigation**: grouped on the left into Appearance / Account / Models / Plugins / Advanced / About, so settings are faster to find
- Plugin settings panels upgraded: support for declarative controls such as "Section / Hint / External link", and plugin UI **follows the theme automatically** (skin / light-dark / flat all stay consistent) — laying the groundwork for a unified plugin look

## 1.3.1 (2026-06-25)

- New "In-app updates": check for updates in one click in "Settings → About"; when a new version is found, a notice appears at the top of the main window
  - Windows / Linux: download and restart to install right in the app, no need to visit the download page manually
  - macOS: when a new version is found, you're guided to the Releases page to download it manually (in-app auto-install isn't enabled on mac yet)
  - Checks silently once at launch; both download and installation require your confirmation

## 1.3.0 (2026-06-25)

- New "External agent engines": at the start of a new session you can choose third-party AI agent frameworks such as Claude Code or Codex instead of the built-in Tangu engine (connected via ACP) —
  - Chat in the main window just like with Tangu, with automatic support for that engine's model selection and slash commands
  - "Settings → Agent CLIs": see the engines detected on this machine and set a default model for each
  - The engine picker only appears when the corresponding engine is "Detected"; a session uses the same engine from start to finish
- New "Group chat mode": multiple agents take turns speaking and voting on the same topic, with an optional moderator summary (local workspaces)
- New "Official account subscription sign-in": run Tangu on your Claude / ChatGPT subscription quota (OAuth sign-in, no API key needed)
- Memory is now "local-first": memory and logs are stored on this machine by default (~/.tangu) and can sync both ways with the Forsion cloud in Settings (manual by default, privacy first)
- More reliable code editing: new structured patches (apply_patch) and a safety gate for local file operations (paths outside the allowed scope require confirmation)
- Fixed: installed Claude Code / Codex occasionally went undetected; cloud sessions no longer mistakenly list local models or show external engines (external engines are only available in local sessions and are mutually exclusive with group chat)

## 1.2.0 (2026-06-21)

- New "WeChat remote": scan a code in "Settings → WeChat remote" to connect your WeChat bot and chat with the Tangu agent directly from WeChat —
  - Appears as a standalone project at the top of the sidebar, with its sessions collapsible underneath
  - In WeChat, use `/new` to create a session, `/list` to list sessions, `/switch <number>` to switch and `/help` for help; reply "Stop" to abort a task and "Approve / Reject" to handle pending actions; a "typing" status is shown
  - The agent can send files / images from the workspace straight back to your WeChat ("Send this file to my WeChat")
  - The main window is used for setup / connection, where you can view and switch the "Currently connected session"
- New "Browser tools": agents can use a lightweight local browser to search the web in real time and interact with pages (`browser_search`, etc.), with DuckDuckGo by default and support for Bing / Google / Baidu
- Custom providers add "Fetch models": after entering a Base URL / API key, fetch the endpoint's available model list in one click, then search and check the ones you want
- Sidebar improvements: the WeChat connection is pinned to the top by default; projects can be reordered by dragging; new session search; "Archive" is now the primary delete action (permanent delete lives in the Archive section)
- New "Quote selection" in chat: select text and a "Quote" button pops up, adding it as a quote block before your next message (like ChatGPT)
- Leaner top bar: the row of status pills (Host / WeChat / Online, etc.) is removed; a notice only appears when disconnected
- Smoother: incoming WeChat messages, toggling background agents and other changes now show up automatically, without manually refreshing the page
- ⚠️ The "background agents" Historian and Muse are still **experimental and currently very unstable**, and may get stuck, trigger repeatedly or show abnormal usage; they're off by default — please try them cautiously in non-critical workspaces, and we recommend keeping them off for real work

## 1.1.0 (2026-06-18)

- New "Context usage bar": below the input box, shows the current model's context usage percentage and this session's token consumption in real time, so you can see at a glance how much room is left
- New "Compact context": when a conversation grows long, one click (the input bar button or `/compact`) summarizes it and continues in condensed form; it compacts automatically near the limit, avoiding overlength errors so long conversations keep going smoothly
- New "Agents" (Normal Agent): create reusable chat personas (system prompt + model + settings) in "Settings → Agents" and switch between them with `/agent` in one click; the AI can also distill new agents on its own during a conversation
- New "Background agents" (off by default; enable them and choose a model in "Settings → Background agents"; their records are isolated and don't appear in the session list):
  - Historian: automatically summarizes session titles as the conversation goes, and maintains your long-term memory and logs when needed
  - Muse: keeps thinking in the background about "what can I do for you right now" and produces a TODO list; multi-select tasks, pick a session and inject them to start running in one click
- New "Background agents" entry in the sidebar: open the Historian / Muse workspace to see their activity and TODOs

## 1.0.3 (2026-06-17)

- Fixed: file operations in local workspaces (preview, open folder, rename, delete, reveal in file manager, drag out) all stopped working and threw an error on click
- New: "Export session log" in "Settings → Advanced" packs all of the current session's conversation and the backend runtime logs into a single JSON file for feedback and troubleshooting
- macOS: the top-left logo and "Tangu" wordmark moved right, so they're no longer covered by the window's traffic-light buttons
- Windows: removed the default top menu bar (File/Edit/View/Window) to match the macOS look
- New `/loop <rounds>` command to adjust the maximum number of loop rounds for a single conversation (default limit raised to 90 rounds), available in both the input bar and the TUI
- When the loop runs out (the round limit is reached before finishing), a clear notice appears; send "Continue" or raise the limit with `/loop`

## 1.0.2 (2026-06-16)

- Fixed: after a fresh install the cloud address defaulted to local (localhost); the built-in default now points to production at api.forsion.net
- Self-hosted / private deployments can still override the cloud address with TANGU_CLOUD_URL in ~/.tangu/.env

## 1.0.1 (2026-06-15)

- Local image recognition: the AI can view images in the workspace or dropped into chat (the view_image tool), with image thumbnails shown in chat
- New developer mode: tap the version number 10 times on "About" to unlock it, then edit the Forsion cloud address or re-enter onboarding
- First-run onboarding adds two steps, "Choose theme" and "Default local folder"; onboarding no longer asks for a cloud address
- Default theme changed to Qbird light; the language and light/dark toggles moved to the top right
- The account card now uses the unified user card style, correctly showing your avatar and membership tier

## 1.0.0 (2026-06-15)

- Added Chinese/English interface switching (Chinese by default); switch from the bottom-left corner of the sidebar or in Settings
- Settings adds an "About" page with the version number and changelog
- Forsion account sign-in moves to the bottom-left corner of the sidebar (avatar / nickname; click to open your account center); the app works fine without signing in
- Models / providers are grouped by provider in Settings and the model picker, collapsed by default
- The workspace now supports rename / new folder / show in file manager / move to trash / drag out
- Fixed: tool calls occasionally ending the loop; scrolling up during streaming output no longer yanks you back to the bottom
