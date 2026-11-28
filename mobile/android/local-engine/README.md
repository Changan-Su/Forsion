# "This phone" local engine: where the two halves come from

The local engine runs the Tangu engine in an Ubuntu arm64 environment under PRoot (`../native/proot/README.md`). It has two halves:

| Half | What | Where it comes from | Changes with |
|---|---|---|---|
| **Base** | Ubuntu 24.04 arm64 rootfs + Node 24 (`/opt/node`), about 63.5 MB xz | Inside the test-channel APK (`-PlocalEngine`), as a stored (uncompressed) asset, pinned by sha256 in `lock.json` | App updates only |
| **Engine** | Engine code + its linux-arm64 glibc `node_modules` (better-sqlite3, koffi, pglite …), about 50 MB gzip, ~10.5k files | npm package `@forsion/tangu-engine-android-arm64`, published by CI (`publish-android-engine.yml`), downloaded by the phone from npmmirror first, then registry.npmjs.org | Engine releases |

Normal (non-test-channel) APKs carry neither the launcher nor the base; the build checks that.

## Files on the phone

```
files/local-engine/rootfs/                   the base, unpacked from the APK asset (Ubuntu + Node; no engine inside)
files/local-engine/engines/<version>/        verified engine trees, bound at /opt/tangu when it runs (at most current + previous)
files/local-engine/installed.json            { schema: 2, base: {version, sha256}, engine: {version, fingerprint}, previous?: {...}, bad: [versions] }
files/local-engine/engine-health.json        consecutive pre-healthy start failures per engine version
files/local-engine/accounts/<k>/home/        bound at /root/.tangu (conversations, state.db) — never touched by install / update / delete
files/local-engine/accounts/<k>/engine-floor.json   the rollback floor of this account's data (see below)
cache/local-engine/downloads/                resumable .part files
```

The engine lives outside the rootfs, so an app update that brings a new base replaces the rootfs without re-downloading the engine,
and going back to the previous engine is a pointer change, not a 178 MB copy. **An app update with a new base replaces the
rootfs: whatever the agent installed with apt is gone** (conversations and workspace files stay; they are outside the rootfs).

## Version line

- The engine package version is the `tangu-agent` version it was built from (`x.y.z`, release versions only; npm versions are immutable).
- **Line** = an integer in `lock.json` (`line`). It changes whenever the base changes or the native ↔ engine contract
  changes incompatibly (env names, ready line, bind layout). The APK carries its line; CI publishes each engine version with
  exactly one dist-tag, `android-<line>` (npm trusted publishing cannot run `npm dist-tag add`, so one publish = one tag).
- The phone reads the dist-tag `android-<its line>`, never `latest`, so an engine that needs a newer base never reaches an APK
  with an older one. A new base = a new line; older APKs keep the last engine of their line until the app is updated.
- The APK also pins `minEngineVersion`: an older version that a stale mirror still serves under the tag is refused.
- Why not the desktop line (`@forsion/tangu-agent`, dist-tag `desktop-<desktop version>`): the phone has no desktop version,
  no bundled engine to compare against, and needs the dependencies; one publish carries one tag, so sharing the package would
  force one version to serve two lines. A separate package also keeps the desktop release gate out of it.

## Signature

`forsion-signed.json` in the package is signed as opaque bytes; the phone verifies before it parses (no re-serialisation in Java).
The signed message is `"forsion-android-engine-v1\n"` + the bytes of `forsion-signed.json` (the context line can never be a
desktop `SIGNATURE` table, which is JSON). The key is the engine signing key (`tangu-agent/src/boot/signingKey.ts`); the public
key and an Ed25519 verifier that does not use JCA (minSdk 26; platform Ed25519 starts at API 33) ship in the APK.

`forsion-signed.json` = `{ name, version, line, schemaFiles: [...], schemaFingerprint, files: { "<path>": [sha256hex, size] } }`.
The phone accepts an engine only if: the signature verifies; `name` is the package it asked for; `version` is the version it
asked for; `line` equals the APK's; `version ≥ minEngineVersion`; the unpacked tree holds exactly the listed files (regular
files only, no links, nothing extra, nothing missing, every sha256 and size equal); at most 20 000 files / 400 MB; and
`schemaFingerprint` recomputes from the listed hashes. Nothing in the staging tree runs before that. npmmirror's sha512 is not
a trust anchor; it is not used.

## Rollback rule (the data-loss path)

A real start runs the engine on an account's `home` (its `state.db`), and an engine may migrate the schema on its first start.
An older engine on a database a newer engine migrated can corrupt it or lose data. So:

1. **Schema fingerprint.** `fingerprint(E)` = sha256 over the sorted `path:sha256\n` lines of the engine's schema files
   (`dist/db/migrate.js`, `dist/db/schemaStandalone.js`, `dist/core/dialectDDL.js`, `dist/adapters/standalone/multiAccountSqliteHost.js`).
   The packer refuses to pack if any other `dist` file contains DDL (`CREATE TABLE/INDEX/VIRTUAL TABLE/TRIGGER/VIEW`,
   `ALTER TABLE`, `DROP TABLE`, `user_version`; any case, with whitespace or SQL comments between the keywords). The phone
   recomputes it from the signed hashes.
