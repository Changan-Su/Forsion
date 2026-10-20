param([Parameter(Mandatory=$true)][ValidateSet('install','uninstall')][string]$Mode)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Disposable Windows Actions runner required' }
$taskRoot=[IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'forsion-installed-file'))
$taskTemp=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
if (!$taskRoot.StartsWith($taskTemp,[StringComparison]::OrdinalIgnoreCase)) { throw 'Install target escaped RUNNER_TEMP' }
$taskInstall=Join-Path $taskRoot 'application'
$taskOutput=Join-Path $taskRoot 'evidence'
New-Item -ItemType Directory -Force $taskOutput | Out-Null
function Read-PdfChoice {
  $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice'
  if (Test-Path $key) { $value=Get-ItemProperty $key; return [ordered]@{ProgId=$value.ProgId; Hash=$value.Hash} }
  return $null
}
function Check([bool]$value,[string]$name) { if (!$value) { throw $name }; Write-Host "PASS $name" }
$taskMarkdown='HKCU:\Software\Classes\Forsion.forsion.markdown'
$taskPdf='HKCU:\Software\Classes\Forsion.forsion.pdf'
if ($Mode -eq 'install') {
  Check (!(Test-Path $taskMarkdown) -and !(Test-Path $taskPdf)) 'runner has no prior Forsion file registrations'
  $taskBefore=Read-PdfChoice
  @{pdfChoice=$taskBefore; version='2.13.5'} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskOutput 'before.json') -Encoding utf8
  $taskRelease=Invoke-RestMethod 'https://api.github.com/repos/Changan-Su/Forsion/releases/tags/v2.13.5'
  $taskAsset=@($taskRelease.assets | Where-Object name -eq 'Forsion-2.13.5-x64.exe')
  Check ($taskAsset.Count -eq 1 -and $taskRelease.tag_name -eq 'v2.13.5') 'official release has the exact standard Windows installer'
  $taskInstaller=Join-Path $taskRoot 'Forsion-2.13.5-x64.exe'
  Invoke-WebRequest -Uri $taskAsset[0].browser_download_url -OutFile $taskInstaller
  $taskHash=(Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  Check ($taskAsset[0].digest -eq "sha256:$taskHash") 'installer SHA256 matches GitHub release asset digest'
  @{name=$taskAsset[0].name; url=$taskAsset[0].browser_download_url; digest=$taskAsset[0].digest; tag=$taskRelease.tag_name} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskOutput 'installer-receipt.json') -Encoding utf8
  $taskProcess=Start-Process -FilePath $taskInstaller -ArgumentList "/S /currentuser /D=$taskInstall" -PassThru -WindowStyle Hidden
  $null=$taskProcess.Handle
  if (!$taskProcess.WaitForExit(180000)) { Stop-Process -Id $taskProcess.Id; throw 'NSIS installation timed out' }
  Check ($taskProcess.ExitCode -eq 0 -and (Test-Path (Join-Path $taskInstall 'Forsion.exe'))) 'real per-user NSIS installation completes'
  # Some installer variants start the app after installation. Stop only that
  # executable in this verified temporary installation before preparing data.
  foreach ($child in @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.Equals((Join-Path $taskInstall 'Forsion.exe'),[StringComparison]::OrdinalIgnoreCase)})) {
    & taskkill.exe /PID $child.ProcessId /T /F | Out-Null
  }
  foreach ($key in @($taskMarkdown,$taskPdf)) {
    Check (Test-Path "$key\shell\open\command") "NSIS registers $($key.Split('\')[-1])"
    $command=(Get-Item "$key\shell\open\command").GetValue('')
    Check ($command.Contains((Join-Path $taskInstall 'Forsion.exe')) -and $command.Contains('%1')) 'registered open command targets this installed executable and its file argument'
  }
  $taskDefault=(Get-Item 'HKCU:\Software\Classes\.md').GetValue('')
  Check ($taskDefault -eq 'Forsion.forsion.markdown') 'NSIS claims unassigned Markdown extension'
  $taskAfter=Read-PdfChoice
  Check (($taskBefore | ConvertTo-Json -Compress) -eq ($taskAfter | ConvertTo-Json -Compress)) 'NSIS preserves existing PDF UserChoice state'
  if (!$taskBefore) { Write-Host 'UNVERIFIED genuine pre-existing PDF UserChoice is absent; preservation of a user-selected Edge/Acrobat default remains unverified' }
  "FORSION_INSTALLED_EXE=$(Join-Path $taskInstall 'Forsion.exe')" | Add-Content -LiteralPath $env:GITHUB_ENV
  "FORSION_INSTALLED_OUTPUT=$taskOutput" | Add-Content -LiteralPath $env:GITHUB_ENV
} else {
  # NSIS's regular uninstall prompts whether to delete account/workspace data.
  # Dismiss only those two exact prompts of the owned uninstall process tree.
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ForsionUninstallPrompts {
  delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumProc fn, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
  public static void Dismiss(int[] owners) {
    EnumWindows((hwnd,_)=> { uint pid; GetWindowThreadProcessId(hwnd,out pid); if(Array.IndexOf(owners,(int)pid)<0) return true;
      var text=new StringBuilder(); EnumChildWindows(hwnd,(child,unused)=>{var part=new StringBuilder(2048); GetWindowText(child,part,part.Capacity); text.Append(part); return true;},IntPtr.Zero);
      if(text.ToString().Contains("同时删除 Forsion")) SendMessage(hwnd,0x111,new IntPtr(7),IntPtr.Zero);
      return true;
    },IntPtr.Zero);
  }
}
'@
  $taskUninstaller=@(Get-ChildItem -LiteralPath $taskInstall -Filter 'Uninstall*.exe')
  Check ($taskUninstaller.Count -eq 1) 'installed application has its real NSIS uninstaller'
  $taskProcess=Start-Process -FilePath $taskUninstaller[0].FullName -ArgumentList '/S' -PassThru -WindowStyle Hidden
  $taskOwners=[Collections.Generic.HashSet[int]]::new(); $null=$taskOwners.Add($taskProcess.Id)
  $taskEnd=[DateTime]::UtcNow.AddSeconds(120)
  do {
    $taskAll=@(Get-CimInstance Win32_Process)
    foreach ($child in $taskAll) { if ($taskOwners.Contains([int]$child.ParentProcessId)) { $null=$taskOwners.Add([int]$child.ProcessId) } }
    [ForsionUninstallPrompts]::Dismiss(@($taskOwners))
    Start-Sleep -Milliseconds 200
    $taskAlive=@($taskAll | Where-Object {$taskOwners.Contains([int]$_.ProcessId)})
  } while ($taskAlive.Count -and [DateTime]::UtcNow -lt $taskEnd)
  Check (!(Test-Path $taskMarkdown) -and !(Test-Path $taskPdf) -and !(Test-Path (Join-Path $taskInstall 'Forsion.exe'))) 'real uninstall removes both Forsion ProgIDs and executable'
  $taskBefore=Get-Content -LiteralPath (Join-Path $taskOutput 'before.json') -Raw | ConvertFrom-Json -AsHashtable
  Check (($taskBefore.pdfChoice | ConvertTo-Json -Compress) -eq ((Read-PdfChoice) | ConvertTo-Json -Compress)) 'uninstall preserves original PDF UserChoice state'
}
