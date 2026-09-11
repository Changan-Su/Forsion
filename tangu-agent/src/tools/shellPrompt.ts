/** Match spawn({ shell: true }): Windows uses ComSpec, not /bin/sh. */
export function hostShellName(platform = process.platform): string {
  return platform === 'win32' ? 'Windows ComSpec, usually cmd.exe' : '/bin/sh -c';
}
export function hostShellQuoting(platform = process.platform): string {
  return platform === 'win32'
    ? 'On Windows, commands are parsed by ComSpec (usually cmd.exe), not Bash or PowerShell. Single quotes do not protect a command from cmd.exe pipes. For PowerShell scripts, prefer powershell.exe -NoProfile -EncodedCommand with UTF-16LE Base64, or a verified .ps1 file via -File; avoid nested shell quoting and do not assume Unix escaping. '
    : '';
}
