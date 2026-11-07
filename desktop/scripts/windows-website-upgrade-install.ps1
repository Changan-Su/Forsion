$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or !$env:RUNNER_TEMP) {
  throw 'An isolated GitHub-hosted Windows runner is required'
}
$root = Join-Path $env:RUNNER_TEMP 'forsion-website-upgrade'
$installDir = Join-Path $root 'application'
$output = Join-Path $root 'evidence'
$exe = Join-Path $installDir 'Forsion.exe'
$fileName, $expected = if ($env:FORSION_UPDATE_CASE -eq 'no-extend') {
  'Forsion-NoExtend-2.13.6-x64.exe', '042beda4a656788a7728fbca9db7315de9e38d651b9b3ee5384cc4bec50e40a6'
} else {
  'Forsion-2.13.6-x64.exe', 'a6c57baf807b97ea9a3f42fbc2bd63859cf3a566020ab9194c2658b32b85d8b7'
}
$installer = Join-Path $root $fileName
$url = "https://github.com/Changan-Su/Forsion/releases/download/v2.13.6/$fileName"
if (Test-Path -LiteralPath $root) { throw 'Fixture directory must be fresh' }
$null = New-Item -ItemType Directory -Path $output
curl.exe --fail --silent --show-error --location --retry 1 --retry-max-time 200 --max-time 230 --output $installer $url
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $expected) { throw 'Official 2.13.6 release asset SHA-256 differs' }
$process = Start-Process -FilePath $installer -ArgumentList "/S /currentuser /D=$installDir" -PassThru -WindowStyle Hidden
$null = $process.Handle
if (!$process.WaitForExit(180000)) { Stop-Process -Id $process.Id; throw '2.13.6 installation timed out' }
if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath $exe)) { throw '2.13.6 NSIS installation failed' }
# If this installer launched the app, stop only the owned fixture executable before attaching Playwright.
foreach ($child in @(Get-CimInstance Win32_Process -Filter "Name = 'Forsion.exe'" | Where-Object { $_.ExecutablePath -eq $exe })) {
  Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
}
@{ name = $fileName; url = $url; sha256 = $hash; installerExit = $process.ExitCode } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'old-installer.json') -Encoding utf8
"FORSION_UPDATE_TEST_EXE=$exe" | Add-Content -LiteralPath $env:GITHUB_ENV
"FORSION_UPDATE_TEST_ROOT=$root" | Add-Content -LiteralPath $env:GITHUB_ENV
Write-Host "PASS $fileName matches the official GitHub SHA-256 and completed per-user NSIS installation"
