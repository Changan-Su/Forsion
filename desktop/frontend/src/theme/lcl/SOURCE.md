# theme/lcl — Genesis-owned LCL compatibility layer

This directory keeps the small compatibility seam between Genesis and the historical LCL
`.tangu-lovable` contract. Genesis now owns the live base/skin/language files; the archived
Forsion-LCL study remains useful provenance, but it is no longer an upstream to sync blindly.

The runtime helper began as a vendored function the folder model could not express:

- `lovableData.ts` ← historical `Forsion-LCL/src/tangu/tanguData.ts` snapshot. Genesis is now the
  source of truth for this function because it owns independent background seeds, semantic
  `accent/on-accent` pairs, and the WCAG contrast guard. Do **not** copy the archived study back.

The historical named palettes were subsequently consolidated into `../skins.css`, while language
folders under `../themes/<id>/` now own structure only. Elevation aliases and the flat-mode rule
live in `../../styles/base.css`.

Single source of truth for Genesis theme behavior = repository-root `DESIGN.md` plus the files
named there (`styles/base.css`, `theme/skins.css`, and `theme/themes/<id>/theme.css`).
