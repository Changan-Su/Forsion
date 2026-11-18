import { expect, it } from 'vitest'
import { appBundleOf, isDeveloperIdSignature } from './macSelfUpdate'

// `codesign -dv --verbose=2` 的真实输出形状(2.13.x 的 ad-hoc 包 / Developer ID 签名包)
const ADHOC = `Executable=/Applications/Forsion.app/Contents/MacOS/Forsion
Identifier=net.forsion.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=520 flags=0x20002(adhoc,linker-signed) hashes=5+7 location=embedded
Signature=adhoc
Info.plist entries=34
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=20`
const DEVID = `Executable=/Applications/Forsion.app/Contents/MacOS/Forsion
Identifier=net.forsion.desktop
CodeDirectory v=20500 size=520 flags=0x10000(runtime) hashes=5+7 location=embedded
Signature size=9046
Authority=Developer ID Application: Example Ltd (F3DBC75233)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=18 Nov 2026 at 10:00:00
TeamIdentifier=F3DBC75233
Runtime Version=26.0.0`

it('only a Developer ID signature with a team can be replaced by Squirrel.Mac', () => {
  expect(isDeveloperIdSignature(DEVID)).toBe(true)
  expect(isDeveloperIdSignature(ADHOC)).toBe(false)
  expect(isDeveloperIdSignature(DEVID.replace('TeamIdentifier=F3DBC75233', 'TeamIdentifier=not set'))).toBe(false)
  expect(isDeveloperIdSignature(DEVID.replace(/Developer ID Application/, 'Apple Development'))).toBe(false)
  expect(isDeveloperIdSignature('')).toBe(false)
})

it('finds the .app bundle from the executable path', () => {
  expect(appBundleOf('/Applications/Forsion.app/Contents/MacOS/Forsion')).toBe('/Applications/Forsion.app')
  expect(appBundleOf('/usr/local/bin/electron')).toBeNull()
})
