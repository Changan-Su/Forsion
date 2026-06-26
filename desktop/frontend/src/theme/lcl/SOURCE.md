# theme/lcl — vendored from Forsion-LCL

Tangu Desktop is the **source** of the LCL `.tangu-lovable` design language (LCL extracted it
from here). So we do **not** vendor the base CSS — Tangu's own `styles/base.css` + the
`themes/{lovable,echo,qbird}/` folders are authoritative for the token values and shell classes.

The only thing vendored here is the runtime helper the folder model can't express:

- `lovableData.ts` ← `Forsion-LCL/src/tangu/tanguData.ts` (the `customSkinVars` seed→vars fn + its
  hex helpers, for the `custom` skin). Re-sync by copying that section verbatim.

The static skin **values** (lovable/echo/qbird, light + dark) were copied from
`Forsion-LCL/src/tangu/tangu.css` (the `.tangu-lovable[data-skin=…]` / `[data-mode='dark']`
blocks) into `../themes/<id>/theme.css`, with the selector translated
`.tangu-lovable[data-skin='X'][data-mode='dark']` → `.dark[data-theme='X']` to fit Tangu's
existing `[data-theme]` + `.dark` engine. The 6 elevation tokens
(`--on-accent/--card-shadow/--btn-shadow/--icon-shadow/--inset/--focus`) and the
`html[data-flat='1']` rule live in `../../styles/base.css`.

Single source of truth for shared values = Forsion-LCL.
