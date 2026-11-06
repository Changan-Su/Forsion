---
title: Appearance and themes
description: Mix design languages, palettes and light or dark mode, tune a theme in place, and pick your own fonts.
---

# Appearance and themes

Appearance lives in Settings → Appearance. The default is the Genesis classic palette with "Raised" shadows, and menus and popovers share a soft shadow. Switch to "Flat" to hide decorative shadows; the choice is saved and synced to your other windows. Flat doesn't change focus rings, selection or menu motion. Design language, palette, light or dark mode, glass and fonts can each be changed on their own.

Submenus open with a short fade and a slight expand, and follow your system's Reduce motion setting.

## Three axes

Themes are made of three independent axes that combine freely:

- **Design language** sets the **character**: fonts, density, texture. Genesis and Genesis Glass are built in, and a first install also adds Soft. More languages come from the Store or the themes folder. A language only shapes structure; colors come from the palette.
- **Palette** sets the **colors**. Classic, Coral, Teal, Lavender and Sky are built in, plus **Custom**: the accent color drives buttons, selection and links, and the background color drives the base surface. The two are tuned separately, so a personal mix such as "off-white paper with an ink-teal accent" is just two color picks. Older "Zhi blue" preferences keep their stored id and now show as Sky.
- **Light or dark**: Light, Dark or Follow system. Every design language and palette works in both.

## Genesis Glass

A built-in theme with native macOS glass. The shell (ribbon, sidebars, tab bar) blends into the desktop wallpaper behind the window, and so do the sidebars of secondary screens such as Settings and the Store. The main paper surface stays opaque, so text never shows the background through it and every palette stays readable.

It always follows the system appearance: when the system switches between light and dark, so does Glass.

## Tune in place

Select a theme in Settings and its own options appear right below it: glass opacity, overlay blur, tint vibrancy, borders and so on. Each theme declares its own knobs, so different themes show different options. Changes apply immediately.

## Three font slots

Interface, body and monospace fonts can each be set. The interface font covers shell text such as menus and buttons, the body font covers reading areas in notes and chats, and the monospace font covers code blocks and terminals. **Leave a slot empty to follow the theme**, so the theme author's typography isn't overridden.

## Details

- Scrollbars are transparent at rest and appear while scrolling or on hover.
- Smooth caret (the caret glides as you type) is off by default; turn it on in Appearance if you like it.
- "Relaxed text" and "Calm transitions" are on by default: note and chat text gets looser line and paragraph spacing, and switching views is a little slower. Turn either off in Appearance and it behaves exactly as before.
- "Dim the edges" is off by default. When on, the Ribbon, inactive tabs, the left sidebar and the cards beside a chat are dimmed until the pointer or keyboard focus moves there.

## Theme packages

You can install more than the built-in themes:

- **From the Store**: one click in the [Store](market.md)'s Themes category, then choose it in Settings → Appearance.
- **By hand**: a theme package is a folder in the `themes/` data directory. Drop a package there.
- **Submit your own**: made a theme others might like? Submit it to the Store.

## For theme authors: thumbnails in Settings

Each theme card in Settings → Appearance draws a small thumbnail that shows **structure only** (colors always come from the user's current palette). Optional fields in `theme.json`:

- `preview.shape`: `paper` / `glass` / `soft` / `compact`. When omitted it's inferred from `tags` (`glass`, `compact` and `soft` each map to their shape), then `panelGap > 0` (floating card layout) maps to `soft`, and anything else is `paper`.
- `preview.font`: `sans` / `serif` / `mono`, the glyphs in the thumbnail. When omitted, a `serif` tag draws serif and everything else draws sans (a `mono` tag means a monochrome palette, not a monospace font).

## For theme authors: motion belongs to Forsion

Themes control how things look (structure beyond color: fonts, radii, shadows, layout). **Forsion manages motion itself.** When a theme from disk or the Store is installed, `theme.css` is processed first:

- **Motion token declarations are removed**: `--duration-*`, `--ease-*`, `--menu-enter-duration` / `--menu-exit-duration`, `--droplet-duration`, `--collapse-duration`, `--tip-*`, `--hovercard-*`, `--switch-edge-*` and the rest, on any selector. An `@property` block that registers one of these names is removed too, and `settings` entries in `theme.json` that use these names have no effect. Settings shows "N motion settings in this theme were ignored" under the theme.
- **Your own `@keyframes` get the prefix** `t-<theme id>-`. References to them in `animation` / `animation-name` inside `theme.css` are rewritten too, so they keep working; you just can't replace a built-in animation by reusing its name. References passed through a custom property (`--a: fade 1s; animation: var(--a)`) aren't rewritten, so write them in `animation` directly.
- **Your own `@layer` names get the same prefix.**
- **The system's Reduce motion setting always wins.** That rule sits in the first layer Forsion declares, so even `!important` in a theme can't override it.

To make the interface move differently, wait for motion themes to open up and submit one separately. Don't change motion inside a theme package.

## Everywhere at once

A theme applies to the whole app: chats, Amadeus notes, every Space and every dialog share one character. The web and mobile apps use the same appearance settings.

## Next

- [Store](market.md): install themes other people made
- [Plugins](plugins.md): change capabilities, not just looks
- [Workspace and interface](../getting-started/workspace.md): how the Ribbon, tabs and status bar are laid out
