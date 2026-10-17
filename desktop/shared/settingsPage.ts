/** `ctx.ui.mountSettingsPage` / `ctx.ui.mountSettingsItem` (2026-10-17+): the host's settings parts, described as data.
 *  The plugin passes groups, items and callbacks; the host draws them and lays them out per device (rows that wrap
 *  on phones, a button + half sheet for pick-to-run choices, 36px touch targets). Parts carry no text of their own:
 *  every label comes from the plugin, in the plugin's own language. Colors always follow the host theme.
 *
 *  Every group and item needs an `id` that stays the same across `update()` calls: the host keys rows by it, so
 *  typed text and in-flight state stay with the right row when rows are added or removed. */

/** A name from the plugin icon vocabulary (`ListItem.icon`). Unknown names draw nothing. */
export type PluginSettingsIcon = string

/** Asked before the button's action runs. On Android it is a native half sheet. Cancel is labeled by the host. */
export interface PluginSettingsConfirm {
  title: string
  message?: string
  confirmLabel: string
  /** Red confirm button. Default true. */
  danger?: boolean
}

export interface PluginSettingsButton<V = void> {
  label: string
  /** Default `'ghost'`. */
  kind?: 'primary' | 'ghost' | 'danger'
  icon?: PluginSettingsIcon
  disabled?: boolean
  confirm?: PluginSettingsConfirm
  /** A returned promise keeps the button disabled until it settles. Input / stepper buttons receive the current value. */
  onClick(value: V): void | Promise<unknown>
}

export interface PluginSettingsOption {
  value: string
  label: string
  /** Second line in the phone sheet (choice only). */
  detail?: string
}

/** Empty / loading / error. `action` is the retry (or next step) button. */
export interface PluginSettingsState {
  kind: 'empty' | 'loading' | 'error'
  title: string
  desc?: string
  icon?: PluginSettingsIcon
  action?: PluginSettingsButton
}

export interface PluginSettingsMeter {
  label: string
  /** Fraction 0–1 (clamped). */
  value: number
  /** Shown at the right of the label. Default: the rounded percentage. */
  valueLabel?: string
  caption?: string
}

interface RowBase {
  id: string
  title: string
  desc?: string
  disabled?: boolean
}

export type PluginSettingsItem =
  /** Stays at the right on phones. A rejected promise flips it back. */
  | (RowBase & { type: 'switch'; value: boolean; onChange(value: boolean): void | Promise<unknown> })
  /** Read-only figure (already formatted by the plugin). Stays at the right. */
  | (RowBase & { type: 'value'; value: string })
  /** One button stays at the right on phones; two or more move under the title and fill the row. */
  | (RowBase & { type: 'button'; buttons: PluginSettingsButton[] })
  /** Text field, optionally with a button that receives the typed text. Moves under the title on phones. */
  | (RowBase & {
      type: 'input'
      value?: string
      placeholder?: string
      inputType?: 'text' | 'email' | 'url' | 'password' | 'search'
      onChange?(value: string): void
      button?: PluginSettingsButton<string>
    })
  /** A setting with a few short options (a segmented control). Stays a segmented control on phones when it fits. */
  | (RowBase & { type: 'segmented'; value: string; options: PluginSettingsOption[]; onChange(value: string): void | Promise<unknown> })
  /** A setting with a dropdown. Moves under the title on phones. */
  | (RowBase & { type: 'select'; value: string; options: PluginSettingsOption[]; onChange(value: string): void | Promise<unknown> })
  /** Picking runs something (e.g. "convert 5% / 10% / 20%"). Desktop: a row of buttons.
   *  Phones: one button labeled `button` that opens a half sheet with the options (`sheetTitle`, default `title`). */
  | (RowBase & { type: 'choice'; options: PluginSettingsOption[]; button: string; sheetTitle?: string; onPick(value: string): void | Promise<unknown> })
  /** Number with − / +, optionally with a button that receives the number. Moves under the title on phones. */
  | (RowBase & {
      type: 'stepper'
      /** Leave it out on later updates to keep the number the user stepped to. Default `min`, else 0. */
      value?: number
      min?: number
      max?: number
      step?: number
      onChange?(value: number): void
      button?: PluginSettingsButton<number>
    })
  /** A code to copy (invite code, key fingerprint). `copyLabel` is the button text. */
  | (RowBase & { type: 'code'; value: string; copyLabel: string; onCopy?(): void })
  /** Usage bars, two per line on desktop and one per line on phones. Filled with the host action color. */
  | { type: 'meters'; id: string; meters: PluginSettingsMeter[] }
  | { type: 'state'; id: string; state: PluginSettingsState }
  /** Anything not in this list: the host gives you an element (inside the panel, full width) and calls the returned
   *  cleanup when the block goes away. Mount parts into it with `ctx.ui.mountSettingsItem`. `mount` runs once per id. */
  | { type: 'custom'; id: string; mount(el: HTMLElement): void | (() => void) }

export interface PluginSettingsGroup {
  id: string
  icon?: PluginSettingsIcon
  title: string
  desc?: string
  /** Buttons at the top right of the panel. */
  actions?: PluginSettingsButton[]
  items: PluginSettingsItem[]
}

/** `state` set: the page shows only that (loading the whole page, signed out, failed to load). */
export interface PluginSettingsPageSchema {
  groups?: PluginSettingsGroup[]
  state?: PluginSettingsState
}

/** `update` replaces the whole description (not a patch). Rows with the same id keep typed text. */
export interface PluginSettingsPageHandle {
  update(schema: PluginSettingsPageSchema): void
  dispose(): void
}
export interface PluginSettingsItemHandle {
  update(item: PluginSettingsItem): void
  dispose(): void
}
