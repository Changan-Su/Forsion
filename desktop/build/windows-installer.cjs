const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');

// Keep upstream extraction, retries, uninstallation and rollback intact. Only
// promote an already extracted tree when the destination is empty and belongs
// to the current user's Programs directory. Never move Temp ACLs into Program
// Files or a custom/shared destination. Rename cannot cross volumes; on any
// failure the original copy path remains available with its source intact.
const promotion = String.raw`
  @{if} $installMode == "CurrentUser"
    @{GetParent} "$R0" $R2
    @{if} $R2 == "$LOCALAPPDATA\Programs"
      SetOutPath "$PLUGINSDIR"
      ClearErrors
      RMDir "$R0"
      IfErrors forsion_copy_payload
      ClearErrors
      Rename "$PLUGINSDIR\7z-out" "$R0"
      IfErrors forsion_copy_payload
      SetOutPath "$R0"
      Goto DoneExtract7za
    @{endif}
  @{endif}
  forsion_copy_payload:
  SetOutPath "$R0"
  ClearErrors
`.replaceAll('@{', '${');

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Unsupported NSIS template: ${before}`);
  return source.replace(before, after);
}

function createWindowsInstallerIncludes() {
  const templates = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');
  const output = mkdtempSync(join(tmpdir(), 'forsion-nsis-'));
  const read = file => readFileSync(join(templates, file), 'utf8');
  const extractor = replaceOnce(read('include/extractAppPackage.nsh'), '  # Retry counter', promotion + '\n  # Retry counter');
  writeFileSync(join(output, 'extractAppPackage.nsh'), extractor);
  return output;
}

module.exports = { createWindowsInstallerIncludes, replaceOnce };
