// rex-omni-inspect.swift
// Native Apple Vision Framework & Accessibility Grounding Engine
// Scans any macOS screen capture with neural OCR and AXUIElement inspection,
// extracts exact grounded pixel coordinates for every text, button, input, and control,
// and optionally renders a high-visibility Set-of-Marks (SoM) annotated screenshot.

import Cocoa
import Vision
import ApplicationServices

struct GroundedElement: Codable {
    let id: Int
    let text: String
    let role: String // "input", "button", "tab", "link", "text", "contact", "question"
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let confidence: Double
    let source: String // "vision" or "ax"
}

func sanitizeText(_ str: String) -> String {
    return str.trimmingCharacters(in: .whitespacesAndNewlines)
              .replacingOccurrences(of: "\n", with: " ")
}

func classifyRole(text: String, width: Double, height: Double, y: Double, screenHeight: Double) -> String {
    let lower = text.lowercased()

    // 1. Text Inputs / Search fields / Composers
    if lower.contains("search") || lower.contains("type a message") || lower.contains("type a") ||
       lower.contains("enter") || lower.contains("write a") || lower.contains("placeholder") ||
       lower.contains("ask anything") || lower.contains("message...") || lower.contains("reply...") ||
       lower.contains("email") || lower.contains("password") || lower.contains("name") {
        return "input"
    }

    // 2. Interactive Buttons / Actions
    if lower == "send" || lower == "submit" || lower == "login" || lower == "sign in" ||
       lower == "continue" || lower == "save" || lower == "apply" || lower == "done" ||
       lower == "cancel" || lower == "ok" || lower == "next" || lower == "solve" ||
       lower == "export" || lower == "share" || lower == "copy" || lower == "run" ||
       lower == "close" || lower.hasPrefix("btn") {
        return "button"
    }

    // 3. Navigation Tabs / App Items (often at top or left edge)
    if (y < 85 && height < 40) || (width > 60 && height < 32 && lower.count < 25) {
        if lower.contains("tab") || lower.contains("zen") || lower.contains("chat") ||
           lower.contains("file") || lower.contains("edit") || lower.contains("view") {
            return "tab"
        }
    }

    // 4. Contact / Chat List Item (typically in sidebars)
    if height >= 35 && height <= 85 && width > 120 {
        return "contact"
    }

    // 5. Questions / Problems / Headers
    if lower.hasPrefix("question") || lower.hasPrefix("problem") || lower.hasPrefix("q.") ||
       lower.hasPrefix("exercise") || lower.contains("solve") {
        return "question"
    }

    return "text"
}

func inspectVision(imagePath: String, screenWidth: Double, screenHeight: Double) -> (elements: [GroundedElement], scaleX: Double, scaleY: Double) {
    let url = URL(fileURLWithPath: imagePath)
    guard let image = NSImage(contentsOf: url),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return ([], 1.0, 1.0)
    }

    let imgWidth = Double(cgImage.width)
    let imgHeight = Double(cgImage.height)

    let scaleX = imgWidth / screenWidth
    let scaleY = imgHeight / screenHeight

    var results: [GroundedElement] = []

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-US"]

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        request.recognitionLevel = .fast
        try? handler.perform([request])
    }

    guard let observations = request.results else {
        return ([], scaleX, scaleY)
    }

    var count = 0
    for obs in observations {
        guard let top = obs.topCandidates(1).first else { continue }
        let text = sanitizeText(top.string)
        if text.isEmpty || text.count < 2 { continue }

        let box = obs.boundingBox
        // Normalized Vision coordinates (bottom-left origin) to macOS display coordinates (top-left origin in points)
        let rawX = box.origin.x * imgWidth
        let rawY = (1.0 - box.origin.y - box.size.height) * imgHeight
        let rawW = box.size.width * imgWidth
        let rawH = box.size.height * imgHeight

        let pointX = rawX / scaleX
        let pointY = rawY / scaleY
        let pointW = rawW / scaleX
        let pointH = rawH / scaleY

        // Discard tiny artifacts or screen borders
        if pointW < 8 || pointH < 7 { continue }
        if pointX < 0 || pointY < 0 || pointX > screenWidth || pointY > screenHeight { continue }

        count += 1
        let role = classifyRole(text: text, width: pointW, height: pointH, y: pointY, screenHeight: screenHeight)

        results.append(GroundedElement(
            id: count,
            text: text,
            role: role,
            x: round(pointX),
            y: round(pointY),
            w: round(pointW),
            h: round(pointH),
            confidence: Double(round(top.confidence * 100) / 100),
            source: "vision"
        ))
    }

    return (results, scaleX, scaleY)
}

