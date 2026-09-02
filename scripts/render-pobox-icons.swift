import AppKit
import Foundation

func drawIcon(size: Int) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    let representation = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    representation.size = image.size
    image.addRepresentation(representation)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: representation)

    let rect = NSRect(x: 0, y: 0, width: size, height: size)
    NSColor(red: 0.06, green: 0.14, blue: 0.11, alpha: 1).setFill()
    NSBezierPath(roundedRect: rect, xRadius: CGFloat(size) * 0.21, yRadius: CGFloat(size) * 0.21).fill()

    let boxRect = NSRect(
        x: CGFloat(size) * 0.16,
        y: CGFloat(size) * 0.24,
        width: CGFloat(size) * 0.68,
        height: CGFloat(size) * 0.48
    )
    NSColor(red: 0.95, green: 0.98, blue: 0.95, alpha: 1).setFill()
    NSBezierPath(roundedRect: boxRect, xRadius: CGFloat(size) * 0.055, yRadius: CGFloat(size) * 0.055).fill()

    NSColor(red: 0.10, green: 0.24, blue: 0.19, alpha: 1).setStroke()
    let slot = NSBezierPath()
    slot.lineWidth = max(3, CGFloat(size) * 0.035)
    slot.move(to: NSPoint(x: CGFloat(size) * 0.30, y: CGFloat(size) * 0.56))
    slot.line(to: NSPoint(x: CGFloat(size) * 0.70, y: CGFloat(size) * 0.56))
    slot.stroke()

    let door = NSBezierPath(
        roundedRect: NSRect(x: CGFloat(size) * 0.37, y: CGFloat(size) * 0.32, width: CGFloat(size) * 0.26, height: CGFloat(size) * 0.12),
        xRadius: CGFloat(size) * 0.025,
        yRadius: CGFloat(size) * 0.025
    )
    NSColor(red: 0.18, green: 0.50, blue: 0.35, alpha: 1).setFill()
    door.fill()

    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: CGFloat(size) * 0.18, weight: .heavy),
        .foregroundColor: NSColor(red: 0.95, green: 0.98, blue: 0.95, alpha: 1)
    ]
    let text = "PB"
    let textSize = text.size(withAttributes: attrs)
    text.draw(at: NSPoint(x: (CGFloat(size) - textSize.width) / 2, y: CGFloat(size) * 0.74), withAttributes: attrs)

    NSGraphicsContext.restoreGraphicsState()
    return image
}

func writePNG(size: Int, path: String) {
    let image = drawIcon(size: size)
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        fatalError("Unable to render \(path)")
    }
    try! png.write(to: URL(fileURLWithPath: path))
}

let fileManager = FileManager.default
let directories = [
    "web/public/icons",
    "assets/app-icons/android",
    "assets/app-icons/windows",
    "apple/iOS/MailboxiOS/Assets.xcassets/AppIcon.appiconset",
    "apple/macOS/MailboxMacOS/Assets.xcassets/AppIcon.appiconset",
    "/tmp/pobox-icon.iconset"
]

for directory in directories {
    try fileManager.createDirectory(atPath: directory, withIntermediateDirectories: true)
}

let outputs: [(Int, String)] = [
    (16, "web/public/icons/favicon-16.png"),
    (32, "web/public/icons/favicon-32.png"),
    (48, "assets/app-icons/windows/pobox-watch-48.png"),
    (64, "assets/app-icons/windows/pobox-watch-64.png"),
    (128, "assets/app-icons/windows/pobox-watch-128.png"),
    (180, "web/public/icons/apple-touch-icon.png"),
    (192, "web/public/icons/icon-192.png"),
    (256, "assets/app-icons/windows/pobox-watch-256.png"),
    (512, "web/public/icons/icon-512.png"),
    (512, "assets/app-icons/android/pobox-watch-512.png"),
    (1024, "assets/app-icons/android/pobox-watch-1024.png")
]

for output in outputs {
    writePNG(size: output.0, path: output.1)
}

for size in [40, 58, 60, 80, 87, 120, 180, 1024] {
    writePNG(size: size, path: "apple/iOS/MailboxiOS/Assets.xcassets/AppIcon.appiconset/icon-\(size).png")
}

for size in [16, 32, 64, 128, 256, 512, 1024] {
    writePNG(size: size, path: "apple/macOS/MailboxMacOS/Assets.xcassets/AppIcon.appiconset/icon-\(size).png")
}

let iconsetMap = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png")
]

for item in iconsetMap {
    writePNG(size: item.0, path: "/tmp/pobox-icon.iconset/\(item.1)")
}
