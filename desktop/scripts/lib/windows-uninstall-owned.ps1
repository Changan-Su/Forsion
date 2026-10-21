# Dot-source only on a disposable CI runner. The caller supplies a checked path.
function Invoke-OwnedNsisUninstall([string]$InstallPath,[string]$Worker,[string]$Scope='currentuser') {
  if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Disposable runner required' }
  $taskPrefix=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
  foreach ($taskPath in @($InstallPath,$Worker)) {
    if (![IO.Path]::GetFullPath($taskPath).StartsWith($taskPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Uninstall path escaped RUNNER_TEMP' }
  }
  if (!('ForsionOwnedUninstall' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ForsionOwnedUninstall {
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
  }
  $taskUninstaller=@(Get-ChildItem -LiteralPath $InstallPath -Filter 'Uninstall*.exe')
  if ($taskUninstaller.Count -ne 1) { throw 'Expected exactly one real NSIS uninstaller' }
  Copy-Item -LiteralPath $taskUninstaller[0].FullName -Destination $Worker
  if ((Get-FileHash -LiteralPath $Worker).Hash -ne (Get-FileHash -LiteralPath $taskUninstaller[0].FullName).Hash) { throw 'Uninstaller copy changed' }
  if ($Scope -notin @('currentuser','allusers')) { throw 'Invalid install scope' }
  $taskProcess=Start-Process -FilePath $Worker -ArgumentList "/S /$Scope _?=$InstallPath" -PassThru -WindowStyle Hidden
  $null=$taskProcess.Handle
  $taskOwners=[Collections.Generic.HashSet[int]]::new(); $null=$taskOwners.Add($taskProcess.Id)
  $taskEnd=[DateTime]::UtcNow.AddSeconds(120)
  do {
    $taskAll=@(Get-CimInstance Win32_Process)
    foreach ($child in $taskAll) { if ($taskOwners.Contains([int]$child.ParentProcessId)) { $null=$taskOwners.Add([int]$child.ProcessId) } }
    [ForsionOwnedUninstall]::Dismiss(@($taskOwners))
    Start-Sleep -Milliseconds 200
    $taskAlive=@($taskAll | Where-Object {$taskOwners.Contains([int]$_.ProcessId)})
  } while ($taskAlive.Count -and [DateTime]::UtcNow -lt $taskEnd)
  if ($taskAlive.Count) { if (!$taskProcess.HasExited) { & taskkill.exe /PID $taskProcess.Id /T /F | Out-Null }; throw 'NSIS worker timed out' }
  if (!$taskProcess.WaitForExit(1000) -or $taskProcess.ExitCode -ne 0) { throw 'NSIS worker failed' }
}
