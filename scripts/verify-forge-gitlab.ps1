param(
  [string]$PackageDirectory,
  [switch]$Live,
  [switch]$DiscussionFixture
)
$ErrorActionPreference = 'Stop'
if (-not $env:DSH_NODE_EXECUTABLE -or -not $env:DSH_INSTALL_DIR) {
  throw 'Run this verification in a DSH Desktop shell.'
}
$start = [System.Diagnostics.ProcessStartInfo]::new($env:DSH_NODE_EXECUTABLE)
$start.WorkingDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ($DiscussionFixture -and $Live) { throw 'Run the live read and the loopback discussion test separately.' }
$scriptName = if ($DiscussionFixture) { 'verify-discussion-actions.mjs' } else { 'verify-forge-gitlab.mjs' }
$start.ArgumentList.Add((Join-Path $PSScriptRoot $scriptName))
if ($Live) { $start.ArgumentList.Add('--live') }
if ($PackageDirectory) { $start.Environment['FORGE_SMOKE_PACKAGE'] = (Resolve-Path $PackageDirectory).Path }
$start.Environment['ELECTRON_RUN_AS_NODE'] = '1'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($start)
$stderr = $process.StandardError.ReadToEndAsync()
$stdout = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
[Console]::Out.Write($stdout)
[Console]::Error.Write($stderr.Result)
exit $process.ExitCode
