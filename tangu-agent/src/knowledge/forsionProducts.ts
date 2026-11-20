/**
 * Forsion 自家产品速查(forsion_guide 工具的正文,唯一真源)。
 *
 * 为什么是工具正文、不是技能(11-16,方案 docs/ToBeImproved/Forsion产品知识覆盖方案_2026-11-16):
 *   技能到不了 chat 预设(D23 关掉了技能体系)和沙盒会话(只认明确装备的技能);网页 / 手机的会话全在云端 Worker 上,
 *   镜像里没有 skills/ 目录。正文编进 dist,三端、两种执行形态都带得到。
 *
 * 按会话里**真有哪些工具**改说法(调用方用 registry.toolAvailable 量,不靠 host / 项目推断 —— Codex 评审 11-16):
 *   - git_* 在:先 git_status;host 但没有:指去项目详情 › Git;沙盒:这里跑不了 git,发布在 Forsion 桌面版里做;
 *   - 账号 / 商店那两节:工具在才说「你可以用 X」,不在就指去设置 / 商店。
 * 界面入口一律中英原文;改入口时在这里改,别在别处另写一份。模型读的是英文(Tangu 提示词英文化)。
 */

export type GuideTopic = 'git' | 'penzor_cloud' | 'store' | 'creations' | 'account' | 'other';
export const GUIDE_TOPICS: readonly GuideTopic[] = ['git', 'penzor_cloud', 'store', 'creations', 'account', 'other'];

export interface GuideContext {
  /** 本机直连(桌面 Work 会话)。否 = 沙盒(桌面轻聊天 / 云端项目、网页、手机)。 */
  host: boolean;
  /** 本会话真的有 git_* 工具(host + 属于本机项目 + 没被预设 / 宿主沙箱 / 严格名单拦掉)。 */
  gitTools: boolean;
  /** forsion_account / forsion_account_action / search_marketplace 在不在(子代理、通道、Muse 等形态没有)。 */
  account: boolean;
  accountAction: boolean;
  marketplace: boolean;
}

const INTRO =
  '# Forsion products\n' +
  "You run inside Forsion, so its own products are not in your training data. Answer from this guide and quote UI labels exactly as written (Chinese / English) so the user can find them. If something is not covered here, say so instead of inventing it. Skills named below can be loaded with use_skill only where this conversation's skill catalog lists them.";

function gitWhatYouCanDo(ctx: GuideContext): string {
  if (ctx.gitTools) {
    return (
      '- **What you can do here:** this conversation belongs to a local project, so `git_status`, `git_commit`, `git_push`, `git_pull` and `git_publish` exist (listed under Additional Tools; load them with `load_tools`). ' +
      'Call `git_status` first. If the repository already has the remote the user means, use `git_push`. Only when they want a new Forsion Git repository (no remote yet, or they ask for one) call `git_publish`: no address needed, it needs at least one commit, and the repository name allows only letters, digits, `-`, `_`, `.`, so give a short English name for a Chinese folder name. The user approves every publish.'
    );
  }
  if (ctx.host) {
    return '- **What you can do here:** the git tools are not available in this conversation, so you cannot commit, push or publish from it, and you must not offer to. Tell the user to use Project details › Git, or to start a Work conversation in that project (pick it in the chat box\'s project picker), where you can do it for them.';
  }
  return '- **What you can do here:** this conversation runs in a cloud sandbox, so you cannot run git, push or publish from it, and you must not offer to. Publishing and cloning happen in the Forsion desktop app: open the project there and use Project details › Git. Explain what Forsion Git is and how to get there.';
}

function gitSection(ctx: GuideContext): string {
  return [
    '## Forsion Git',
    "- **What it is:** Forsion's own Git hosting, like a private GitHub. The official site is https://git.forsion.net (a self-hosted Forsion cloud can use another address; the app always opens the right one).",
    "- **Sign-in:** only with the user's Forsion account; there is no separate registration or password. Repositories are **private**; pushing to a repository that does not exist yet creates it as private.",
    '- **In the desktop app:**',
    '  - Publishing: Project details › Git (项目详情 › Git), the "远端" / "Remotes" card → "添加远端…" / "Add remote…" ("添加…" / "Add…" when it already has remotes) → Forsion Git → "新建并推送" / "Create and push". It creates a private repository under the user\'s account and pushes the current branch; tick "以后推送到这里" / "Push here from now on" to make it the push target. Older app versions show a single "发布到 Forsion Git…" / "Publish to Forsion Git…" button instead.',
    '  - The same page has "提交…" / "Commit…", "推送" / "Push" and "拉取" / "Pull"; each remote\'s menu has "在 {site} 打开" / "Open in {site}" to see it on the web.',
    '  - Cloning: the project picker in the chat box has "从 Git 克隆…" / "Clone from Git…"; it opens on the Forsion Git tab and lists the user\'s repositories.',
    gitWhatYouCanDo(ctx),
    '- **Errors:** "Your Forsion account is not set up on Forsion Git yet" → the user signs in to Forsion Git on the web once (the "Open Forsion Git" button), then retries. "Forsion Git cannot be used right now" → not signed in to Forsion, or the site is unreachable.',
    '- **Business edition:** an organization has its own Forsion Git organization. Members can write but not create repositories; the default branch is protected (no direct push, one approval to merge); agents only read and open merge requests from their own forks.',
  ].join('\n');
}

