# Windows acceptance — 2026-10-31

Windows 11 26200, Electron 40.10.2. The current H27T22S and CFORCE displays both use real 125% scaling; the user confirmed that no 150% display is available. No display setting, installed Forsion profile, production configuration, or release was changed.

## Mini (#23 / PR #179)

Merged current main (`66fc44859`) into the acceptance branch. The previously unstaged LCL release-coordinate and theme-radius changes are now included in the branch. A focused read-only GPT-6.1-sol review found no actionable correctness/lifecycle/data-loss regressions.

The current build exposed another real fractional-DPI defect: a remembered 380×300 content rectangle reopened as 383×303. The Windows transparent HWND constructor was treating its initial size differently from subsequent content bounds. Explicitly set the remembered content rectangle immediately after construction, before painting/showing. The regression now checks five consecutive close/reopen cycles, all exactly 380×300.

Validation: production build and TypeScript passed; 27 related unit tests passed; real Electron Mini suite **44/44**, including those five reopen cycles. Logs are under `desktop/outputs/windows-issues/1031/` (local artifacts).

Native Sky input on the primary 125% display resized 360→320 and 320→280. A native titlebar move cleared the old rounded mask before the position changed. Moving the actual window to the second physical display through the fixture's bounds API also cleared the old mask; this is not reported as a mouse cross-screen drag. On the secondary 125% display, native bottom-edge and right-edge gestures reached exactly **260×160**, with rounded corners still visible. At **640×900**, native short outward edge gestures stayed clamped to 640×900. Trusted pointer events, actual content bounds, display topology, renderer DPR and native shape calls were recorded in `native-stage/*.json`.

These current native gestures are short; the tool cannot hold the mouse at an out-of-window endpoint. They do not replace a sustained human outward-drag visual check or the unavailable mixed 125%/150% retest. Earlier compositor recordings and native 150% evidence remain documented in the October 23/24 reports. Do not close #23 by interpreting these current checks as the full remaining matrix.

## Diting (#7 / issue #1)

Plugin verification passed on current main (typecheck/build, 32 logic, 10 model checks, storage). The full fake-WAV/offline-ASR Windows run passed 41/42: media imports, Mini controls, UI zoom and actual crash recovery passed. The minimized run preserved PCM/transcription time over 340 seconds, but the page reported visible, so its strict hidden assertion correctly failed. A second short run also failed that precondition; speculative debugger focus changes were removed. A separate native-only mode avoids connecting any renderer debugger and records native visibility plus real PCM/ASR state; its result must be assessed separately.

Physical microphone permission, live speech and unplugging still require the user's participation and remain unverified.

## Other issues

The official website still advertises 2.13.7 / 461841453 bytes without SHA512. The existing real-NSIS downloader/hash result does not establish installed `quitAndInstall` or production dual-source behavior (#57). Temporary shortcut/ICO tests do not establish the installed icon/reboot/all-users matrix (#17). The history and application-reference native checks already completed remain in the October 24 report; outstanding lock/unlock, actual agent attribution, global hotkey/IME, elevated-window and virtual-desktop cases must not be inferred from unrelated probes.

## Subsequent results on the same day

PR #179 merged as `b6d98da6` after all five fast checks passed. The final native stage exercised all four edges on each current physical 125% display: width 360→280→260 and height 400→340→160, with opposing edges anchored. Trusted events, actual native bounds and rounded masks were retained in `desktop/outputs/windows-issues/1031/native-final/`. The two remaining sustained-motion visual checks still await a human result; no new 150% result is claimed.

Diting PR #7 merged as `e2d2df5c`. A separate native-only run, without connecting any renderer debugger, passed all three strict visibility preconditions. Actual background wall/transcription seconds: minimize 330.092/327.940, Notes Space 330.533/329.480, close-to-tray 330.086/329.220. Disk audit found 61/119 nonempty successful ASR segments and zero failed segments. The old 41/42 renderer-attached result remains above. A fresh real-editor click run then passed 5/5: Chinese-and-space folder name, corrected-word revert and persisted text, and opening each of transcript/notes/summary in ProseMirror. Only physical microphone permission/speech and unplugging remain for issue #1.

The installed icon test now uses the complete official 2.13.7 payload in a namespaced local NSIS installation, with `app.isPackaged=true`. The namespace isolates install path, protocol, AppUserModelId, legacy migration and default workspace; appearance logic is unchanged. This is a test variant, not an untouched stock installer. Desktop and Start Menu links plus an actual Explorer-pinned Taskbar link passed 8/8: built-in choice, restart persistence, custom upload/new ICO, sync off/on, default restore, manual desktop icon preservation and same-package reinstall/startup reconciliation. Actual Shell `SHGetFileInfoW` resolution (without USEFILEATTRIBUTES) confirmed the custom image in all three links, including after complete exit. Evidence is in `outputs/windows-issues/1031/icon-all-three-*.json` and `shell-native-icons-{result,after-exit}.json`. The task-created pin and installation were removed. Reboot, all-users permissions, Win10 and full taskbar visual refresh timing are still unverified.

Read-only app-reference inventory returned 17 windows / 290 apps, backed by 569 StartApps, 516 links and 149 App Paths records. IDs were unique, localized names were present, and no ApplicationFrameHost identity leaked through. A deliberately denied window snapshot preserved 284 cached installed apps with the explicit unavailable error. This is an injected per-instance failure, not a machine policy change. Global hotkey/IME, elevated windows, virtual desktops and real launches remain separate checks.

The history stage now offers a loopback browser fixture, explicit Chrome/Edge/Notepad allow-list commands and `HISTORY_BROWSER_ONLY=1`. Native browser actions are handed to the user because the computer-use tool could not verify Windows browser URLs. Only disposable fixture rows are written to stage receipts; collector data stays in the isolated temporary profile. Ordinary-browser URL stripping, lock/unlock and actual agent attribution are not marked passed without their own evidence.

The website direct-upload commit path was found to omit SHA512 despite the multipart/GitHub paths computing it. A focused backend fix is being validated separately; no production deployment or installer publication has occurred.
