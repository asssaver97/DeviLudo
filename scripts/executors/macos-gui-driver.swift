import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

func argument(_ name: String) -> String {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { fail("missing \(name)", code: 64) }
    return CommandLine.arguments[index + 1]
}

func json(_ value: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [])
    FileHandle.standardOutput.write(data)
    exit(0)
}

struct GameWindow {
    let id: CGWindowID
    let bounds: CGRect
    let isOnScreen: Bool
}

func gameWindow(pid: pid_t) -> GameWindow? {
    // Discover the process window even before WindowServer marks it on-screen.
    // A freshly launched app can be present but initially ordered behind the
    // login desktop; finding it first lets wait activate it deterministically.
    guard let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    var candidates: [GameWindow] = []
    for row in rows {
        guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let boundsValue = row[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsValue), bounds.width > 0, bounds.height > 0 else { continue }
        let isOnScreen = (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
        candidates.append(GameWindow(id: id, bounds: bounds, isOnScreen: isOnScreen))
    }
    return candidates.max { left, right in
        // Godot exposes backing-store helper windows whose dimensions are in
        // pixels, while the actual Retina window is reported in points. Always
        // prefer the visible window before comparing area so a 1280x720 hidden
        // surface cannot eclipse the visible 640x388 (2x) game window.
        if left.isOnScreen != right.isOnScreen { return !left.isOnScreen }
        return left.bounds.width * left.bounds.height < right.bounds.width * right.bounds.height
    }
}

func backingScale() -> CGFloat {
    max(1, NSScreen.main?.backingScaleFactor ?? 1)
}

func windowDiagnostics(pid: pid_t) -> String {
    guard let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return "window-list-unavailable"
    }
    let owned = rows.compactMap { row -> String? in
        guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid else { return nil }
        let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
        let onScreen = (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
        let bounds = (row[kCGWindowBounds as String] as? NSDictionary).flatMap(CGRect.init(dictionaryRepresentation:)) ?? .zero
        return "layer=\(layer),onScreen=\(onScreen),bounds=\(Int(bounds.width))x\(Int(bounds.height))@\(Int(bounds.minX)),\(Int(bounds.minY))"
    }
    let application = NSRunningApplication(processIdentifier: pid)
    return "app=\(application?.localizedName ?? "missing"),active=\(application?.isActive ?? false),terminated=\(application?.isTerminated ?? true),windows=[\(owned.joined(separator: ";"))]"
}

func focus(pid: pid_t) -> Bool {
    guard AXIsProcessTrusted() else { fail("accessibility permission is not authorized") }
    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
    let app = AXUIElementCreateApplication(pid)
    var windowValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowValue) == .success,
          let window = windowValue else { return false }
    return CFGetTypeID(window) == AXUIElementGetTypeID()
}

func resizeFocusedWindow(pid: pid_t, width: CGFloat, height: CGFloat) -> Bool {
    guard focus(pid: pid) else { return false }
    let app = AXUIElementCreateApplication(pid)
    var windowValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowValue) == .success,
          let windowValue,
          CFGetTypeID(windowValue) == AXUIElementGetTypeID() else { return false }
    let window = unsafeBitCast(windowValue, to: AXUIElement.self)
    var size = CGSize(width: width, height: height)
    guard let sizeValue = AXValueCreate(.cgSize, &size) else { return false }
    return AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue) == .success
}

let keyCodes: [String: CGKeyCode] = [
    "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7,
    "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16,
    "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "EQUAL": 24, "9": 25, "7": 26, "MINUS": 27, "8": 28, "0": 29, "O": 31,
    "U": 32, "I": 34, "P": 35, "ENTER": 36, "L": 37, "J": 38, "K": 40,
    "N": 45, "M": 46, "TAB": 48, "SPACE": 49, "ESCAPE": 53,
    "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126
]

func normalizedKey(_ value: String) -> String {
    value.hasPrefix("KEY_") ? String(value.dropFirst(4)) : value
}

func performInputEvent(_ event: [String: Any], window: GameWindow) {
    guard let type = event["type"] as? String else { fail("input event type is invalid") }
    if type == "key_press" || type == "key_release" {
        guard let key = event["key"] as? String, let code = keyCodes[normalizedKey(key)],
              let input = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: type == "key_press") else { fail("unsupported keyboard input") }
        input.post(tap: .cghidEventTap)
    } else if type == "mouse_move" {
        guard let x = event["x"] as? Int, let y = event["y"] as? Int,
              let input = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(
                x: window.bounds.midX - 640 / backingScale() + CGFloat(x) / backingScale(),
                y: window.bounds.maxY - 720 / backingScale() + CGFloat(y) / backingScale()
              ), mouseButton: .left) else { fail("mouse move input is invalid") }
        input.post(tap: .cghidEventTap)
    } else if type == "mouse_click" {
        let button = (event["button"] as? String) ?? ""
        let mouseButton: CGMouseButton = button == "RIGHT" ? .right : button == "MIDDLE" ? .center : .left
        let down: CGEventType = button == "RIGHT" ? .rightMouseDown : button == "MIDDLE" ? .otherMouseDown : .leftMouseDown
        let up: CGEventType = button == "RIGHT" ? .rightMouseUp : button == "MIDDLE" ? .otherMouseUp : .leftMouseUp
        let location = CGEvent(source: nil)?.location ?? CGPoint(x: window.bounds.midX, y: window.bounds.midY)
        CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: location, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
        CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: location, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
    } else if type != "wait" {
        fail("unsupported input event")
    }
}

