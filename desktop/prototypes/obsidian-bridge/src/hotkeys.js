// Obsidian public Hotkey declarations → native command bindings. Keep literal Ctrl/Meta distinct.
export function nativeHotkeys(hotkeys, mac) {
  if (!Array.isArray(hotkeys)) return [];
  const mods = { Mod: mac ? "meta" : "ctrl", Ctrl: "ctrl", Meta: "meta", Alt: "alt", Shift: "shift" };
  const aliases = { " ": "space", Space: "space", Esc: "escape", Up: "arrowup", Down: "arrowdown", Left: "arrowleft", Right: "arrowright" };
  return [...new Set(hotkeys.flatMap(hotkey => {
    if (!hotkey || typeof hotkey.key !== "string" || !Array.isArray(hotkey.modifiers)) return [];
    if (hotkey.modifiers.some(mod => !mods[mod])) return [];
    const key = aliases[hotkey.key] || hotkey.key.toLowerCase();
    // '+' is the host separator; do not silently turn malformed declarations into another binding.
    if (!key || key.includes("+") || ["control", "ctrl", "meta", "shift", "alt", "mod"].includes(key)) return [];
    return [[...new Set(hotkey.modifiers.map(mod => mods[mod])), key].flat().join("+")];
  }))];
}