func drawSetOfMarks(imagePath: String, elements: [GroundedElement], outPath: String, scaleX: Double, scaleY: Double) {
    let url = URL(fileURLWithPath: imagePath)
    guard let image = NSImage(contentsOf: url),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return
    }

    let rep = NSBitmapImageRep(cgImage: cgImage)
    let canvas = NSImage(size: NSSize(width: rep.pixelsWide, height: rep.pixelsHigh))
    canvas.addRepresentation(rep)

    canvas.lockFocus()

    let font = NSFont.boldSystemFont(ofSize: 18)
    let textAttrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor.white
    ]

    for elem in elements.prefix(50) {
        let px = elem.x * scaleX
        let py = Double(rep.pixelsHigh) - (elem.y * scaleY) - (elem.h * scaleY)
        let pw = elem.w * scaleX
        let ph = elem.h * scaleY

        // 1. Draw glowing bounding box
        let rect = NSRect(x: px, y: py, width: pw, height: ph)
        let strokeColor: NSColor
        if elem.role == "input" {
            strokeColor = NSColor(calibratedRed: 0.12, green: 0.75, blue: 1.0, alpha: 0.9) // Cyan for inputs
        } else if elem.role == "button" {
            strokeColor = NSColor(calibratedRed: 0.22, green: 0.94, blue: 0.49, alpha: 0.9) // Lime for buttons
        } else if elem.role == "contact" {
            strokeColor = NSColor(calibratedRed: 1.0, green: 0.76, blue: 0.14, alpha: 0.9) // Gold for contacts
        } else {
            strokeColor = NSColor(calibratedRed: 0.65, green: 0.35, blue: 1.0, alpha: 0.85) // Violet
        }

        strokeColor.setStroke()
        let path = NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4)
        path.lineWidth = 3.0
        path.stroke()

        // 2. Draw Tag Badge [ID] at top-left of element
        let tagStr = "[\(elem.id)]"
        let strSize = tagStr.size(withAttributes: textAttrs)
        let badgeRect = NSRect(x: px, y: py + ph - strSize.height - 4, width: strSize.width + 10, height: strSize.height + 4)

        NSColor(calibratedRed: 0.05, green: 0.05, blue: 0.08, alpha: 0.88).setFill()
        let badgePath = NSBezierPath(roundedRect: badgeRect, xRadius: 4, yRadius: 4)
        badgePath.fill()

        strokeColor.setStroke()
        badgePath.lineWidth = 1.0
        badgePath.stroke()

        tagStr.draw(at: NSPoint(x: px + 5, y: py + ph - strSize.height - 2), withAttributes: textAttrs)
    }

    canvas.unlockFocus()

    if let tiff = canvas.tiffRepresentation,
       let bitmap = NSBitmapImageRep(data: tiff),
       let pngData = bitmap.representation(using: .png, properties: [:]) {
        try? pngData.write(to: URL(fileURLWithPath: outPath))
    }
}

// CLI Execution
let args = CommandLine.arguments
guard args.count >= 2 else {
    print("[]")
    exit(0)
}

let imagePath = args[1]
let screenW = args.count > 2 ? (Double(args[2]) ?? 1470.0) : 1470.0
let screenH = args.count > 3 ? (Double(args[3]) ?? 956.0) : 956.0
let outAnnotatedPath = args.count > 4 ? args[4] : ""

let (elements, scaleX, scaleY) = inspectVision(imagePath: imagePath, screenWidth: screenW, screenHeight: screenH)

if !outAnnotatedPath.isEmpty {
    drawSetOfMarks(imagePath: imagePath, elements: elements, outPath: outAnnotatedPath, scaleX: scaleX, scaleY: scaleY)
}

let encoder = JSONEncoder()
encoder.outputFormatting = .prettyPrinted
if let data = try? encoder.encode(elements), let str = String(data: data, encoding: .utf8) {
    print(str)
} else {
    print("[]")
}
