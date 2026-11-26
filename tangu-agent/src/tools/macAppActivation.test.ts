import { describe, expect, it } from 'vitest';
import { shellActivatesMacApp } from './macAppActivation.js';

describe('macOS foreground command routing', () => {
  it.each([
    `osascript -e 'tell application id "com.netease.163music" to activate' 2>&1; sleep 1`,
    `pgrep -x WeChat >/dev/null && echo running; /usr/bin/osascript -e 'tell application "WeChat" to activate'`,
    `osascript -e 'tell application "System Events" to set frontmost of application process "WeChat" to true'`,
    `osascript -e 'tell application "Finder"' -e '  activate' -e 'end tell'`,
    'open -a Music', 'if true; then open -a Music; fi', 'open /System/Applications/Music.app',
    'osascript <<EOF\ntell application "Music" to activate\nEOF',
  ])('routes activation through Computer Use: %s', cmd => expect(shellActivatesMacApp(cmd)).toBe(true));
  it.each([
    `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
    `osascript -e 'return "to activate"'`, `printf '%s' 'open -a Music; osascript -e activate'`,
    'open -gb com.netease.163music', 'open -ga Music', 'open -a Music -g', 'echo activate', 'git status # comment; open -a Music',
    "cat <<'DOC'\nopen -a Music\nDOC", 'open -a TextEdit local.txt',
    "osascript -e 'return 1 (* to activate *)'",
  ])('preserves non-activating commands: %s', cmd => expect(shellActivatesMacApp(cmd)).toBe(false));
});
