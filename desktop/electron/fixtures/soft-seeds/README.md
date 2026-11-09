# Soft seed fixtures

Verbatim `theme.json` / `theme.css` that earlier desktop builds wrote into `<home>/themes/soft/` on first run
(evaluated from `electron/seedThemes.ts` at each commit that changed it: `b2d9521d3`, `beb7fefd5`, `7ba5ac5a1`).
`themeMigrations.test.ts` uses them to prove an untouched copy is recognised; `SHIPPED_SOFT_SEEDS` holds their hashes.
Test data only; never shipped.
