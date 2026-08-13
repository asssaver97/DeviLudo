import Foundation
import IOKit.hid

// A system-visible HID gamepad. Godot receives these reports through macOS' HID
// stack exactly as it would receive a physical controller; the game process is
// never injected with synthetic InputEvent objects.
private let reportDescriptor: [UInt8] = [
  0x05, 0x01, 0x09, 0x05, 0xA1, 0x01, 0x85, 0x01,
  0x05, 0x09, 0x19, 0x01, 0x29, 0x10, 0x15, 0x00,
  0x25, 0x01, 0x75, 0x01, 0x95, 0x10, 0x81, 0x02,
  0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x33,
  0x09, 0x34, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75,
  0x08, 0x95, 0x04, 0x81, 0x02, 0x09, 0x32, 0x09,
  0x35, 0x95, 0x02, 0x81, 0x02, 0xC0,
]

private let buttonIndex: [String: Int] = [
  "A": 0, "B": 1, "X": 2, "Y": 3, "LEFT_SHOULDER": 4,
  "RIGHT_SHOULDER": 5, "BACK": 6, "START": 7, "LEFT_STICK": 8,
  "RIGHT_STICK": 9, "DPAD_UP": 10, "DPAD_DOWN": 11,
  "DPAD_LEFT": 12, "DPAD_RIGHT": 13, "GUIDE": 14,
]
private let axisIndex: [String: Int] = ["LEFT_X": 0, "LEFT_Y": 1, "RIGHT_X": 2, "RIGHT_Y": 3]

private var buttons: UInt16 = 0
private var axes = [UInt8](repeating: 128, count: 4)
private var triggers = [UInt8](repeating: 0, count: 2)

private let properties: [String: Any] = [
  kIOHIDReportDescriptorKey as String: Data(reportDescriptor),
  kIOHIDProductKey as String: "DeviLudo Virtual Gamepad",
  kIOHIDManufacturerKey as String: "DeviLudo",
  kIOHIDVendorIDKey as String: 0x1209,
  kIOHIDProductIDKey as String: 0xD311,
  kIOHIDVersionNumberKey as String: 1,
  kIOHIDPrimaryUsagePageKey as String: 0x01,
  kIOHIDPrimaryUsageKey as String: 0x05,
]

guard CommandLine.arguments.dropFirst().first == "serve",
      let device = IOHIDUserDeviceCreate(kCFAllocatorDefault, properties as CFDictionary, 0) else {
  FileHandle.standardError.write(Data("unable to create Core HID virtual game controller\n".utf8))
  exit(64)
}

func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

func sendReport() throws {
  var report: [UInt8] = [1, UInt8(buttons & 0xFF), UInt8((buttons >> 8) & 0xFF)]
  report.append(contentsOf: axes)
  report.append(contentsOf: triggers)
  let result = IOHIDUserDeviceHandleReport(device, Data(report) as CFData)
  if result != kIOReturnSuccess { throw NSError(domain: "DeviLudoGamepad", code: Int(result)) }
}

func releaseAll() throws {
  buttons = 0; axes = [UInt8](repeating: 128, count: 4); triggers = [UInt8](repeating: 0, count: 2)
  try sendReport()
}

func duration(_ event: [String: Any]) -> UInt32 {
  UInt32(min(2_000, max(0, event["duration_ms"] as? Int ?? 0)))
}

func perform(_ event: [String: Any]) throws {
  guard let type = event["type"] as? String else { throw NSError(domain: "DeviLudoGamepad", code: 2) }
  switch type {
  case "gamepad_button_tap", "gamepad_button_hold":
    guard let name = event["button"] as? String, let index = buttonIndex[name] else { throw NSError(domain: "DeviLudoGamepad", code: 3) }
    buttons |= UInt16(1 << index); try sendReport()
    usleep(type == "gamepad_button_tap" ? 80_000 : duration(event) * 1_000)
    buttons &= ~UInt16(1 << index); try sendReport()
  case "gamepad_axis":
    guard let name = event["axis"] as? String, let index = axisIndex[name], let value = event["value"] as? Double, (-1.0...1.0).contains(value) else { throw NSError(domain: "DeviLudoGamepad", code: 4) }
    axes[index] = UInt8(((value + 1.0) * 127.5).rounded()); try sendReport()
    if duration(event) > 0 { usleep(duration(event) * 1_000); axes[index] = 128; try sendReport() }
  case "gamepad_trigger":
    guard let name = event["trigger"] as? String, let value = event["value"] as? Double, (0.0...1.0).contains(value) else { throw NSError(domain: "DeviLudoGamepad", code: 5) }
    let index = name == "LEFT" ? 0 : 1
    triggers[index] = UInt8((value * 255.0).rounded()); try sendReport()
    if duration(event) > 0 { usleep(duration(event) * 1_000); triggers[index] = 0; try sendReport() }
  case "gamepad_release_all": try releaseAll()
  default: throw NSError(domain: "DeviLudoGamepad", code: 6)
  }
}

while let line = readLine(strippingNewline: true) {
  var id = "unknown"
  do {
    let command = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
    id = command["id"] as? String ?? id
    switch command["command"] as? String {
    case "ready": try releaseAll()
    case "release_all": try releaseAll()
    case "sequence":
      guard let events = command["events"] as? [[String: Any]], !events.isEmpty, events.count <= 200 else { throw NSError(domain: "DeviLudoGamepad", code: 7) }
      for event in events { try perform(event) }
    case "destroy": try releaseAll(); emit(["id": id, "ok": true]); exit(0)
    default: throw NSError(domain: "DeviLudoGamepad", code: 8)
    }
    emit(["id": id, "ok": true])
  } catch {
    try? releaseAll()
    emit(["id": id, "ok": false, "error": error.localizedDescription])
  }
}
try? releaseAll()
