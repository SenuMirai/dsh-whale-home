param([Parameter(Mandatory = $true)][string]$PayloadBase64)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('DshWechatUi.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace DshWechatUi {
  public class Native {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static List<IntPtr> FindByProcess(string pattern) {
      var regex = new System.Text.RegularExpressions.Regex(pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
      var found = new List<IntPtr>();
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h)) return true;
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (pid == 0) return true;
        try {
          var proc = System.Diagnostics.Process.GetProcessById((int)pid);
          if (regex.IsMatch(proc.ProcessName)) {
            var title = new StringBuilder(512);
            GetWindowText(h, title, title.Capacity);
            if (title.Length > 0) found.Add(h);
          }
        } catch { }
        return true;
      }, IntPtr.Zero);
      return found;
    }

    public static List<IntPtr> Find(string needle) {
      var found = new List<IntPtr>();
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h)) return true;
        var title = new StringBuilder(512);
        GetWindowText(h, title, title.Capacity);
        var cls = new StringBuilder(256);
        GetClassName(h, cls, cls.Capacity);
        var t = title.ToString();
        var c = cls.ToString();
        if ((t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) ||
            (c.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)) {
          found.Add(h);
        }
        return true;
      }, IntPtr.Zero);
      return found;
    }
  }
}
'@
}

function Get-WechatWindow {
  $handles = [DshWechatUi.Native]::FindByProcess('weixin|wechat')

  $best = $null
  $bestArea = 0
  foreach ($h in $handles) {
    $r = New-Object DshWechatUi.Native+RECT
    [void][DshWechatUi.Native]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    if ($w -lt 200 -or $ht -lt 200) { continue }
    $area = $w * $ht
    if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
  }
  return $best
}

$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
$action = [string]$payload.action

switch ($action) {
  'probe' {
    $h = Get-WechatWindow
    if ($null -eq $h) { @{ found = $false } | ConvertTo-Json -Compress; break }
    $r = New-Object DshWechatUi.Native+RECT
    [void][DshWechatUi.Native]::GetWindowRect($h, [ref]$r)
    $title = New-Object System.Text.StringBuilder 512
    [void][DshWechatUi.Native]::GetWindowText($h, $title, $title.Capacity)
    @{ found = $true; title = $title.ToString(); left = $r.Left; top = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) } | ConvertTo-Json -Compress
  }
  'capture' {
    $h = Get-WechatWindow
    if ($null -eq $h) { @{ ok = $false; message = 'WeChat window not found' } | ConvertTo-Json -Compress; break }

    $r = New-Object DshWechatUi.Native+RECT
    [void][DshWechatUi.Native]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    if ($w -lt 50 -or $ht -lt 50) { @{ ok = $false; message = 'window too small' } | ConvertTo-Json -Compress; break }

    $src = New-Object System.Drawing.Bitmap($w, $ht)
    $g = [System.Drawing.Graphics]::FromImage($src)
    $hdc = $g.GetHdc()
    $ok = $false
    try { $ok = [DshWechatUi.Native]::PrintWindow($h, $hdc, 2) } catch { $ok = $false }
    $g.ReleaseHdc($hdc)
    $g.Dispose()

    $maxW = if ($payload.maxWidth) { [double]$payload.maxWidth } else { 1100 }
    $maxH = if ($payload.maxHeight) { [double]$payload.maxHeight } else { 1400 }
    $scale = [Math]::Min(1.0, [Math]::Min($maxW / $w, $maxH / $ht))
    $ow = [Math]::Max(1, [int][Math]::Floor($w * $scale))
    $oh = [Math]::Max(1, [int][Math]::Floor($ht * $scale))

    $dst = New-Object System.Drawing.Bitmap($ow, $oh)
    $g2 = [System.Drawing.Graphics]::FromImage($dst)
    $g2.DrawImage($src, 0, 0, $ow, $oh)
    $ms = New-Object IO.MemoryStream
    $dst.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $g2.Dispose(); $dst.Dispose(); $src.Dispose()

    @{ ok = [bool]$ok; pngBase64 = $b64; left = $r.Left; top = $r.Top; width = $w; height = $ht; scale = $scale } | ConvertTo-Json -Compress
  }
  'click' {
    $h = Get-WechatWindow
    if ($null -eq $h) { @{ ok = $false; message = 'WeChat window not found' } | ConvertTo-Json -Compress; break }
    $previous = [DshWechatUi.Native]::GetForegroundWindow()
    [void][DshWechatUi.Native]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 250

    $r = New-Object DshWechatUi.Native+RECT
    [void][DshWechatUi.Native]::GetWindowRect($h, [ref]$r)
    $x = $r.Left + [int]$payload.x
    $y = $r.Top + [int]$payload.y
    [void][DshWechatUi.Native]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 80
    [DshWechatUi.Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [DshWechatUi.Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 350
    if ($previous -ne [IntPtr]::Zero) { [void][DshWechatUi.Native]::SetForegroundWindow($previous) }
    @{ ok = $true } | ConvertTo-Json -Compress
  }
  'type' {
    $text = [string]$payload.text
    if ([string]::IsNullOrEmpty($text)) { @{ ok = $false; message = 'text required' } | ConvertTo-Json -Compress; break }
    $h = Get-WechatWindow
    if ($null -eq $h) { @{ ok = $false; message = 'WeChat window not found' } | ConvertTo-Json -Compress; break }
    [void][DshWechatUi.Native]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait($text)
    Start-Sleep -Milliseconds 250
    @{ ok = $true } | ConvertTo-Json -Compress
  }
  'key' {
    $key = [string]$payload.key
    if ([string]::IsNullOrEmpty($key)) { @{ ok = $false; message = 'key required' } | ConvertTo-Json -Compress; break }
    $h = Get-WechatWindow
    if ($null -eq $h) { @{ ok = $false; message = 'WeChat window not found' } | ConvertTo-Json -Compress; break }
    [void][DshWechatUi.Native]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait($key)
    Start-Sleep -Milliseconds 250
    @{ ok = $true } | ConvertTo-Json -Compress
  }
  default { @{ ok = $false; message = "unknown action: $action" } | ConvertTo-Json -Compress }
}