2. **Per-account history.** `accounts/<k>/engine-floor.json` lists `{version, fingerprint}` of every engine version that has
   been allowed to start on this account's data (outside `home`, so the guest cannot write it; it moves with the data on
   device transfer and survives deleting / reinstalling the environment). Before every real start, under the lifecycle lock
   that also blocks installs, for the engine E about to be bound:
   - **E may start only if every recorded version newer than E, or equal to it, has E's fingerprint.** Equal counts too:
     two signed builds of one version with different schema code are different engines, and the one that ran first may
     have migrated the data (a version number alone proves nothing). (Nothing recorded, or E at least
     as new as everything recorded → allowed. An older E is allowed only when no newer engine with different schema code
     has ever been let onto the data — this is what "roll back only on an identical fingerprint" means, and it closes the
     A → B → A case: v1 (A) after v2 (B) and v3 (A) is refused because v2 is newer than v1 and differs.)
   - Otherwise start is refused with `needs_update`: nothing is spawned, nothing is written.
   - A history that exists but cannot be read or parsed refuses the start (unknown is not empty).
   - When E is allowed and newer than everything recorded, E is appended **and made durable (fsync file, rename, fsync
     directory) before the spawn** — an engine may migrate and crash before it is healthy. Entries are never removed.
3. **The engine about to start is fixed under the lock**: account directory, engine tree and the history check are read in
   the same critical section as the spawn; installs and swaps take the same lock (maintenance), and a crash retry goes
   through the same check. The self-test runs on a throwaway data directory and never reads or writes a history.
4. **Crash budget.** A start whose every attempt (2 spawns) exits or times out before healthy counts one failure for that
   engine version, persisted in `engine-health.json` across `start()` calls and app restarts; a healthy start resets it.
   3 failed starts in a row mark the version bad (`installed.json` `bad`). With the current engine bad, a start uses the
   previous engine if there is one, it is not bad, and the signed-in account's history allows it (rule 2) — chosen per
   account, so one account's migrated data does not block another's. Otherwise start is refused with `engine_bad`, the page
   shows "needs an update", and nothing is deleted. A bad version is never offered as an update. A base change (app update
   with a new base) clears the bad list and the counters: the crash may have been the base.
5. **Updates only go forward.** An update is strictly newer than the installed engine and not bad; there is no
   user-triggered downgrade. A repair (reset with a tree that no longer verifies, or a committed record whose tree is
   gone) takes the same version or newer, never older. A same-version repair moves the old tree to `engines/.replaced`
   and the journal names the version it came from; an interrupted repair puts it back under that name only. The mirror's dist-tag is checked against the official registry when the mirror offers nothing
   newer. Before every start the retained engine must still be `≥ minEngineVersion` of the running APK.
6. **Versions** are canonical `x.y.z` release triples compared numerically (no prerelease, no `+meta`).

Known limits (accepted, written down so nobody mistakes the rule for more than it is):
- Fingerprint equality says the schema *code* is byte-identical, not that the data is. An engine that rewrites row
  encodings without touching the four schema files defeats it. Same rule as the desktop hot update (`overlay.ts`).
- A new engine that raised the history and then crashed before opening the database blocks the older one on that
  account although the data was never touched: the host cannot prove that. Recovery is a newer engine.
- Release process: engine versions are one sequence on `main`. Never publish a higher version built from older schema
  code for an older line; rule 2 would let it onto data a lower-numbered, newer-schema engine migrated.
- Data written before histories existed (pre-release test builds of #921 only) starts with an empty history.
- The environment is shared by every account on the phone and is writable from inside it: `/opt/tangu` (the bound
  engine tree), `/opt/node` and the rest of the rootfs. An agent run can change code that a later start — also another
  account's — runs. The signature is checked when an engine is installed, updated or reset, not on every start.
  (Same as #921: one environment per phone.)
- Extracted trees and the rootfs are not fsynced file by file: a power cut right after an install can leave a torn tree
  behind a committed record. Account data is not affected (it is outside both); the engine then fails to start, is
  marked bad after three starts, and reset rebuilds the environment.
- A line bump does not by itself stop engines of the old line that are already installed: when old engines cannot run
  with the new APK, raise `minEngineVersion` in the same change.

Download and unpack: the engine tarball is unpacked before its signature is read, by a strict extractor — regular files
and directories under canonical names only (a link, hard link or special entry, `a//b`, `./x`, more than 40 000 entries
or 64 levels fails the unpack), so nothing can be written through a link. Only gzip is accepted (no xz decoder sizes a
dictionary for an unsigned file), and a header that does not parse makes the archive malformed: it is evicted and the
next registry tried. A partial download is never resumed from
another registry. Nothing in the staging tree runs before the verification passes.

## Building the test-channel APK

```bash
cd mobile/android && ./gradlew assembleDebug -PlocalEngine -PlocalEngineBase=/path/to/base-….tar.xz
```

`-PlocalEngineBase` (or `ANDROID_LOCAL_ENGINE_BASE`) points at the file pinned in `lock.json`; without it the build looks in
`~/.forsion-dev/local-engine/<file>`. A missing file or a sha256 mismatch fails a `-PlocalEngine` build. CI fetches it from
`lock.json` `url` when that is set; while it is empty, test-channel CI builds go out without the launcher (with a notice).

## Building and publishing the engine package

```bash
mobile/scripts/local-engine/build-android-engine.sh <out-dir> --boot-check   # after `npm run build` in tangu-agent
```

Three containers (linux/arm64 Ubuntu 24.04, the base's Node): **stage** runs `npm ci --omit=dev` (dependency install
scripts) with no key; **sign** runs no package code, signs, packs, and verifies the tarball against the key the APK pins
(`--expect-key`); **boot** starts the engine from the tarball with no key and the output mounted read-only, and the
tarball's sha256 must be unchanged afterwards. The sign phase replaces only this version's own tarball in `<out-dir>`.

CI (`.github/workflows/publish-android-engine.yml`) is three jobs so no dependency code shares a job with a credential:
**build** (host `npm ci` + `tsc`; no secret, no OIDC) → **sign** (fresh checkout + the built `dist`; the key is in this
job, dependency scripts run only in the keyless stage container) → **publish** (OIDC; downloads the tarball and runs no
package code), then a sync request to npmmirror.
