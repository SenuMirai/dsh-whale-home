# 常驻的桌面操作宿主：C# 只编译一次，之后靠 stdin/stdout 收发 JSON 行。
# 一行一个请求，一行一个响应；进程活着就一直服务。
#
# 请求形如 {"action":"click","x":100,"y":200}
# 响应形如 {"ok":true} 或 {"ok":false,"message":"..."}

param([switch]$NoWindow)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('DshInput.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace DshInput {
  public class Native {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x1000;

    public static string ForegroundTitle() {
      var h = GetForegroundWindow();
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      return sb.ToString();
    }
  }
}
'@
}

$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen

function Invoke-Action($p) {
  $action = [string]$p.action
  switch ($action) {
    'ping' { return @{ ok = $true; pid = $PID } }

    'bounds' {
      return @{ ok = $true; left = $virtual.Left; top = $virtual.Top; width = $virtual.Width; height = $virtual.Height }
    }

    'cursor' {
      $pt = New-Object DshInput.Native+POINT
      [void][DshInput.Native]::GetCursorPos([ref]$pt)
      return @{ ok = $true; x = $pt.X; y = $pt.Y }
    }

    'foreground' {
      return @{ ok = $true; title = [DshInput.Native]::ForegroundTitle() }
    }

    'move' {
      [void][DshInput.Native]::SetCursorPos([int]$p.x, [int]$p.y)
      return @{ ok = $true }
    }

    'click' {
      $button = if ($p.button) { [string]$p.button } else { 'left' }
      $clicks = if ($p.clicks) { [Math]::Max(1, [Math]::Min(3, [int]$p.clicks)) } else { 1 }
      if ($null -ne $p.x -and $null -ne $p.y) { [void][DshInput.Native]::SetCursorPos([int]$p.x, [int]$p.y) }
      $down = 0x0002; $up = 0x0004
      if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 }
      elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
      for ($i = 0; $i -lt $clicks; $i += 1) {
        [DshInput.Native]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 12
        [DshInput.Native]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
        if ($i -lt $clicks - 1) { Start-Sleep -Milliseconds 40 }
      }
      return @{ ok = $true }
    }

    'scroll' {
      $amount = if ($p.amount) { [int]$p.amount } else { -120 }
      [DshInput.Native]::mouse_event(0x0800, 0, 0, [uint32]$amount, [UIntPtr]::Zero)
      return @{ ok = $true }
    }

    'key' {
      $keys = [string]$p.keys
      if ([string]::IsNullOrEmpty($keys)) { return @{ ok = $false; message = 'keys required' } }
      [System.Windows.Forms.SendKeys]::SendWait($keys)
      return @{ ok = $true }
    }

    'type' {
      $text = [string]$p.text
      if ([string]::IsNullOrEmpty($text)) { return @{ ok = $false; message = 'text required' } }
      if ($text -match '^[\x00-\x7F]*$') {
        [System.Windows.Forms.SendKeys]::SendWait($text)
      } else {
        Set-Clipboard -Value $text
        Start-Sleep -Milliseconds 60
        [System.Windows.Forms.SendKeys]::SendWait('^v')
      }
      return @{ ok = $true }
    }

    'screenshot' {
      $maxW = if ($p.maxWidth) { [double]$p.maxWidth } else { 1280 }
      $maxH = if ($p.maxHeight) { [double]$p.maxHeight } else { 800 }
      $scale = [Math]::Min(1.0, [Math]::Min($maxW / $virtual.Width, $maxH / $virtual.Height))
      $w = [Math]::Max(1, [int][Math]::Floor($virtual.Width * $scale))
      $h = [Math]::Max(1, [int][Math]::Floor($virtual.Height * $scale))
      $src = New-Object System.Drawing.Bitmap($virtual.Width, $virtual.Height)
      $g = [System.Drawing.Graphics]::FromImage($src)
      $g.CopyFromScreen($virtual.Left, $virtual.Top, 0, 0, $src.Size)
      $g.Dispose()
      $dst = New-Object System.Drawing.Bitmap($w, $h)
      $g2 = [System.Drawing.Graphics]::FromImage($dst)
      $g2.DrawImage($src, 0, 0, $w, $h)
      $g2.Dispose()
      $ms = New-Object IO.MemoryStream
      $dst.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $b64 = [Convert]::ToBase64String($ms.ToArray())
      $dst.Dispose(); $src.Dispose()
      return @{ ok = $true; pngBase64 = $b64; width = $w; height = $h; scale = $scale }
    }

    default { return @{ ok = $false; message = "unknown action: $action" } }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $resp = $null
  try {
    $payload = $line | ConvertFrom-Json
    $resp = Invoke-Action $payload
  } catch {
    $resp = @{ ok = $false; message = $_.Exception.Message }
  }
  try {
    $json = $resp | ConvertTo-Json -Compress -Depth 4
  } catch {
    $json = '{"ok":false,"message":"serialize failed"}'
  }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
