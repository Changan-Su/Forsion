# Forsion messaging guide

2026-11-10 · Checked against v2.14.0 and [forsion.net](https://forsion.net).

[中文](messaging.md) · [English README](../../README.md) · [Assets and provenance](../../.github/assets/showcase/README.md)

## Positioning

**Forsion is All You Need**<br>
A local-first second-brain workbench.<br>
What you've built up, you and AI carry forward together.

In one sentence: your things sit on one desk on your own computer, and you and AI keep using them in the same interface.

- The desk is the lead. Agents are the help working on it, not the product itself.
- Use "second-brain workbench" as a whole. Don't say "AI workbench" or "AI second brain" on their own.
- People and AI "complete each other": not overwriting each other, but completing each other. What's symmetric is the file format; the decisions are the user's.
- Don't compare Forsion with Claude Code or Codex as the same kind of product. They can join Forsion through ACP.

## Story

The website home page and the README follow the same example, a neighborhood book fair, in the same order:

1. **Home is your desk**: widgets on both sides, and material that stays as plain files on the computer.
2. **Ask, and the answer stays useful**: Tangu reads the files before it answers; the answer carries a card that works things out, kept as a widget and put on a dashboard.
3. **Muse speaks first**: urgent things come as a message, the rest as a letter, and it has a Space of its own.
4. **The Human Completion Plan**: `AGENT.md`, `HUMAN.md`, `SOUL.md` and `MEMORY.md` on both sides.
5. **Missing something? Get it from the store**: official plugins, finding one from a chat, adding your own sources; Forsion Clip.
6. **Build on it**: a plugin is a folder; three layers of Space, View and UI components; try it in a sandbox first.

Lead each part with what you can do with it, then name the feature.

## Words

| Use | Avoid | Note |
| --- | --- | --- |
| second-brain workbench | AI second brain, AI workbench | The desk is the lead |
| Tangu, the agent built into Forsion | "our AI" | Explain it the first time |
| Muse | 卜算子 in English text | The Chinese interface calls it 卜算子 |
| Arioso, Aria, Recita, Coding | Chinese names in English text | Chinese: 行香子, 浣溪沙, 临江仙, Coding |
| complete each other | merge, equal | The decisions are the user's |
| Sentence case in headings | Title Case | `Home is your desk`, not `Home Is Your Desk` |

## Ready-to-use descriptions

- **GitHub About**: Forsion is All You Need. A local-first second-brain workbench: your files on one desk, and AI working on it with you.
- **One sentence**: Forsion is a local-first second-brain workbench: your things sit on one desk on your own computer, and you and AI keep using them in the same interface.
- **Topics**: `second-brain`, `local-first`, `workbench`, `markdown`, `block-editor`, `ai-agents`, `personal-knowledge-management`, `plugins`, `desktop-app`, `ollama`.

## Boundaries of each claim

| Claim | Source | Boundary |
| --- | --- | --- |
| Muse speaks first | [Muse (中文)](../agents/muse.md) | Works while Forsion is running on the computer; the user sets active hours, budgets and approvals |
| Answers carry a card you can keep as a widget | [Changelog](../../desktop/CHANGELOG.md) 2.13.7, 2.14.0 | The Android app doesn't render these cards; it shows a note instead |
| An `AGENT.md` for one agent | — | Planned; say so wherever it appears |
| Memory can be forgotten | [Memory (中文)](../agents/memory.md) | Forgetting keeps the revision history, so don't say "permanently deleted"; memory upkeep isn't a nightly job, so don't say "while you sleep" |
| Claude Code and Codex can join | [External engines (中文)](../agents/external-engines.md) | They get the working folder and the current message, not Forsion's memory |
| Over twenty official plugins | The store | The number changes; check before quoting it |
| Plugins run in a sandbox first | [Plugin development](../customization/plugin-development.en.md) | A separate Forsion with an empty vault, signed out |

## Assets

See [Assets and provenance](../../.github/assets/showcase/README.md) for where the screenshots and the header image come from.
