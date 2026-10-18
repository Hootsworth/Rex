// RexScreenCursor.swift
// Full-Screen Transparent Click-Through Overlay for Rex Second Cursor on macOS
// Compiled with: swiftc -O -module-cache-path ... RexScreenCursor.swift -o bin/rex-cursor-overlay

import Cocoa
import WebKit
import ApplicationServices
import CoreGraphics

class OverlayController: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var window: NSPanel!
    var webView: WKWebView!
    var screenFrame: NSRect = .zero
    var mode: String = "follow" // "follow", "autonomous", "idle"
    var appearance: String = "both" // "dino", "cursor", "both"
    var currentStyle: String = "default"
    var followOffsetX: CGFloat = 28
    var followOffsetY: CGFloat = 28
    var targetX: CGFloat = 100
    var targetY: CGFloat = 100
    var lastMousePos: NSPoint = .zero
    var lastUserMousePos: NSPoint = .zero
    var autonomousBargeInEnabled: Bool = false
    var isExecutingAutonomousAction: Bool = false
    var lastAutonomousActionTime: TimeInterval = 0
    var accumulatedUserDelta: Double = 0.0
    var isReady: Bool = false
    var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupWindow()
        startStdinListener()
    }

    func setupWindow() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        screenFrame = screen.frame

        // Create transparent, borderless, click-through, non-activating floating panel
        window = NSPanel(
            contentRect: screenFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        // Float above everything including full-screen apps and screen savers
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.maximumWindow)))
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true // Allow all user clicks to pass through!
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isReleasedWhenClosed = false

        // Configure WebKit with non-persistent data store to prevent permission/sandbox issues
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let contentController = WKUserContentController()
        contentController.add(self, name: "rexOverlay")
        config.userContentController = contentController

        webView = WKWebView(frame: screenFrame, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")

        window.contentView = webView
        window.orderFrontRegardless()

        loadHtml()

        // Global Hotkey Monitor: Control + Shift + Space, Control + Shift + R, or Escape (Emergency Pause)
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return }
            let flags = event.modifierFlags
            let isControl = flags.contains(.control)
            let isShift = flags.contains(.shift)
            let isOption = flags.contains(.option)

            // Space keycode: 49, R keycode: 15, Escape keycode: 53
            let isCtrlShiftSpace = isControl && isShift && event.keyCode == 49
            let isCtrlShiftR = isControl && isShift && event.keyCode == 15
            let isOptShiftSpace = isOption && isShift && event.keyCode == 49
            let isEscape = event.keyCode == 53

            if isEscape && self.mode == "autonomous" {
                self.mode = "paused"
                self.callJS("window.showRexSpeech('Emergency Brake: Paused via Escape key.', 4000, 'PAUSED')")
                print("{\"event\":\"bargeIn\",\"reason\":\"escapeKey\"}")
                fflush(stdout)
                return
            }

            if isCtrlShiftSpace || isCtrlShiftR || isOptShiftSpace {
                let shortcutName = isCtrlShiftR ? "Ctrl+Shift+R" : (isOptShiftSpace ? "Option+Shift+Space" : "Ctrl+Shift+Space")
                print("{\"event\":\"hotkeyTriggered\",\"shortcut\":\"\(shortcutName)\"}")
                fflush(stdout)
            }
        }

        // 60Hz tracking timer for global mouse tracking and emergency brake detection
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.tickMouseTracking()
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "rexOverlay", let body = message.body as? String {
            print("{\"event\":\"jsMessage\",\"data\":\(body)}")
            fflush(stdout)
        }
    }

    func tickMouseTracking() {
        guard isReady else { return }

        let rawPos = NSEvent.mouseLocation

        // Emergency Brake / Take the Wheel detection in autonomous mode
        if mode == "autonomous" && autonomousBargeInEnabled {
            let now = Date().timeIntervalSince1970
            // If Rex is currently executing an autonomous action or just completed one, ignore cursor repositioning!
            if isExecutingAutonomousAction || (now - lastAutonomousActionTime < 1.2) {
                lastUserMousePos = rawPos
                accumulatedUserDelta = 0
                return
            }

            if lastUserMousePos != .zero {
                let dx = rawPos.x - lastUserMousePos.x
                let dy = rawPos.y - lastUserMousePos.y
                let dist = sqrt(dx * dx + dy * dy)
                // Filter out sub-pixel jitter
                if dist > 3.0 {
                    accumulatedUserDelta += dist
                } else {
                    accumulatedUserDelta = max(0, accumulatedUserDelta - 2.0)
                }

                // If user deliberately moves the mouse (cumulative displacement > 80 points)
                if accumulatedUserDelta > 80 {
                    accumulatedUserDelta = 0
                    self.mode = "paused"
                    self.callJS("window.showRexSpeech('Control yielded to user. Tap Control+Shift+Space to resume!', 4000, 'PAUSED')")
                    print("{\"event\":\"bargeIn\",\"reason\":\"mouseMoved\",\"x\":\(rawPos.x),\"y\":\(self.screenFrame.height - rawPos.y)}")
                    fflush(stdout)
                }
            }
            lastUserMousePos = rawPos
            return
        }

        lastUserMousePos = rawPos
        accumulatedUserDelta = 0

        if rawPos != lastMousePos {
            lastMousePos = rawPos
            callJS("window.onUserMouseActivity()")

            // Check mouse proximity to Rex Mascot Dock in bottom-right corner
            let rexCornerX = screenFrame.width - 100
            let rexCornerY: CGFloat = 90
            let distToRex = hypot(rawPos.x - rexCornerX, rawPos.y - rexCornerY)
            if distToRex < 160 {
                callJS("window.setMascotHover(true)")
            } else {
                callJS("window.setMascotHover(false)")
            }

            if mode == "follow" {
                // Convert Cocoa coordinates (origin at bottom-left) to Web coordinates (origin at top-left)
                let webX = rawPos.x
                let webY = screenFrame.size.height - rawPos.y

                let rexX = webX + followOffsetX
                let rexY = webY + followOffsetY
                callJS("window.updateMousePosition(\(rexX), \(rexY), true)")
            }
        }
    }

    func callJS(_ code: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(code, completionHandler: nil)
        }
    }

    func startStdinListener() {
        DispatchQueue.global(qos: .userInteractive).async { [weak self] in
            let input = FileHandle.standardInput
            var buffer = Data()

            while true {
                let chunk = input.availableData
                if chunk.isEmpty {
                    // EOF reached -> terminate overlay
                    DispatchQueue.main.async {
                        NSApp.terminate(nil)
                    }
                    break
                }
                buffer.append(chunk)

                while let newlineIndex = buffer.firstIndex(of: 0x0A) { // newline '\n'
                    let lineData = buffer.subdata(in: 0..<newlineIndex)
                    buffer.removeSubrange(0...newlineIndex)

                    if let lineStr = String(data: lineData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !lineStr.isEmpty {
                        self?.handleIncomingCommand(lineStr)
                    }
                }
            }
        }
    }

    func postRealClick(x: Double, y: Double, button: String = "left", clickCount: Int = 1) {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return }
        let pt = CGPoint(x: x, y: y)

        self.isExecutingAutonomousAction = true
        self.lastAutonomousActionTime = Date().timeIntervalSince1970
        self.lastUserMousePos = NSPoint(x: x, y: self.screenFrame.height - y)

        CGWarpMouseCursorPosition(pt)
        if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left) {
            move.post(tap: .cghidEventTap)
        }
        usleep(25000)

        let cgButton: CGMouseButton = (button == "right") ? .right : .left
        let downType: CGEventType = (button == "right") ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = (button == "right") ? .rightMouseUp : .leftMouseUp

        if let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: pt, mouseButton: cgButton) {
            down.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
            down.post(tap: .cghidEventTap)
        }
        usleep(55000)
        if let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: pt, mouseButton: cgButton) {
            up.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
            up.post(tap: .cghidEventTap)
        }

        self.lastUserMousePos = NSPoint(x: x, y: self.screenFrame.height - y)
        self.lastAutonomousActionTime = Date().timeIntervalSince1970 + 0.8
        self.accumulatedUserDelta = 0
        self.isExecutingAutonomousAction = false
    }

    func postMouseDrag(fromX: Double, fromY: Double, toX: Double, toY: Double, steps: Int = 15) {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return }
        let start = CGPoint(x: fromX, y: fromY)
        let end = CGPoint(x: toX, y: toY)

        self.isExecutingAutonomousAction = true
        self.lastAutonomousActionTime = Date().timeIntervalSince1970
        self.lastUserMousePos = NSPoint(x: toX, y: self.screenFrame.height - toY)
        self.accumulatedUserDelta = 0

        CGWarpMouseCursorPosition(start)
        usleep(20000)

        if let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left) {
            down.post(tap: .cghidEventTap)
        }
        usleep(35000)

        let totalSteps = max(4, steps)
        for i in 1...totalSteps {
            let t = Double(i) / Double(totalSteps)
            let curX = start.x + (end.x - start.x) * t
            let curY = start.y + (end.y - start.y) * t
            let pt = CGPoint(x: curX, y: curY)
            CGWarpMouseCursorPosition(pt)
            if let drag = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: pt, mouseButton: .left) {
                drag.post(tap: .cghidEventTap)
            }
            usleep(15000)
        }

        usleep(35000)
        if let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left) {
            up.post(tap: .cghidEventTap)
        }

        self.lastUserMousePos = NSPoint(x: toX, y: self.screenFrame.height - toY)
        self.lastAutonomousActionTime = Date().timeIntervalSince1970 + 0.8
        self.accumulatedUserDelta = 0
        self.isExecutingAutonomousAction = false
    }

    func postTypeText(_ text: String) {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return }
        for scalar in text.utf16 {
            var charCode = scalar
            if let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) {
                keyDown.keyboardSetUnicodeString(stringLength: 1, unicodeString: &charCode)
                keyDown.post(tap: .cghidEventTap)
            }
            usleep(10000)
            if let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
                keyUp.keyboardSetUnicodeString(stringLength: 1, unicodeString: &charCode)
                keyUp.post(tap: .cghidEventTap)
            }
            usleep(10000)
        }
    }

    func postKey(key: String, modifiers: [String] = []) {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return }
        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod.lowercased() {
            case "cmd", "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "opt", "option", "alt": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: break
            }
        }

        var keyCode: CGKeyCode = 0
        switch key.lowercased() {
        case "return", "enter": keyCode = 36
        case "tab": keyCode = 48
        case "space": keyCode = 49
        case "delete", "backspace": keyCode = 51
        case "escape", "esc": keyCode = 53
        case "up": keyCode = 126
        case "down": keyCode = 125
        case "left": keyCode = 123
        case "right": keyCode = 124
        case "a": keyCode = 0
        case "c": keyCode = 8
        case "v": keyCode = 9
        case "x": keyCode = 7
        case "z": keyCode = 6
        case "s": keyCode = 1
        default:
            postTypeText(key)
            return
        }

        if let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true) {
            down.flags = flags
            down.post(tap: .cghidEventTap)
        }
        usleep(25000)
        if let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) {
            up.flags = flags
            up.post(tap: .cghidEventTap)
        }
    }

    func activateApp(named: String) {
        guard !named.isEmpty else { return }
        let cleanName = named.trimmingCharacters(in: .whitespacesAndNewlines)
        var candidates = [cleanName]
        let lower = cleanName.lowercased()

        if lower.contains("zen") {
            candidates.append(contentsOf: ["Zen", "Zen Browser", "app.zen-browser.zen"])
        } else if lower.contains("chrome") {
            candidates.append(contentsOf: ["Google Chrome", "Chrome"])
        } else if lower.contains("davinci") {
            candidates.append(contentsOf: ["DaVinci Resolve", "DaVinciResolve"])
        } else if lower.contains("whatsapp") || lower.contains("wahsyapp") {
            candidates.append(contentsOf: ["WhatsApp"])
        } else if lower.contains("vscode") || lower.contains("vs code") || lower == "code" {
            candidates.append(contentsOf: ["Visual Studio Code", "Code"])
        }

        let apps = NSWorkspace.shared.runningApplications
        var target: NSRunningApplication? = nil
        for cand in candidates {
            if let matched = apps.first(where: {
                ($0.localizedName?.localizedCaseInsensitiveContains(cand) == true) ||
                (cand.localizedCaseInsensitiveContains($0.localizedName ?? "") == true) ||
                ($0.bundleIdentifier?.localizedCaseInsensitiveContains(cand) == true)
            }) {
                target = matched
                break
            }
        }

        if let app = target {
            app.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
            let targetName = app.localizedName ?? candidates.first ?? cleanName
            let script = "tell application \"\(targetName)\" to activate"
            if let appleScript = NSAppleScript(source: script) {
                var error: NSDictionary?
                appleScript.executeAndReturnError(&error)
            }
        } else {
            // App not running yet, launch via NSWorkspace and open command
            for cand in candidates {
                if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: cand) ??
                             NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: "/Applications/\(cand).app")) {
                    let config = NSWorkspace.OpenConfiguration()
                    config.activates = true
                    NSWorkspace.shared.openApplication(at: url, configuration: config, completionHandler: nil)
                    break
                }
            }
            let targetName = candidates.first ?? cleanName
            let script = "tell application \"\(targetName)\" to activate"
            if let appleScript = NSAppleScript(source: script) {
                var error: NSDictionary?
                appleScript.executeAndReturnError(&error)
            }
        }
    }

    func handleIncomingCommand(_ line: String) {
        guard let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any],
              let cmd = json["cmd"] as? String else {
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            switch cmd {
            case "ping":
                print("{\"event\":\"pong\",\"time\":\(Date().timeIntervalSince1970)}")
                fflush(stdout)

            case "setMode":
                if let newMode = json["mode"] as? String {
                    self.mode = newMode
                    self.lastUserMousePos = NSEvent.mouseLocation
                    self.lastAutonomousActionTime = Date().timeIntervalSince1970 + 0.8
                    self.callJS("window.setRexMode('\(newMode)')")
                    print("{\"event\":\"modeChanged\",\"mode\":\"\(newMode)\"}")
                    fflush(stdout)
                }

            case "setAppearance":
                if let app = json["appearance"] as? String {
                    self.appearance = app
                    self.callJS("window.setRexAppearance('\(app)')")
                }

            case "setStyle":
                if let style = json["style"] as? String {
                    self.currentStyle = style
                    self.callJS("window.setRexStyle('\(style)')")
                }

            case "moveTo":
                let x = json["x"] as? Double ?? Double(self.targetX)
                let y = json["y"] as? Double ?? Double(self.targetY)
                let duration = json["duration"] as? Double ?? 250.0
                let style = json["style"] as? String ?? self.currentStyle
                self.targetX = CGFloat(x)
                self.targetY = CGFloat(y)
                self.isExecutingAutonomousAction = true
                self.lastAutonomousActionTime = Date().timeIntervalSince1970 + (duration / 1000.0) + 1.2
                self.lastUserMousePos = NSPoint(x: x, y: self.screenFrame.height - y)
                self.accumulatedUserDelta = 0
                self.callJS("window.moveToTarget(\(x), \(y), \(duration), '\(style)')")
                DispatchQueue.main.asyncAfter(deadline: .now() + (duration / 1000.0)) { [weak self] in
                    self?.isExecutingAutonomousAction = false
                }

            case "followMouse":
                let enabled = json["enabled"] as? Bool ?? true
                self.mode = enabled ? "follow" : "autonomous"
                if let ox = json["offsetX"] as? Double { self.followOffsetX = CGFloat(ox) }
                if let oy = json["offsetY"] as? Double { self.followOffsetY = CGFloat(oy) }
                self.callJS("window.setRexMode('\(self.mode)')")

            case "click":
                let x = json["x"] as? Double ?? Double(self.lastMousePos.x)
                let y = json["y"] as? Double ?? Double(self.screenFrame.height - self.lastMousePos.y)
                let style = json["style"] as? String ?? "handpointing"
                let real = json["real"] as? Bool ?? true
                let buttonStr = json["button"] as? String ?? "left"
                let count = json["count"] as? Int ?? 1

                self.callJS("window.triggerClickPulse(\(x), \(y), '\(style)')")
                if real {
                    self.postRealClick(x: x, y: y, button: buttonStr, clickCount: count)
                }
                print("{\"event\":\"clicked\",\"x\":\(x),\"y\":\(y),\"real\":\(real)}")
                fflush(stdout)

            case "doubleClick":
                let x = json["x"] as? Double ?? Double(self.lastMousePos.x)
                let y = json["y"] as? Double ?? Double(self.screenFrame.height - self.lastMousePos.y)
                let style = json["style"] as? String ?? "handpointing"
                self.callJS("window.triggerClickPulse(\(x), \(y), '\(style)')")
                self.postRealClick(x: x, y: y, button: "left", clickCount: 2)
                print("{\"event\":\"doubleClicked\",\"x\":\(x),\"y\":\(y)}")
                fflush(stdout)

            case "rightClick":
                let x = json["x"] as? Double ?? Double(self.lastMousePos.x)
                let y = json["y"] as? Double ?? Double(self.screenFrame.height - self.lastMousePos.y)
                let style = json["style"] as? String ?? "handpointing"
                self.callJS("window.triggerClickPulse(\(x), \(y), '\(style)')")
                self.postRealClick(x: x, y: y, button: "right", clickCount: 1)
                print("{\"event\":\"rightClicked\",\"x\":\(x),\"y\":\(y)}")
                fflush(stdout)

            case "drag":
                let fromX = json["fromX"] as? Double ?? Double(self.lastMousePos.x)
                let fromY = json["fromY"] as? Double ?? Double(self.screenFrame.height - self.lastMousePos.y)
                let toX = json["toX"] as? Double ?? fromX
                let toY = json["toY"] as? Double ?? fromY
                let steps = json["steps"] as? Int ?? 15
                self.callJS("window.triggerClickPulse(\(fromX), \(fromY), 'handgrabbing')")
                self.postMouseDrag(fromX: fromX, fromY: fromY, toX: toX, toY: toY, steps: steps)
                self.callJS("window.moveToTarget(\(toX), \(toY), 250, 'handopen')")
                print("{\"event\":\"dragged\",\"fromX\":\(fromX),\"fromY\":\(fromY),\"toX\":\(toX),\"toY\":\(toY)}")
                fflush(stdout)

            case "typeText":
                let text = json["text"] as? String ?? ""
                self.postTypeText(text)
                print("{\"event\":\"typed\",\"length\":\(text.count)}")
                fflush(stdout)

            case "keyPress":
                let key = json["key"] as? String ?? ""
                let mods = json["modifiers"] as? [String] ?? []
                self.postKey(key: key, modifiers: mods)
                print("{\"event\":\"keyPressed\",\"key\":\"\(key)\"}")
                fflush(stdout)

            case "activateApp":
                let appName = json["app"] as? String ?? ""
                self.activateApp(named: appName)
                print("{\"event\":\"appActivated\",\"app\":\"\(appName)\"}")
                fflush(stdout)

            case "speak":
                let text = (json["text"] as? String ?? "").replacingOccurrences(of: "'", with: "\\'")
                let duration = json["duration"] as? Double ?? 3500.0
                let badge = (json["badge"] as? String ?? "COPILOT").replacingOccurrences(of: "'", with: "\\'")
                self.callJS("window.showRexSpeech('\(text)', \(duration), '\(badge)')")

            case "highlight":
                let x = json["x"] as? Double ?? 0
                let y = json["y"] as? Double ?? 0
                let w = json["w"] as? Double ?? 100
                let h = json["h"] as? Double ?? 100
                let label = (json["label"] as? String ?? "").replacingOccurrences(of: "'", with: "\\'")
                self.callJS("window.highlightRegion(\(x), \(y), \(w), \(h), '\(label)')")

            case "hideHighlight":
                self.callJS("window.hideHighlight()")

            case "setListening":
                let isListening = json["listening"] as? Bool ?? true
                self.callJS("window.setListening(\(isListening))")

            case "getWindowBounds":
                let targetApp = (json["app"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
                var matched: [String: Any]? = nil
                if let infoList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] {
                    for info in infoList {
                        let layer = info[kCGWindowLayer as String] as? Int ?? -1
                        guard layer == 0 else { continue }
                        let owner = info[kCGWindowOwnerName as String] as? String ?? ""
                        if owner == "rex-cursor-overlay" || owner == "Window Server" { continue }
                        let bounds = info[kCGWindowBounds as String] as? [String: Any] ?? [:]
                        let w = bounds["Width"] as? Double ?? 0
                        let h = bounds["Height"] as? Double ?? 0
                        let x = bounds["X"] as? Double ?? 0
                        let y = bounds["Y"] as? Double ?? 0
                        guard w > 150, h > 150 else { continue }

                        let winData: [String: Any] = [
                            "found": true,
                            "owner": owner,
                            "x": x,
                            "y": y,
                            "width": w,
                            "height": h,
                            "screenWidth": self.screenFrame.width,
                            "screenHeight": self.screenFrame.height
                        ]
                        if matched == nil { matched = winData }
                        let lowerOwner = owner.lowercased()
                        if !targetApp.isEmpty && (lowerOwner.contains(targetApp) || targetApp.contains(lowerOwner)) {
                            matched = winData
                            break
                        }
                    }
                }
                let res = matched ?? ["found": false, "x": 0, "y": 33, "width": self.screenFrame.width, "height": self.screenFrame.height - 33]
                if let jsonData = try? JSONSerialization.data(withJSONObject: res, options: []),
                   let jsonStr = String(data: jsonData, encoding: .utf8) {
                    print("{\"event\":\"windowBounds\",\"data\":\(jsonStr)}")
                    fflush(stdout)
                }

            case "pause":
                self.mode = "paused"
                self.callJS("window.showRexSpeech('Autonomous execution paused.', 3000, 'PAUSED')")
                print("{\"event\":\"paused\"}")
                fflush(stdout)

            case "resume":
                self.mode = "autonomous"
                self.accumulatedUserDelta = 0
                self.lastUserMousePos = NSEvent.mouseLocation
                self.lastAutonomousActionTime = Date().timeIntervalSince1970 + 1.0
                self.callJS("window.showRexSpeech('Resuming autonomous control.', 3000, 'RESUMED')")
                print("{\"event\":\"resumed\"}")
                fflush(stdout)

            case "setBargeIn":
                self.autonomousBargeInEnabled = json["enabled"] as? Bool ?? true
                self.accumulatedUserDelta = 0
                self.lastUserMousePos = NSEvent.mouseLocation
                self.lastAutonomousActionTime = Date().timeIntervalSince1970 + 0.5
                print("{\"event\":\"bargeInUpdated\",\"enabled\":\(self.autonomousBargeInEnabled)}")
                fflush(stdout)

            case "setEmotion":
                if let emo = json["emotion"] as? String {
                    self.callJS("window.setRexEmotion('\(emo)')")
                    print("{\"event\":\"emotionChanged\",\"emotion\":\"\(emo)\"}")
                    fflush(stdout)
                }

            case "quit":
                NSApp.terminate(nil)

            default:
                break
            }
        }
    }

    func loadHtml() {
        let html = """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; }
                html, body {
                    width: 100vw;
                    height: 100vh;
                    overflow: hidden;
                    background: transparent;
                    pointer-events: none;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
                }

                /* =========================================
                   AUTONOMOUS REX CURSOR (ON-SCREEN TAKEOVER)
                   ========================================= */
                #rex-container {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 0;
                    height: 0;
                    z-index: 999999;
                    pointer-events: none;
                    will-change: transform;
                }

                .rex-cursor-icon {
                    position: absolute;
                    left: -4px;
                    top: -4px;
                    width: 38px;
                    height: 38px;
                    filter: drop-shadow(0 4px 10px rgba(0,0,0,0.5));
                    transition: transform 120ms ease;
                }
                .rex-cursor-icon.clicking {
                    transform: scale(0.88) translate(1px, 1px);
                }

                /* REX Cursor Identification Badge */
                .rex-cursor-badge {
                    position: absolute;
                    left: 28px;
                    top: 8px;
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    padding: 3px 8px 3px 6px;
                    background: rgba(10, 14, 20, 0.90);
                    -webkit-backdrop-filter: blur(20px) saturate(180%);
                    backdrop-filter: blur(20px) saturate(180%);
                    border: 1.2px solid rgba(56, 239, 125, 0.7);
                    border-radius: 999px;
                    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6), 0 0 10px rgba(56, 239, 125, 0.4);
                    color: #38ef7d;
                    font-size: 10px;
                    font-weight: 800;
                    letter-spacing: 0.12em;
                    text-transform: uppercase;
                    white-space: nowrap;
                    pointer-events: none;
                    transition: transform 120ms ease, box-shadow 120ms ease;
                }
                .rex-cursor-badge.clicking {
                    transform: scale(1.12);
                    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.65), 0 0 16px rgba(56, 239, 125, 0.8);
                }
                .rex-cursor-badge .badge-dot {
                    width: 5px;
                    height: 5px;
                    border-radius: 50%;
                    background: #38ef7d;
                    box-shadow: 0 0 8px #38ef7d;
                    animation: badge-pulse 1.8s infinite ease-in-out;
                }
                @keyframes badge-pulse {
                    0%, 100% { opacity: 0.6; transform: scale(0.9); }
                    50% { opacity: 1; transform: scale(1.25); box-shadow: 0 0 12px #38ef7d; }
                }

                /* =========================================
                   REX MASCOT DOCK (BOTTOM-RIGHT OF SCREEN)
                   ========================================= */
                #rex-dock {
                    position: fixed;
                    right: 28px;
                    bottom: 22px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    pointer-events: none;
                    z-index: 999990;
                    transition: transform 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 300ms ease;
                }

                .mascot-pedestal {
                    position: relative;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    padding: 12px 16px 10px 16px;
                    background: rgba(10, 14, 20, 0.78);
                    -webkit-backdrop-filter: blur(28px) saturate(190%) contrast(105%);
                    backdrop-filter: blur(28px) saturate(190%) contrast(105%);
                    border: 1px solid rgba(255, 255, 255, 0.16);
                    border-radius: 26px;
                    box-shadow: 0 16px 42px rgba(0, 0, 0, 0.55),
                                0 0 0 1px rgba(255, 255, 255, 0.08),
                                0 0 32px rgba(56, 239, 125, 0.15);
                    transition: all 260ms cubic-bezier(0.16, 1, 0.3, 1);
                }
                .mascot-pedestal.hovered {
                    transform: translateY(-4px) scale(1.03);
                    border-color: rgba(56, 239, 125, 0.55);
                    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.65), 0 0 36px rgba(56, 239, 125, 0.35);
                }

                .mascot-avatar-wrap {
                    position: relative;
                    width: 128px;
                    height: 128px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                /* Scaled 64x64 Canvas to 128px Prominent Display */
                #dino-canvas {
                    width: 128px;
                    height: 128px;
                    image-rendering: pixelated;
                    image-rendering: crisp-edges;
                    filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.45));
                    transition: transform 180ms ease;
                }

                /* Sleek Translucent Status Pill */
                .mascot-status-pill {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-top: 6px;
                    padding: 3px 10px;
                    background: rgba(255, 255, 255, 0.08);
                    border: 1px solid rgba(255, 255, 255, 0.14);
                    border-radius: 999px;
                    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
                    transition: all 200ms ease;
                }
                .status-indicator-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: #38ef7d;
                    box-shadow: 0 0 8px #38ef7d;
                    transition: background 200ms ease, box-shadow 200ms ease;
                }
                .status-name {
                    font-size: 10px;
                    font-weight: 800;
                    letter-spacing: 0.12em;
                    color: #ffffff;
                }
                .status-mood {
                    font-size: 9px;
                    font-weight: 700;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    color: #38ef7d;
                    transition: color 200ms ease;
                }

                /* Audio Equalizer & Mic Pulse for Listening Mode */
                .audio-eq-wrap {
                    display: none;
                    position: absolute;
                    top: -18px;
                    left: 50%;
                    transform: translateX(-50%);
                    align-items: flex-end;
                    gap: 3px;
                    height: 16px;
                    background: rgba(10, 10, 14, 0.85);
                    -webkit-backdrop-filter: blur(20px) saturate(180%);
                    backdrop-filter: blur(20px) saturate(180%);
                    padding: 3px 8px;
                    border-radius: 999px;
                    border: 1px solid rgba(255, 255, 255, 0.22);
                    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2);
                    z-index: 10;
                }
                .audio-eq-wrap.active {
                    display: flex;
                }
                .eq-bar {
                    width: 2.5px;
                    background: #38ef7d;
                    height: 100%;
                    border-radius: 1.5px;
                    animation: eq-bounce 0.4s infinite alternate ease-in-out;
                    box-shadow: 0 0 6px rgba(56, 239, 125, 0.5);
                }
                .eq-bar:nth-child(1) { animation-delay: 0.1s; }
                .eq-bar:nth-child(2) { animation-delay: 0.25s; }
                .eq-bar:nth-child(3) { animation-delay: 0.15s; }
                .eq-bar:nth-child(4) { animation-delay: 0.3s; }
                @keyframes eq-bounce {
                    0% { height: 3px; opacity: 0.4; }
                    100% { height: 14px; opacity: 1; }
                }

                .mic-indicator {
                    position: absolute;
                    top: -4px;
                    right: 8px;
                    width: 9px;
                    height: 9px;
                    border-radius: 50%;
                    background: #38ef7d;
                    box-shadow: 0 0 8px rgba(56, 239, 125, 0.9);
                    display: none;
                    z-index: 10;
                }
                .mic-indicator.active {
                    display: block;
                    animation: mic-pulse 1.2s infinite ease-in-out;
                }
                @keyframes mic-pulse {
                    0%, 100% { transform: scale(0.9); opacity: 0.7; }
                    50% { transform: scale(1.2); opacity: 1; box-shadow: 0 0 12px #38ef7d; }
                }

                /* =========================================
                   GLASSMORPHIC SPEECH BUBBLE (ABOVE MASCOT)
                   ========================================= */
                .rex-speech-bubble {
                    position: absolute;
                    bottom: 195px;
                    right: 0;
                    min-width: 250px;
                    max-width: 360px;
                    padding: 14px 18px;
                    background: rgba(10, 14, 20, 0.85);
                    -webkit-backdrop-filter: blur(32px) saturate(190%) contrast(105%);
                    backdrop-filter: blur(32px) saturate(190%) contrast(105%);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 18px;
                    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.65),
                                inset 0 1px 0 rgba(255, 255, 255, 0.24),
                                0 0 24px rgba(56, 239, 125, 0.18);
                    color: #ffffff;
                    opacity: 0;
                    transform: translateY(14px) scale(0.95);
                    transition: opacity 280ms cubic-bezier(0.16, 1, 0.3, 1), transform 300ms cubic-bezier(0.16, 1, 0.3, 1);
                    pointer-events: none;
                    z-index: 1000000;
                }
                .rex-speech-bubble.active {
                    opacity: 1;
                    transform: translateY(0) scale(1);
                }
                .rex-speech-bubble::before {
                    content: '';
                    position: absolute;
                    bottom: -6px;
                    right: 56px;
                    width: 12px;
                    height: 12px;
                    background: rgba(10, 14, 20, 0.85);
                    border-right: 1px solid rgba(255, 255, 255, 0.2);
                    border-bottom: 1px solid rgba(255, 255, 255, 0.2);
                    transform: rotate(45deg);
                }
                .bubble-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-bottom: 6px;
                }
                .bubble-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: #38ef7d;
                    box-shadow: 0 0 8px rgba(56, 239, 125, 0.85);
                    animation: dot-pulse 2s infinite ease-in-out;
                }
                @keyframes dot-pulse {
                    0%, 100% { opacity: 0.6; transform: scale(0.9); }
                    50% { opacity: 1; transform: scale(1.15); box-shadow: 0 0 12px #38ef7d; }
                }
                .bubble-title {
                    font-size: 10px;
                    font-weight: 800;
                    letter-spacing: 0.12em;
                    text-transform: uppercase;
                    color: #ffffff;
                }
                .bubble-badge {
                    margin-left: auto;
                    font-size: 9px;
                    font-weight: 700;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    padding: 2px 7px;
                    background: rgba(56, 239, 125, 0.12);
                    border: 1px solid rgba(56, 239, 125, 0.28);
                    border-radius: 999px;
                    color: #38ef7d;
                }
                .bubble-body {
                    font-size: 13px;
                    font-weight: 500;
                    line-height: 1.45;
                    color: rgba(255, 255, 255, 0.95);
                    white-space: pre-wrap;
                    letter-spacing: -0.01em;
                }

                /* =========================================
                   INTERACTIVE CLICK RIPPLE & SPOTLIGHT BOX
                   ========================================= */
                .click-ripple {
                    position: fixed;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    border: 2px solid rgba(56, 239, 125, 0.95);
                    background: radial-gradient(circle, rgba(56, 239, 125, 0.25) 0%, transparent 70%);
                    box-shadow: 0 0 18px rgba(56, 239, 125, 0.7), inset 0 0 10px rgba(56, 239, 125, 0.4);
                    pointer-events: none;
                    transform: translate(-50%, -50%) scale(1);
                    animation: ripple-wave 500ms cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
                    z-index: 999998;
                }
                @keyframes ripple-wave {
                    0% { transform: translate(-50%, -50%) scale(0.5); opacity: 1; border-width: 3px; }
                    100% { transform: translate(-50%, -50%) scale(4.8); opacity: 0; border-width: 1px; }
                }

                #highlight-box {
                    position: fixed;
                    border: 1.5px solid rgba(56, 239, 125, 0.75);
                    background: rgba(56, 239, 125, 0.06);
                    -webkit-backdrop-filter: blur(12px);
                    backdrop-filter: blur(12px);
                    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.15), 0 0 24px rgba(56, 239, 125, 0.25);
                    border-radius: 10px;
                    pointer-events: none;
                    display: none;
                    z-index: 999997;
                    transition: all 260ms cubic-bezier(0.16, 1, 0.3, 1);
                }
                #highlight-tag {
                    position: absolute;
                    top: -28px;
                    left: 0;
                    background: rgba(10, 14, 20, 0.90);
                    -webkit-backdrop-filter: blur(16px);
                    backdrop-filter: blur(16px);
                    color: #38ef7d;
                    font-size: 11px;
                    font-weight: 700;
                    letter-spacing: 0.04em;
                    padding: 3px 10px;
                    border-radius: 999px;
                    border: 1px solid rgba(56, 239, 125, 0.35);
                    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
                }
            </style>
        </head>
        <body>
            <!-- Region Highlight Box -->
            <div id="highlight-box">
                <div id="highlight-tag">Rex Spotlight</div>
            </div>

            <!-- Autonomous Screen Cursor with REX Badge -->
            <div id="rex-container">
                <div class="rex-cursor-icon" id="cursor-icon"></div>
                <div class="rex-cursor-badge" id="cursor-badge">
                    <span class="badge-dot"></span>
                    <span class="badge-label">REX</span>
                </div>
            </div>

            <!-- Rex Desktop Mascot Dock (Bottom-Right Screen) -->
            <div id="rex-dock">
                <!-- Speech Bubble -->
                <div class="rex-speech-bubble" id="speech-bubble">
                    <div class="bubble-header">
                        <span class="bubble-dot"></span>
                        <span class="bubble-title">REX COPILOT</span>
                        <span class="bubble-badge" id="bubble-badge">READY</span>
                    </div>
                    <div class="bubble-body" id="bubble-text">Ready.</div>
                </div>

                <!-- Mascot Pedestal -->
                <div class="mascot-pedestal" id="mascot-pedestal">
                    <div class="audio-eq-wrap" id="audio-eq">
                        <div class="eq-bar"></div>
                        <div class="eq-bar"></div>
                        <div class="eq-bar"></div>
                        <div class="eq-bar"></div>
                    </div>
                    <div class="mic-indicator" id="mic-indicator"></div>

                    <div class="mascot-avatar-wrap">
                        <canvas id="dino-canvas" width="64" height="64"></canvas>
                    </div>

                    <div class="mascot-status-pill">
                        <span class="status-indicator-dot" id="status-dot"></span>
                        <span class="status-name">REX</span>
                        <span class="status-mood" id="mascot-mood-tag">IDLE</span>
                    </div>
                </div>
            </div>

            <script>
                // SVG Cursors
                const SVGS = {
                    default: `<svg height="38" viewBox="0 0 32 32" width="38" xmlns="http://www.w3.org/2000/svg"><g fill="none" fill-rule="evenodd" transform="translate(10 7)"><path d="m6.148 18.473 1.863-1.003 1.615-.839-2.568-4.816h4.332l-11.379-11.408v16.015l3.316-3.221z" fill="#38ef7d"/><path d="m6.431 17 1.765-.941-2.775-5.202h3.604l-8.025-8.043v11.188l2.53-2.442z" fill="#0f172a"/></g></svg>`,
                    handpointing: `<svg height="38" viewBox="0 0 32 32" width="38" xmlns="http://www.w3.org/2000/svg"><g fill="none" fill-rule="evenodd" transform="translate(7 6)"><path d="m4.55 8.57c-.1-.37-.2-.85-.4-1.55-.17-.56-.34-.86-.47-1.23-.15-.46-.3-.72-.5-1.18-.14-.33-.36-1.05-.46-1.44-.12-.51.03-.92.24-1.21.25-.34.96-.49 1.36-.35.37.13.74.51.92.79.29.46.36.63.72 1.54.39.99.56 1.92.61 2.23l.08.45c0-.04-.04-1.12-.04-1.16-.04-1.03-.06-1.82-.04-2.94.01-.13.06-.59.08-.72.08-.5.3-.8.67-.98.41-.2.93-.21 1.4-.02.42.17.63.55.69 1.02.01.11.09.99.09 1.11-.01 1.02.01 1.64.02 2.17 0 .23 0 1.62.01 1.47.06-.66.09-3.19.34-3.94.14-.43.41-.75.8-.93.43-.2 1.11-.07 1.4.24.29.31.45.69.48 1.15.03.41-.02.9-.02 1.25 0 .87-.02 1.32-.04 2.12 0 .04-.01.3.02.18.1-.28.19-.54.27-.75.05-.12.24-.61.36-.86.11-.23.21-.37.41-.69.2-.31.42-.45.67-.56.54-.23 1.11.11 1.3.59.09.22.01.71-.03 1.1-.06.65-.25 1.31-.35 1.65-.13.45-.27 1.24-.34 1.6-.07.4-.23 1.39-.36 1.82-.09.3-.37.98-.65 1.39 0 0-1.07 1.25-1.19 1.81-.12.56-.08.57-.1.97-.02.4.12.92.12.92s-.8.1-1.23.03c-.39-.06-.88-.84-1-1.08-.17-.33-.54-.26-.68-.02-.23.38-.71 1.07-1.05 1.11-.67.08-2.05.03-3.14.02 0 0 .19-1.01-.23-1.36-.3-.26-.83-.78-1.14-1.06l-.83-.92c-.28-.36-.63-1.09-1.24-1.99-.35-.5-1.03-1.08-1.29-1.58-.22-.42-.33-.95-.19-1.32.23-.6.68-.9 1.36-.83.52.05.85.2 1.24.53.22.19.57.54.75.75.16.2.2.28.38.51.23.31.3.46.21.12" fill="#38ef7d"/><g stroke="#0f172a" stroke-linecap="round" stroke-width=".75"><path d="m4.55 8.57c-.1-.37-.2-.85-.4-1.55-.17-.56-.34-.86-.47-1.23-.15-.46-.3-.72-.5-1.18-.14-.33-.36-1.05-.46-1.44-.12-.51.03-.92.24-1.21.25-.34.96-.49 1.36-.35.37.13.74.51.92.79.29.46.36.63.72 1.54.39.99.56 1.92.61 2.23l.08.45c0-.04-.04-1.12-.04-1.16-.04-1.03-.06-1.82-.04-2.94.01-.13.06-.59.08-.72.08-.5.3-.8.67-.98.41-.2.93-.21 1.4-.02.42.17.63.55.69 1.02.01.11.09.99.09 1.11-.01 1.02.01 1.64.02 2.17 0 .23 0 1.62.01 1.47.06-.66.09-3.19.34-3.94.14-.43.41-.75.8-.93.43-.2 1.11-.07 1.4.24.29.31.45.69.48 1.15.03.41-.02.9-.02 1.25 0 .87-.02 1.32-.04 2.12 0 .04-.01.3.02.18.1-.28.19-.54.27-.75.05-.12.24-.61.36-.86.11-.23.21-.37.41-.69.2-.31.42-.45.67-.56.54-.23 1.11.11 1.3.59.09.22.01.71-.03 1.1-.06.65-.25 1.31-.35 1.65-.13.45-.27 1.24-.34 1.6-.07.4-.23 1.39-.36 1.82-.09.3-.37.98-.65 1.39 0 0-1.07 1.25-1.19 1.81-.12.56-.08.57-.1.97-.02.4.12.92.12.92s-.8.1-1.23.03c-.39-.06-.88-.84-1-1.08-.17-.33-.54-.26-.68-.02-.23.38-.71 1.07-1.05 1.11-.67.08-2.05.03-3.14.02 0 0 .19-1.01-.23-1.36-.3-.26-.83-.78-1.14-1.06l-.83-.92c-.28-.36-.63-1.09-1.24-1.99-.35-.5-1.03-1.08-1.29-1.58-.22-.42-.33-.95-.19-1.32.23-.6.68-.9 1.36-.83.52.05.85.2 1.24.53.22.19.57.54.75.75.16.2.2.28.38.51.23.31.3.46.21.12" stroke-linejoin="round"/></g></svg>`,
                    handopen: `<svg height="38" viewBox="0 0 32 32" width="38" xmlns="http://www.w3.org/2000/svg"><g fill="#38ef7d" stroke="#0f172a" stroke-width=".8"><path d="M12 6a2 2 0 0 1 2 2v6h1V4a2 2 0 0 1 2-2 2 2 0 0 1 2 2v10h1V6a2 2 0 0 1 2-2 2 2 0 0 1 2 2v8h1V9a2 2 0 0 1 2-2 2 2 0 0 1 2 2v11c0 5-4 9-9 9s-9-4-9-9V12a2 2 0 0 1 2-2 2 2 0 0 1 2 2v2h1V8a2 2 0 0 1 2-2z"/></g></svg>`,
                    busy: `<svg height="38" viewBox="0 0 32 32" width="38" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="12" fill="none" stroke="#38ef7d" stroke-width="3" stroke-dasharray="16 8"><animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="0.9s" repeatCount="indefinite"/></circle><circle cx="16" cy="16" r="4" fill="#38ef7d"/></svg>`,
                    beachball: `<svg height="38" viewBox="0 0 32 32" width="38" xmlns="http://www.w3.org/2000/svg"><g><animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="1s" repeatCount="indefinite"/><circle cx="16" cy="16" r="14" fill="#38ef7d"/><path d="M16 2A14 14 0 0 1 30 16L16 16Z" fill="#f1c40f"/><path d="M16 16L30 16A14 14 0 0 1 16 30Z" fill="#e74c3c"/><path d="M16 16L16 30A14 14 0 0 1 2 16Z" fill="#3498db"/></g></svg>`,
                    handgrabbing: `<svg height="38" viewBox="0 0 32 32" width="38" xmlns="http://www.w3.org/2000/svg"><path d="M10 14a3 3 0 0 1 6 0v2h2v-2a3 3 0 0 1 6 0v6c0 4-3 7-7 7s-7-3-7-7z" fill="#38ef7d" stroke="#0f172a" stroke-width="1"/></svg>`,
                    copy: `<svg height="38" viewBox="0 0 32 32" width="38" xmlns="http://www.w3.org/2000/svg"><g fill="#38ef7d"><path d="M8 8h12v14H8z"/><path d="M12 4h12v14h-2V6H12z" fill="#a7f3d0"/><path d="M14 13h-2v4h-4v2h4v4h2v-4h4v-2h-4z" fill="#0f172a"/></g></svg>`
                };

                const container = document.getElementById('rex-container');
                const cursorIcon = document.getElementById('cursor-icon');
                const cursorBadge = document.getElementById('cursor-badge');
                const speechBubble = document.getElementById('speech-bubble');
                const highlightBox = document.getElementById('highlight-box');
                const highlightTag = document.getElementById('highlight-tag');
                const mascotPedestal = document.getElementById('mascot-pedestal');
                const mascotMoodTag = document.getElementById('mascot-mood-tag');
                const statusDot = document.getElementById('status-dot');

                let curX = 200, curY = 200;
                let targetX = 200, targetY = 200;
                let curStyle = 'default';
                let curMode = 'autonomous';
                let curAppearance = 'both';
                let speechTimer = null;
                let isAutonomousMoving = false;
                let idleTimerSeconds = 0;

                cursorIcon.innerHTML = SVGS.default;

                // =========================================
                // 8-BIT BABY T-REX 64x64 CANVAS & EMOTIONS
                // =========================================
                const canvas = document.getElementById('dino-canvas');
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = false;

                let frameCount = 0;
                let dinoEmotion = 'idle'; // 'idle', 'happy', 'sad', 'angry', 'crying', 'sleepy', 'thinking', 'excited', 'shocked'
                let isBlinking = false;
                let mouthOpen = false;

                const C = {
                    g1: '#38ef7d', // vibrant green
                    g2: '#11998e', // medium green shading
                    g3: '#0b5345', // dark green outline / spikes
                    y1: '#f9ca24', // belly yellow
                    y2: '#f0932b', // belly shading
                    w: '#ffffff',  // white
                    k: '#130f40',  // dark pupil / outline
                    p: '#ff7979',  // blush pink
                    o: '#eb4d4b',  // mouth red
                    b: '#48dbfb',  // tear blue
                    r: '#ff4757',  // anger red
                    gold: '#ffd32a'// star eyes yellow
                };

                const MOOD_CONFIG = {
                    idle: { label: 'IDLE', color: '#38ef7d', dot: '#38ef7d' },
                    happy: { label: 'HAPPY', color: '#38ef7d', dot: '#38ef7d' },
                    excited: { label: 'EXCITED', color: '#2ed573', dot: '#2ed573' },
                    thinking: { label: 'THINKING', color: '#f1c40f', dot: '#f1c40f' },
                    sleepy: { label: 'SLEEPY', color: '#a29bfe', dot: '#a29bfe' },
                    sad: { label: 'SAD', color: '#70a1ff', dot: '#70a1ff' },
                    crying: { label: 'CRYING', color: '#48dbfb', dot: '#48dbfb' },
                    angry: { label: 'ANGRY', color: '#ff4757', dot: '#ff4757' },
                    shocked: { label: 'SHOCKED', color: '#ff9f43', dot: '#ff9f43' }
                };

                function updateMoodTag(emotion) {
                    const cfg = MOOD_CONFIG[emotion] || MOOD_CONFIG.idle;
                    if (mascotMoodTag) {
                        mascotMoodTag.textContent = cfg.label;
                        mascotMoodTag.style.color = cfg.color;
                    }
                    if (statusDot) {
                        statusDot.style.background = cfg.dot;
                        statusDot.style.boxShadow = `0 0 8px ${cfg.dot}`;
                    }
                }

                function drawRect(x, y, w, h, col) {
                    ctx.fillStyle = col;
                    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
                }

                // Floating emotion particles system
                let particles = [];

                function updateAndDrawParticles() {
                    // Spawn particles based on emotion
                    if (dinoEmotion === 'sleepy' && frameCount % 35 === 0) {
                        particles.push({
                            x: 25, y: 10,
                            vx: 0.15, vy: -0.35,
                            text: ['Z', 'z', '·'][particles.length % 3],
                            color: '#a29bfe', size: 8, life: 70, maxLife: 70
                        });
                    } else if ((dinoEmotion === 'happy' || dinoEmotion === 'excited') && frameCount % 22 === 0) {
                        particles.push({
                            x: 12 + Math.random() * 16, y: 12,
                            vx: (Math.random() - 0.5) * 0.3, vy: -0.5,
                            text: ['✦', '✨', '★'][Math.floor(Math.random() * 3)],
                            color: '#ffd32a', size: 7, life: 50, maxLife: 50
                        });
                    } else if (dinoEmotion === 'angry' && frameCount % 20 === 0) {
                        particles.push({
                            x: 14 + Math.random() * 8, y: 6,
                            vx: (Math.random() - 0.5) * 0.25, vy: -0.4,
                            text: '♨',
                            color: 'rgba(255, 255, 255, 0.75)', size: 8, life: 40, maxLife: 40
                        });
                    } else if (dinoEmotion === 'shocked' && particles.length === 0) {
                        particles.push({
                            x: 20, y: 4,
                            vx: 0, vy: -0.15,
                            text: '!',
                            color: '#ff4757', size: 10, life: 45, maxLife: 45
                        });
                    }

                    // Render particles
                    for (let i = particles.length - 1; i >= 0; i--) {
                        const p = particles[i];
                        p.x += p.vx;
                        p.y += p.vy;
                        p.life--;
                        const alpha = Math.max(0, p.life / p.maxLife);
                        ctx.save();
                        ctx.globalAlpha = alpha;
                        ctx.fillStyle = p.color;
                        ctx.font = `bold ${p.size}px monospace`;
                        ctx.fillText(p.text, p.x, p.y);
                        ctx.restore();
                        if (p.life <= 0) particles.splice(i, 1);
                    }
                }

                function renderDino() {
                    ctx.clearRect(0, 0, 64, 64);
                    ctx.save();
                    ctx.scale(2, 2);

                    let bounceY = 0;
                    if (dinoEmotion === 'idle') {
                        bounceY = (Math.floor(frameCount / 30) % 2 === 0) ? 0 : 1;
                    } else if (dinoEmotion === 'happy' || dinoEmotion === 'excited') {
                        bounceY = (Math.floor(frameCount / 8) % 2 === 0) ? 0 : 2;
                    } else if (dinoEmotion === 'angry') {
                        bounceY = (Math.floor(frameCount / 6) % 2 === 0) ? 0 : 1;
                    } else if (dinoEmotion === 'shocked') {
                        bounceY = 2;
                    } else if (dinoEmotion === 'sad') {
                        bounceY = -1;
                    }

                    let y0 = 4 - bounceY;
                    if (dinoEmotion === 'sleepy') {
                        y0 = 4 + (Math.sin(frameCount * 0.05) > 0 ? 1 : 0);
                    }

                    let shakeX = 0;
                    if (dinoEmotion === 'crying') {
                        shakeX = (frameCount % 4 < 2) ? 1 : 0;
                    }

                    // 1. Spikes on back
                    drawRect(9 + shakeX, y0 + 5, 2, 2, C.g3);
                    drawRect(8 + shakeX, y0 + 9, 2, 2, C.g3);
                    drawRect(7 + shakeX, y0 + 13, 2, 2, C.g3);

                    // 2. Head
                    drawRect(11 + shakeX, y0 + 3, 13, 11, C.g1);
                    drawRect(24 + shakeX, y0 + 6, 4, 8, C.g1);
                    drawRect(10 + shakeX, y0 + 4, 1, 9, C.g3);
                    drawRect(11 + shakeX, y0 + 2, 13, 1, C.g3);
                    drawRect(24 + shakeX, y0 + 5, 4, 1, C.g3);
                    drawRect(28 + shakeX, y0 + 6, 1, 7, C.g3);
                    drawRect(11 + shakeX, y0 + 12, 13, 2, C.g2);
                    drawRect(24 + shakeX, y0 + 12, 3, 2, C.g2);

                    // 3. Eyes based on Emotion
                    if (dinoEmotion === 'sleepy') {
                        // Closed sleeping lines: - -
                        drawRect(17 + shakeX, y0 + 7, 5, 1, C.k);
                        drawRect(17 + shakeX, y0 + 8, 1, 1, C.k);
                        drawRect(21 + shakeX, y0 + 8, 1, 1, C.k);
                    } else if (dinoEmotion === 'happy') {
                        // Curved happy eyes ^ ^
                        drawRect(17 + shakeX, y0 + 7, 1, 2, C.k);
                        drawRect(18 + shakeX, y0 + 6, 3, 1, C.k);
                        drawRect(21 + shakeX, y0 + 7, 1, 2, C.k);
                    } else if (dinoEmotion === 'excited') {
                        // Golden star eyes ★
                        drawRect(18 + shakeX, y0 + 5, 3, 5, C.gold);
                        drawRect(17 + shakeX, y0 + 6, 5, 3, C.gold);
                        drawRect(19 + shakeX, y0 + 7, 1, 1, C.w);
                    } else if (dinoEmotion === 'angry') {
                        // Furrowed slanting brow & fierce red-tinted eye
                        drawRect(16 + shakeX, y0 + 4, 2, 1, C.k);
                        drawRect(18 + shakeX, y0 + 5, 3, 1, C.k);
                        drawRect(21 + shakeX, y0 + 6, 2, 1, C.k);
                        drawRect(18 + shakeX, y0 + 7, 3, 2, C.k);
                        drawRect(18 + shakeX, y0 + 7, 1, 1, C.r);
                    } else if (dinoEmotion === 'crying') {
                        // Teary eyes with streaming animated teardrops
                        drawRect(17 + shakeX, y0 + 5, 5, 5, C.w);
                        drawRect(18 + shakeX, y0 + 6, 3, 4, C.k);
                        drawRect(19 + shakeX, y0 + 7, 2, 2, C.b);
                        const tearOff = (frameCount * 2) % 12;
                        drawRect(16 + shakeX, y0 + 10 + Math.min(8, tearOff), 2, 2, C.b);
                        drawRect(20 + shakeX, y0 + 11 + Math.min(7, (tearOff + 5) % 12), 2, 2, C.b);
                    } else if (dinoEmotion === 'sad') {
                        // Drooped eyelids
                        drawRect(17 + shakeX, y0 + 5, 5, 5, C.w);
                        drawRect(17 + shakeX, y0 + 5, 5, 2, C.g1);
                        drawRect(18 + shakeX, y0 + 7, 3, 3, C.k);
                    } else if (dinoEmotion === 'shocked') {
                        // Huge shocked eyes with tiny pupil
                        drawRect(16 + shakeX, y0 + 4, 6, 6, C.w);
                        drawRect(18 + shakeX, y0 + 6, 2, 2, C.k);
                    } else if (dinoEmotion === 'thinking') {
                        // Raised eyebrow & inquisitive eye
                        drawRect(17 + shakeX, y0 + 3, 4, 1, C.k);
                        drawRect(17 + shakeX, y0 + 5, 5, 5, C.w);
                        drawRect(19 + shakeX, y0 + 5, 3, 3, C.k);
                        drawRect(19 + shakeX, y0 + 5, 1, 1, C.w);
                    } else {
                        // Default / Idle Eye (with blinking)
                        if (isBlinking) {
                            drawRect(17 + shakeX, y0 + 7, 5, 1, C.k);
                        } else {
                            drawRect(17 + shakeX, y0 + 5, 5, 5, C.w);
                            drawRect(19 + shakeX, y0 + 6, 3, 4, C.k);
                            drawRect(19 + shakeX, y0 + 6, 1, 1, C.w);
                        }
                    }

                    // 4. Cheeks Blush
                    if (dinoEmotion === 'angry') {
                        drawRect(15 + shakeX, y0 + 10, 3, 2, C.r);
                    } else if (dinoEmotion !== 'sleepy' && dinoEmotion !== 'sad') {
                        drawRect(15 + shakeX, y0 + 10, 3, 2, C.p);
                    }

                    // 5. Mouth
                    if (dinoEmotion === 'happy' || dinoEmotion === 'excited') {
                        drawRect(23 + shakeX, y0 + 10, 4, 3, C.g3);
                        drawRect(24 + shakeX, y0 + 11, 2, 2, C.o);
                    } else if (dinoEmotion === 'angry') {
                        drawRect(23 + shakeX, y0 + 10, 5, 2, C.k);
                        drawRect(24 + shakeX, y0 + 10, 1, 1, C.w);
                        drawRect(26 + shakeX, y0 + 10, 1, 1, C.w);
                    } else if (dinoEmotion === 'sad' || dinoEmotion === 'crying') {
                        drawRect(24 + shakeX, y0 + 11, 3, 1, C.g3);
                        drawRect(23 + shakeX, y0 + 12, 1, 1, C.g3);
                    } else if (dinoEmotion === 'shocked') {
                        drawRect(24 + shakeX, y0 + 10, 3, 3, C.k);
                        drawRect(25 + shakeX, y0 + 11, 1, 1, C.o);
                    } else if (mouthOpen) {
                        drawRect(23 + shakeX, y0 + 10, 4, 3, C.g3);
                        drawRect(24 + shakeX, y0 + 11, 2, 1, C.o);
                    } else {
                        drawRect(24 + shakeX, y0 + 10, 3, 1, C.g3);
                    }

                    // 6. Body & Belly
                    drawRect(10 + shakeX, y0 + 14, 12, 11, C.g1);
                    drawRect(9 + shakeX, y0 + 15, 1, 9, C.g3);
                    drawRect(10 + shakeX, y0 + 23, 12, 2, C.g2);
                    drawRect(16 + shakeX, y0 + 14, 6, 8, C.y1);
                    drawRect(17 + shakeX, y0 + 21, 5, 1, C.y2);

                    // 7. Arms
                    if (dinoEmotion === 'happy' || dinoEmotion === 'excited') {
                        drawRect(22 + shakeX, y0 + 12, 3, 2, C.g1);
                        drawRect(24 + shakeX, y0 + 10, 2, 2, C.g1);
                    } else if (dinoEmotion === 'thinking') {
                        drawRect(22 + shakeX, y0 + 13, 3, 2, C.g1);
                        drawRect(24 + shakeX, y0 + 11, 2, 2, C.g1);
                    } else {
                        drawRect(21 + shakeX, y0 + 16, 3, 2, C.g1);
                    }

                    // 8. Tail Wagging
                    const tailFast = (dinoEmotion === 'happy' || dinoEmotion === 'excited');
                    const tailDiv = tailFast ? 6 : 14;
                    const tailWag = (Math.floor(frameCount / tailDiv) % 2 === 0);
                    if (dinoEmotion === 'sad') {
                        drawRect(6 + shakeX, y0 + 20, 4, 3, C.g1);
                        drawRect(3 + shakeX, y0 + 22, 3, 2, C.g1);
                        drawRect(1 + shakeX, y0 + 23, 2, 2, C.g1);
                    } else if (tailWag) {
                        drawRect(6 + shakeX, y0 + 18, 4, 4, C.g1);
                        drawRect(3 + shakeX, y0 + 19, 3, 3, C.g1);
                        drawRect(2 + shakeX, y0 + 20, 2, 2, C.g1);
                    } else {
                        drawRect(6 + shakeX, y0 + 19, 4, 4, C.g1);
                        drawRect(3 + shakeX, y0 + 21, 3, 3, C.g1);
                        drawRect(1 + shakeX, y0 + 23, 2, 2, C.g1);
                    }

                    // 9. Feet
                    if (dinoEmotion === 'angry') {
                        const stomp = (Math.floor(frameCount / 8) % 2 === 0);
                        drawRect(12 + shakeX, y0 + 25 - (stomp ? 1 : 0), 3, 3, C.g3);
                        drawRect(17 + shakeX, y0 + 25 - (stomp ? 0 : 1), 3, 3, C.g3);
                    } else {
                        drawRect(12 + shakeX, y0 + 25, 3, 3, C.g3);
                        drawRect(17 + shakeX, y0 + 25, 3, 3, C.g3);
                    }

                    updateAndDrawParticles();
                    ctx.restore();
                }

                function animLoop() {
                    frameCount++;
                    if (frameCount % 180 === 0) isBlinking = true;
                    if (frameCount % 180 === 12) isBlinking = false;
                    if (dinoEmotion === 'thinking') mouthOpen = (frameCount % 16 < 8);

                    // Idle sleep timer check (every ~1s)
                    if (frameCount % 60 === 0) {
                        idleTimerSeconds++;
                        if (idleTimerSeconds >= 25 && dinoEmotion === 'idle') {
                            dinoEmotion = 'sleepy';
                            updateMoodTag('sleepy');
                        }
                    }

                    // Autonomous Cursor smooth interpolation when in follow mode
                    if (curMode === 'follow' && !isAutonomousMoving) {
                        const dx = targetX - curX;
                        const dy = targetY - curY;
                        const dist = Math.hypot(dx, dy);

                        if (dist > 0.4) {
                            const lerpFactor = dist > 80 ? 0.38 : 0.28;
                            curX += dx * lerpFactor;
                            curY += dy * lerpFactor;
                            container.style.transform = `translate3d(${curX.toFixed(2)}px, ${curY.toFixed(2)}px, 0)`;
                        }
                    }

                    renderDino();
                    requestAnimationFrame(animLoop);
                }
                requestAnimationFrame(animLoop);

                // =========================================
                // WINDOW GLOBAL APIS CALLED FROM SWIFT
                // =========================================
                window.setRexEmotion = (emotion) => {
                    const clean = String(emotion || 'idle').toLowerCase().trim();
                    dinoEmotion = clean;
                    updateMoodTag(clean);
                    idleTimerSeconds = 0;
                };

                window.onUserMouseActivity = () => {
                    idleTimerSeconds = 0;
                    if (dinoEmotion === 'sleepy') {
                        dinoEmotion = 'idle';
                        updateMoodTag('idle');
                    }
                };

                window.setMascotHover = (hovered) => {
                    if (hovered) {
                        mascotPedestal.classList.add('hovered');
                        if (dinoEmotion === 'idle' || dinoEmotion === 'sleepy') {
                            dinoEmotion = 'happy';
                            updateMoodTag('happy');
                        }
                    } else {
                        mascotPedestal.classList.remove('hovered');
                        if (dinoEmotion === 'happy' && idleTimerSeconds > 2) {
                            dinoEmotion = 'idle';
                            updateMoodTag('idle');
                        }
                    }
                };

                window.updateMousePosition = (x, y) => {
                    if (curMode !== 'follow') return;
                    targetX = x;
                    targetY = y;
                };

                window.moveToTarget = (x, y, duration = 300, style = 'default') => {
                    curStyle = style;
                    cursorIcon.innerHTML = SVGS[style] || SVGS.default;
                    isAutonomousMoving = true;
                    curMode = 'autonomous';
                    idleTimerSeconds = 0;

                    if (dinoEmotion === 'idle' || dinoEmotion === 'sleepy') {
                        dinoEmotion = 'excited';
                        updateMoodTag('excited');
                    }

                    container.style.transition = `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)`;
                    curX = x;
                    curY = y;
                    targetX = x;
                    targetY = y;
                    container.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;

                    setTimeout(() => {
                        container.style.transition = 'none';
                        isAutonomousMoving = false;
                    }, duration);
                };

                window.setRexMode = (mode) => {
                    curMode = mode;
                    if (mode === 'follow') {
                        container.style.transition = 'none';
                        isAutonomousMoving = false;
                    }
                };

                window.setRexAppearance = (app) => {
                    curAppearance = app;
                    container.style.display = (app === 'dino') ? 'none' : 'block';
                    document.getElementById('rex-dock').style.display = (app === 'cursor') ? 'none' : 'flex';
                };

                window.setRexStyle = (style) => {
                    curStyle = style;
                    cursorIcon.innerHTML = SVGS[style] || SVGS.default;
                };

                window.triggerClickPulse = (x, y, style = 'handpointing') => {
                    cursorIcon.innerHTML = SVGS[style] || SVGS.handpointing;
                    cursorIcon.classList.add('clicking');
                    cursorBadge.classList.add('clicking');

                    if (dinoEmotion === 'idle' || dinoEmotion === 'excited') {
                        dinoEmotion = 'happy';
                        updateMoodTag('happy');
                    }

                    const ripple = document.createElement('div');
                    ripple.className = 'click-ripple';
                    ripple.style.left = `${x}px`;
                    ripple.style.top = `${y}px`;
                    document.body.appendChild(ripple);

                    setTimeout(() => {
                        cursorIcon.classList.remove('clicking');
                        cursorBadge.classList.remove('clicking');
                        cursorIcon.innerHTML = SVGS[curStyle] || SVGS.default;
                        ripple.remove();
                    }, 500);
                };

                window.showRexSpeech = (text, duration = 3500, badge = 'COPILOT') => {
                    if (speechTimer) clearTimeout(speechTimer);
                    const textEl = document.getElementById('bubble-text');
                    const badgeEl = document.getElementById('bubble-badge');
                    if (textEl) textEl.textContent = text;
                    if (badgeEl) badgeEl.textContent = badge;
                    speechBubble.classList.add('active');

                    if (badge === 'ERROR' || badge === 'CAUTION') {
                        dinoEmotion = (badge === 'ERROR') ? 'crying' : 'shocked';
                    } else if (badge === 'PAUSED') {
                        dinoEmotion = 'sad';
                    } else if (badge === 'READY' || badge === 'SUCCESS') {
                        dinoEmotion = 'happy';
                    } else {
                        dinoEmotion = 'happy';
                    }
                    updateMoodTag(dinoEmotion);

                    speechTimer = setTimeout(() => {
                        speechBubble.classList.remove('active');
                        if (dinoEmotion === 'happy' || dinoEmotion === 'shocked') {
                            dinoEmotion = 'idle';
                            updateMoodTag('idle');
                        }
                    }, duration);
                };

                window.highlightRegion = (x, y, w, h, label = 'Rex Spotlight') => {
                    highlightBox.style.left = `${x}px`;
                    highlightBox.style.top = `${y}px`;
                    highlightBox.style.width = `${w}px`;
                    highlightBox.style.height = `${h}px`;
                    highlightTag.textContent = label;
                    highlightBox.style.display = 'block';
                };

                window.hideHighlight = () => {
                    highlightBox.style.display = 'none';
                };

                window.setListening = (active) => {
                    const eq = document.getElementById('audio-eq');
                    const mic = document.getElementById('mic-indicator');
                    if (active) {
                        eq?.classList.add('active');
                        mic?.classList.add('active');
                        window.setRexEmotion('thinking');
                        window.setRexStyle('beachball');
                    } else {
                        eq?.classList.remove('active');
                        mic?.classList.remove('active');
                        window.setRexEmotion('idle');
                    }
                };

                window.setThinking = (active) => {
                    const eq = document.getElementById('audio-eq');
                    const mic = document.getElementById('mic-indicator');
                    eq?.classList.remove('active');
                    mic?.classList.remove('active');
                    if (active) {
                        window.setRexEmotion('thinking');
                        window.setRexStyle('busy');
                    } else {
                        window.setRexEmotion('idle');
                        window.setRexStyle('default');
                    }
                };
            </script>
        </body>
        </html>
        """

        webView.loadHTMLString(html, baseURL: nil)
        isReady = true
        print("{\"event\":\"ready\",\"screenWidth\":\(screenFrame.width),\"screenHeight\":\(screenFrame.height)}")
        fflush(stdout)
    }
}

let app = NSApplication.shared
let delegate = OverlayController()
app.delegate = delegate
app.setActivationPolicy(.accessory) // Non-activating: never steals focus from active windows!
app.run()
