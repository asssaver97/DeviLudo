import CoreHID
import Foundation

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

private enum DriverError: LocalizedError {
  case invalidCommand(Int)
  case unavailable

  var errorDescription: String? {
    switch self {
    case .invalidCommand(let code): return "invalid gamepad command (\(code))"
    case .unavailable: return "unable to create Core HID virtual game controller"
    }
  }
}

@available(macOS 15, *)
private final class DeviceDelegate: HIDVirtualDeviceDelegate, @unchecked Sendable {
  func hidVirtualDevice(
    _ device: HIDVirtualDevice,
    receivedSetReportRequestOfType type: HIDReportType,
    id: HIDReportID?,
    data: Data
  ) async throws {}

  func hidVirtualDevice(
    _ device: HIDVirtualDevice,
    receivedGetReportRequestOfType type: HIDReportType,
    id: HIDReportID?,
    maxSize: Int
  ) async throws -> Data { Data() }
}

@available(macOS 15, *)
private actor GamepadController {
  private let device: HIDVirtualDevice
  private var buttons: UInt16 = 0
  private var axes = [UInt8](repeating: 128, count: 4)
  private var triggers = [UInt8](repeating: 0, count: 2)

  init(device: HIDVirtualDevice) { self.device = device }

  private func sendReport() async throws {
    var report: [UInt8] = [1, UInt8(buttons & 0xFF), UInt8((buttons >> 8) & 0xFF)]
    report.append(contentsOf: axes)
    report.append(contentsOf: triggers)
    try await device.dispatchInputReport(data: Data(report), timestamp: SuspendingClock.now)
  }

  func releaseAll() async throws {
    buttons = 0
    axes = [UInt8](repeating: 128, count: 4)
    triggers = [UInt8](repeating: 0, count: 2)
    try await sendReport()
  }

  func perform(_ event: [String: Any]) async throws {
    guard let type = event["type"] as? String else { throw DriverError.invalidCommand(2) }
    switch type {
    case "gamepad_button_tap", "gamepad_button_hold":
      guard let name = event["button"] as? String, let index = buttonIndex[name] else { throw DriverError.invalidCommand(3) }
      buttons |= UInt16(1 << index)
      try await sendReport()
      try await Task.sleep(for: .milliseconds(type == "gamepad_button_tap" ? 80 : duration(event)))
      buttons &= ~UInt16(1 << index)
      try await sendReport()
    case "gamepad_axis":
      guard let name = event["axis"] as? String, let index = axisIndex[name], let value = event["value"] as? Double,
            (-1.0...1.0).contains(value) else { throw DriverError.invalidCommand(4) }
      axes[index] = UInt8(((value + 1.0) * 127.5).rounded())
      try await sendReport()
      if duration(event) > 0 {
        try await Task.sleep(for: .milliseconds(duration(event)))
        axes[index] = 128
        try await sendReport()
      }
    case "gamepad_trigger":
      guard let name = event["trigger"] as? String, ["LEFT", "RIGHT"].contains(name),
            let value = event["value"] as? Double, (0.0...1.0).contains(value) else { throw DriverError.invalidCommand(5) }
      let index = name == "LEFT" ? 0 : 1
      triggers[index] = UInt8((value * 255.0).rounded())
      try await sendReport()
      if duration(event) > 0 {
        try await Task.sleep(for: .milliseconds(duration(event)))
        triggers[index] = 0
        try await sendReport()
      }
    case "gamepad_release_all":
      try await releaseAll()
    default:
      throw DriverError.invalidCommand(6)
    }
  }
}

private func duration(_ event: [String: Any]) -> Int {
  min(2_000, max(0, event["duration_ms"] as? Int ?? 0))
}

private func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

@main
private struct GamepadDriver {
  static func main() async {
    guard #available(macOS 15, *), CommandLine.arguments.dropFirst().first == "serve" else {
      FileHandle.standardError.write(Data("Core HID virtual game controller requires macOS 15 or newer\n".utf8))
      exit(64)
    }
    let properties = HIDVirtualDevice.Properties(
      descriptor: Data(reportDescriptor),
      vendorID: 0x1209,
      productID: 0xD311,
      transport: .virtual,
      product: "DeviLudo Virtual Gamepad",
      manufacturer: "DeviLudo",
      versionNumber: 1
    )
    guard let device = HIDVirtualDevice(properties: properties) else {
      FileHandle.standardError.write(Data("\(DriverError.unavailable.localizedDescription)\n".utf8))
      exit(64)
    }
    let delegate = DeviceDelegate()
    await device.activate(delegate: delegate)
    let controller = GamepadController(device: device)

    while let line = readLine(strippingNewline: true) {
      var id = "unknown"
      do {
        guard let command = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
          throw DriverError.invalidCommand(8)
        }
        id = command["id"] as? String ?? id
        switch command["command"] as? String {
        case "ready", "release_all":
          try await controller.releaseAll()
        case "sequence":
          guard let events = command["events"] as? [[String: Any]], !events.isEmpty, events.count <= 200 else {
            throw DriverError.invalidCommand(7)
          }
          for event in events { try await controller.perform(event) }
        case "destroy":
          try await controller.releaseAll()
          emit(["id": id, "ok": true])
          _ = delegate
          return
        default:
          throw DriverError.invalidCommand(8)
        }
        emit(["id": id, "ok": true])
      } catch {
        try? await controller.releaseAll()
        emit(["id": id, "ok": false, "error": error.localizedDescription])
      }
    }
    try? await controller.releaseAll()
    _ = delegate
  }
}
