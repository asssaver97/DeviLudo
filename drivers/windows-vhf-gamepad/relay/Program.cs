using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const uint GenericWrite = 0x40000000;
    private const uint OpenExisting = 3;
    private const uint IoctlSubmitReport = 0x0022A004;
    private static SafeFileHandle? device;
    private static GamepadReport report = GamepadReport.Neutral;

    private static readonly IReadOnlyDictionary<string, int> Buttons = new Dictionary<string, int>(StringComparer.Ordinal)
    {
        ["A"] = 0, ["B"] = 1, ["X"] = 2, ["Y"] = 3, ["LEFT_SHOULDER"] = 4,
        ["RIGHT_SHOULDER"] = 5, ["BACK"] = 6, ["START"] = 7, ["LEFT_STICK"] = 8,
        ["RIGHT_STICK"] = 9, ["DPAD_UP"] = 10, ["DPAD_DOWN"] = 11,
        ["DPAD_LEFT"] = 12, ["DPAD_RIGHT"] = 13, ["GUIDE"] = 14,
    };

    public static async Task<int> Main(string[] args)
    {
        if (args.Length < 1 || args[0] != "serve") return 64;
        device = CreateFileW("\\\\.\\DeviLudoVhfGamepad", GenericWrite, 0, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
        if (device.IsInvalid) { Console.Error.WriteLine($"unable to open VHF driver: {Marshal.GetLastWin32Error()}"); return 69; }
        Console.CancelKeyPress += (_, eventArgs) => { eventArgs.Cancel = true; TryRelease(); Environment.Exit(130); };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => TryRelease();
        Submit();
        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            string id = "unknown";
            try
            {
                using JsonDocument command = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 16 });
                JsonElement root = command.RootElement;
                id = root.TryGetProperty("id", out JsonElement idValue) && idValue.ValueKind == JsonValueKind.String ? idValue.GetString()! : id;
                string name = root.TryGetProperty("command", out JsonElement nameValue) && nameValue.ValueKind == JsonValueKind.String ? nameValue.GetString()! : "";
                if (name is "ready" or "release_all") ReleaseAll();
                else if (name == "sequence") await Sequence(root.GetProperty("events"));
                else if (name == "destroy") { ReleaseAll(); Reply(id, true, null); return 0; }
                else throw new InvalidOperationException("invalid gamepad command");
                Reply(id, true, null);
            }
            catch (Exception error)
            {
                TryRelease(); Reply(id, false, error.Message);
            }
        }
        TryRelease(); return 0;
    }

    private static async Task Sequence(JsonElement events)
    {
        if (events.ValueKind != JsonValueKind.Array || events.GetArrayLength() is < 1 or > 200) throw new InvalidOperationException("invalid gamepad sequence");
        foreach (JsonElement action in events.EnumerateArray()) await Perform(action);
    }

    private static async Task Perform(JsonElement action)
    {
        string type = RequiredString(action, "type");
        if (type == "gamepad_release_all") { ReleaseAll(); return; }
        if (type is "gamepad_button_tap" or "gamepad_button_hold")
        {
            if (!Buttons.TryGetValue(RequiredString(action, "button"), out int index)) throw new InvalidOperationException("invalid gamepad button");
            int duration = type == "gamepad_button_tap" ? 80 : RequiredInteger(action, "duration_ms", 1, 2000);
            report.Buttons |= (ushort)(1 << index); Submit(); await Task.Delay(duration);
            report.Buttons &= (ushort)~(1 << index); Submit(); return;
        }
        if (type == "gamepad_axis")
        {
            double value = RequiredNumber(action, "value", -1, 1); int duration = OptionalDuration(action);
            short raw = (short)Math.Round(value * short.MaxValue);
            string axis = RequiredString(action, "axis");
            if (axis == "LEFT_X") report.LeftX = raw; else if (axis == "LEFT_Y") report.LeftY = raw;
            else if (axis == "RIGHT_X") report.RightX = raw; else if (axis == "RIGHT_Y") report.RightY = raw;
            else throw new InvalidOperationException("invalid gamepad axis");
            Submit(); if (duration > 0) { await Task.Delay(duration); SetAxis(axis, 0); Submit(); } return;
        }
        if (type == "gamepad_trigger")
        {
            ushort raw = (ushort)Math.Round(RequiredNumber(action, "value", 0, 1) * ushort.MaxValue);
            int duration = OptionalDuration(action); string trigger = RequiredString(action, "trigger");
            if (trigger == "LEFT") report.LeftTrigger = raw; else if (trigger == "RIGHT") report.RightTrigger = raw;
            else throw new InvalidOperationException("invalid gamepad trigger");
            Submit(); if (duration > 0) { await Task.Delay(duration); if (trigger == "LEFT") report.LeftTrigger = 0; else report.RightTrigger = 0; Submit(); } return;
        }
        throw new InvalidOperationException("unsupported gamepad event");
    }

    private static void SetAxis(string axis, short value)
    {
        if (axis == "LEFT_X") report.LeftX = value; else if (axis == "LEFT_Y") report.LeftY = value;
        else if (axis == "RIGHT_X") report.RightX = value; else report.RightY = value;
    }

    private static string RequiredString(JsonElement value, string name) =>
        value.TryGetProperty(name, out JsonElement field) && field.ValueKind == JsonValueKind.String ? field.GetString()! : throw new InvalidOperationException($"{name} is invalid");
    private static int RequiredInteger(JsonElement value, string name, int minimum, int maximum) =>
        value.TryGetProperty(name, out JsonElement field) && field.TryGetInt32(out int number) && number >= minimum && number <= maximum ? number : throw new InvalidOperationException($"{name} is invalid");
    private static double RequiredNumber(JsonElement value, string name, double minimum, double maximum) =>
        value.TryGetProperty(name, out JsonElement field) && field.TryGetDouble(out double number) && double.IsFinite(number) && number >= minimum && number <= maximum ? number : throw new InvalidOperationException($"{name} is invalid");
    private static int OptionalDuration(JsonElement value) => value.TryGetProperty("duration_ms", out _) ? RequiredInteger(value, "duration_ms", 1, 2000) : 0;

    private static void ReleaseAll() { report = GamepadReport.Neutral; Submit(); }
    private static void TryRelease() { try { if (device is { IsInvalid: false, IsClosed: false }) ReleaseAll(); } catch { } device?.Dispose(); }

    private static void Submit()
    {
        int size = Marshal.SizeOf<GamepadReport>(); IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(report, buffer, false);
            if (!DeviceIoControl(device!, IoctlSubmitReport, buffer, (uint)size, IntPtr.Zero, 0, out _, IntPtr.Zero))
                throw new InvalidOperationException($"VHF report failed: {Marshal.GetLastWin32Error()}");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void Reply(string id, bool ok, string? error) => Console.WriteLine(JsonSerializer.Serialize(new { id, ok, error }));

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct GamepadReport
    {
        public byte ReportId; public ushort Buttons; public short LeftX; public short LeftY;
        public short RightX; public short RightY; public ushort LeftTrigger; public ushort RightTrigger;
        public static GamepadReport Neutral => new() { ReportId = 1 };
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input, uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
}
