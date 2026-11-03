import SwiftUI
import AppKit

/// Low-contrast chrome so the device screen and the conversation stand out.
/// Every color resolves per appearance (near-black in dark, near-white in light).
enum Theme {
    static let window = dynamic(light: 1.0, dark: 0.0)
    static let sidebar = dynamic(light: 0.975, dark: 0.035)
    static let surface = dynamic(light: 0.955, dark: 0.06)
    static let raised = dynamic(light: 0.92, dark: 0.10)
    static let hover = dynamic(light: 0.90, dark: 0.13)
    static let border = dynamic(light: 0.88, dark: 0.12)
    static let text = dynamic(light: 0.08, dark: 0.94)
    /// Foreground on top of `text`-colored fills (prominent buttons).
    static let onText = dynamic(light: 1.0, dark: 0.0)
    static let secondary = dynamic(light: 0.42, dark: 0.56)
    static let tertiary = dynamic(light: 0.62, dark: 0.36)
    static let live = Color(red: 0.20, green: 0.75, blue: 0.40)
    static let warn = Color(red: 0.95, green: 0.65, blue: 0.20)
    static let danger = Color(red: 0.95, green: 0.30, blue: 0.30)
    static let control = Color(red: 0.30, green: 0.50, blue: 1.0)
    static let link = Color(red: 0.40, green: 0.62, blue: 1.0)

    private static func dynamic(light: CGFloat, dark: CGFloat) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(white: isDark ? dark : light, alpha: 1)
        })
    }
}

/// User's appearance choice, applied app-wide (windows, sheets and popovers).
enum Appearance: String, CaseIterable, Identifiable {
    case auto, light, dark
    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    static let key = "appearance"

    static var current: Appearance {
        Appearance(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .dark
    }

    func apply() {
        switch self {
        case .auto: NSApplication.shared.appearance = nil
        case .light: NSApplication.shared.appearance = NSAppearance(named: .aqua)
        case .dark: NSApplication.shared.appearance = NSAppearance(named: .darkAqua)
        }
    }
}

extension View {
    func hairline(_ radius: CGFloat = 12) -> some View {
        overlay(RoundedRectangle(cornerRadius: radius).stroke(Theme.border, lineWidth: 1))
    }
}

/// Bot avatar from the brain's SVG (NSImage renders SVG natively).
struct Avatar: View {
    let svg: String?
    var size: CGFloat = 28

    var body: some View {
        Group {
            if let svg, let image = NSImage(data: Data(svg.utf8)) {
                Image(nsImage: image).resizable().interpolation(.high)
            } else {
                RoundedRectangle(cornerRadius: size * 0.25).fill(Theme.raised)
            }
        }
        .frame(width: size, height: size)
    }
}

/// Small round icon button, the same family as the title-bar buttons.
struct IconButton: View {
    let systemImage: String
    var help: String = ""
    var size: CGFloat = 26
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.44, weight: .medium))
                .foregroundStyle(hovering ? Theme.text : Theme.secondary)
                .frame(width: size, height: size)
                .background(Circle().fill(hovering ? Theme.hover : Theme.raised.opacity(0.7)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

struct PillButton: View {
    let title: String
    let systemImage: String
    var prominent = false
    var tint: Color?
    let action: () -> Void
    @State private var hovering = false
    /// Icon only (title as tooltip), for tight toolbars.
    @Environment(\.compactPills) private var compact

    var body: some View {
        Button(action: action) {
            Group {
                if compact {
                    Image(systemName: systemImage)
                        .frame(width: 30, height: 28)
                } else {
                    Label(title, systemImage: systemImage)
                        .lineLimit(1)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                }
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(prominent ? Theme.onText : Theme.text)
            .background(Capsule().fill(background))
            .overlay(Capsule().stroke(prominent || tint != nil ? .clear : Theme.border))
            .fixedSize()
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(compact ? title : "")
        .accessibilityLabel(title)
    }

    private var background: Color {
        if let tint { return tint }
        if prominent { return hovering ? Theme.text.opacity(0.85) : Theme.text }
        return hovering ? Theme.hover : Theme.raised
    }
}

private struct CompactPillsKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var compactPills: Bool {
        get { self[CompactPillsKey.self] }
        set { self[CompactPillsKey.self] = newValue }
    }
}

struct Placeholder: View {
    let icon: String
    let text: String
    var detail: String?

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 26, weight: .light)).foregroundStyle(Theme.tertiary)
            Text(text).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.secondary)
            if let detail {
                Text(detail).font(.system(size: 12)).foregroundStyle(Theme.tertiary)
                    .multilineTextAlignment(.center).frame(maxWidth: 280)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Text field styled for the dark chrome.
struct Field: View {
    let label: String
    @Binding var text: String
    var placeholder = ""
    var axis: Axis = .horizontal
    var secure = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.secondary)
            Group {
                if secure {
                    SecureField(placeholder, text: $text)
                } else {
                    TextField(placeholder, text: $text, axis: axis).lineLimit(axis == .vertical ? 3...8 : 1...1)
                }
            }
            .textFieldStyle(.plain)
            .font(.system(size: 13))
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
            .hairline(8)
        }
    }
}

func stateLabel(_ state: String) -> String {
    switch state {
    case "running": return "On"
    case "stopped": return "Off"
    case "starting": return "Starting…"
    case "stopping": return "Shutting down…"
    case "suspended": return "Suspended"
    case "creating": return "Being created…"
    default: return "Error"
    }
}

func stateColor(_ state: String) -> Color {
    switch state {
    case "running": return Theme.live
    case "starting", "stopping", "creating": return Theme.warn
    case "stopped": return Theme.tertiary
    case "suspended": return Theme.secondary
    default: return Theme.danger
    }
}
