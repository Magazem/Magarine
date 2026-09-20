param([Parameter(Mandatory)][string]$Tag, [string]$Browser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', [string[]]$Extra = @('--disable-sync','--disable-features=msImplicitSignin'), [switch]$CloseNotificationFirst)
$ErrorActionPreference = 'Continue'
$T = 'C:\Users\yazan\AppData\Local\Temp\magarine-spike'
. "$T\lib.ps1"
& "$T\run3.ps1" -Browser $Browser -Tag $Tag -Extra $Extra -NoNotify *>&1 | Select-String -Pattern 'spawned' | Out-String
$s = Get-Content "$T\state-$Tag.json" -Raw | ConvertFrom-Json
# raise the notification and keep the debug session open long enough for it to show
$job = Start-Job { param($t, $d, $o) & node "$t\cdp3.mjs" $d $o 12 2>&1 } -ArgumentList $T, $s.dbg, "http://127.0.0.1:$($s.port)/"
Start-Sleep -Seconds 5
"page.log: " + ((Get-Content "$($s.run)\page.log" | Select-Object -Last 1))
if ($CloseNotificationFirst) {
  $o = & node "$T\cdp2.mjs" $s.dbg "http://127.0.0.1:$($s.port)/" "(()=>{window.__n.close(); return 'notification closed'})()" 2>&1 | Select-Object -First 1
  "close notification: $o"
  Start-Sleep -Seconds 2
}
Receive-Job $job -Wait | Out-Null
& "$T\closeB.ps1" -Tag $Tag *>&1 | Select-String -Pattern 'CloseMainWindow|visible|exited|still carrying|removed|now:' | Out-String
