if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Association probes require a disposable runner' }
if (!('ForsionShellAssociations' -as [type])) { Add-Type -TypeDefinition (Get-Content -LiteralPath "$PSScriptRoot/windows-assoc-handlers.cs" -Raw) }
function Assert-ShellHandler([string]$Executable,[bool]$Present,[string]$Evidence,[string]$Phase) {
  $handlers=@([ForsionShellAssociations]::Read('.pdf'))
  $handlers | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Evidence "$Phase-pdf-shell-handlers.json") -Encoding utf8
  $ours=@($handlers | Where-Object {$_.NameResult -ge 0 -and $_.Name -and $_.Name.Equals($Executable,[StringComparison]::OrdinalIgnoreCase)})
  if (($ours.Count -gt 0) -ne $Present) { throw "Native Open With discovery did not match expected presence ($Present) of $Executable" }
  Write-Host "PASS native Open With discovery presence=$Present for this exact executable"
}
