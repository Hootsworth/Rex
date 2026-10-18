// rex-ax-inspect.swift
// Native macOS Accessibility Tree Inspector for Rex Autonomous Screen Copilot
// Traverses AXUIElement hierarchy to find exact pixel-perfect hitboxes for buttons,
// text fields, sliders, checkboxes, and menu items across any macOS application.

import Cocoa
import ApplicationServices

struct ElementInfo: Codable {
    let role: String
    let title: String
    let value: String
    let placeholder: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let enabled: Bool
}

func getAXAttribute<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success, let val = value as? T else { return nil }
    return val
}

func getElementRect(_ element: AXUIElement) -> CGRect? {
    var posValue: AnyObject?
    var sizeValue: AnyObject?

    let posResult = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue)
    let sizeResult = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue)

    guard posResult == .success, sizeResult == .success,
          let posVal = posValue, let sizeVal = sizeValue else {
        return nil
    }

    var pt = CGPoint.zero
    var sz = CGSize.zero
    guard AXValueGetValue(posVal as! AXValue, .cgPoint, &pt),
          AXValueGetValue(sizeVal as! AXValue, .cgSize, &sz) else {
        return nil
    }

    return CGRect(origin: pt, size: sz)
}

func inspectElementRecursive(_ element: AXUIElement, depth: Int, maxDepth: Int, results: inout [ElementInfo]) {
    guard depth <= maxDepth else { return }

    let role: String = getAXAttribute(element, kAXRoleAttribute) ?? ""
    let title: String = getAXAttribute(element, kAXTitleAttribute) ?? ""
    let description: String = getAXAttribute(element, kAXDescriptionAttribute) ?? ""
    let valueStr: String = {
        if let v: String = getAXAttribute(element, kAXValueAttribute) { return v }
        if let n: NSNumber = getAXAttribute(element, kAXValueAttribute) { return n.stringValue }
        return ""
    }()
    let placeholder: String = getAXAttribute(element, "AXPlaceholderValue") ?? ""
    let enabled: Bool = getAXAttribute(element, kAXEnabledAttribute) ?? true

    let interestingRoles = [
        "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXSlider",
        "AXCheckBox", "AXPopUpButton", "AXRadioButton", "AXTab", "AXLink",
        "AXMenuItem", "AXColorWell", "AXIncrementor", "AXCell"
    ]

    let displayTitle = !title.isEmpty ? title : description

    if interestingRoles.contains(role) || !displayTitle.isEmpty {
        if let rect = getElementRect(element), rect.width > 12, rect.height > 10 {
            results.append(ElementInfo(
                role: role,
                title: displayTitle,
                value: valueStr,
                placeholder: placeholder,
                x: Double(rect.origin.x),
                y: Double(rect.origin.y),
                width: Double(rect.size.width),
                height: Double(rect.size.height),
                enabled: enabled
            ))
        }
    }

    // Traverse children
    var childrenValue: AnyObject?
    if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue) == .success,
       let children = childrenValue as? [AXUIElement] {
        for child in children {
            inspectElementRecursive(child, depth: depth + 1, maxDepth: maxDepth, results: &results)
        }
    }
}

func findAppPID(named appName: String) -> pid_t? {
    let lower = appName.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    let apps = NSWorkspace.shared.runningApplications
    for app in apps {
        let name = (app.localizedName ?? "").lowercased()
        let bid = (app.bundleIdentifier ?? "").lowercased()
        if name == lower || name.contains(lower) || lower.contains(name) ||
           bid.contains(lower) ||
           (lower.contains("zen") && name.contains("zen")) ||
           (lower.contains("chrome") && name.contains("chrome")) ||
           (lower.contains("davinci") && name.contains("resolve")) ||
           (lower.contains("whatsapp") && (name.contains("whatsapp") || name.contains("wahsyapp"))) {
            return app.processIdentifier
        }
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

// CLI Entrypoint
let args = CommandLine.arguments
let appArg = args.count > 1 ? args[1] : ""
let queryArg = args.count > 2 ? args[2].lowercased().trimmingCharacters(in: .whitespacesAndNewlines) : ""

guard let pid = findAppPID(named: appArg) else {
    print("{\"found\":false,\"error\":\"App not running\"}")
    exit(0)
}

let appElement = AXUIElementCreateApplication(pid)
var windowsValue: AnyObject?
var targetElement: AXUIElement = appElement

if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsValue) == .success,
   let windows = windowsValue as? [AXUIElement], !windows.isEmpty {
    targetElement = windows.first!
}

var elements: [ElementInfo] = []
inspectElementRecursive(targetElement, depth: 0, maxDepth: 12, results: &elements)

if !queryArg.isEmpty {
    // Score elements matching query
    elements = elements.filter { elem in
        let t = elem.title.lowercased()
        let p = elem.placeholder.lowercased()
        let r = elem.role.lowercased()
        let v = elem.value.lowercased()
        return t.contains(queryArg) || p.contains(queryArg) || r.contains(queryArg) || v.contains(queryArg)
    }
}

let encoder = JSONEncoder()
encoder.outputFormatting = .prettyPrinted
if let data = try? encoder.encode(elements), let str = String(data: data, encoding: .utf8) {
    print(str)
} else {
    print("[]")
}
