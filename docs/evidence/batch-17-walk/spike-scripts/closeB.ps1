param([Parameter(Mandatory)][string]$Tag, [switch]$Minimised)
$ErrorActionPreference = 'Continue'
$T = 'C:\Users\yazan\AppData\Local\Temp\magarine-spike'
. "$T\lib.ps1"
$s = Get-Content "$T\state-$Tag.json" -Raw | ConvertFrom-Json
$p = Get-Process -Id ([int]$s.pid) -ErrorAction SilentlyContinue
if (-not $p) { "spawned pid $($s.pid) is already gone" } else {
  $p.Refresh()
  if ($Minimised) { [void][W]::ShowWindow([IntPtr]$p.MainWindowHandle, 6); Start-Sleep -Milliseconds 800 }
  "pid $($s.pid): hwnd=$($p.MainWindowHandle) minimised=$([W]::IsIconic([IntPtr]$p.MainWindowHandle)) responding=$($p.Responding)"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ok = $p.CloseMainWindow()
  "CloseMainWindow() returned $ok"
  $h0 = [IntPtr][int64]$s.hwnd
  Start-Sleep -Milliseconds 1500
  "main window still visible 1.5 s after close: $([W]::IsWindowVisible($h0))"
  for ($i = 0; $i -lt 600; $i++) { $p.Refresh(); if ($p.HasExited) { break }; Start-Sleep -Milliseconds 100 }
  "spawned pid exited=$($p.HasExited) after $($sw.ElapsedMilliseconds) ms (polled up to 60 s)"
}
Start-Sleep -Seconds 3
$run = [string]$s.run
$left = @(Get-MyProcs $run | Where-Object { $_.Name -ne 'node.exe' })
"browser processes still carrying my profile marker 3 s later: $($left.Count)"
foreach ($x in (Get-MyProcs $run)) { if ($x.Name -ne 'node.exe') { "  leftover pid $($x.ProcessId) $($x.Name): stopping by PID" }; Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2
Get-Content "$run\page.log" -ErrorAction SilentlyContinue | Select-Object -Last 8
for ($i = 0; $i -lt 10; $i++) { try { Remove-Item -LiteralPath $run -Recurse -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 500 } }
"profile/run dir removed: $(-not (Test-Path -LiteralPath $run))"
"edge/chrome processes on the machine now: $((Get-Process msedge,chrome -ErrorAction SilentlyContinue | Measure-Object).Count)"
