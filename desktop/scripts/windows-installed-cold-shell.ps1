param([string]$Executable,[string]$File,[string]$Output)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Disposable Windows runner required' }
$taskPrefix=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
foreach ($taskPath in @($Executable,$File,$Output)) {
  if (![IO.Path]::GetFullPath($taskPath).StartsWith($taskPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Cold-shell path escaped RUNNER_TEMP' }
}
function Owned { return @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.Equals($Executable,[StringComparison]::OrdinalIgnoreCase)}) }
$taskEvidence=@{file=$File; executable=$Executable; passed=$false}
try {
  if ((Owned).Count) { throw 'Cold shell requires the installed app to be stopped first' }
  Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
  # No debug arguments, rewritten registry command or injected open-file event.
  Start-Process -FilePath $File -WindowStyle Hidden
  $taskEnd=[DateTime]::UtcNow.AddSeconds(60)
  do {
    $taskProcesses=Owned
    $taskNames=[Collections.Generic.List[string]]::new()
    foreach ($taskProc in $taskProcesses) {
      $taskHandle=(Get-Process -Id $taskProc.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle
      if (!$taskHandle) { continue }
      try {
        $taskRoot=[System.Windows.Automation.AutomationElement]::FromHandle($taskHandle)
        $taskNodes=$taskRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
        foreach ($taskNode in $taskNodes) {
          $taskNames.Add($taskNode.Current.Name)
          $taskPattern=$null
          if ($taskNode.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$taskPattern)) {
            $taskNames.Add($taskPattern.DocumentRange.GetText(12000))
          }
        }
      } catch [System.Windows.Automation.ElementNotAvailableException] { }
    }
    $taskText=$taskNames -join "`n"
    if ($taskText.Contains('Outside note.md') -and $taskText.Contains('SAVED BY INSTALLED APP')) { break }
    Start-Sleep -Milliseconds 400
  } while ([DateTime]::UtcNow -lt $taskEnd)
  $taskEvidence.processes=@($taskProcesses | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)
  $taskEvidence.accessibilityText=$taskText
  if (!$taskText.Contains('Outside note.md') -or !$taskText.Contains('SAVED BY INSTALLED APP')) { throw 'Cold ShellExecute did not expose the expected file and saved content in native accessibility' }
  if (!@($taskProcesses | Where-Object {$_.CommandLine.Contains($File)}).Count) { throw 'Actual cold installed process did not receive the complete path' }
  $taskEvidence.passed=$true
  Write-Host 'PASS real cold ShellExecute starts the installed application with the complete file and renders its saved content'
} catch {
  $taskEvidence.error=$_.Exception.Message
  throw
} finally {
  $taskEvidence | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Output -Encoding utf8
  $taskAlive=Owned
  $taskIds=@($taskAlive.ProcessId)
  foreach ($taskProc in @($taskAlive | Where-Object {$_.ParentProcessId -notin $taskIds})) {
    try { & taskkill.exe /PID $taskProc.ProcessId /T /F 2>$null | Out-Null } catch { }
  }
  $taskCleanupEnd=[DateTime]::UtcNow.AddSeconds(5)
  while ((Owned).Count -and [DateTime]::UtcNow -lt $taskCleanupEnd) { Start-Sleep -Milliseconds 100 }
  if ((Owned).Count) { throw 'Cold installed application did not terminate during owned cleanup' }
}
