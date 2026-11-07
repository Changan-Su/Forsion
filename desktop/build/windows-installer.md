# Windows installation cost

`npm run check:installer-speed` runs the production NSIS extraction macro in
isolated, unregistered fixtures on Windows. It compares the original copy path
with directory promotion and verifies every payload byte. Nonempty destinations,
machine scope and custom destinations must retain the copy fallback. An optional
payload directory is read only: `npm run check:installer-speed -- <directory>`.
Add `--benchmark-only` to compare just copy versus promotion with a large payload;
`--build-only` runs the generated installer/new install/upgrade/uninstall chain.
Results and compiled fixtures remain in the printed temporary evidence directory.

Only an empty destination directly under the current user's LocalAppData/Programs
may be replaced with the staged directory. Per-machine/custom paths keep the
original copy behavior so temporary-directory ACLs never replace their security
boundary. Cross-volume or failed renames fall back to the stock retry path.
Old-version uninstallation and recovery are unchanged. This does not make the
whole upgrade transactional: it preserves electron-builder's existing guarantees.

`windows-installer.cjs` overrides only `extractAppPackage.nsh` via the compiler's
working directory. Do not replace `nsis.script`: that bypasses builder's generation
and signing of the uninstaller. Template changes fail closed if the insertion
point is no longer unique. `check:installer` checks the stock header search paths.

Backend dependency pruning removes declaration files and JS/TS/CSS source maps
on every build host (including cross-building Windows). Runtime TS, data `.map`
files, package metadata and license notices remain. Production debugging loses
dependency source-map remapping; executable JS remains byte-identical.
