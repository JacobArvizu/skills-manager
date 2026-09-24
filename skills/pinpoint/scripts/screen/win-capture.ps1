# Pinpoint (Windows): screenshot the whole virtual desktop and snapshot the UI
# Automation tree of every top-level window (front to back), breadth-first under
# a time/node budget. Writes display-1.png and raw.json into -Out.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$BudgetMs = 8000,
  [int]$MaxNodes = 4000,
  [int]$MaxDepth = 12,
  [switch]$NoElements
)
$ErrorActionPreference = 'Stop'
$warnings = New-Object System.Collections.ArrayList

# Physical pixels everywhere: screenshot and UIA rectangles then share one space.
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class PinpointNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
}
"@
try { [PinpointNative]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { }   # PER_MONITOR_AWARE_V2
try { [PinpointNative]::SetProcessDPIAware() | Out-Null } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save((Join-Path $Out 'display-1.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$displays = @([ordered]@{ id = 1; x = $vs.Left; y = $vs.Top; width = $vs.Width; height = $vs.Height; file = 'display-1.png'; scale = 1 })
$tree = New-Object System.Collections.ArrayList

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $procNames = @{}
  $truncated = $false

  function Get-ProcName([int]$procId) {
    if (-not $procNames.ContainsKey($procId)) {
      try { $procNames[$procId] = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $procNames[$procId] = '' }
    }
    return $procNames[$procId]
  }
  function Add-Node($el, $parent) {
    try {
      $c = $el.Current
      if ($c.IsOffscreen) { return -1 }
      $r = $c.BoundingRectangle
      if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0 -or [double]::IsInfinity($r.Width)) { return -1 }
      $value = $null
      try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp) { $value = $vp.Current.Value; if ($value -and $value.Length -gt 500) { $value = $value.Substring(0, 500) } }
      } catch { }
      $node = [ordered]@{
        parent = $parent; app = (Get-ProcName $c.ProcessId); pid = $c.ProcessId
        role = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''); name = $c.Name
        description = $c.HelpText; value = $value; identifier = $c.AutomationId; className = $c.ClassName
        x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height
      }
      return $tree.Add($node)
    } catch { return -1 }
  }

  # Top-level windows come back in z-order (front first).
  $queue = New-Object System.Collections.Queue
  $w = $walker.GetFirstChild($root)
  while ($w -ne $null) {
    $id = Add-Node $w $null
    if ($id -ge 0 -and -not $NoElements) { $queue.Enqueue(@($w, $id, 1)) }
    $w = $walker.GetNextSibling($w)
  }
  while ($queue.Count -gt 0) {
    if ($sw.ElapsedMilliseconds -gt $BudgetMs -or $tree.Count -ge $MaxNodes) { $truncated = $true; break }
    $item = $queue.Dequeue()
    $child = $null
    try { $child = $walker.GetFirstChild($item[0]) } catch { }
    while ($child -ne $null) {
      if ($tree.Count -ge $MaxNodes) { $truncated = $true; break }
      $id = Add-Node $child $item[1]
      if ($id -ge 0 -and $item[2] -lt $MaxDepth) { $queue.Enqueue(@($child, $id, $item[2] + 1)) }
      try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
    }
  }
  if ($truncated) { [void]$warnings.Add('Element snapshot hit its time/size budget; raise --budget for deeper trees.') }
} catch {
  [void]$warnings.Add("UI Automation unavailable: $($_.Exception.Message)")
}

$result = [ordered]@{ displays = $displays; tree = $tree; warnings = $warnings }
$json = ConvertTo-Json -InputObject $result -Depth 6 -Compress
[System.IO.File]::WriteAllText((Join-Path $Out 'raw.json'), $json, (New-Object System.Text.UTF8Encoding $false))
