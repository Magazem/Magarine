param(
  [Parameter(Mandatory)][string]$Browser,
  [Parameter(Mandatory)][string]$Tag,
  [string[]]$Extra = @(),
  [switch]$NoNotify
)
$ErrorActionPreference = 'Continue'
$T = 'C:\Users\yazan\AppData\Local\Temp\magarine-spike'
. "$T\lib.ps1"
function Taskbar-Names {
  (Find-ByName '' 'Shell_TrayWnd') | Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' } | ForEach-Object { $_.Current.Name }
}
$run = Join-Path $T ("run-$Tag-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $run | Out-Null
$profile = Join-Path $run 'window'
$srv = Start-Process node -ArgumentList "`"$T\server.mjs`"", "`"$run`"" -PassThru -WindowStyle Hidden
for ($i = 0; $i -lt 50 -and -not (Test-Path "$run\port.txt"); $i++) { Start-Sleep -Milliseconds 100 }
$port = [string](Get-Content "$run\port.txt")
$dbg = Get-Random -Minimum 41000 -Maximum 49000
$before = @(Taskbar-Names)
$launch = @("--app=http://127.0.0.1:$port/", "--user-data-dir=`"$profile`"", '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--window-size=1400,900', "--remote-debugging-port=$dbg") + $Extra
"launch: $Browser $($launch -join ' ')"
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process $Browser -ArgumentList $launch -PassThru
$hwnd = 0
for ($i = 0; $i -lt 150; $i++) { $p.Refresh(); if ($p.HasExited) { break }; if ($p.MainWindowHandle -ne 0) { $hwnd = [int64]$p.MainWindowHandle; break }; Start-Sleep -Milliseconds 100 }
"spawned pid $($p.Id); exited-early=$($p.HasExited); hwnd=$hwnd after $($sw.ElapsedMilliseconds) ms"
[pscustomobject]@{ run = $run; srv = $srv.Id; pid = $p.Id; hwnd = $hwnd; port = $port; dbg = $dbg; tag = $Tag } | ConvertTo-Json | Set-Content "$T\state-$Tag.json"
Start-Sleep -Seconds 4
$p.Refresh()
"title (MainWindowTitle): '$($p.MainWindowTitle)'"
$r = Get-Rect $hwnd
"window rect: $($r.Left),$($r.Top) - $($r.Right),$($r.Bottom) visible=$([W]::IsWindowVisible([IntPtr]$hwnd)) foreground-is-mine=$([W]::GetForegroundWindow() -eq [IntPtr]$hwnd)"
Save-Region ($r.Left + 9) $r.Top ($r.Right - $r.Left - 18) ($r.Bottom - $r.Top - 9) "$T\$Tag-fact1-window.png"
"captured $Tag-fact1-window.png"

# ---- fact 3: my taskbar button = the name that appeared after launch ----
$after = @(Taskbar-Names)
$new = @($after | Where-Object { $before -notcontains $_ })
"taskbar button names new after launch: $($new -join ' | ')   (before $($before.Count), after $($after.Count))"
if ($new.Count -ge 1) {
  $mine = @(Find-ByName $new[0] 'Shell_TrayWnd' | Where-Object { $_.Current.Name -eq $new[0] })
  if ($mine.Count -ge 1) {
    $b = $mine[0].Current.BoundingRectangle
    Save-Region ([int]$b.X - 6) ([int]$b.Y - 6) ([int]$b.Width + 12) ([int]$b.Height + 12) "$T\$Tag-fact3-taskbar-button.png"
    "captured $Tag-fact3-taskbar-button.png (my button $($b))"
    $cursor0 = [System.Windows.Forms.Cursor]::Position
    $cx = [int]($b.X + $b.Width / 2); $cy = [int]($b.Y + $b.Height / 2)
    [void][W]::SetCursorPos($cx - 20, $cy); Start-Sleep -Milliseconds 150
    [W]::mouse_event(0x0001, 5, 0, 0, [UIntPtr]::Zero)  # relative MOVE, so the shell sees a real hover
    [void][W]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 100
    [W]::mouse_event(0x0001, 1, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 2500
    Save-Region ([int]($cx - 220)) ([int]($cy - 300)) 440 296 "$T\$Tag-fact3-hover.png"
    "captured $Tag-fact3-hover.png"
    [void][W]::SetCursorPos($cursor0.X, $cursor0.Y)
  }
}

# ---- fact 4: grant for MY origin over MY debug port, click with a user gesture, capture the toast area ----
if (-not $NoNotify) {
  $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $job = Start-Job { param($t, $d, $o) & node "$t\cdp.mjs" $d $o 2>&1 } -ArgumentList $T, $dbg, "http://127.0.0.1:$port/"
  for ($i = 1; $i -le 8; $i++) {
    Start-Sleep -Milliseconds 700
    Save-Region ($scr.Width - 520) ($scr.Height - 60 - 12 - 240) 516 240 "$T\$Tag-fact4-frame-$i.png"
  }
  Receive-Job $job -Wait | Out-String
  "page.log:"; Get-Content "$run\page.log"
}
"STATE FILE: state-$Tag.json ; window is still open, close it with closeB.ps1 -Tag $Tag"
