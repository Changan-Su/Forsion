$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP -or !$env:FORSION_NSIS_FIXTURE) { throw 'Disposable Windows Actions fixture required' }
$taskRoot=[IO.Path]::GetFullPath($env:FORSION_NSIS_FIXTURE)
$taskPrefix=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
if (!$taskRoot.StartsWith($taskPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped RUNNER_TEMP' }
. "$PSScriptRoot/lib/windows-uninstall-owned.ps1"
. "$PSScriptRoot/lib/windows-assoc-handlers.ps1"
$taskInstall=Join-Path $taskRoot 'NSIS Probe Application'
$taskOutput=Join-Path $env:RUNNER_TEMP 'forsion-installed-file/evidence'
New-Item -ItemType Directory -Force $taskOutput | Out-Null
$taskChecks=[Collections.Generic.List[object]]::new()
$taskHive='HKCU:'
$taskScope='currentuser'
function Check([bool]$Value,[string]$Name) {
  $taskChecks.Add(@{name=$Name; passed=$Value})
  if (!$Value) { throw $Name }; Write-Host "PASS $Name"
}
function Default([string]$Ext,[string]$Hive=$taskHive) {
  $key="$Hive\Software\Classes\.$Ext"
  if (Test-Path $key) { return [string](Get-Item $key).GetValue('') }
  return ''
}
function PdfChoice {
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice'
  if (Test-Path $key) { $v=Get-ItemProperty $key; return @{ProgId=$v.ProgId; Hash=$v.Hash} | ConvertTo-Json -Compress }
  return 'absent'
}
function Install([string]$Scope='currentuser') {
  $script:taskScope=$Scope
  $script:taskHive=if ($Scope -eq 'allusers') {'HKLM:'} else {'HKCU:'}
  $proc=Start-Process -FilePath (Join-Path $taskRoot 'installer-fixture.exe') -ArgumentList "/S /$Scope /D=$taskInstall" -PassThru -WindowStyle Hidden
  $null=$proc.Handle
  if (!$proc.WaitForExit(120000)) { Stop-Process -Id $proc.Id; throw 'Source installer timed out' }
  Check ($proc.ExitCode -eq 0 -and (Test-Path (Join-Path $taskInstall 'ForsionRegistryProbe.exe'))) 'source NSIS install completes with inert payload'
  foreach ($kind in @('markdown','pdf')) {
    $base="$taskHive\Software\Classes\Forsion.forsion.$kind"
    $expected='"'+(Join-Path $taskInstall 'ForsionRegistryProbe.exe')+'" "%1"'
    Check ((Get-Item "$base\shell\open\command").GetValue('') -eq $expected) "source NSIS quotes the executable and entire file argument for $kind"
    Check ((Get-Item "$base\DefaultIcon").GetValue('') -eq ('"'+(Join-Path $taskInstall 'ForsionRegistryProbe.exe')+'",0')) "source NSIS quotes the icon path for $kind"
  }
  foreach ($ext in @('pdf','md','markdown')) {
    $class=if ($ext -eq 'pdf') {'Forsion.forsion.pdf'} else {'Forsion.forsion.markdown'}
    Check ((Get-Item "$taskHive\Software\Classes\.$ext\OpenWithProgids").GetValueNames() -contains $class) "source NSIS registers $ext in OpenWith"
  }
  Check ((PdfChoice) -eq $taskChoice) 'source install preserves genuine PDF UserChoice'
  Assert-ShellHandler (Join-Path $taskInstall 'ForsionRegistryProbe.exe') $true $taskOutput "source-install-$taskScope"
  $env:FORSION_NSIS_ARGS=Join-Path $taskRoot 'shell-args.txt'
  if (Test-Path $env:FORSION_NSIS_ARGS) { Remove-Item -LiteralPath $env:FORSION_NSIS_ARGS }
  $file=Join-Path $taskRoot '中文 note with spaces.markdown'
  Set-Content -LiteralPath $file -Value 'argument fixture'
  Start-Process -FilePath $file -WindowStyle Hidden
  $end=[DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path $env:FORSION_NSIS_ARGS) -and [DateTime]::UtcNow -lt $end) { Start-Sleep -Milliseconds 100 }
  Check ((Test-Path $env:FORSION_NSIS_ARGS) -and [IO.File]::ReadAllText($env:FORSION_NSIS_ARGS) -eq $file) 'real ShellExecute delivers one complete Unicode file argument through the quoted source registration'
}
function Uninstall {
  Invoke-OwnedNsisUninstall $taskInstall (Join-Path $taskRoot 'source-uninstall-worker.exe') $taskScope
  Check (!(Test-Path $taskInstall)) 'source uninstall removes complete payload directory'
  Assert-ShellHandler (Join-Path $taskInstall 'ForsionRegistryProbe.exe') $false $taskOutput "source-uninstall-$taskScope"
  foreach ($kind in @('markdown','pdf')) { Check (!(Test-Path "$taskHive\Software\Classes\Forsion.forsion.$kind")) "source uninstall removes its $kind ProgID" }
  foreach ($ext in @('pdf','md','markdown')) {
    Check ((Default $ext) -notin @('Forsion.forsion.pdf','Forsion.forsion.markdown')) "source uninstall clears its dangling $ext default"
    $key="$taskHive\Software\Classes\.$ext\OpenWithProgids"
    if (Test-Path $key) { Check (!@((Get-Item $key).GetValueNames() | Where-Object {$_ -in @('Forsion.forsion.pdf','Forsion.forsion.markdown')}).Count) "source uninstall clears its $ext OpenWith value" }
  }
  Check ((PdfChoice) -eq $taskChoice) 'source uninstall preserves genuine PDF UserChoice'
}
$taskChoice=PdfChoice
try {
  # First consume the real published installer's orphaned defaults. Do not
  # fabricate them: this migration check depends on the baseline step.
  foreach ($ext in @('pdf','md','markdown')) {
    $expected=if ($ext -eq 'pdf') {'Forsion.forsion.pdf'} else {'Forsion.forsion.markdown'}
    Check ((Default $ext) -eq $expected) "published baseline left its real $ext orphan for migration"
  }
  $taskMachineMd=Default 'md' 'HKLM:'
  $taskMachinePdf=Default 'pdf' 'HKLM:'
  Check ((Default 'markdown' 'HKLM:') -eq '') 'machine Markdown extension is unassigned before source migration'
  Install 'allusers'
  Check ((Default 'pdf') -eq $taskMachinePdf) 'source preserves the machine PDF owner while migrating the retired per-user default'
  $taskExpectedMd=if ($taskMachineMd) {$taskMachineMd} else {'Forsion.forsion.markdown'}
  Check ((Default 'md') -eq $taskExpectedMd) 'source keeps an existing machine Markdown owner or claims an unassigned one'
  foreach ($ext in @('pdf','md','markdown')) { Check ((Default $ext 'HKCU:') -eq '') "scope migration clears only the retired product's real orphan for $ext" }
  Uninstall
  # A machine-level default must not be overridden by a new HKCU claim.
  New-Item -Path 'HKLM:\Software\Classes\.md\OpenWithProgids' -Force | Out-Null
  Set-Item -Path 'HKLM:\Software\Classes\.md' -Value 'Forsion.machine.document'
  New-ItemProperty -Path 'HKLM:\Software\Classes\.md\OpenWithProgids' -Name 'Forsion.machine.document' -PropertyType None -Value ([byte[]]@()) -Force | Out-Null
  Install
  Check ((Default 'md') -eq '' -and (Default 'md' 'HKLM:') -eq 'Forsion.machine.document') 'per-user source install preserves a machine-level Markdown owner without shadowing it'
  Uninstall
  Check ((Default 'md' 'HKLM:') -eq 'Forsion.machine.document') 'per-user uninstall preserves the machine-level Markdown default'
  # Explicit synthetic negative controls: another Forsion product owns these
  # defaults. Our normal install, overwrite install and uninstall must preserve it.
  foreach ($ext in @('pdf','md')) {
    New-Item -Path "HKCU:\Software\Classes\.$ext\OpenWithProgids" -Force | Out-Null
    Set-Item -Path "HKCU:\Software\Classes\.$ext" -Value 'Forsion.other.document'
    New-ItemProperty -Path "HKCU:\Software\Classes\.$ext\OpenWithProgids" -Name 'Forsion.other.document' -PropertyType None -Value ([byte[]]@()) -Force | Out-Null
  }
  New-Item -Path 'HKCU:\Software\Classes\Forsion.other.document' -Force | Out-Null
  foreach ($round in 1..2) {
    Install
    foreach ($ext in @('pdf','md')) { Check ((Default $ext) -eq 'Forsion.other.document') "install $round preserves another product's $ext default" }
    Check ((Default 'markdown') -eq 'Forsion.forsion.markdown') "install $round claims the unassigned Markdown extension"
  }
  Uninstall
  foreach ($ext in @('pdf','md')) {
    Check ((Default $ext) -eq 'Forsion.other.document') "uninstall preserves another product's $ext default"
    Check ((Get-Item "HKCU:\Software\Classes\.$ext\OpenWithProgids").GetValueNames() -contains 'Forsion.other.document') "uninstall preserves another product's $ext OpenWith"
  }
  Check (Test-Path 'HKCU:\Software\Classes\Forsion.other.document') 'uninstall preserves the other product ProgID'
} finally {
  @{checks=$taskChecks; pdfUserChoicePresent=($taskChoice -ne 'absent'); root=$taskRoot} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOutput 'source-nsis-results.json') -Encoding utf8
}
