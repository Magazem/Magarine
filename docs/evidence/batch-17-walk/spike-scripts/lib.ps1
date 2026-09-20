# Helpers for the window spike. Never matches a process by name for anything destructive.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[void][W]::SetProcessDPIAware()

function Get-Rect($hwnd) {
  $r = New-Object W+RECT
  [void][W]::GetWindowRect([IntPtr]$hwnd, [ref]$r)
  return $r
}
function Save-Region([int]$x, [int]$y, [int]$w, [int]$h, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
function Get-Title($hwnd) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][W]::GetWindowText([IntPtr]$hwnd, $sb, 512)
  return $sb.ToString()
}
# Find UIA elements anywhere on the desktop whose Name contains $text (used to locate MY taskbar button / toast only).
function Find-ByName([string]$text, [string]$className = $null) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $scope = $root
  if ($className) {
    $cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ClassNameProperty), $className
    $scope = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if (-not $scope) { return @() }
  }
  $all = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $hits = @()
  foreach ($e in $all) {
    try { if ($e.Current.Name -like "*$text*") { $hits += $e } } catch {}
  }
  return $hits
}
# PIDs of processes whose command line contains $marker (my unique temp profile path). Listing only.
function Get-MyProcs([string]$marker) {
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) } | Select-Object ProcessId, ParentProcessId, Name
}
