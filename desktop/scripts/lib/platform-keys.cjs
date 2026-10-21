/** Test chords describe macOS intent; exercise the actual host's equivalent. */
module.exports = key => {
  if (process.platform === 'darwin') return key
  const navigation = {
    'Meta+ArrowLeft': 'Home', 'Meta+ArrowRight': 'End',
    'Meta+ArrowUp': 'Control+Home', 'Meta+ArrowDown': 'Control+End',
    'Meta+Shift+ArrowLeft': 'Shift+Home', 'Meta+Shift+ArrowRight': 'Shift+End',
  }
  return navigation[key] || key.replace(/^Meta\+/, 'Control+')
}