const sections = (ctx: GuideContext): Record<Exclude<GuideTopic, 'git'>, string> => ({
  penzor_cloud: [
    '## Penzor Cloud (蓬洲云)',
    '- Forsion\'s cloud drive and sync, shown as the "蓬洲云" / "Penzor Cloud" Space. It opens on My drive; uploads go to My uploads, synced sources there are read-only.',
    '- What can sync: Notes (the note vault; by default every 5 minutes and at startup, both ways), Agents & memory (agents are chosen one by one, none by default; Muse cannot sync yet), and Plugin data.',
    '- Settings: 蓬洲云 › 同步 / Penzor Cloud › Sync.',
  ].join('\n'),
  store: [
    '## Store (商店)',
    '- Where users get plugins, skills, agents, Spaces, themes and web apps; also Installed, Updates and Submit (投稿) for authors. Opened from the "商店" / "Store" icon in the ribbon.',
    ctx.marketplace
      ? '- Find candidates with `search_marketplace`. Use `recommend_marketplace_plugin` if available to show a card for a candidate that meets the user’s need. Installation is the user’s choice.'
      : '- You cannot search the Store from this conversation; tell the user to open it and search there. Never claim you installed anything.',
  ].join('\n'),
  creations: [
    '## Creations (造物) and Forsion Connect',
    '- **Creations:** the Space that holds what the user builds to open again (web apps, small tools, games, plugins), with preview, desktop shortcut, publishing and version history. The `forsion-creations` skill covers building one.',
    '- **Forsion Connect:** lets a web page use Forsion AI with the visitor\'s Forsion account and be published. The `forsion-connect` skill covers building one. Published pages are listed under Settings › Forsion 云端 › 我的网页 / Forsion Cloud › My web pages.',
    '- **Writing a Forsion plugin:** the `forsion-plugin` skill.',
  ].join('\n'),
  account: [
    '## Forsion account, membership, quota and points',
    '- Settings › Forsion 云端 / Forsion Cloud has: 账号 / Account, 会员与用量 / Membership & usage (with 积分与邀请 / Points & invites and 用量记录 / Usage), 背包 / Backpack (items such as reset cards), 插件投稿 / Submissions, 我的网页 / My web pages, 反馈 / Feedback.',
    '- Membership, points and items are bought from the Store\'s 会员 / Membership, 积分 / Points and 物品 / Items pages; payment happens in the browser. The web account centre is https://account.forsion.net.',
    ctx.account
      ? '- `forsion_account` reads the overview, usage, backpack and web pages' + (ctx.accountAction ? '; `forsion_account_action` can use a reset card, move quota to the background pool or send feedback, each with the user\'s approval' : '') + '. You cannot buy, redeem or change plans: send the user to Settings › Forsion Cloud.'
      : '- You cannot read or change the account from this conversation: send the user to Settings › Forsion Cloud.',
  ].join('\n'),
  other: [
    '## Other names users mention',
    '- **Forsion Clip:** the browser extension for Chrome and Edge. It clips web pages into the user\'s notes and, once paired with the desktop app, lets the agent control the browser. Settings › 浏览器控制 / Browser control › 浏览器扩展（Forsion Clip）/ Browser extension (Forsion Clip). Download page: https://forsion.net/clip/.',
    '- **Forsion Unit:** a Forsion that runs on another computer, a server or the cloud. The ribbon\'s "Forsion Unit 切换" / "Switch Forsion Unit" switches between this computer, the cloud and the user\'s other devices; Settings › 系统 › 设备 / System › Devices manages them.',
    '- **Notes (笔记, also called Amadeus):** the note vault Space; the `amadeus_*` tools read (and in work sessions write) notes and calendars.',
    '- **Muse (卜算子):** the background agent that keeps thinking and suggests things; it has its own Space and uses the background quota.',
    '- **Coding Studio (编码工作室):** the Space for coding projects.',
    '- **Forsion Extend:** the built-in extension behind the account, cloud sync, devices and Connect. Users rarely need to touch it.',
    '- **Help and docs:** https://forsion.net/docs/ ; What\'s new: https://forsion.net/releases/.',
  ].join('\n'),
});

/** 速查正文。topic 缺省 = 全部。 */
export function forsionGuide(ctx: GuideContext, topic?: GuideTopic): string {
  const rest = sections(ctx);
  const body = (t: GuideTopic): string => (t === 'git' ? gitSection(ctx) : rest[t]);
  const topics = topic ? [topic] : GUIDE_TOPICS;
  return [INTRO, ...topics.map(body)].join('\n\n');
}
