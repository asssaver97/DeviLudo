param([string]$Command,[Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference='Stop'
function Arg([string]$Name){$i=[Array]::IndexOf($Arguments,$Name);if($i -lt 0 -or $i+1 -ge $Arguments.Count){throw "missing $Name"};$Arguments[$i+1]}
$pidValue=[int](Arg '--pid')
$process=Get-Process -Id $pidValue -ErrorAction Stop
for($i=0;$i -lt 300 -and $process.MainWindowHandle -eq 0;$i++){Start-Sleep -Milliseconds 100;$process.Refresh()}
if($process.MainWindowHandle -eq 0){throw 'display unavailable: game window did not appear'}
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DeviludoWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo;
  }

  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll", SetLastError=true)] static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll", SetLastError=true)] static extern bool AdjustWindowRectEx(ref RECT rect, int style, bool menu, int extendedStyle);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;

  public static void ResizeClient(IntPtr window, int width, int height) {
    RECT rect = new RECT { Left = 0, Top = 0, Right = width, Bottom = height };
    int style = GetWindowLong(window, -16), extended = GetWindowLong(window, -20);
    if (!AdjustWindowRectEx(ref rect, style, false, extended)
      || !MoveWindow(window, 40, 40, rect.Right - rect.Left, rect.Bottom - rect.Top, true)) {
      throw new InvalidOperationException("game client size could not be fixed");
    }
  }

  public static void Key(string name, bool down) {
    ushort virtualKey = VirtualKey(name);
    INPUT input = new INPUT { type = INPUT_KEYBOARD };
    input.U.ki = new KEYBDINPUT { wVk = virtualKey, dwFlags = down ? 0u : KEYEVENTF_KEYUP };
    Send(new [] { input });
  }

  public static void MovePointer(IntPtr window, int clientX, int clientY) {
    POINT point = new POINT { X = clientX, Y = clientY };
    if (!ClientToScreen(window, ref point)) throw new InvalidOperationException("mouse coordinate conversion failed");
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    INPUT input = new INPUT { type = INPUT_MOUSE };
    input.U.mi = new MOUSEINPUT {
      dx = (int)Math.Round((point.X - left) * 65535.0 / Math.Max(1, width - 1)),
      dy = (int)Math.Round((point.Y - top) * 65535.0 / Math.Max(1, height - 1)),
      dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
    };
    Send(new [] { input });
  }

  public static void Click(string button) {
    MouseButton(button, true);
    MouseButton(button, false);
  }

  public static void MouseButton(string button, bool pressed) {
    uint down, up;
    switch (button) {
      case "RIGHT": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
      case "MIDDLE": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
      case "LEFT": down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
      default: throw new ArgumentException("unsupported mouse button");
    }
    INPUT input = new INPUT { type = INPUT_MOUSE };
    input.U.mi = new MOUSEINPUT { dwFlags = pressed ? down : up };
    Send(new [] { input });
  }

  public static void Scroll(int deltaY) {
    INPUT input = new INPUT { type = INPUT_MOUSE };
    input.U.mi = new MOUSEINPUT { mouseData = unchecked((uint)deltaY), dwFlags = MOUSEEVENTF_WHEEL };
    Send(new [] { input });
  }

  public static void Text(string text) {
    var inputs = new List<INPUT>();
    foreach (char character in text) {
      INPUT down = new INPUT { type = INPUT_KEYBOARD };
      down.U.ki = new KEYBDINPUT { wScan = character, dwFlags = KEYEVENTF_UNICODE };
      INPUT up = new INPUT { type = INPUT_KEYBOARD };
      up.U.ki = new KEYBDINPUT { wScan = character, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP };
      inputs.Add(down); inputs.Add(up);
    }
    if (inputs.Count > 0) Send(inputs.ToArray());
  }

  static void Send(INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != (uint)inputs.Length) {
      throw new InvalidOperationException("SendInput failed");
    }
  }

  static ushort VirtualKey(string name) {
    var fixedKeys = new Dictionary<string, ushort>(StringComparer.Ordinal) {
      ["ENTER"] = 0x0D, ["TAB"] = 0x09, ["SPACE"] = 0x20, ["ESCAPE"] = 0x1B,
      ["LEFT"] = 0x25, ["UP"] = 0x26, ["RIGHT"] = 0x27, ["DOWN"] = 0x28,
      ["MINUS"] = 0xBD, ["EQUAL"] = 0xBB
    };
    string raw = name.StartsWith("KEY_", StringComparison.Ordinal) ? name.Substring(4) : name;
    ushort value;
    if (fixedKeys.TryGetValue(raw, out value)) return value;
    if (raw.Length == 1 && ((raw[0] >= 'A' && raw[0] <= 'Z') || (raw[0] >= '0' && raw[0] <= '9'))) return raw[0];
    throw new ArgumentException("unsupported keyboard input");
  }
}
'@
$handle=$process.MainWindowHandle
[DeviludoWindow]::SetForegroundWindow($handle)|Out-Null
function Send-DeviludoEvent($event){
  if($event.type -eq 'wait'){return}
  if($event.type -eq 'key_press'){[DeviludoWindow]::Key([string]$event.key,$true)}
  elseif($event.type -eq 'key_release'){[DeviludoWindow]::Key([string]$event.key,$false)}
  elseif($event.type -eq 'mouse_move'){[DeviludoWindow]::MovePointer($handle,[int]$event.x,[int]$event.y)}
  elseif($event.type -eq 'mouse_click'){[DeviludoWindow]::Click([string]$event.button)}
  elseif($event.type -eq 'mouse_down'){[DeviludoWindow]::MouseButton([string]$event.button,$true)}
  elseif($event.type -eq 'mouse_up'){[DeviludoWindow]::MouseButton([string]$event.button,$false)}
  elseif($event.type -eq 'scroll'){[DeviludoWindow]::Scroll([int]$event.deltaY)}
  elseif($event.type -eq 'text_input'){[DeviludoWindow]::Text([string]$event.text)}
  else{throw 'unsupported input event'}
}
if($Command -eq 'wait'){
  [DeviludoWindow]::ResizeClient($handle,[int](Arg '--width'),[int](Arg '--height'))
} elseif($Command -eq 'event'){
  $event=(Arg '--event'|ConvertFrom-Json)
  Send-DeviludoEvent $event
} elseif($Command -eq 'sequence'){
  $events=@((Arg '--events'|ConvertFrom-Json))
  if($events.Count -lt 1 -or $events.Count -gt 200){throw 'input sequence is invalid'}
  # Keep all events on one monotonic timeline. Relative Start-Sleep calls add
  # SendInput and PowerShell loop overhead to every subsequent delay.
  $clock=[Diagnostics.Stopwatch]::StartNew()
  [double]$dueMilliseconds=0
  foreach($event in $events){
    $delay=if($null -eq $event.delay_ms){0}else{[int]$event.delay_ms}
    if($delay -lt 0 -or $delay -gt 300000){throw 'input sequence delay is invalid'}
    $dueMilliseconds+=$delay
    $remaining=[int][Math]::Floor($dueMilliseconds-$clock.Elapsed.TotalMilliseconds)
    if($remaining -gt 0){Start-Sleep -Milliseconds $remaining}
    Send-DeviludoEvent $event
  }
} elseif($Command -eq 'capture'){
  $rect=New-Object DeviludoWindow+RECT
  if(![DeviludoWindow]::GetClientRect($handle,[ref]$rect)){throw 'capture backend could not read the client area'}
  $point=New-Object DeviludoWindow+POINT
  if(![DeviludoWindow]::ClientToScreen($handle,[ref]$point)){throw 'capture backend could not locate the client area'}
  $bitmap=New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  try{$graphics.CopyFromScreen($point.X,$point.Y,0,0,$bitmap.Size);$bitmap.Save((Arg '--output'),[Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}
} else{throw 'unsupported command'}
$client=New-Object DeviludoWindow+RECT
if(![DeviludoWindow]::GetClientRect($handle,[ref]$client)){throw 'game client area is unavailable'}
@{ok=$true;pid=$pidValue;windowId=$handle.ToInt64();width=($client.Right-$client.Left);height=($client.Bottom-$client.Top);capturedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress
