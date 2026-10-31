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
