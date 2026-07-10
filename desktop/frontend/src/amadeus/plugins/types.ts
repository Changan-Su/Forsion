// Public contract for Amadeus plugins. A plugin's setup(ctx) registers contributions
// (slash items, commands, accent themes, sidebar panels, status-bar items) and may return
// a disposer. The host enables built-in plugins on startup; enable/disable is persisted.
// This is the seam that lets the markdown block, themes, slash menu, command palette,
// sidebar, and status bar all be extended uniformly.

import type { ComponentType } from 'react'
import type { PropertyTypeDef } from '../blocks/database/propertyTypes'

/** A custom multi-dimensional-table (Database) property/column type a plugin can register.
 *  Provides render+edit + a primitive baseType for storage; see blocks/database/propertyTypes. */
export type PropertyTypeContribution = PropertyTypeDef

/** A slash-menu entry a plugin can contribute. */
export interface SlashContribution {
  id: string
  label: string
  hint?: string
  /** Short mono glyph shown in the menu badge. */
  icon?: string
  /** Section label; defaults to "插件". */
  group?: string
  /** Markdown scaffold inserted on pick. */
  scaffold: string
  /** Extra search keywords (zh/en). */
  keywords?: string
}

/** A command surfaced in the command palette (Cmd/Ctrl+K). */
export interface CommandContribution {
  id: string
  title: string
  run(): void
  keywords?: string
}

/** An accent theme a plugin can contribute (CSS is injected into a <style> when enabled). */
export interface ThemeContribution {
  id: string
  label: string
  swatch: string
  /** CSS defining [data-theme='<id>'][data-mode='light'|'dark'] variable blocks. */
  css: string
}

/** App actions exposed to plugins (no direct store access). */
export interface PluginAppApi {
  getActivePage(): string | null
  /** Concatenated text of the active page's blocks. */
  getActivePageText(): string
  loadPage(path: string): void
  createPage(): void
  toggleMode(): void
  setTheme(theme: string): void
  openSearch(): void
  openSwitcher(): void
  /** Show a transient toast. */
  notify(message: string): void
}

/** One achievement inside a plugin-registered series. Titles/descriptions are literal strings
 *  (plugins don't go through app i18n). `event` is the counter key the plugin bumps via
 *  ctx.achievements.track(); the host prefixes ids/events with `plugin:<pluginId>:` automatically. */
export interface AchievementContribution {
  id: string
  title: string
  desc: string
  event: string
  goal: number
  points: number
}

/** An achievement series a plugin can contribute (shows up in the Achievements panel).
 *  medals = claimed-points thresholds for bronze/silver/gold; omit to auto-derive from total points. */
export interface AchievementSeriesContribution {
  id: string
  title: string
  medals?: { bronze: number; silver: number; gold: number }
  achievements: AchievementContribution[]
}

/** A collapsible panel a plugin contributes to the sidebar. (React component; built-in plugins.) */
export interface PanelContribution {
  id: string
  title: string
  component: ComponentType
}

/** An item a plugin contributes to the bottom status bar. (React component; built-in plugins.) */
export interface StatusItemContribution {
  id: string
  component: ComponentType
}

export interface PluginContext {
  app: PluginAppApi
  registerSlashItem(item: SlashContribution): void
  registerCommand(command: CommandContribution): void
  registerTheme(theme: ThemeContribution): void
  registerPanel(panel: PanelContribution): void
  registerStatusItem(item: StatusItemContribution): void
  /** Register a custom Database property/column type (Obsidian-style open extension point). */
  registerPropertyType(def: PropertyTypeContribution): void
  /** Achievements: register a series and bump its counters. Series/achievement ids and events
   *  are auto-prefixed `plugin:<pluginId>:` (can't collide with or forge official ones). */
  achievements: {
    registerSeries(def: AchievementSeriesContribution): void
    track(event: string, n?: number): void
  }
}

export interface AmadeusPlugin {
  id: string
  name: string
  version: string
  description?: string
  /** Built-in plugins ship with the app and can't be uninstalled (only disabled). */
  builtin?: boolean
  /** External plugin origin: vault-local (.amadeus/plugins) or global (~/.forsion/amadeus/plugins). */
  source?: 'vault' | 'global'
  /** Manifest apiVersion (missing → 1). */
  apiVersion?: number
  minAppVersion?: string
  /** Present → gated out by the host: 'api' = apiVersion mismatch, 'minApp' = app too old. Never activated. */
  blocked?: 'api' | 'minApp'
  /** Wire up contributions; optionally return a disposer for teardown on disable. */
  setup(ctx: PluginContext): void | (() => void)
}
