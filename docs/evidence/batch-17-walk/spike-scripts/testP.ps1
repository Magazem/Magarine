param([Parameter(Mandatory)][string]$Tag, [Parameter(Mandatory)][string]$Expr, [string]$Browser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', [string[]]$Extra = @('--disable-sync','--disable-features=msImplicitSignin'), [switch]$Screenshot)
$ErrorActionPreference = 'Continue'
$T = 'C:\Users\yazan\AppData\Local\Temp\magarine-spike'
. "$T\lib.ps1"
& "$T\run3.ps1" -Browser $Browser -Tag $Tag -Extra $Extra -NoNotify *>&1 | Select-String -Pattern 'spawned' | Out-String
$s = Get-Content "$T\state-$Tag.json" -Raw | ConvertFrom-Json
$job = Start-Job { param($t, $d, $o, $e) & node "$t\cdp4.mjs" $d $o 12 $e 2>&1 } -ArgumentList $T, $s.dbg, "http://127.0.0.1:$($s.port)/", $Expr
Start-Sleep -Seconds 5
"page.log: " + ((Get-Content "$($s.run)\page.log" | Select-Object -Last 2) -join ' | ')
if ($Screenshot) {
  $p = Get-Process -Id ([int]$s.pid); [void]$p.CloseMainWindow(); Start-Sleep -Milliseconds 1500
  $h = [IntPtr][int64]$s.hwnd
  "after CloseMainWindow: visible=$([W]::IsWindowVisible($h)) foreground='$(Get-Title ([W]::GetForegroundWindow()))'"
  if ([W]::IsWindowVisible($h) -and (Get-Title $h) -like 'Magarine spike window*') { $r = Get-Rect $h; Save-Region ($r.Left + 9) $r.Top ($r.Right - $r.Left - 18) ($r.Bottom - $r.Top - 9) "$T\$Tag-after-close.png"; "captured $Tag-after-close.png (verified title of my hwnd)" }
}
Receive-Job $job -Wait | Out-Null
& "$T\closeB.ps1" -Tag $Tag *>&1 | Select-String -Pattern 'CloseMainWindow|visible|exited|still carrying|removed|now:' | Out-String
