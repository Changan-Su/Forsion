# Release versions

Desktop and engine versions are independent. Their tags are `v<desktop>` and `tangu-v<engine>`.

| Identity | Example | Meaning |
| --- | --- | --- |
| Stable | `2.13.7` | Normal installer release |
| Revision | `2.13.7+build.1` | A new installer revision of that stable version |
| Prerelease | `2.13.8-beta.1`, `2.13.8-rc.1` | Preview channel only |
| Prerelease revision | `2.13.8-beta.1+build.2` | Revision of that exact preview |

Use numeric `+build.N`, never `-build-N` for a stable revision. A hyphen introduces a prerelease. Four-part names such as `2.13.7.1` are not accepted release identities. Numeric fields cannot have leading zeroes. The reserved revision must be a safe nonnegative integer; other SemVer metadata does not affect ordering.

Forsion compares SemVer precedence first, then the reserved numeric revision when the core and prerelease identifiers are equal:

`2.13.7-rc.1 < 2.13.7 < 2.13.7+build.1 < 2.13.7+build.10 < 2.13.8-beta.1 < 2.13.8`.

Stable users never receive prereleases, even if a GitHub release is incorrectly missing its prerelease flag. Preview users can upgrade back to stable. Website installer records remain authoritative; GitHub is the fallback discovery source and an alternative download source pinned to the exact version. Android previews must have an APK asset.

The identity contract is `tangu-agent/src/contracts/releaseVersion.mjs`, also consumed through `desktop/shared/updateVersion.ts` and `desktop/shared/releaseVersion.mjs`. The standalone engine build copies it into `dist/contracts/`; hot-update packages must include and sign that runtime `.mjs`. Desktop host stamping and engine `minDesktop` use the same comparison, while engine npm identities keep their stable-only hot-update policy.

Stock SemVer and electron-updater ignore build metadata. Windows/Linux use a narrowly scoped bridge for a pinned same-version revision increase; it retains electron-updater's OS support and rollout checks and leaves the actual manifest version and checksum untouched. The real-library integration test must pass when upgrading electron-updater. macOS continues its existing manual DMG download flow.

This recognition support first ships in Desktop 2.13.7. Older installed clients cannot be retroactively taught revision ordering: first upgrade them to 2.13.7 or a newer ordinary patch. Do not offer a same-core metadata revision as the only upgrade route for older clients. Before publishing the first revision, run normal installer acceptance on each target platform; recognition tests do not replace installer validation.

npm ignores build metadata in package identities. Unit prereleases and metadata revisions therefore stay as downloadable build artifacts under the existing stable-only npm policy; they must never overwrite the base `@forsion/unit` version. A normal stable tag can publish to npm only from its exact clean tagged source. Engine source changes require their own unused engine version before a release; Desktop's number does not determine it.

No version/tag is changed merely by adding this compatibility support. Release after all intended changes have merged, using a new immutable tag and the full release gates.
