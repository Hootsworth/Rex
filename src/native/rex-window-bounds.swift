// rex-window-bounds.swift
// Ultra-fast CLI tool to inspect active macOS window frames and display dimensions.
// Outputs JSON with { found: true, owner: "...", x: 0, y: 33, width: 1470, height: 923, screenWidth: 1470, screenHeight: 956 }

import Cocoa
import CoreGraphics

let targetApp = CommandLine.arguments.count > 1 ? CommandLine.arguments[1].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() : ""

let mainScreen = NSScreen.main ?? NSScreen.screens.first
let screenW = mainScreen?.frame.width ?? 1470
let screenH = mainScreen?.frame.height ?? 956

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
var matchedWindow: [String: Any]? = nil
var fallbackWindow: [String: Any]? = nil

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
            "screenWidth": screenW,
            "screenHeight": screenH
        ]

        if fallbackWindow == nil {
            fallbackWindow = winData
        }

        if !targetApp.isEmpty {
            let lowerOwner = owner.lowercased()
            if lowerOwner == targetApp ||
               lowerOwner.contains(targetApp) ||
               targetApp.contains(lowerOwner) ||
               (targetApp.contains("zen") && lowerOwner.contains("zen")) ||
               (targetApp.contains("chrome") && lowerOwner.contains("chrome")) ||
               (targetApp.contains("davinci") && lowerOwner.contains("resolve")) ||
               (targetApp.contains("whatsapp") && (lowerOwner.contains("whatsapp") || lowerOwner.contains("wahsyapp"))) {
                matchedWindow = winData
                break
            }
        }
    }
}

let result = matchedWindow ?? fallbackWindow ?? [
    "found": false,
    "owner": "",
    "x": 0,
    "y": 33,
    "width": screenW,
    "height": screenH - 33,
    "screenWidth": screenW,
    "screenHeight": screenH
]

if let jsonData = try? JSONSerialization.data(withJSONObject: result, options: []),
   let jsonStr = String(data: jsonData, encoding: .utf8) {
    print(jsonStr)
} else {
    print("{\"found\":false}")
}
