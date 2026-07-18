// Public contract for Amadeus plugins. A plugin's setup(ctx) registers contributions
// (slash items, commands, accent themes, sidebar panels, status-bar items) and may return
// a disposer. The host enables built-in plugins on startup; enable/disable is persisted.
// This is the seam that lets the markdown block, themes, slash menu, command palette,
// sidebar, and status bar all be extended uniformly.

import type { ComponentType } from 'react'
import type { PropertyTypeDef } from '../blocks/database/propertyTypes'
import type { PluginOnboardingSpec } from '@amadeus-shared/ipc'

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

/** A collapsible panel a plugin contributes to the sidebar. (React component; built-in plugins.)
 *  @deprecated Dead since the LCL shell — panels only ever rendered in the retired VaultSidebar.
 *  Contribute a workbench view via `registerView` instead. */
export interface PanelContribution {
  id: string
  title: string
  component: ComponentType
}

/** An item a plugin contributes to the bottom status bar. (React component; built-in plugins.)
 *  @deprecated Dead since the LCL shell — no live consumer renders these. */
export interface StatusItemContribution {
  id: string
  component: ComponentType
}

/** A workbench view a plugin can contribute (plain DOM mount — no React needed in the plugin).
 *  The host registers it into the engine view registry as `plugin:<pluginId>:<viewId>`, so custom
 *  Spaces can compose it (and declare it under `requires.views`), and the plugin's own commands
 *  can open it via `ctx.openView(viewId)`. Unregistered again when the plugin is disabled
 *  (open instances are closed first). */
export interface ViewContribution {
  /** View id, unique within the plugin (kebab-case recommended). */
  id: string
  /** Tab title shown in the workbench. */
  title: string
  /** Build the view's DOM into the host-provided element; called once per opened instance.
   *  Return a cleanup to run when the instance closes (clear timers/observers here). */
  mount(el: HTMLElement): (() => void) | void
  /** Default true: at most one instance app-wide (re-opening focuses the existing one). */
  singleton?: boolean
}

/** A user-tunable setting a plugin declares. The host renders the form on the plugin's detail
 *  page and persists values to localStorage `plugin.<pluginId>.<key>` — the plugin reads the
 *  same key at use time (poll-loop reads pick changes up next round; no change notification). */
export interface SettingContribution {
  /** Storage key suffix (localStorage `plugin.<pluginId>.<key>`). */
  key: string
  label: string
  type: 'number' | 'boolean' | 'text'
  default: string | number | boolean
  min?: number
  max?: number
  description?: string
}

export interface PluginContext {
  app: PluginAppApi
  registerSlashItem(item: SlashContribution): void
  registerCommand(command: CommandContribution): void
  registerTheme(theme: ThemeContribution): void
  /** @deprecated No live render surface — use registerView. */
  registerPanel(panel: PanelContribution): void
  /** @deprecated No live render surface. */
  registerStatusItem(item: StatusItemContribution): void
  /** Contribute a workbench view (registered as engine view type `plugin:<pluginId>:<id>`). */
  registerView(view: ViewContribution): void
  /** Open (or focus) one of this plugin's own registered views in the main area.
   *  No-op on hosts without a workbench (e.g. the standalone notes app). */
  openView(viewId: string): void
  /** Declare a tunable setting (rendered on the plugin detail page; localStorage-backed). */
  registerSetting(def: SettingContribution): void
  /** Register a custom Database property/column type (Obsidian-style open extension point). */
  registerPropertyType(def: PropertyTypeContribution): void
  /** Achievements: register a series and bump its counters. Series/achievement ids and events
   *  are auto-prefixed `plugin:<pluginId>:` (can't collide with or forge official ones). */
  achievements: {
    registerSeries(def: AchievementSeriesContribution): void
    track(event: string, n?: number): void
  }
  /** Activity log: report user actions inside the plugin's UI to the local activity journal
   *  (feeds background agents like Muse). Events are auto-prefixed `plugin:<pluginId>:`;
   *  `detail` values are sanitized/truncated by the host (`text` key = trailing snippet). */
  activity?: {
    log(event: string, detail?: Record<string, unknown>): void
  }
}

export interface AmadeusPlugin {
  id: string
  name: string
  version: string
  description?: string
  /** Built-in plugins ship with the app and can't be uninstalled (only disabled). */
  builtin?: boolean
  /** Manifest apiVersion (missing → 1). */
  apiVersion?: number
  minAppVersion?: string
  /** Companion app id (manifest.requiresApp); detail page renders install/probe UI when whitelisted in KNOWN_APPS. */
  requiresApp?: string
  /** README.md content for the detail page (external plugins only). */
  readme?: string
  /** Declarative first-run setup card (manifest `onboarding`; sanitized by the host). */
  onboarding?: PluginOnboardingSpec
  /** Present → gated out by the host: 'api' = apiVersion mismatch, 'minApp' = app too old. Never activated. */
  blocked?: 'api' | 'minApp'
  /** Wire up contributions; optionally return a disposer for teardown on disable. */
  setup(ctx: PluginContext): void | (() => void)
}
