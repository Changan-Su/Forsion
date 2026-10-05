/** Web rows of a `.ctx-menu` built from the same `SheetMenuItem` data the Android native sheet gets
 *  (lcl nativeSheetMenu): one item list per menu, two renders. The DOM matches the hand-written menus it
 *  replaced — `<button>{icon} {label}</button>`, `.danger`, `data-act` — so styles and harnesses hold. */
import React from 'react'
import type { SheetMenuItem } from '@lcl/engine'

export function CtxMenuButtons({ items }: { items: readonly SheetMenuItem[] }): React.ReactElement {
  return (
    <>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={it.danger ? 'danger' : undefined}
          data-act={it.act}
          disabled={it.disabled}
          onClick={it.run}
        >
          {it.icon} {it.label}
        </button>
      ))}
    </>
  )
}
