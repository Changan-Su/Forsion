---
name: Forsion Products
description: What Forsion's own products are and where to find them in the app (Forsion Git, Penzor Cloud 蓬洲云, Store, Creations, Connect, account and points, Clip, Unit, Notes, Muse). Load it when the user asks about one of them or mentions a Forsion name you don't recognise, instead of saying you don't know.
version: 1.0.0
author: Forsion
category: Forsion
---

# Forsion Products

You run inside Forsion, so its own products are not in your training data. Use this page to answer "what is X", "where do I find X" and "can you do X for me". Quote UI labels exactly as written here (Chinese / English) so the user can find them. If something is not covered here, say so instead of inventing it.

## Forsion Git

- **What it is:** Forsion's own Git hosting, like a private GitHub. The official site is https://git.forsion.net (a self-hosted Forsion cloud can use another address; the app always opens the right one).
- **Sign-in:** only with the user's Forsion account; there is no separate registration or password. Repositories are **private**; pushing to a repository that does not exist yet creates it as private.
- **In the app:**
  - Project details › Git (项目详情 › Git): "发布到 Forsion Git…" / "Publish to Forsion Git…" creates a private repository under the user's account and pushes the current branch. The same page has "打开 Forsion Git" / "Open Forsion Git", "连接已有远端…" / "Connect a remote…", "提交…" / "Commit…", "推送" / "Push", "拉取" / "Pull".
  - Cloning: the project picker in the chat box has "从 Git 克隆…" / "Clone from Git…"; it opens on the Forsion Git tab and lists the user's repositories.
- **What you can do:** the `git_status`, `git_commit`, `git_push`, `git_pull` and `git_publish` tools, listed under Additional Tools (load them with `load_tools`). They exist **only when this conversation belongs to a local project folder**.
  - In a project: call `git_status` first. If the repository already has the remote the user means, use `git_push`. Only when they want a new Forsion Git repository (no remote yet, or they ask for one) call `git_publish`: no address needed, it needs at least one commit, and the repository name allows only letters, digits, `-`, `_`, `.`, so give a short English name for a Chinese folder name. The user approves every publish.
  - Not in a project: you cannot push from here. Explain what Forsion Git is and point the user to opening the project (or picking it in the chat box's project picker) and using Project details › Git, or ask them to start a conversation in that project.
- **Errors:** "Your Forsion account is not set up on Forsion Git yet" → the user signs in to Forsion Git on the web once (the "Open Forsion Git" button), then retries. "Forsion Git cannot be used right now" → not signed in to Forsion, or the site is unreachable.
- **Business edition:** an organization has its own Forsion Git organization. Members can write but not create repositories; the default branch is protected (no direct push, one approval to merge); agents only read and open merge requests from their own forks.

## Penzor Cloud (蓬洲云)

- Forsion's cloud drive and sync, shown as the "蓬洲云" / "Penzor Cloud" Space. It opens on My drive; uploads go to My uploads, synced sources there are read-only.
- What can sync: Notes (the note vault; by default every 5 minutes and at startup, both ways), Agents & memory (agents are chosen one by one, none by default; Muse cannot sync yet), and Plugin data.
- Settings: 蓬洲云 › 同步 / Penzor Cloud › Sync.

## Store (商店)

- Where users get plugins, skills, agents, Spaces, themes and web apps; also Installed, Updates and Submit (投稿) for authors. Opened from the "商店" / "Store" icon in the ribbon.
- To recommend something, load the `find-forsion-plugins` skill (it uses `search_marketplace`). Never claim you installed anything; the user installs from the cards.

## Creations (造物) and Forsion Connect

- **Creations:** the Space that holds what the user builds to open again (web apps, small tools, games, plugins), with preview, desktop shortcut, publishing and version history. Load the `forsion-creations` skill before building one.
- **Forsion Connect:** lets a web page use Forsion AI with the visitor's Forsion account and be published. Load the `forsion-connect` skill to build one. Published pages are listed under Settings › Forsion 云端 › 我的网页 / Forsion Cloud › My web pages.
- **Writing a Forsion plugin:** load the `forsion-plugin` skill.

## Forsion account, membership, quota and points

- Settings › Forsion 云端 / Forsion Cloud has: 账号 / Account, 会员与用量 / Membership & usage (with 积分与邀请 / Points & invites and 用量记录 / Usage), 背包 / Backpack (items such as reset cards), 插件投稿 / Submissions, 我的网页 / My web pages, 反馈 / Feedback.
- Membership, points and items are bought from the Store's 会员 / Membership, 积分 / Points and 物品 / Items pages; payment happens in the browser. The web account centre is https://account.forsion.net.
- `forsion_account` reads the overview, usage, backpack and web pages; `forsion_account_action` can use a reset card, move quota to the background pool or send feedback, each with the user's approval. You cannot buy, redeem or change plans: send the user to Settings › Forsion Cloud.

## Other names users mention

- **Forsion Clip:** the browser extension for Chrome and Edge. It clips web pages into the user's notes and, once paired, lets you control the browser. Settings › 浏览器控制 / Browser control › 浏览器扩展（Forsion Clip）/ Browser extension (Forsion Clip). Download page: https://forsion.net/clip/.
- **Forsion Unit:** a Forsion that runs on another computer, a server or the cloud. The ribbon's "Forsion Unit 切换" / "Switch Forsion Unit" switches between this computer, the cloud and the user's other devices; Settings › 系统 › 设备 / System › Devices manages them.
- **Notes (笔记, also called Amadeus):** the note vault Space. Use the `amadeus_*` note and calendar tools; the `amadeus-note-format` skill covers note syntax.
- **Muse (卜算子):** the background agent that keeps thinking and suggests things; it has its own Space and uses the background quota.
- **Coding Studio (编码工作室):** the Space for coding projects.
- **Forsion Extend:** the built-in extension behind the account, cloud sync, devices and Connect. Users rarely need to touch it.
- **Help and docs:** https://forsion.net/docs/ ; What's new: https://forsion.net/releases/.
