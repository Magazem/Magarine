param([string]$Tag)
$ErrorActionPreference = 'Continue'
$T = 'C:\Users\yazan\AppData\Local\Temp\magarine-spike'
. "$T\lib.ps1"
$s = Get-Content "$T\state-$Tag.json" -Raw | ConvertFrom-Json
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$h = [IntPtr][int64](Get-Process -Id ([int]$s.pid)).MainWindowHandle
[void][W]::ShowWindow($h, 9); Start-Sleep -Milliseconds 1200
# my own cover window (a WinForms form in a job of mine) takes the foreground; the app window stays OPEN but in the background
$cover = Start-Job { Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = 'spike-cover'; $f.StartPosition = 'Manual'; $f.Location = '2200,200'; $f.Size = '300,200'; $f.Add_Shown({ $f.Activate() }); $t = New-Object System.Windows.Forms.Timer; $t.Interval = 40000; $t.Add_Tick({ $f.Close() }); $t.Start(); [void]$f.ShowDialog() }
Start-Sleep -Seconds 3
"before: app minimised=$([W]::IsIconic($h)) foreground='$(Get-Title ([W]::GetForegroundWindow()))'"
$job = Start-Job { param($t, $d, $o) & node "$t\cdp3.mjs" $d $o 14 2>&1 } -ArgumentList $T, $s.dbg, "http://127.0.0.1:$($s.port)/"
Start-Sleep -Milliseconds 2500
$ox = $scr.Width - 520; $oy = $scr.Height - 60 - 12 - 240
Save-Region $ox $oy 516 240 "$T\$Tag-bg-toast.png"
$cursor0 = [System.Windows.Forms.Cursor]::Position
[void][W]::SetCursorPos($ox + 250, $oy + 90); Start-Sleep -Milliseconds 200
[W]::mouse_event(0x0001, 2, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 100
[W]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
[W]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 2000
"after click: foreground='$(Get-Title ([W]::GetForegroundWindow()))' app-is-foreground=$([W]::GetForegroundWindow() -eq $h)"
[void][W]::SetCursorPos($cursor0.X, $cursor0.Y)
Receive-Job $job -Wait | Out-Null
Stop-Job $cover -ErrorAction SilentlyContinue; Remove-Job $cover -Force -ErrorAction SilentlyContinue
"page.log:"; Get-Content "$($s.run)\page.log" | Select-Object -Last 5