let command = CommandLine.arguments.dropFirst().first ?? ""
let pid = pid_t(Int32(argument("--pid")) ?? 0)
guard pid > 1 else { fail("invalid pid", code: 64) }

switch command {
case "resize":
    let width = CGFloat(Double(argument("--width")) ?? 0)
    let height = CGFloat(Double(argument("--height")) ?? 0)
    guard width >= 1280, height >= 720 else { fail("game window resize dimensions are invalid") }
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
        if resizeFocusedWindow(pid: pid, width: width, height: height) {
            Thread.sleep(forTimeInterval: 0.2)
            if let window = gameWindow(pid: pid), window.bounds.width >= width, window.bounds.height >= height {
                json(["ok": true, "pid": pid, "windowId": window.id, "width": Int(window.bounds.width), "height": Int(window.bounds.height)])
            }
        }
        Thread.sleep(forTimeInterval: 0.1)
    }
    fail("game window could not be resized")
case "wait":
    let width = CGFloat(Double(argument("--width")) ?? 0)
    let height = CGFloat(Double(argument("--height")) ?? 0)
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
        // Godot's custom game window is present in the WindowServer before it
        // consistently exposes kAXFocusedWindowAttribute. Requiring that AX
        // attribute here made a healthy, visible game time out even though the
        // PID and client bounds were already available. Activation is still
        // requested so later CGEvents target the game, but window discovery is
        // locked exclusively by the WindowServer owner PID and dimensions.
        if let application = NSRunningApplication(processIdentifier: pid),
           gameWindow(pid: pid) != nil {
            application.activate(options: [.activateAllWindows])
            Thread.sleep(forTimeInterval: 0.2)
            if let window = gameWindow(pid: pid), window.isOnScreen,
               window.bounds.width * backingScale() >= width,
               window.bounds.height * backingScale() >= height {
                json(["ok": true, "pid": pid, "windowId": window.id, "width": Int(width), "height": Int(height)])
            }
        }
        Thread.sleep(forTimeInterval: 0.1)
    }
    fail("game window did not appear at the required client size: \(windowDiagnostics(pid: pid))")
case "event":
    guard let data = argument("--event").data(using: .utf8),
          let event = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let window = gameWindow(pid: pid) else { fail("input event or game window is invalid") }
    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
    performInputEvent(event, window: window)
    json(["ok": true, "pid": pid, "width": Int(window.bounds.width), "height": Int(window.bounds.height)])
case "sequence":
    guard let data = argument("--events").data(using: .utf8),
          let events = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
          !events.isEmpty, events.count <= 200,
          let window = gameWindow(pid: pid) else { fail("input sequence or game window is invalid") }
    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
    // Schedule every event against one monotonic origin. Sleeping each relative
    // delay independently accumulates CGEvent posting and scheduler overhead;
    // long rhythm-based journeys can drift by multiple simulation frames even
    // though every individual delay is correct.
    let sequenceStartedAt = ProcessInfo.processInfo.systemUptime
    var dueOffset = 0.0
    for event in events {
        let delayMs = (event["delay_ms"] as? NSNumber)?.doubleValue ?? 0
        guard delayMs >= 0, delayMs <= 300_000 else { fail("input sequence delay is invalid") }
        dueOffset += delayMs / 1000
        let remaining = sequenceStartedAt + dueOffset - ProcessInfo.processInfo.systemUptime
        if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
        performInputEvent(event, window: window)
    }
    json(["ok": true, "pid": pid, "width": Int(window.bounds.width), "height": Int(window.bounds.height)])
case "capture":
    guard let window = gameWindow(pid: pid) else { fail("game window is unavailable for capture") }
    let output = argument("--output")
    guard let fullImage = captureWindow(window),
          fullImage.width >= 1280, fullImage.height >= 720,
          let image = fullImage.cropping(to: CGRect(x: CGFloat(fullImage.width - 1280) / 2, y: CGFloat(fullImage.height - 720), width: 1280, height: 720)),
          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail("capture backend is unavailable") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fail("capture backend could not write PNG") }
    json(["ok": true, "pid": pid, "windowId": window.id, "width": image.width, "height": image.height, "capturedAt": ISO8601DateFormatter().string(from: Date())])
default:
    fail("unsupported command", code: 64)
}

func captureWindow(_ window: GameWindow) -> CGImage? {
    let completed = DispatchSemaphore(value: 0)
    var result: CGImage?
    var captureError: Error?
    var retainedBackgroundColor: CGColor?
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
        guard let content, error == nil,
              let shareableWindow = content.windows.first(where: { $0.windowID == window.id }) else {
            captureError = error ?? NSError(domain: "DeviLudoE2E", code: 1, userInfo: [NSLocalizedDescriptionKey: "game window is not shareable"])
            completed.signal()
            return
        }
        let configuration = SCStreamConfiguration()
        let scale = backingScale()
        configuration.width = max(1280, Int((window.bounds.width * scale).rounded()))
        configuration.height = max(720, Int((window.bounds.height * scale).rounded()))
        configuration.scalesToFit = true
        configuration.showsCursor = false
        let backgroundColor = CGColor(gray: 0, alpha: 1)
        retainedBackgroundColor = backgroundColor
        configuration.backgroundColor = backgroundColor
        let filter = SCContentFilter(desktopIndependentWindow: shareableWindow)
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
            result = image
            captureError = error
            completed.signal()
        }
    }
    let waitResult = completed.wait(timeout: .now() + 30)
    withExtendedLifetime(retainedBackgroundColor) {}
    if waitResult == .timedOut { fail("capture backend timed out") }
    if let captureError { fail("capture backend is unavailable: \(captureError.localizedDescription)") }
    return result
}
