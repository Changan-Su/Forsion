---
name: Forsion Creations
description: Use when the user asks you to build something they will open and use again — a web app, page, small tool, game or Forsion plugin — and this conversation's working folder is not already a creation, or when they ask to put something built here into Creations (造物). Proposes it with a forsion-creation card the user clicks, so it lands in Creations with a stable preview, desktop shortcut, publishing and automatic version history. Not for scripts, documents, data analysis or the user's existing codebases.
version: 1.0.0
author: Forsion
category: Forsion
---

# Forsion Creations

Creations (造物) is the Forsion desktop space that lists what the user has built. Each creation is a folder in the Forsion projects folder (`Forsion/Project/<name>`). Creations get a preview that keeps its local data across restarts, a desktop shortcut, publishing through Forsion Connect, and version history that Forsion saves after every agent run. Things built in an ordinary conversation folder get none of this and never show up in Creations.

## When to propose

- The user asks you to build something meant to be opened and used again (a web app, page, small tool, game, or Forsion plugin), and your working folder is not already inside `Forsion/Project`. Propose it once, before you write the app's files.
- The user asks to put something already built in this working folder into Creations.
- Do not propose it for scripts, one-off files, documents, spreadsheets, data analysis, or changes to a project the user already develops somewhere else.
- At most once per conversation. If the user declines, ignores the card, or asks you to keep going here, keep working in the current folder and do not propose it again.
- The card renders as a button in the Forsion desktop app; elsewhere it just shows as a small code block. If this conversation is relayed through a messaging channel (plain text only), do not write it; mention that they can add it from the Forsion desktop app instead.

## How

End your reply with this fenced block and write nothing after it (the card appears below your reply, so refer to it as the button below):

```forsion-creation
name: Pomodoro Timer
```

For something already built in this working folder, add its folder relative to the working folder (use `.` only when the whole working folder is the project):

```forsion-creation
name: Pomodoro Timer
path: pomodoro
```

Then stop and wait. The user sees a card with one button:

- Without `path`, Forsion creates the creation's folder, moves this conversation's working folder into it, and sends you a message to continue. Build there with relative paths; check the new working folder with `list_dir` first.
- With `path`, Forsion copies that folder into Creations without `.git` and `node_modules`, and this conversation continues on the copy. The original folder stays as it was.

## Rules

- Keep `name` short and human: it becomes the folder name and the title in Creations. No slashes.
- Only the card creates or copies a creation. Do not make folders in, or copy files into, the Forsion projects folder yourself. Once this conversation has moved into a creation, build there normally.
- Never create `.forsion-product.json`, and never run `git init` or commit in a creation. Forsion creates its identity and owns its version history.
- For a web app, keep `index.html` at the creation's root so Creations can open it. For a Forsion plugin, load the Forsion plugin skill before writing it.
